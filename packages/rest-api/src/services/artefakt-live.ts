/**
 * P22-T154 Etappe 5 (R5): Live-Artefakte. Gezeichnet wird nur, solange jemand zusieht (offener SSE-Strom eines Betrachters);
 * sonst beim naechsten Anzeigen (renderArtefakt anlass 'anzeigen'). EIN LISTEN-Client fuer alle Abos (erster Abonnent baut ihn
 * auf, der letzte gibt ihn frei) auf synapse_plan, synapse_channel, synapse_event, synapse_tool_activity. Je (Artefakt, Projekt):
 * Ereignisse buendel_ms sammeln, hoechstens alle drossel_ms neu zeichnen (PG-Einstellungen). Neue Revision nur bei geaenderten
 * Daten (core renderArtefakt, daten_hash); dann geht 'artefakt' an alle Betrachter dieses Schluessels, die Verlaufszeilen
 * (Koordinator-Fenster) aktualisiert core selbst. Schalter artefakt_vorlagen_live AUS -> 'aus' und kein Neuzeichnen.
 * DEBUG: artefaktLiveStatus() {abonnenten, schluessel, listener, benachrichtigungen, renderungen, gedrosselt, letzter_fehler}.
 */
import type { Client, Notification } from 'pg';
import {
  verbindeListenClient, ladeVorlagenZeile, kanaeleFuerQuellen, renderArtefakt, artefaktVorlagenSchalter, leseArtefaktVorlagenEinstellungen,
  ARTEFAKT_VORLAGEN_LIVE_FUNKTION, ArtefaktVorlagenFehler, type ArtefaktBetrachter, type ArtefaktRenderErgebnis,
} from '@synapse/core';
import './artefakt-quellen-api.js';

export type LiveSende = (event: string, data: Record<string, unknown>) => void;
interface Abo { id: number; artefakt_id: string; project: string; betrachter: ArtefaktBetrachter; kanaele: string[]; sende: LiveSende }

export const ARTEFAKT_LIVE_KANAELE = ['synapse_plan', 'synapse_channel', 'synapse_event', 'synapse_tool_activity'] as const;
const abos = new Map<number, Abo>();
const zeitplan = new Map<string, NodeJS.Timeout>();
const letzte = new Map<string, number>();
let naechsteId = 1;
let client: Client | null = null;
let verbindet: Promise<void> | null = null;
const mess = { benachrichtigungen: 0, renderungen: 0, gedrosselt: 0, letzter_fehler: null as string | null };

const schluessel = (a: { artefakt_id: string; project: string }) => a.artefakt_id + '\u0000' + a.project;

/** Fuer SSE und Verlauf: die Renderung ohne Debug-Ballast. */
export function liveDaten(r: ArtefaktRenderErgebnis): Record<string, unknown> {
  return { artefakt_id: r.artefakt_id, project: r.project, revision: r.revision, html: r.html, gerendert_am: r.gerendert_am, modus: r.modus,
    ...(r.titel ? { titel: r.titel } : {}), ...(r.fehler.length ? { fehler: r.fehler } : {}) };
}

function anAlle(k: string, event: string, data: Record<string, unknown>): void {
  for (const a of abos.values()) {
    if (schluessel(a) !== k) continue;
    try { a.sende(event, data); } catch { /* eine kaputte Verbindung darf die anderen nicht mitnehmen */ }
  }
}

async function zeichne(k: string): Promise<void> {
  const abo = [...abos.values()].find((a) => schluessel(a) === k);
  if (!abo) return;
  const live = await artefaktVorlagenSchalter(ARTEFAKT_VORLAGEN_LIVE_FUNKTION);
  if (!live.aktiv) { anAlle(k, 'aus', { schalter: live }); return; }
  letzte.set(k, Date.now());
  try {
    const r = await renderArtefakt(abo.artefakt_id, { project: abo.project, betrachter: abo.betrachter, anlass: 'live', von: 'live' });
    mess.renderungen++;
    if (r.neu) anAlle(k, 'artefakt', liveDaten(r));
  } catch (error) {
    mess.letzter_fehler = error instanceof Error ? error.message : String(error);
    anAlle(k, 'fehler', { code: error instanceof ArtefaktVorlagenFehler ? error.code : 'render_fehler', message: mess.letzter_fehler });
  }
}

