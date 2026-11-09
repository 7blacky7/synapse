/**
 * P22-T330 (Befund P22-T327, thought cde3305b): EIN gemeinsamer LISTEN-Client je API-Prozess fuer die SSE-Route
 * GET /api/projects/:name/events (routes/specialists.ts).
 * ANLASS: Bisher hielt jeder offene Stream eine Verbindung aus dem HAUPTPOOL (getPool().connect() + LISTEN). Gemessen 09.11.2026:
 *   5 Streams LISTEN synapse_tool_activity = 5 von 20 Plaetzen dauerhaft belegt, Stichprobe Pool frei 0 / wartend 6.
 * WEG: verbindeListenClient() (eigene Verbindung, application_name synapse-<prozess>-listen, KEIN Pool-Platz), LISTEN auf alle
 *   SSE-Kanaele, prozessinterne Verteilung an die Abonnenten (je Abo nur seine Kanaele). Filter (Projekt, netzwerk, daten_schalter)
 *   und Buendelung bleiben je Stream in der Route. Der Client entsteht beim ersten Abo und endet mit dem letzten.
 *   Abriss (error/end): Neuverbindung mit Backoff 1 s .. 30 s; danach bekommt jedes Abo einmal neuVerbunden() (Route: netzwerk_bereit,
 *   die Web-UI gleicht per laden() ab), weil verpasste Benachrichtigungen nicht nachweisbar sind.
 * SCHALTER: Produkt-Schalter sse_gemeinsamer_listen (NUR global gelesen, Standard AUS, nur ausdruecklich, bis zur Abnahme nicht
 *   freigegeben). AUS = Bestand (je Stream eine Pool-Verbindung). intern-Schalter sse_gemeinsamer_listen (modus freigegeben)
 *   ueberschreibt befristet. Gelesen wird je NEUEM Stream; offene Streams behalten ihren Weg.
 * DEBUG: intern(action:'status') quellen.sse_listen {schalter-unabhaengig: offen, je_projekt, netzwerk, aeltester_seit, alt_weg_offen,
 *   listen_client {verbunden, seit, neuverbindungen, verbindungsfehler, letzter_fehler}, benachrichtigungen, zugestellt, zustellfehler}.
 */
import { setTimeout, clearTimeout } from 'node:timers';
import type { Client, Notification } from 'pg';
import { verbindeListenClient, leseProfilProduktSchalter, internToolAktiv, getPool, registriereInternQuelle } from '@synapse/core';

export const SSE_LISTEN_FUNKTION = 'sse_gemeinsamer_listen' as const;
export const SSE_KANAELE = ['synapse_specialist_status_change', 'synapse_channel', 'synapse_tool_activity'] as const;
export type SseNachricht = { channel: string; payload?: string };

interface Abo {
  id: number; project: string; netzwerk: boolean; kanaele: ReadonlySet<string>; seit: number;
  zustellen: (m: SseNachricht) => void; neuVerbunden?: () => void; zugestellt: number;
}

const abos = new Map<number, Abo>();
let naechsteId = 1;
let client: Client | null = null;
let verbindet: Promise<void> | null = null;
let warVerbunden = false;
let neuversuchMs = 1_000;
let neuversuchTimer: ReturnType<typeof setTimeout> | null = null;
const mess = {
  verbunden_seit: null as string | null, neuverbindungen: 0, verbindungsfehler: 0, letzter_fehler: null as string | null,
  letzter_fehler_am: null as string | null, benachrichtigungen: 0, zugestellt: 0, zustellfehler: 0, abos_gesamt: 0, abos_beendet: 0,
  alt_weg_offen: 0,
};

/** Wirksamer Stand: intern (befristet, nur mit intern-Tool) > Produkt-Schalter global > Standard AUS. Lesefehler = AUS. */
export async function sseGemeinsamerListenSchalter(): Promise<{ aktiv: boolean; quelle: string; letzter_fehler: string | null; bis: string | null }> {
  const p = await leseProfilProduktSchalter(SSE_LISTEN_FUNKTION, null).catch(() => null);
  const basis = { aktiv: !!p && p.aktiv && !p.letzter_fehler, quelle: String(p?.quelle ?? 'fehler'),
    letzter_fehler: p?.letzter_fehler ?? (p ? null : 'nicht_lesbar'), bis: null as string | null };
  if (!internToolAktiv()) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: "SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND (bis IS NULL OR bis>NOW())",
      values: [SSE_LISTEN_FUNKTION], query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    return z ? { aktiv: z.aktiv, quelle: 'intern', letzter_fehler: null, bis: z.bis?.toISOString() ?? null } : basis;
  } catch {
    return { ...basis, letzter_fehler: 'intern_nicht_lesbar' };
  }
}

function verteile(n: Notification): void {
  mess.benachrichtigungen++;
  for (const a of [...abos.values()]) {
    if (!a.kanaele.has(n.channel)) continue;
    try { a.zustellen({ channel: n.channel, payload: n.payload }); a.zugestellt++; mess.zugestellt++; }
    catch { mess.zustellfehler++; /* ein kaputter Stream nimmt die anderen nicht mit */ }
  }
}

