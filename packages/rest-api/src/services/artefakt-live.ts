/**
 * P22-T154 Etappe 5 (R5): Live-Artefakte. Gezeichnet wird nur, solange jemand zusieht (offener SSE-Strom eines Betrachters);
 * sonst beim naechsten Anzeigen (renderArtefakt anlass 'anzeigen'). EIN LISTEN-Client fuer alle Abos (erster Abonnent baut ihn
 * auf, der letzte gibt ihn frei) auf synapse_plan, synapse_channel, synapse_event, synapse_tool_activity. Je (Artefakt, Projekt):
 * Ereignisse buendel_ms sammeln, hoechstens alle drossel_ms neu zeichnen (PG-Einstellungen). Neue Revision nur bei geaenderten
 * Daten (core renderArtefakt, daten_hash); dann geht 'artefakt' an alle Betrachter dieses Schluessels, die Verlaufszeilen
 * (Koordinator-Fenster) aktualisiert core selbst. Schalter artefakt_vorlagen_live AUS -> 'aus' und kein Neuzeichnen.
 * P22-T169 (User 25.10.2026, thought 403c12bd): keine Aenderung geht mehr verloren. Frueher verwarf core eine Live-Renderung als
 *   'gedrosselt', wenn kurz vorher jemand angezeigt/neu gezeichnet hatte oder der Zeitplan ein paar ms vor Ablauf der Drossel
 *   feuerte (gerendert_am liegt nach dem Startzeitpunkt) - das Ereignis war dann weg (Befund: plan(verschieben) nicht live).
 *   Jetzt: 'gedrosselt' wird bis drossel_bis nachgeholt, die Drossel rechnet ab gerendert_am, und die Anlaesse (Kanal, op, id)
 *   je Schluessel gehen als ausloeser ins Render-Debug, kurz als anlass ins SSE-Ereignis und in artefaktLiveStatus().
 *   LISTEN-Verbindung zu ohne Fehler ('end') -> neu aufbauen; nach jedem Neuaufbau zeichnet jeder Schluessel einmal nach.
 * DEBUG: artefaktLiveStatus() {abonnenten, schluessel, listener, geplant, wartende_anlaesse, benachrichtigungen, renderungen,
 *   gedrosselt, nachgeholt, neu_verbunden, letzter_fehler, letzte_renderungen[{schluessel, um, ergebnis, revision, ausloeser}]}.
 */
import type { Client, Notification } from 'pg';
import {
  verbindeListenClient, ladeVorlagenZeile, kanaeleFuerQuellen, renderArtefakt, artefaktVorlagenSchalter, leseArtefaktVorlagenEinstellungen,
  ARTEFAKT_VORLAGEN_LIVE_FUNKTION, ArtefaktVorlagenFehler, type ArtefaktBetrachter, type ArtefaktRenderErgebnis,
} from '@synapse/core';
import './artefakt-quellen-api.js';

export type LiveSende = (event: string, data: Record<string, unknown>) => void;
interface Abo { id: number; artefakt_id: string; project: string; betrachter: ArtefaktBetrachter; kanaele: string[]; sende: LiveSende }
/** P22-T169: ein NOTIFY, das einen Schluessel betrifft (Payload-Felder op/id, sofern vorhanden). */
interface Anlass { kanal: string; op: string | null; id: string | null; um: string }
type RenderErgebnisArt = 'neu' | 'gleiche_daten' | 'gedrosselt' | 'fehler' | 'aus';

export const ARTEFAKT_LIVE_KANAELE = ['synapse_plan', 'synapse_channel', 'synapse_event', 'synapse_tool_activity'] as const;
/** Zeitplan und gerendert_am liegen ein paar ms auseinander; so viel spaeter zeichnen, damit core nicht 'gedrosselt' meldet. */
const DROSSEL_RESERVE_MS = 50;
/** Anlaesse je Schluessel bis zur naechsten Renderung (die aeltesten fallen weg, gezaehlt wird weiter). */
const ANLAESSE_MAX = 20;
const LETZTE_RENDERUNGEN_MAX = 10;
const abos = new Map<number, Abo>();
const zeitplan = new Map<string, NodeJS.Timeout>();
const letzte = new Map<string, number>();
const anlaesse = new Map<string, { liste: Anlass[]; anzahl: number }>();
const letzteRenderungen = new Map<string, { artefakt_id: string; project: string; um: string; ergebnis: RenderErgebnisArt; revision: number | null;
  ausloeser: Record<string, unknown> | null; hinweis?: string }>();