async function plane(k: string): Promise<void> {
  if (zeitplan.has(k)) return;
  const w = (await leseArtefaktVorlagenEinstellungen()).werte;
  if (zeitplan.has(k)) return;
  const seit = Date.now() - (letzte.get(k) ?? 0);
  const warte = Math.max(w.buendel_ms, w.drossel_ms - seit);
  if (warte > w.buendel_ms) mess.gedrosselt++;
  zeitplan.set(k, setTimeout(() => { zeitplan.delete(k); void zeichne(k); }, warte));
}

/** NOTIFY -> betroffene Schluessel (gleiches Projekt, Quelle haengt an diesem Kanal) planen. Exportiert fuer Tests. */
export function verarbeiteBenachrichtigung(kanal: string, payload: string | undefined): string[] {
  mess.benachrichtigungen++;
  let project = '';
  try { const p = JSON.parse(payload ?? '{}') as { project?: unknown }; project = typeof p.project === 'string' ? p.project : ''; } catch { /* kein JSON */ }
  const betroffen = new Set<string>();
  for (const a of abos.values()) if (a.project === project && a.kanaele.includes(kanal)) betroffen.add(schluessel(a));
  for (const k of betroffen) void plane(k);
  return [...betroffen];
}

async function stelleListenerSicher(): Promise<void> {
  if (client) return;
  if (verbindet) return verbindet;
  verbindet = (async () => {
    try {
      const c = await verbindeListenClient();
      for (const k of ARTEFAKT_LIVE_KANAELE) await c.query('LISTEN ' + k);
      c.on('notification', (n: Notification) => { verarbeiteBenachrichtigung(n.channel, n.payload); });
      c.on('error', (error: Error) => {
        mess.letzter_fehler = 'LISTEN: ' + error.message;
        client = null;
        c.end().catch(() => undefined);
        if (abos.size) setTimeout(() => { void stelleListenerSicher(); }, 2000);
      });
      client = c;
    } catch (error) {
      mess.letzter_fehler = 'LISTEN-Aufbau: ' + (error instanceof Error ? error.message : String(error));
    } finally {
      verbindet = null;
    }
  })();
  return verbindet;
}

function gibListenerFrei(): void {
  if (abos.size || !client) return;
  const c = client;
  client = null;
  c.end().catch(() => undefined);
}

/**
 * Betrachter anmelden. Nur Artefakte mit Vorlage und modus 'live' reagieren auf Kanaele (sonst leeres kanaele, keine Updates).
 * Rueckgabe: Abmelden + die Kanaele, auf die dieses Artefakt hoert.
 */
export async function abonniereArtefaktLive(artefakt_id: string, project: string, betrachter: ArtefaktBetrachter, sende: LiveSende): Promise<{ abmelden: () => void; kanaele: string[] }> {
  const z = await ladeVorlagenZeile(artefakt_id);
  const kanaele = z?.vorlage && z.modus === 'live' && z.quellen ? kanaeleFuerQuellen(z.quellen) : [];
  const id = naechsteId++;
  abos.set(id, { id, artefakt_id, project, betrachter, kanaele, sende });
  if (kanaele.length) await stelleListenerSicher();
  return {
    kanaele,
    abmelden: () => {
      const a = abos.get(id);
      abos.delete(id);
      if (a && ![...abos.values()].some((x) => schluessel(x) === schluessel(a))) {
        const t = zeitplan.get(schluessel(a));
        if (t) clearTimeout(t);
        zeitplan.delete(schluessel(a));
      }
      gibListenerFrei();
    },
  };
}

export function artefaktLiveStatus(): Record<string, unknown> {
  return { abonnenten: abos.size, schluessel: new Set([...abos.values()].map(schluessel)).size, listener: !!client, geplant: zeitplan.size, ...mess };
}