function planeNeuverbindung(): void {
  if (neuversuchTimer || !abos.size) return;
  const ms = neuversuchMs;
  neuversuchMs = Math.min(neuversuchMs * 2, 30_000);
  neuversuchTimer = setTimeout(() => { neuversuchTimer = null; stelleListenerSicher().catch(() => undefined); }, ms);
  neuversuchTimer.unref?.();
}

function verbindungWeg(c: Client, grund: string): void {
  if (client !== c) return;
  client = null;
  mess.verbunden_seit = null;
  mess.letzter_fehler = grund;
  mess.letzter_fehler_am = new Date().toISOString();
  c.end().catch(() => undefined);
  planeNeuverbindung();
}

async function stelleListenerSicher(): Promise<void> {
  if (client) return;
  if (verbindet) return verbindet;
  verbindet = (async () => {
    let c: Client | null = null;
    try {
      c = await verbindeListenClient();
      const cc = c;
      cc.on('notification', verteile);
      cc.on('error', (e: Error) => verbindungWeg(cc, 'LISTEN: ' + e.message));
      cc.on('end', () => verbindungWeg(cc, 'LISTEN: Verbindung beendet'));
      for (const k of SSE_KANAELE) await cc.query('LISTEN ' + k);
      if (!abos.size) { await cc.end().catch(() => undefined); return; }
      client = cc;
      mess.verbunden_seit = new Date().toISOString();
      neuversuchMs = 1_000;
      if (warVerbunden) {
        mess.neuverbindungen++;
        for (const a of [...abos.values()]) { try { a.neuVerbunden?.(); } catch { /* Stream weg */ } }
      }
      warVerbunden = true;
    } catch (e) {
      mess.verbindungsfehler++;
      mess.letzter_fehler = 'LISTEN-Aufbau: ' + (e instanceof Error ? e.message : String(e));
      mess.letzter_fehler_am = new Date().toISOString();
      if (c && client !== c) await c.end().catch(() => undefined);
      planeNeuverbindung();
      throw e;
    } finally {
      verbindet = null;
    }
  })();
  return verbindet;
}

function gibListenerFrei(): void {
  if (abos.size) return;
  if (neuversuchTimer) { clearTimeout(neuversuchTimer); neuversuchTimer = null; }
  neuversuchMs = 1_000;
  warVerbunden = false;
  const c = client;
  client = null;
  mess.verbunden_seit = null;
  if (c) c.end().catch(() => undefined);
}

/**
 * Stream anmelden. Wartet, bis der gemeinsame Client hoert; scheitert der Aufbau, ist das Abo wieder weg und der Fehler geht an die
 * Route (Antwort wie bisher bei SSE-Initialisierungsfehler, EventSource verbindet nach retry neu). Rueckgabe: idempotentes Abmelden.
 */
export async function abonniereSseKanaele(
  o: { project: string; netzwerk: boolean; kanaele: readonly string[] },
  zustellen: (m: SseNachricht) => void, neuVerbunden?: () => void,
): Promise<() => void> {
  const id = naechsteId++;
  abos.set(id, { id, project: o.project, netzwerk: o.netzwerk, kanaele: new Set(o.kanaele), seit: Date.now(), zustellen, neuVerbunden, zugestellt: 0 });
  mess.abos_gesamt++;
  let offen = true;
  const abmelden = () => {
    if (!offen) return;
    offen = false;
    if (abos.delete(id)) mess.abos_beendet++;
    gibListenerFrei();
  };
  try { await stelleListenerSicher(); }
  catch (e) { abmelden(); throw e; }
  return abmelden;
}

/** Bestand (Schalter AUS): Streams mit eigener Pool-Verbindung mitzaehlen, damit der Debug beide Wege zeigt. */
export function zaehleAltStream(d: 1 | -1): void {
  mess.alt_weg_offen = Math.max(0, mess.alt_weg_offen + d);
}

export function sseListenZustand() {
  const jetzt = Date.now();
  const je_projekt: Record<string, number> = {};
  let netzwerk = 0, aeltester: number | null = null;
  for (const a of abos.values()) {
    je_projekt[a.project] = (je_projekt[a.project] ?? 0) + 1;
    if (a.netzwerk) netzwerk++;
    if (aeltester === null || a.seit < aeltester) aeltester = a.seit;
  }
  return {
    funktion: SSE_LISTEN_FUNKTION, offen: abos.size, je_projekt, netzwerk,
    aeltester_seit: aeltester === null ? null : new Date(aeltester).toISOString(),
    aeltester_alter_s: aeltester === null ? null : Math.round((jetzt - aeltester) / 1000),
    alt_weg_offen: mess.alt_weg_offen, kanaele: [...SSE_KANAELE],
    listen_client: {
      verbunden: client !== null, verbindet: verbindet !== null, seit: mess.verbunden_seit, neuverbindungen: mess.neuverbindungen,
      verbindungsfehler: mess.verbindungsfehler, neuversuch_geplant: neuversuchTimer !== null, letzter_fehler: mess.letzter_fehler,
      letzter_fehler_am: mess.letzter_fehler_am,
    },
    benachrichtigungen: mess.benachrichtigungen, zugestellt: mess.zugestellt, zustellfehler: mess.zustellfehler,
    abos_gesamt: mess.abos_gesamt, abos_beendet: mess.abos_beendet,
  };
}

registriereInternQuelle('sse_listen', sseListenZustand);
