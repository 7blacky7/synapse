/**
 * P22-T166 (User 25.10.2026, Entwurf 407305f5, GO F1-F9): nur lesende DATEN-BRUECKE fuer Artefakte mit Skript.
 *
 * WO: Das Skript eines Artefakts laeuft NUR in den Top-Artefakten der Web-UI, in einem iframe mit sandbox="allow-scripts" (ohne
 *   allow-same-origin, eigener undurchsichtiger Ursprung) und strenger CSP (connect-src 'none'). Daten bekommt es nur ueber postMessage
 *   an den Rahmen (web-ui kios/SkriptRahmen.tsx), der jede Anfrage an DIESEN Dienst weiterreicht (REST POST
 *   /api/main-agent/artefakte/:id/bruecke). Chatfenster und Persoenliche Artefakte bleiben bereinigt (sanitize.ts, kein Skript).
 * WAS: op 'quelle' = ein Vertrag aus dem festen Quellenkatalog der Vorlagen (pruefeQuellen/ladeQuellen: typisierte args, project nie in
 *   args, Frist quelle_timeout_ms, Kappung quelle_max_bytes); op 'lese' = Klartext wie das Lesefenster fuer task, plan, thought, memory
 *   (Lesefunktion reicht die API herein). KEIN Schreiben.
 * RECHTE (Projekt-Klammer, F4): Das Projekt setzt der Rahmen (Render-Projekt), nie das Skript. Erlaubt nur, wenn der Betrachter das
 *   Projekt lesen darf (darfProjekt) UND der Urheber des Artefakts: Main (Main-Session bzw. Identitaet mit Rolle main) alle Projekte,
 *   Ausweis nur das Projekt seiner Identitaet, sonst keins. Grund: Ein Skript kann sich selbst wegnavigieren (Restkanal fuer Datenabfluss,
 *   kein Sandbox-Flag verhindert das). So erreicht es nie mehr, als sein Urheber ohnehin per MCP lesen darf.
 * SCHALTER: artefakt_skripte (global, Standard AUS, nur ausdruecklich). AUS -> jede Anfrage schalter_aus (409), die Web-UI zeigt bereinigt.
 * DEBUG: skriptBrueckeStatus() = Aufrufe, ok, abgelehnt je Grund, die letzten 20 Aufrufe (ohne Daten).
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import {
  ArtefaktVorlagenFehler, darfProjekt, ladeQuellen, ladeVorlagenZeile, leseArtefaktVorlagenEinstellungen, pruefeQuellen,
  type ArtefaktBetrachter, type VorlagenZeile,
} from './artefakt-vorlagen.js';

export const ARTEFAKT_SKRIPTE_FUNKTION = 'artefakt_skripte' as const;
export const SKRIPT_BRUECKE_OPS = ['quelle', 'lese'] as const;
export type SkriptBrueckeOp = typeof SKRIPT_BRUECKE_OPS[number];
/** F3: Arten fuer op 'lese' (doc/event/nachricht/chat/asset spaeter auf Wunsch). */
export const SKRIPT_LESE_ARTEN = ['task', 'plan', 'thought', 'memory'] as const;
export type SkriptLeseArt = typeof SKRIPT_LESE_ARTEN[number];
/** Groesse einer Anfrage (JSON) wie im Rahmen. */
export const SKRIPT_ANFRAGE_MAX_BYTES = 4096;
const SKRIPT_MUSTER = /<script[\s>/]/i;
const REF_MAX = 300;