let naechsteId = 1;
let client: Client | null = null;
let verbindet: Promise<void> | null = null;
let warVerbunden = false;
const mess = { benachrichtigungen: 0, renderungen: 0, gedrosselt: 0, nachgeholt: 0, neu_verbunden: 0, letzter_fehler: null as string | null };

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

function merkeAnlass(k: string, a: Anlass): void {
  const s = anlaesse.get(k) ?? { liste: [], anzahl: 0 };
  s.liste.push(a);
  if (s.liste.length > ANLAESSE_MAX) s.liste.shift();
  s.anzahl++;
  anlaesse.set(k, s);
}

/** P22-T169: gesammelte Anlaesse eines Schluessels als Debug-Objekt (null = keiner, z. B. erster Aufbau). Rein. */
export function ausloeserVon(s: { liste: Anlass[]; anzahl: number } | undefined): Record<string, unknown> | null {
  if (!s || !s.anzahl) return null;
  return {
    anzahl: s.anzahl,
    kanaele: [...new Set(s.liste.map((a) => a.kanal))],
    ops: [...new Set(s.liste.map((a) => a.op).filter((x): x is string => !!x))],
    ids: [...new Set(s.liste.map((a) => a.id).filter((x): x is string => !!x))].slice(0, 10),
    erstes_um: s.liste[0]?.um ?? null,
    letztes_um: s.liste[s.liste.length - 1]?.um ?? null,
  };
}

function merkeRenderung(k: string, abo: Abo, ergebnis: RenderErgebnisArt, revision: number | null, ausloeser: Record<string, unknown> | null, hinweis?: string): void {
  letzteRenderungen.delete(k);
  letzteRenderungen.set(k, { artefakt_id: abo.artefakt_id, project: abo.project, um: new Date().toISOString(), ergebnis, revision, ausloeser, ...(hinweis ? { hinweis } : {}) });
  while (letzteRenderungen.size > LETZTE_RENDERUNGEN_MAX) letzteRenderungen.delete(letzteRenderungen.keys().next().value as string);
}

async function zeichne(k: string): Promise<void> {
  const abo = [...abos.values()].find((a) => schluessel(a) === k);
  if (!abo) return;
  const gesammelt = anlaesse.get(k);
  anlaesse.delete(k);
  const ausloeser = ausloeserVon(gesammelt);
  const live = await artefaktVorlagenSchalter(ARTEFAKT_VORLAGEN_LIVE_FUNKTION);
  if (!live.aktiv) { merkeRenderung(k, abo, 'aus', null, ausloeser); anAlle(k, 'aus', { schalter: live }); return; }
  letzte.set(k, Date.now());
  try {
    const r = await renderArtefakt(abo.artefakt_id, { project: abo.project, betrachter: abo.betrachter, anlass: 'live', von: 'live', ausloeser });
    mess.renderungen++;
    if (r.neu) {
      // Drossel ab dem gespeicherten gerendert_am rechnen (nicht ab dem Start), sonst feuert der naechste Zeitplan zu frueh.
      const am = Date.parse(r.gerendert_am);
      letzte.set(k, Number.isFinite(am) ? am : Date.now());
      merkeRenderung(k, abo, 'neu', r.revision, ausloeser);
      anAlle(k, 'artefakt', { ...liveDaten(r), ...(ausloeser ? { anlass: { anzahl: ausloeser.anzahl, kanaele: ausloeser.kanaele, ops: ausloeser.ops } } : {}) });
      return;
    }
    if (r.hinweis === 'gedrosselt') {
      // P22-T169: eine juengere Renderung (Anzeigen, Neu zeichnen, frueher Zeitplan) sperrt noch -> Anlaesse behalten und nachholen.
      if (gesammelt) {
        const s = anlaesse.get(k);
        anlaesse.set(k, s ? { liste: [...gesammelt.liste, ...s.liste].slice(-ANLAESSE_MAX), anzahl: gesammelt.anzahl + s.anzahl } : gesammelt);
      }
      const bis = Date.parse(String((r.debug as Record<string, unknown> | undefined)?.drossel_bis ?? ''));
      mess.nachgeholt++;
      merkeRenderung(k, abo, 'gedrosselt', r.revision, ausloeser, 'nachgeholt bis ' + (Number.isFinite(bis) ? new Date(bis).toISOString() : 'Drossel'));
      void plane(k, Number.isFinite(bis) ? bis - Date.now() + DROSSEL_RESERVE_MS : undefined);
      return;
    }
    merkeRenderung(k, abo, 'gleiche_daten', r.revision, ausloeser);
  } catch (error) {
    mess.letzter_fehler = error instanceof Error ? error.message : String(error);
    merkeRenderung(k, abo, 'fehler', null, ausloeser, mess.letzter_fehler);
    anAlle(k, 'fehler', { code: error instanceof ArtefaktVorlagenFehler ? error.code : 'render_fehler', message: mess.letzter_fehler });
  }
}