export class ArtefaktSkriptFehler extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const fehler = (code: string, message: string, status = 400): never => { throw new ArtefaktSkriptFehler(code, message, status); };
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Wirksamer Stand (global); Lesefehler = AUS mit letzter_fehler. Wirft nie. */
export async function artefaktSkripteSchalter(): Promise<{ aktiv: boolean; quelle: string; letzter_fehler: string | null }> {
  try {
    const s = await leseProfilProduktSchalter(ARTEFAKT_SKRIPTE_FUNKTION, null);
    return { aktiv: s.aktiv && !s.letzter_fehler, quelle: s.quelle, letzter_fehler: s.letzter_fehler };
  } catch (error) {
    return { aktiv: false, quelle: 'standard', letzter_fehler: 'schalter_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

/** Enthaelt das HTML (bzw. die Vorlage) ein <script>? Rein. Gleiches Muster wie die Web-UI (kios/skript-rahmen-logik.ts). */
export function enthaeltSkript(html: unknown): boolean {
  return typeof html === 'string' && SKRIPT_MUSTER.test(html);
}

// ---------------------------------------------------------------------------------------------
// Urheber-Klammer
// ---------------------------------------------------------------------------------------------
export type SkriptUrheber =
  | { art: 'main'; quelle: 'session' | 'identitaet' }
  | { art: 'ausweis'; identity_id: string; project: string }
  | { art: 'unbekannt'; grund: string };

/** Urheber eines Artefakts: Main-Session -> main; Identitaet mit Rolle main -> main; sonst Ausweis mit Projekt der Identitaet. */
export async function skriptUrheber(z: Pick<VorlagenZeile, 'session_id' | 'created_by_identity_id'>): Promise<SkriptUrheber> {
  if (z.session_id) return { art: 'main', quelle: 'session' };
  if (!z.created_by_identity_id) return { art: 'unbekannt', grund: 'weder Main-Session noch Urheber-Identitaet' };
  const r = await getPool().query<{ project: string; rolle: string }>('SELECT project, rolle FROM agent_identitaeten WHERE id = $1', [z.created_by_identity_id]);
  const i = r.rows[0];
  if (!i) return { art: 'unbekannt', grund: 'Urheber-Identitaet ' + z.created_by_identity_id + ' nicht gefunden' };
  if (i.rolle === 'main') return { art: 'main', quelle: 'identitaet' };
  return { art: 'ausweis', identity_id: z.created_by_identity_id, project: i.project };
}

/** Darf der Urheber das Projekt lesen? Rein. */
export function urheberDarfProjekt(u: SkriptUrheber, project: string): boolean {
  return u.art === 'main' || (u.art === 'ausweis' && u.project === project);
}

// ---------------------------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------------------------
interface Eintrag { zeit: string; artefakt_id: string | null; op: string; ergebnis: string; ms: number; bytes?: number }
const zaehler = { aufrufe: 0, ok: 0, abgelehnt: {} as Record<string, number>, letzte: [] as Eintrag[] };

function merke(e: Eintrag): void {
  zaehler.aufrufe++;
  if (e.ergebnis === 'ok') zaehler.ok++;
  else zaehler.abgelehnt[e.ergebnis] = (zaehler.abgelehnt[e.ergebnis] ?? 0) + 1;
  zaehler.letzte.unshift(e);
  if (zaehler.letzte.length > 20) zaehler.letzte.length = 20;
}

/** Debug-Stand der Bruecke (ohne Daten). */
export function skriptBrueckeStatus(): { aufrufe: number; ok: number; abgelehnt: Record<string, number>; letzte: Eintrag[] } {
  return { aufrufe: zaehler.aufrufe, ok: zaehler.ok, abgelehnt: { ...zaehler.abgelehnt }, letzte: zaehler.letzte.map((e) => ({ ...e })) };
}

/** Nur fuer Tests. */
export function setzeSkriptBrueckeStatusZurueck(): void {
  zaehler.aufrufe = 0; zaehler.ok = 0; zaehler.abgelehnt = {}; zaehler.letzte = [];
}

// ---------------------------------------------------------------------------------------------
// Bruecke
// ---------------------------------------------------------------------------------------------
export interface SkriptBrueckeKontext {
  betrachter: ArtefaktBetrachter;
  /** Lesefenster-Weg (rest-api services/verweise.ts leseVerweis); null = nicht gefunden. */
  lese?: (project: string, art: SkriptLeseArt, ref: string) => Promise<unknown | null>;
}
export interface SkriptBrueckeErgebnis {
  op: SkriptBrueckeOp;
  project: string;
  daten: unknown;
  debug: { ms: number; bytes: number; gekappt: boolean; vertrag?: string; art?: SkriptLeseArt; urheber: SkriptUrheber['art'] };
}

async function mitFrist<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new ArtefaktSkriptFehler('frist', 'Frist ' + ms + ' ms ueberschritten', 504)), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

const bytesVon = (v: unknown): number => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

/**
 * Eine Anfrage des Skripts (ueber den Rahmen). anfrage: {op:'quelle', vertrag, args?, project} | {op:'lese', art, ref, project}.
 * Wirft ArtefaktSkriptFehler (code, status); jede Anfrage wird gezaehlt (ok bzw. Grund).
 */
export async function artefaktSkriptBruecke(idRoh: unknown, anfrage: unknown, k: SkriptBrueckeKontext): Promise<SkriptBrueckeErgebnis> {
  const start = Date.now();
  const id = typeof idRoh === 'string' ? idRoh : null;
  const op = anfrage && typeof anfrage === 'object' && typeof (anfrage as { op?: unknown }).op === 'string' ? String((anfrage as { op: string }).op).slice(0, 20) : '?';
  try {
    const e = await brueckeIntern(id, anfrage, k, start);
    merke({ zeit: new Date().toISOString(), artefakt_id: id, op, ergebnis: 'ok', ms: e.debug.ms, bytes: e.debug.bytes });
    return e;
  } catch (error) {
    const code = error instanceof ArtefaktSkriptFehler ? error.code : 'serverfehler';
    merke({ zeit: new Date().toISOString(), artefakt_id: id, op, ergebnis: code, ms: Date.now() - start });
    throw error;
  }
}

async function brueckeIntern(id: string | null, anfrage: unknown, k: SkriptBrueckeKontext, start: number): Promise<SkriptBrueckeErgebnis> {
  const s = await artefaktSkripteSchalter();
  if (!s.aktiv) fehler('schalter_aus', 'Artefakt-Skripte sind aus (Produkt-Schalter artefakt_skripte)', 409);
  if (!anfrage || typeof anfrage !== 'object' || Array.isArray(anfrage)) fehler('anfrage_ungueltig', 'Anfrage muss ein Objekt sein');
  if (bytesVon(anfrage) > SKRIPT_ANFRAGE_MAX_BYTES) fehler('anfrage_zu_gross', 'Anfrage hoechstens ' + SKRIPT_ANFRAGE_MAX_BYTES + ' Bytes', 413);
  const a = anfrage as Record<string, unknown>;
  const op = a.op;
  if (typeof op !== 'string' || !(SKRIPT_BRUECKE_OPS as readonly string[]).includes(op)) fehler('op_unbekannt', 'op: ' + SKRIPT_BRUECKE_OPS.join(' | ') + ' (nur lesend)');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) fehler('artefakt_unbekannt', 'Artefakt-ID ungueltig', 404);
  const z = await ladeVorlagenZeile(id!);
  if (!z) fehler('artefakt_unbekannt', 'Artefakt ' + id + ' gibt es nicht', 404);
  if (!enthaeltSkript(z!.html) && !enthaeltSkript(z!.vorlage)) fehler('kein_skript', 'Das Artefakt enthaelt kein Skript; die Bruecke gilt nur fuer Skript-Artefakte', 409);
  const project = text(a.project);
  if (!project || project.length > 200) fehler('projekt_fehlt', 'project (Render-Projekt, setzt der Rahmen) fehlt');
  if (!darfProjekt(k.betrachter, project!)) fehler('projekt_fremd', 'Der Betrachter darf das Projekt ' + project + ' nicht lesen', 403);
  const urheber = await skriptUrheber(z!);
  if (!urheberDarfProjekt(urheber, project!)) {
    fehler('urheber_fremd', urheber.art === 'unbekannt'
      ? 'Urheber des Artefakts unbekannt (' + urheber.grund + '): keine Daten'
      : 'Der Urheber (Ausweis, Projekt ' + (urheber as { project: string }).project + ') darf ' + project + ' nicht lesen', 403);
  }
  const w = (await leseArtefaktVorlagenEinstellungen()).werte;

  if (op === 'quelle') {
    let quellen;
    try {
      quellen = pruefeQuellen([{ name: 'daten', vertrag: a.vertrag, args: a.args ?? {} }], 1);
    } catch (error) {
      if (error instanceof ArtefaktVorlagenFehler) fehler(error.code, error.message, 400);
      throw error;
    }
    const geladen = await ladeQuellen(quellen!, project!, w);
    const st = geladen.stand[0];
    if (st.fehler) {
      if (/^Frist /.test(st.fehler)) fehler('frist', st.fehler, 504);
      if (/^Ergebnis groesser/.test(st.fehler)) fehler('zu_gross', st.fehler, 413);
      fehler('quelle_fehler', st.fehler, 502);
    }
    return { op: 'quelle', project: project!, daten: geladen.daten.daten,
      debug: { ms: Date.now() - start, bytes: st.bytes, gekappt: st.gekappt, vertrag: st.vertrag, urheber: urheber.art } };
  }

  const art = a.art;
  if (typeof art !== 'string' || !(SKRIPT_LESE_ARTEN as readonly string[]).includes(art)) fehler('art_gesperrt', 'lese: art ' + SKRIPT_LESE_ARTEN.join(' | '), 403);
  const ref = text(a.ref);
  if (!ref || ref.length > REF_MAX) fehler('ref_ungueltig', 'lese: ref (ID bzw. Name) fehlt oder ist laenger als ' + REF_MAX);
  if (!k.lese) fehler('lese_fehlt', 'Lesefenster-Weg nicht verfuegbar', 500);
  const v = await mitFrist(k.lese!(project!, art as SkriptLeseArt, ref!), w.quelle_timeout_ms);
  if (v === null || v === undefined) fehler('nicht_gefunden', art + ' ' + ref + ' nicht gefunden', 404);
  let daten: unknown = v;
  let bytes = bytesVon(daten);
  let gekappt = false;
  if (bytes > w.quelle_max_bytes) {
    const o = daten as Record<string, unknown>;
    if (o && typeof o === 'object' && typeof o.text === 'string') {
      const uebrig = Math.max(0, w.quelle_max_bytes - (bytes - Buffer.byteLength(o.text, 'utf8')) - 64);
      daten = { ...o, text: Buffer.from(o.text, 'utf8').subarray(0, uebrig).toString('utf8').replace(/�+$/, '') + '…', gekappt: true };
      bytes = bytesVon(daten);
      gekappt = true;
    }
    if (bytes > w.quelle_max_bytes) fehler('zu_gross', 'Ergebnis groesser als ' + w.quelle_max_bytes + ' Bytes', 413);
  }
  return { op: 'lese', project: project!, daten, debug: { ms: Date.now() - start, bytes, gekappt, art: art as SkriptLeseArt, urheber: urheber.art } };
}