/** Zeitplan je Schluessel. mindestMs: feste Wartezeit (Nachholen bis drossel_bis), sonst Buendel bzw. Rest der Drossel. */
async function plane(k: string, mindestMs?: number): Promise<void> {
  if (zeitplan.has(k)) return;
  const w = (await leseArtefaktVorlagenEinstellungen()).werte;
  if (zeitplan.has(k)) return;
  const rest = letzte.has(k) ? w.drossel_ms - (Date.now() - (letzte.get(k) ?? 0)) + DROSSEL_RESERVE_MS : 0;
  const warte = Math.max(w.buendel_ms, mindestMs ?? rest);
  if (warte > w.buendel_ms) mess.gedrosselt++;
  zeitplan.set(k, setTimeout(() => { zeitplan.delete(k); void zeichne(k); }, warte));
}

/** NOTIFY -> betroffene Schluessel (gleiches Projekt, Quelle haengt an diesem Kanal) planen. Exportiert fuer Tests. */
export function verarbeiteBenachrichtigung(kanal: string, payload: string | undefined): string[] {
  mess.benachrichtigungen++;
  let project = '';
  let op: string | null = null;
  let id: string | null = null;
  try {
    const p = JSON.parse(payload ?? '{}') as { project?: unknown; op?: unknown; id?: unknown };
    project = typeof p.project === 'string' ? p.project : '';
    op = typeof p.op === 'string' ? p.op : null;
    id = typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id) : null;
  } catch { /* kein JSON */ }
  const betroffen = new Set<string>();
  for (const a of abos.values()) if (a.project === project && a.kanaele.includes(kanal)) betroffen.add(schluessel(a));
  const um = new Date().toISOString();
  for (const k of betroffen) { merkeAnlass(k, { kanal, op, id, um }); void plane(k); }
  return [...betroffen];
}

/** Nach einem Neuaufbau des LISTEN-Clients: verpasste Ereignisse sind nicht nachweisbar -> jeder Schluessel zeichnet einmal nach. */
function zeichneNachNeuaufbau(): void {
  mess.neu_verbunden++;
  const um = new Date().toISOString();
  const schon = new Set<string>();
  for (const a of abos.values()) {
    const k = schluessel(a);
    if (!a.kanaele.length || schon.has(k)) continue;
    schon.add(k);
    merkeAnlass(k, { kanal: 'listen', op: 'neu_verbunden', id: null, um });
    void plane(k);
  }
}

function verbindungWeg(c: Client, grund: string): void {
  if (client !== c) return;
  mess.letzter_fehler = grund;
  client = null;
  c.end().catch(() => undefined);
  if (abos.size) setTimeout(() => { void stelleListenerSicher(); }, 2000);
}

async function stelleListenerSicher(): Promise<void> {
  if (client) return;
  if (verbindet) return verbindet;
  verbindet = (async () => {
    try {
      const c = await verbindeListenClient();
      for (const k of ARTEFAKT_LIVE_KANAELE) await c.query('LISTEN ' + k);
      c.on('notification', (n: Notification) => { verarbeiteBenachrichtigung(n.channel, n.payload); });
      c.on('error', (error: Error) => verbindungWeg(c, 'LISTEN: ' + error.message));
      // P22-T169: auch eine still beendete Verbindung (ohne error) neu aufbauen, sonst kaeme kein Ereignis mehr an.
      c.on('end', () => verbindungWeg(c, 'LISTEN: Verbindung beendet'));
      client = c;
      if (warVerbunden) zeichneNachNeuaufbau();
      warVerbunden = true;
    } catch (error) {
      mess.letzter_fehler = 'LISTEN-Aufbau: ' + (error instanceof Error ? error.message : String(error));
      if (abos.size) setTimeout(() => { void stelleListenerSicher(); }, 2000);
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
  warVerbunden = false;
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
        anlaesse.delete(schluessel(a));
      }
      gibListenerFrei();
    },
  };
}

export function artefaktLiveStatus(): Record<string, unknown> {
  return {
    abonnenten: abos.size, schluessel: new Set([...abos.values()].map(schluessel)).size, listener: !!client, geplant: zeitplan.size,
    wartende_anlaesse: [...anlaesse.values()].reduce((n, s) => n + s.anzahl, 0), ...mess,
    letzte_renderungen: [...letzteRenderungen.entries()].reverse().map(([k, v]) => ({ schluessel: k.replace('\u0000', ' @ '), ...v })),
  };
}
