/**
 * P22-T63: Vollstaendiger Verlauf des Hauptagenten geraeteuebergreifend (User 20.10.2026). Vertrag thought 97d9a354, Nachtrag
 * 823715c5. Tabelle hauptagent_verlauf (Schema 124), EINE Lese-/Schreibstelle hier.
 *
 * VOLLSTAENDIG: nichts wird gekuerzt, zusammengefasst oder automatisch geloescht (Zaehlbasis fuer Tokens, Kontext und Uebergabe
 *   beim Wechsel). Nur die ANZEIGE darf einklappen. 'Leeren' blendet nur aus (hauptagent_verlauf_stand.ausgeblendet_bis_id).
 * VERLAUF JE MAIN-IDENTITAET, nicht je Tab/Sitzung (hauptagentIdentitaetsId). Sitzungen ohne Identitaet speichern NICHTS.
 * EINTRAEGE: rolle user|agent|nachricht|ausgabe|system, richtung ein|aus|intern, weg webui|inbox|chat|channel|event|heartbeat|
 *   werkzeug|lauf|wechsel. Stufe 1 schreibt die Web-UI-Zuege (user -> agent); Stufe 2 (Nachtrag A-D) die uebrigen Wege.
 * REIHENFOLGE: id (BIGSERIAL, serverseitig). Je Ausloeser genau eine Antwortzeile (antwort_auf UNIQUE).
 * LIVE: rev = nextval('hauptagent_verlauf_rev') bei jedem Schreiben; Geraete fragen mit seit_rev nach. Ausblenden erhoeht
 *   geleert_rev, damit andere Geraete ihre Anzeige verwerfen.
 * SCHREIBEN WAEHREND DES STROMS: starteVerlaufAntwort sammelt delta/tool/thinking/artifact/usage/runtime im Speicher und
 *   schreibt gedrosselt (VERLAUF_DROSSEL_MS) den ganzen Stand der Antwortzeile; abschliessen schreibt sofort, samt Zugdaten
 *   (Zuege, Dauer, Kosten der CLI), gemessenen Tokens und Kontextstand (Fenster/Schwellen wie der Wrapper: pruefeRespawnKorridor).
 *   Schreibfehler werfen nie, sie landen in letzter_fehler (verlaufStatus). Laufende Antworten ohne Strom in diesem Prozess
 *   (API neu gestartet) schliesst leseVerlauf als 'abgebrochen' ab.
 * VERBRAUCH: Quelle der Wahrheit fuer die Abrechnung bleibt agent_verbrauch (bucheAgentVerbrauch). Der Verlauf bucht nie,
 *   er speichert nur die Referenzen (verbrauch_referenzen).
 *
 * SCHALTER 'hauptagent_verlauf' (Produkt-Schalter I im Katalog PROFIL_PRODUKT_FUNKTIONEN, nur ausdruecklich): STANDARD EIN
 *   (reine Speicherung/Anzeige des eigenen Chats; AUS = Altverhalten, Verlauf nur im Browser-Tab). Wirksam = intern-Override
 *   (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (ebene global; admin profil_schalter_setzen bzw.
 *   PUT /api/main-agent/verlauf/schalter) > Standard EIN. Lesefehler -> Standard mit letzter_fehler.
 * DEBUG: verlaufStatus() (GET /api/main-agent/verlauf/status): Schalter samt Quelle, Identitaet, Anzahl, sichtbar, laufende
 *   Antworten, letzter Schreibfehler mit Zeit.
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter, setzeProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pflichtText } from './agent-profil-verwalter.js';
import { hauptagentIdentitaetsId } from './hauptagent-dienst.js';
import { pruefeRespawnKorridor } from './specialist-respawn.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { bucheAgentVerbrauch } from './agent-verbrauch.js';
import {
  leseTokenZaehlSchalter, leseVerlaufStufe2Schalter, modellFamilie, zaehleTokens, zaehltextEintrag, ausgabetextEintrag, leseKalibrierung, kalibriere,
  laufSumme, setzeGrundlast, ABWEICHUNG_BEFUND_PROZENT, type TokenZaehlung,
} from './verlauf-tokens.js';
import type { Zustellung } from './hauptagent-zustellung.js';
import { enqueueSpecialistJob } from './specialist-queue.js';
import { addThought } from './thoughts.js';
import type { ThoughtSource } from '../types/index.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

export const HAUPTAGENT_VERLAUF_FUNKTION = 'hauptagent_verlauf' as const;
/** Abstand der Zwischenstaende einer laufenden Antwort (andere Geraete sehen sie nach hoechstens Drossel + Poll). */
export const VERLAUF_DROSSEL_MS = 1_000;
/** Seitengroesse beim Laden (Standard/Obergrenze). Betrifft nur das Lesen, gespeichert wird immer alles. */
export const VERLAUF_SEITE_STANDARD = 50;
const VERLAUF_SEITE_MAX = 200;

type Q = QueryConfig & { query_timeout: number };
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface VerlaufSchalter {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  standard: boolean;
  bis: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache). Standard EIN; Lesefehler -> Standard mit letzter_fehler. */
export async function leseVerlaufSchalter(): Promise<VerlaufSchalter> {
  const basis: VerlaufSchalter = { aktiv: true, quelle: 'standard', standard: true, bis: null, gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null };
  let letzter: string | null = null;
  // Dynamisch wie hauptagent-modelle.ts (Importzyklus ueber intern-tool).
  const { internToolAktiv } = await import('./intern-tool.js');
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [HAUPTAGENT_VERLAUF_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'schalter_nicht_erreichbar'; }
  }
  const p = await leseProfilProduktSchalter(HAUPTAGENT_VERLAUF_FUNKTION, null);
  if (p.quelle === 'produkt-schalter') {
    return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', gesetzt_von: p.gesetzt_von, gesetzt_am: p.gesetzt_am, grund: p.grund, letzter_fehler: letzter };
  }
  return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
}

/** REST-Weg der Web-UI (nur User, ebene global). Gleicher Speicher wie admin profil_schalter_setzen. */
export async function setzeVerlaufSchalter(akteur: AusweisAkteur | null, e: { aktiv: unknown; grund: unknown }): Promise<VerlaufSchalter> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Dieser Weg ist der User-Eingang; Koordinatoren nutzen admin profil_schalter_setzen' });
  if (typeof e.aktiv !== 'boolean') fehler('aktiv_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await setzeProfilProduktSchalter({ ebene: 'global', funktion: HAUPTAGENT_VERLAUF_FUNKTION, aktiv: e.aktiv, grund }, { system: 'user' });
  return leseVerlaufSchalter();
}

// ---------------------------------------------------------------------------------------------
// Datenform
// ---------------------------------------------------------------------------------------------
export interface VerlaufWerkzeug {
  id: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  /** P22-T67: Bilder des Ergebnisses als Asset-Verweis (nie Base64); die Web-UI laedt sie ueber /api/main-agent/tool-bild. */
  bilder?: VerlaufBild[];
  start: string;
  ende: string | null;
}
export interface VerlaufBild {
  mime_type: string;
  bytes: number;
  project?: string;
  file_path?: string;
  revision?: string;
  breite?: number;
  hoehe?: number;
}
export interface VerlaufWerkzeuge { calls: VerlaufWerkzeug[]; phasen: string[] }
export interface VerlaufAnhang { name: string; typ: string | null; groesse: number | null }

export type VerlaufRolle = 'user' | 'agent' | 'nachricht' | 'ausgabe' | 'system';
export type VerlaufRichtung = 'ein' | 'aus' | 'intern';
export type VerlaufWeg = 'webui' | 'inbox' | 'chat' | 'channel' | 'event' | 'heartbeat' | 'werkzeug' | 'lauf' | 'wechsel';

/** Gemessene Tokens eines Zugs (CLI usage, letzte Meldung des Zugs). kontext (P22-T70): Kontextstand des Wrappers (dauerhafter Weg). */
export interface VerlaufGemessen { input: number; output: number; cache_read: number; cache_creation: number; quelle: 'cli_usage'; kontext?: number }
export interface VerlaufKontext {
  tokens: number;
  quelle: 'gemessen' | 'berechnet' | 'max';
  modell: string;
  fenster: number;
  prozent: number;
  handoff: number;
  rotation: number;
  hard: number;
  schwellen_quelle: 'registry' | 'cli' | 'fallback';
}
export interface VerlaufZug { zuege: number | null; dauer_ms: number; kosten: { usd: number; quelle: 'cli' } | null }

export interface VerlaufEintrag {
  id: string;
  rolle: VerlaufRolle;
  richtung: VerlaufRichtung;
  weg: VerlaufWeg;
  absender: Record<string, unknown> | null;
  quelle_ref: string | null;
  antwort_auf: string | null;
  gehoert_zu: string | null;
  /** P22-T73: 'wartet' = Antwortzeile einer User-Nachricht in der Warteschlange (meta.warteschlange), Schema 125. */
  status: 'laeuft' | 'fertig' | 'fehler' | 'abgebrochen' | 'wartet';
  text: string;
  werkzeuge: VerlaufWerkzeuge;
  artefakte: Array<Record<string, unknown>>;
  anhaenge: VerlaufAnhang[];
  hinweise: string[];
  meta: Record<string, unknown>;
  tokens: { gemessen?: VerlaufGemessen | null; berechnet?: Record<string, unknown> | null };
  kontext: VerlaufKontext | null;
  zug: VerlaufZug | null;
  verbrauch_referenzen: string[];
  zaehlt: boolean;
  lauf_id: string | null;
  session_id: string | null;
  runtime: string | null;
  modell: string | null;
  hauptagent_weg: string | null;
  geraet: string | null;
  rev: string;
  erstellt_am: string;
  aktualisiert_am: string;
}

interface Zeile extends Omit<VerlaufEintrag, 'erstellt_am' | 'aktualisiert_am'> { erstellt_am: Date; aktualisiert_am: Date }
// ⚠️ Ausgabespalte id ist TEXT: ORDER BY immer mit hauptagent_verlauf.id (sonst Textsortierung 1, 10, 2).
const SPALTEN = `id::text AS id, rolle, richtung, weg, absender, quelle_ref, antwort_auf::text AS antwort_auf, gehoert_zu::text AS gehoert_zu,
  status, text, werkzeuge, artefakte, anhaenge, hinweise, meta, tokens, kontext, zug, verbrauch_referenzen, zaehlt, lauf_id, session_id,
  runtime, modell, hauptagent_weg, geraet, rev::text AS rev, erstellt_am, aktualisiert_am`;
function eintrag(z: Zeile): VerlaufEintrag {
  return { ...z, erstellt_am: z.erstellt_am.toISOString(), aktualisiert_am: z.aktualisiert_am.toISOString() };
}

/** Geraet fuer die Anzeige aus dem User-Agent (Browser · System); nichts Identifizierendes. */
export function geraetAusUserAgent(ua: unknown): string | null {
  if (typeof ua !== 'string' || !ua.trim()) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const system = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  const teile = [browser, system].filter(Boolean);
  return teile.length ? teile.join(' · ') : ua.slice(0, 40);
}

// ---------------------------------------------------------------------------------------------
// Debug-Stand (prozesslokal)
// ---------------------------------------------------------------------------------------------
let letzterSchreibfehler: { code: string; am: string } | null = null;
/** Antwortzeilen, deren Strom in DIESEM Prozess noch laeuft (Rest nach einem Neustart wird beim Lesen abgeschlossen). */
const aktiveAntworten = new Set<string>();
/** Schonfrist zwischen Anlegen der Antwortzeile und Start ihres Schreibers. */
const VERWAIST_NACH_SEKUNDEN = 60;
function merkeFehler(code: string, error: unknown): void {
  letzterSchreibfehler = { code: code + ': ' + (error instanceof Error ? error.message : String(error)).slice(0, 300), am: new Date().toISOString() };
}

// ---------------------------------------------------------------------------------------------
// Verfuegbarkeit
// ---------------------------------------------------------------------------------------------
export type VerlaufNichtVerfuegbar = 'schalter_aus' | 'keine_hauptagent_identitaet' | 'fehler';

async function verfuegbareIdentitaet(): Promise<{ identity_id: string; schalter: VerlaufSchalter } | { grund: VerlaufNichtVerfuegbar; schalter: VerlaufSchalter }> {
  const schalter = await leseVerlaufSchalter();
  if (!schalter.aktiv) return { grund: 'schalter_aus', schalter };
  const identity_id = await hauptagentIdentitaetsId().catch(() => null);
  return identity_id ? { identity_id, schalter } : { grund: 'keine_hauptagent_identitaet', schalter };
}

// ---------------------------------------------------------------------------------------------
// Schreiben (Stufe 1: Web-UI-Zug)
// ---------------------------------------------------------------------------------------------
export interface VerlaufTurnEingabe {
  /** identity_id der Sitzung; nur die Main-Identitaet speichert. */
  identity_id: string | null | undefined;
  text: string;
  session_id?: string | null;
  runtime?: string | null;
  /** Tatsaechliches Modell des Zugs (Fenster/Schwellen fuer den Kontextstand). */
  modell?: string | null;
  lauf_id?: string | null;
  geraet?: string | null;
  anhaenge?: unknown;
}
export type VerlaufTurn = { gespeichert: true; identity_id: string; user_id: string; antwort_id: string }
  | { gespeichert: false; grund: VerlaufNichtVerfuegbar };

function anhaengeAus(v: unknown): VerlaufAnhang[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a) => {
    const o = a && typeof a === 'object' ? a as Record<string, unknown> : null;
    if (!o || typeof o.name !== 'string' || !o.name.trim()) return [];
    return [{ name: o.name, typ: typeof o.typ === 'string' ? o.typ : null,
      groesse: typeof o.groesse === 'number' && Number.isFinite(o.groesse) ? Math.round(o.groesse) : null }];
  });
}

/** User-Nachricht + laufende Antwortzeile in EINER Transaktion (sofort sichtbar auf allen Geraeten). Wirft nie. */
export async function legeVerlaufTurnAn(e: VerlaufTurnEingabe): Promise<VerlaufTurn> {
  try {
    const v = await verfuegbareIdentitaet();
    if ('grund' in v) return { gespeichert: false, grund: v.grund };
    if (!e.identity_id || e.identity_id !== v.identity_id) return { gespeichert: false, grund: 'keine_hauptagent_identitaet' };
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const u = await client.query<{ id: string }>(
        `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, status, text, anhaenge, session_id, runtime, modell, lauf_id, geraet)
         VALUES ($1,'user','ein','webui','fertig',$2,$3::jsonb,$4,$5,$6,$7,$8) RETURNING id::text AS id`,
        [v.identity_id, e.text, JSON.stringify(anhaengeAus(e.anhaenge)), e.session_id ?? null, e.runtime ?? null, e.modell ?? null,
          e.lauf_id ?? null, e.geraet ?? null]);
      const a = await client.query<{ id: string }>(
        `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, antwort_auf, status, session_id, runtime, modell, lauf_id)
         VALUES ($1,'agent','aus','webui',$2::bigint,'laeuft',$3,$4,$5,$6) RETURNING id::text AS id`,
        [v.identity_id, u.rows[0].id, e.session_id ?? null, e.runtime ?? null, e.modell ?? null, e.lauf_id ?? null]);
      await client.query('COMMIT');
      return { gespeichert: true, identity_id: v.identity_id, user_id: u.rows[0].id, antwort_id: a.rows[0].id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    merkeFehler('turn_anlegen', error);
    return { gespeichert: false, grund: 'fehler' };
  }
}

export interface VerlaufAntwortStand {
  text: string;
  werkzeuge: VerlaufWerkzeuge;
  artefakte: Array<Record<string, unknown>>;
  hinweise: string[];
  meta: Record<string, unknown>;
  gemessen: VerlaufGemessen | null;
  /** Anzahl der usage-Meldungen (Rueckfall fuer die Zugzahl, wenn die CLI keine num_turns liefert). */
  usage_meldungen: number;
  verbrauch_referenzen: string[];
  /** P22-T63 B: eigene Zaehlung der Antwortzeile (Schalter verlauf_token_zaehlung). */
  berechnet: Record<string, unknown> | null;
  /** P22-T63 A3: Zeile ist Spiegel der Sitzungs-Eintraege (zaehlt nicht zum Kontext). */
  spiegel?: boolean;
}

export function neuerAntwortStand(): VerlaufAntwortStand {
  return { text: '', werkzeuge: { calls: [], phasen: [] }, artefakte: [], hinweise: [], meta: {}, gemessen: null, usage_meldungen: 0, verbrauch_referenzen: [], berechnet: null };
}

/** Kurzfassung einer Denkphase fuer die Anzeige (erste Zeile, wie die Chat-Anzeige); der volle Text steht in meta.denkphasen. */
function kurzeDenkphase(text: string): string {
  const zeile = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return zeile.length > 140 ? zeile.slice(0, 140) + ' …' : zeile || 'Denkphase';
}

function revisionNeuer(neu: unknown, alt: unknown): boolean {
  if (neu === undefined || alt === undefined) return true;
  const a = Number(neu);
  const b = Number(alt);
  return Number.isFinite(a) && Number.isFinite(b) ? a >= b : true;
}

function neueHinweiszeile(stand: VerlaufAntwortStand, zeile: string): void {
  if (!stand.hinweise.includes(zeile)) stand.hinweise.push(zeile);
}

/** P22-T67: nur die bekannten Verweisfelder uebernehmen (nie Daten/Base64), hoechstens 8 Bilder je Aufruf. */
export function bilderAusStrom(v: unknown): VerlaufBild[] {
  if (!Array.isArray(v)) return [];
  const text = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
  const mass = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : undefined);
  return v.slice(0, 8).flatMap((b): VerlaufBild[] => {
    const o = b && typeof b === 'object' ? b as Record<string, unknown> : null;
    if (!o) return [];
    const bild: VerlaufBild = { mime_type: text(o.mime_type) ?? 'image/png', bytes: mass(o.bytes) ?? 0 };
    const project = text(o.project);
    const pfad = text(o.file_path);
    const revision = text(o.revision);
    if (project && pfad) { bild.project = project; bild.file_path = pfad; }
    if (revision && /^[1-9][0-9]*$/.test(revision)) bild.revision = revision;
    const breite = mass(o.breite);
    const hoehe = mass(o.hoehe);
    if (breite) bild.breite = breite;
    if (hoehe) bild.hoehe = hoehe;
    return [bild];
  });
}

function zahl(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Ein Ereignis des Antwortstroms (SSE-Namen wie agent-runtimes.ts) in den Stand uebernehmen. Rueckgabe: ob sich etwas
 * geaendert hat. Reine Funktion (testbar ohne PG). Nichts wird gekuerzt.
 */
export function wendeStromEreignisAn(stand: VerlaufAntwortStand, event: string, data: Record<string, unknown> | null | undefined): boolean {
  const d = data ?? {};
  if (event === 'delta') {
    if (typeof d.content !== 'string' || !d.content) return false;
    stand.text += d.content;
    return true;
  }
  if (event === 'thinking') {
    if (typeof d.content !== 'string') return false;
    stand.werkzeuge.phasen.push(kurzeDenkphase(d.content));
    const voll = Array.isArray(stand.meta.denkphasen) ? stand.meta.denkphasen as string[] : [];
    stand.meta.denkphasen = [...voll, d.content];
    return true;
  }
  if (event === 'tool') {
    if (typeof d.id !== 'string' || !d.id) return false;
    const jetzt = new Date().toISOString();
    const vorhanden = stand.werkzeuge.calls.find((c) => c.id === d.id);
    const call: VerlaufWerkzeug = vorhanden ?? { id: d.id, start: jetzt, ende: null };
    if (typeof d.name === 'string') call.name = d.name;
    if (d.input !== undefined) call.input = d.input;
    if (d.phase === 'end') {
      call.ende = jetzt;
      call.isError = d.isError === true;
      if (d.output !== undefined) call.output = d.output;
      const bilder = bilderAusStrom(d.bilder);
      if (bilder.length) call.bilder = bilder;
    }
    if (!vorhanden) stand.werkzeuge.calls.push(call);
    return true;
  }
  if (event === 'artifact') {
    if (typeof d.html !== 'string') return false;
    const id = typeof d.id === 'string' && d.id ? d.id : 'block-' + (stand.artefakte.length + 1);
    const i = stand.artefakte.findIndex((a) => a.id === id);
    if (i >= 0) {
      if (!revisionNeuer(d.revision, stand.artefakte[i].revision)) return false;
      stand.artefakte[i] = { ...d, id };
      return true;
    }
    stand.artefakte.push({ ...d, id });
    return true;
  }
  if (event === 'usage') {
    // Letzte usage-Meldung des Zugs zaehlt (wie bucheMainChatVerbrauch). Codex: cachedInputTokens ist Teil von inputTokens.
    stand.gemessen = {
      input: zahl(d.inputTokens), output: zahl(d.outputTokens),
      cache_read: zahl(d.cacheReadInputTokens), cache_creation: zahl(d.cacheCreationInputTokens), quelle: 'cli_usage',
      ...(zahl(d.kontextTokens) > 0 ? { kontext: zahl(d.kontextTokens) } : {}),
    };
    stand.usage_meldungen += 1;
    stand.meta.usage = d;
    return true;
  }
  if (event === 'runtime') {
    const h = d.hauptagent && typeof d.hauptagent === 'object' ? d.hauptagent as Record<string, unknown> : null;
    if (!h) return false;
    if (typeof h.weg === 'string') stand.meta.hauptagent_weg = h.weg;
    // Beschaeftigter Main (bestehende Regel): die Nachricht wurde zugestellt, der Hinweis steht schon als Antworttext da.
    if (h.schritt === 'zugestellt') stand.meta.zugestellt = true;
    else if (typeof h.hinweis === 'string' && h.hinweis) neueHinweiszeile(stand, 'Hinweis: ' + h.hinweis);
    return true;
  }
  if (event === 'error') {
    neueHinweiszeile(stand, 'Runtime-Fehler: ' + (typeof d.message === 'string' ? d.message : 'unbekannt'));
    return true;
  }
  return false;
}

/**
 * Kontextstand eines Zugs aus gemessenen Tokens: dieselbe Rechnung wie Wrapper und Respawn-Check (pruefeRespawnKorridor).
 * P22-T70: Auf dem dauerhaften Weg ist die usage des Wrappers ohne Cache (Summe ~0 %); dort zaehlt nur der Kontextstand des
 * Wrappers (g.kontext). Fehlt er, ist der Kontext nicht gemessen (null), statt eine falsche Zahl zu zeigen.
 */
export async function kontextAusGemessen(modell: string | null | undefined, g: VerlaufGemessen | null,
  o: { dauerhaft?: boolean } = {}): Promise<VerlaufKontext | null> {
  if (!modell || !g) return null;
  if (o.dauerhaft && !(g.kontext && g.kontext > 0)) return null;
  const tokens = g.kontext && g.kontext > 0 ? g.kontext : g.input + g.cache_read + g.cache_creation + g.output;
  if (tokens <= 0) return null;
  const k = await pruefeRespawnKorridor({ model: modell, tokens });
  return {
    tokens, quelle: 'gemessen', modell, fenster: k.schwellen.ceiling, prozent: k.prozent, handoff: k.schwellen.handoffTokens,
    rotation: k.schwellen.rotationTokens, hard: k.schwellen.hardRotationTokens, schwellen_quelle: k.schwellen.quelle,
  };
}

function zugAus(stand: VerlaufAntwortStand, start: number, laufkontext: unknown): VerlaufZug {
  const k = laufkontext && typeof laufkontext === 'object' ? laufkontext as Record<string, unknown> : {};
  const zuegeCli = Number(k.num_turns ?? k.numTurns);
  const usd = Number(k.total_cost_usd ?? k.totalCostUsd);
  return {
    zuege: Number.isFinite(zuegeCli) && zuegeCli > 0 ? zuegeCli : stand.usage_meldungen || null,
    dauer_ms: Math.max(0, Date.now() - start),
    kosten: Number.isFinite(usd) && usd > 0 ? { usd, quelle: 'cli' } : null,
  };
}

async function schreibeAntwort(antwort_id: string, stand: VerlaufAntwortStand, status: VerlaufEintrag['status'],
  ende?: { zug: VerlaufZug; kontext: VerlaufKontext | null; lauf_id?: string | null }): Promise<void> {
  await getPool().query({
    text: `UPDATE hauptagent_verlauf SET text = $2, werkzeuge = $3::jsonb, artefakte = $4::jsonb, hinweise = $5::jsonb, meta = $6::jsonb,
             status = $7, tokens = jsonb_set(jsonb_set(tokens, '{gemessen}', $8::jsonb), '{berechnet}', $13::jsonb), verbrauch_referenzen = $9::text[],
             zug = COALESCE($10::jsonb, zug), kontext = COALESCE($11::jsonb, kontext), hauptagent_weg = COALESCE($12, hauptagent_weg),
             lauf_id = COALESCE($14, lauf_id), zaehlt = NOT $15,
             rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
           WHERE id = $1::bigint AND rolle = 'agent'`,
    values: [antwort_id, stand.text, JSON.stringify(stand.werkzeuge), JSON.stringify(stand.artefakte), JSON.stringify(stand.hinweise),
      JSON.stringify(stand.meta), status, JSON.stringify(stand.gemessen), stand.verbrauch_referenzen,
      ende ? JSON.stringify(ende.zug) : null, ende?.kontext ? JSON.stringify(ende.kontext) : null,
      typeof stand.meta.hauptagent_weg === 'string' ? stand.meta.hauptagent_weg : null, JSON.stringify(stand.berechnet), ende?.lauf_id ?? null, stand.spiegel === true],
    query_timeout: 5000,
  } as Q);
}

export interface VerlaufAntwortSchreiber {
  readonly antwort_id: string;
  readonly stand: VerlaufAntwortStand;
  /** Ein Stromereignis uebernehmen; schreibt gedrosselt. */
  ereignis(event: string, data: Record<string, unknown> | null | undefined): void;
  /** Referenz einer Buchung in agent_verbrauch (keine eigene Buchung). */
  verbrauchReferenz(referenz: string): void;
  /** Endstand sofort schreiben (fertig | fehler | abgebrochen) samt Zugdaten und Kontextstand. Idempotent, wirft nie. */
  abschliessen(status: 'fertig' | 'fehler' | 'abgebrochen', zusatz?: { fehler?: string; laufkontext?: unknown }): Promise<void>;
  /**
   * P22-T73: die Zeile geht an die Warteschlange (hauptagent-warteschlange.ts). Wartet auf laufende Schreibvorgaenge und schreibt
   * danach nichts mehr (auch kein spaeteres abschliessen). Wirft nie.
   */
  uebergeben(): Promise<void>;
}

/** Daten des Zugs fuer die eigene Zaehlung (Stufe 2 B). Ohne identity_id wird nicht gezaehlt. */
export interface VerlaufZugKontext {
  identity_id?: string | null;
  user_id?: string | null;
  user_text?: string | null;
  runtime?: string | null;
  lauf_id?: string | null;
}

function gemessenGueltig(g: VerlaufGemessen | null): g is VerlaufGemessen {
  return !!g && g.input + g.output + g.cache_read + g.cache_creation > 0;
}
function zaehlungJson(z: TokenZaehlung): Record<string, unknown> {
  return { tokens: z.tokens, verfahren: z.verfahren, familie: z.familie, faktor: z.faktor, zeichen: z.zeichen };
}
let letzterZaehlBefund: { text: string; am: string } | null = null;

/**
 * P22-T63 B: eigene Zaehlung am Zugende (nur bei Schalter verlauf_token_zaehlung EIN). Schreibt tokens.berechnet der
 * User-Zeile, setzt stand.berechnet der Antwort, kalibriert den Faktor an der gemessenen Ausgabe, haelt die Grundlast des
 * Laufs fest und liefert den Kontextstand als max(gemessen, berechnet). Ohne CLI-usage im Altweg bucht sie EINMAL berechnet
 * in agent_verbrauch (referenz verlauf:<antwort_id>); der dauerhafte Weg bucht immer der Wrapper.
 */
async function zaehleZug(antwort_id: string, stand: VerlaufAntwortStand, modell: string | null | undefined, z: VerlaufZugKontext,
  gemessenKontext: VerlaufKontext | null): Promise<VerlaufKontext | null> {
  if (!z.identity_id || !(await leseTokenZaehlSchalter()).aktiv) return gemessenKontext;
  const familie = modellFamilie(z.runtime, modell);
  const faktor = (await leseKalibrierung(z.identity_id, familie))?.faktor ?? null;
  const nutzer = await zaehleTokens(z.user_text ?? '', familie, faktor);
  const antwort = await zaehleTokens(zaehltextEintrag(stand), familie, faktor);
  if (z.user_id) {
    await getPool().query(`UPDATE hauptagent_verlauf SET tokens = jsonb_set(tokens, '{berechnet}', $2::jsonb), rev = nextval('hauptagent_verlauf_rev'),
      aktualisiert_am = NOW() WHERE id = $1::bigint`, [z.user_id, JSON.stringify(zaehlungJson(nutzer))]);
  }
  stand.berechnet = zaehlungJson(antwort);
  const ausgabe = ausgabetextEintrag(stand);
  if (gemessenGueltig(stand.gemessen)) await kalibriere(z.identity_id, familie, ausgabe.length, stand.gemessen.output);
  let berechnetKontext: number | null = null;
  if (z.lauf_id) {
    const { summe, grundlast } = await laufSumme(z.identity_id, z.lauf_id); // ohne die Antwortzeile (deren Zaehlung steht erst im Endstand)
    let last = grundlast;
    // Spiegelzeile (A3): der Inhalt steckt schon in den Sitzungs-Eintraegen der Summe, also nicht ein zweites Mal zaehlen.
    const eigen = stand.spiegel ? 0 : antwort.tokens;
    if (last === null && gemessenKontext) {
      last = Math.max(0, gemessenKontext.tokens - summe - eigen);
      await setzeGrundlast(z.identity_id, z.lauf_id, last);
    }
    berechnetKontext = (last ?? 0) + summe + eigen;
  }
  if (berechnetKontext !== null) stand.berechnet.kontext = berechnetKontext;
  if (gemessenKontext && berechnetKontext !== null) {
    const abweichung = Math.round((Math.abs(berechnetKontext - gemessenKontext.tokens) / Math.max(1, gemessenKontext.tokens)) * 100);
    stand.berechnet.abweichung_prozent = abweichung;
    if (abweichung > ABWEICHUNG_BEFUND_PROZENT) {
      letzterZaehlBefund = { text: `Zug ${antwort_id}: berechnet ${berechnetKontext} vs. gemessen ${gemessenKontext.tokens} (${abweichung} %, ${antwort.verfahren})`, am: new Date().toISOString() };
    }
  }
  // Ohne CLI-usage (Altweg) einmal berechnet buchen; dieselbe referenz verhindert jede Doppelbuchung.
  if (!gemessenGueltig(stand.gemessen) && stand.meta.hauptagent_weg !== 'dauerhaft' && z.runtime) {
    const referenz = 'verlauf:' + antwort_id;
    const aus = await zaehleTokens(ausgabe, familie, faktor);
    const r = await bucheAgentVerbrauch({
      project: HAUPTAGENT_PROJEKT, identity_id: z.identity_id, agent_id: 'hauptagent', runtime: z.runtime,
      zugang: z.runtime === 'claude' || z.runtime === 'codex' ? 'abo' : 'api', modell: modell ?? null,
      input_tokens: Math.max(0, (berechnetKontext ?? nutzer.tokens) - antwort.tokens), output_tokens: aus.tokens,
      quelle: 'main_chat', lauf_id: z.lauf_id ?? null, referenz, messart: 'berechnet',
    });
    if (r.gebucht || r.grund === 'doppelt') {
      if (!stand.verbrauch_referenzen.includes(referenz)) stand.verbrauch_referenzen.push(referenz);
    }
  }
  if (berechnetKontext === null) return gemessenKontext;
  const tokens = Math.max(berechnetKontext, gemessenKontext?.tokens ?? 0);
  const k = await pruefeRespawnKorridor({ model: modell ?? 'unbekannt', tokens });
  return {
    tokens, quelle: gemessenKontext ? 'max' : 'berechnet', modell: modell ?? 'unbekannt', fenster: k.schwellen.ceiling, prozent: k.prozent,
    handoff: k.schwellen.handoffTokens, rotation: k.schwellen.rotationTokens, hard: k.schwellen.hardRotationTokens, schwellen_quelle: k.schwellen.quelle,
  };
}

/**
 * Schreiber fuer die laufende Antwortzeile. Schreibvorgaenge laufen nacheinander (nie zwei UPDATEs derselben Zeile
 * gleichzeitig); nach abschliessen schreibt er nichts mehr. modell = tatsaechliches Modell (Kontextfenster). drossel_ms nur fuer Tests.
 */
export function starteVerlaufAntwort(antwort_id: string, o: { drossel_ms?: number; modell?: string | null; meta?: Record<string, unknown> } & VerlaufZugKontext = {}): VerlaufAntwortSchreiber {
  const stand = neuerAntwortStand();
  // P22-T73: Zustellung aus der Warteschlange behaelt die Metadaten der Zeile (meta.warteschlange), der Schreiber ersetzt meta ganz.
  if (o.meta) stand.meta = { ...o.meta };
  const drossel = o.drossel_ms ?? VERLAUF_DROSSEL_MS;
  const start = Date.now();
  let timer: NodeJS.Timeout | null = null;
  let kette: Promise<void> = Promise.resolve();
  let fertig = false;
  aktiveAntworten.add(antwort_id);
  const flush = (status: VerlaufEintrag['status'], ende?: { zug: VerlaufZug; kontext: VerlaufKontext | null; lauf_id?: string | null }): Promise<void> => {
    kette = kette.then(async () => {
      try { await schreibeAntwort(antwort_id, stand, status, ende); } catch (error) { merkeFehler('antwort_schreiben', error); }
    });
    return kette;
  };
  return {
    antwort_id,
    stand,
    ereignis(event, data) {
      if (fertig || !wendeStromEreignisAn(stand, event, data) || timer) return;
      timer = setTimeout(() => { timer = null; if (!fertig) void flush('laeuft'); }, drossel);
      timer.unref?.();
    },
    verbrauchReferenz(referenz) {
      if (!stand.verbrauch_referenzen.includes(referenz)) stand.verbrauch_referenzen.push(referenz);
    },
    async uebergeben() {
      if (fertig) return;
      fertig = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { await kette; } finally { aktiveAntworten.delete(antwort_id); }
    },
    async abschliessen(status, zusatz) {
      if (fertig) return;
      fertig = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (zusatz?.fehler) neueHinweiszeile(stand, 'Runtime-Fehler: ' + zusatz.fehler);
      if (zusatz?.laufkontext !== undefined && zusatz.laufkontext !== null) stand.meta.laufkontext = zusatz.laufkontext;
      if (status === 'abgebrochen') neueHinweiszeile(stand, 'Ausgabe abgebrochen');
      // Lauf des Zugs: der dauerhafte Main zaehlt je Anmeldung (agent_identitaet_sitzungen.lauf_id, neu nach jeder Rotation);
      // der Altweg je CLI-Sitzung (vom Aufrufer, 'altweg:<session>').
      let lauf = o.lauf_id ?? null;
      let spiegel = false;
      if (stand.meta.hauptagent_weg === 'dauerhaft' && o.identity_id) {
        try { lauf = (await aktuellerMainLauf(o.identity_id)) ?? lauf; } catch (error) { merkeFehler('lauf_lesen', error); }
        // A3: auf dem dauerhaften Weg liefert die Sitzung des Wrappers den vollstaendigen Inhalt; diese Zeilen sind dann Spiegel.
        try { spiegel = (await leseVerlaufStufe2Schalter('verlauf_alle_richtungen')).aktiv; } catch (error) { merkeFehler('schalter_lesen', error); }
        if (o.user_id) {
          await getPool().query('UPDATE hauptagent_verlauf SET lauf_id = COALESCE($2, lauf_id), zaehlt = NOT $3 WHERE id = $1::bigint',
            [o.user_id, lauf, spiegel]).catch((error) => merkeFehler('lauf_setzen', error));
        }
      }
      stand.spiegel = spiegel;
      let kontext: VerlaufKontext | null = null;
      try {
        kontext = await kontextAusGemessen(o.modell, stand.gemessen, { dauerhaft: stand.meta.hauptagent_weg === 'dauerhaft' });
      } catch (error) { merkeFehler('kontext_berechnen', error); }
      try { kontext = await zaehleZug(antwort_id, stand, o.modell, { ...o, lauf_id: lauf }, kontext); } catch (error) { merkeFehler('tokens_zaehlen', error); }
      try { await flush(status, { zug: zugAus(stand, start, zusatz?.laufkontext), kontext, lauf_id: lauf }); } finally { aktiveAntworten.delete(antwort_id); }
      // C1: Korridor des dauerhaften Main nach jedem Zug (auch bei Heartbeat AUS), Schalter main_korridor.
      if (stand.meta.hauptagent_weg === 'dauerhaft' && o.identity_id && kontext) {
        await pruefeMainKorridor(o.identity_id, kontext, lauf).catch((error) => merkeFehler('korridor', error));
      }
    },
  };
}

/** Aktueller Lauf des dauerhaften Main (jede Anmeldung = neuer Lauf, also auch nach jeder Rotation). */
export async function aktuellerMainLauf(identity_id: string): Promise<string | null> {
  const r = await getPool().query<{ lauf_id: string | null }>('SELECT lauf_id FROM agent_identitaet_sitzungen WHERE identity_id = $1', [identity_id]);
  return r.rows[0]?.lauf_id ?? null;
}

/** Tatsaechliches Modell des Main (bestaetigt, sonst Selbstauskunft). */
export async function aktuellesMainModell(identity_id: string): Promise<string | null> {
  const r = await getPool().query<{ m: string | null }>(
    'SELECT COALESCE(modell_bestaetigt, modell_selbstauskunft) AS m FROM agent_identitaeten WHERE id = $1', [identity_id]);
  return r.rows[0]?.m ?? null;
}

// ---------------------------------------------------------------------------------------------
// Stufe 2 C: Korridor des dauerhaften Main (lokale Vorlage: Auto-Handoff-Wake, Rotations-Marker; die API prueft nach jedem Zug)
// ---------------------------------------------------------------------------------------------
/** Runtime, der der Main zugewiesen ist (Ziel der Container-Jobs). */
export async function zugewieseneMainRuntime(): Promise<string | null> {
  const r = await getPool().query<{ runtime: string }>('SELECT runtime FROM agent_runtime_instances WHERE assigned_to_main LIMIT 1');
  return r.rows[0]?.runtime ?? null;
}

export const MAIN_HANDOFF_TEXT = (k: VerlaufKontext): string =>
  `KONTEXT-WARNUNG: Dein Kontext ist bei ${k.prozent}% (${k.tokens} von ${k.fenster} Tokens, ${k.quelle}). Sichere JETZT deinen Arbeitsstand `
  + `und rufe danach thought(action:"add", tags:["auto-handoff"], content:"AUTO-HANDOFF: <Aufgabe, Stand, offene Punkte>", trigger_respawn:true) auf. `
  + 'Den Gespraechsverlauf gibt Synapse beim Neustart selbst als Startkontext mit; du musst ihn nicht abschreiben.';

/**
 * Wie Wrapper-Heartbeat (lokale Vorlage), aber fuer den Main durch die API nach jedem Zug und damit unabhaengig vom Heartbeat:
 * ab handoffTokens EINMAL je Lauf ein Handoff-Wake (wie handoffWarningSent), ab rotationTokens EINMAL je Lauf Uebergabe aus dem
 * Verlauf + Job 'rotate' an den Container-Daemon (er schreibt den Rotations-Marker; der Wrapper rotiert am Turn-Ende bzw. im
 * Marker-Takt, auch bei Heartbeat AUS). Nur Schalter main_korridor EIN. Der PC-Weg der Spezialisten bleibt unveraendert.
 */
export async function pruefeMainKorridor(identity_id: string, k: VerlaufKontext, lauf: string | null): Promise<'nichts' | 'handoff' | 'rotation'> {
  if (!lauf || !(await leseVerlaufStufe2Schalter('main_korridor')).aktiv || k.tokens < k.handoff) return 'nichts';
  const s = await getPool().query<{ k: { lauf_id?: string; handoff_am?: string; rotation_am?: string } | null }>(
    `SELECT kalibrierung -> 'korridor' AS k FROM hauptagent_verlauf_stand WHERE identity_id = $1`, [identity_id]);
  const alt = s.rows[0]?.k?.lauf_id === lauf ? s.rows[0].k : {};
  const rotation = k.tokens >= k.rotation;
  if (rotation ? alt?.rotation_am : alt?.handoff_am) return 'nichts';
  const runtime = await zugewieseneMainRuntime();
  if (!runtime) return 'nichts';
  if (rotation) {
    await erzeugeVerlaufUebergabe(identity_id, { runtime, modell: k.modell }, 'korridor_neustart');
    await enqueueSpecialistJob({ project: HAUPTAGENT_PROJEKT, action: 'rotate', args: { name: 'hauptagent', identity_id, target_runtime: runtime } });
  } else {
    await enqueueSpecialistJob({ project: HAUPTAGENT_PROJEKT, action: 'wake',
      args: { name: 'hauptagent', identity_id, message: MAIN_HANDOFF_TEXT(k), target_runtime: runtime } });
  }
  const neu = { ...alt, lauf_id: lauf, [rotation ? 'rotation_am' : 'handoff_am']: new Date().toISOString() };
  await getPool().query(
    `INSERT INTO hauptagent_verlauf_stand (identity_id, kalibrierung) VALUES ($1, jsonb_build_object('korridor', $2::jsonb))
     ON CONFLICT (identity_id) DO UPDATE SET kalibrierung = hauptagent_verlauf_stand.kalibrierung || jsonb_build_object('korridor', $2::jsonb)`,
    [identity_id, JSON.stringify(neu)]);
  return rotation ? 'rotation' : 'handoff';
}

// ---------------------------------------------------------------------------------------------
// Stufe 2 D: Uebergabe beim Modell-/Runtime-Wechsel, Failover und Korridor-Neustart
// ---------------------------------------------------------------------------------------------
/** Reserve fuer Handoff-Turn und grosse Werkzeugaufrufe (wie HANDOFF_VORLAUF_TOKENS). */
const UEBERGABE_RESERVE = 30_000;
/** Grundlast, wenn fuer das Ziel noch keine gemessen wurde (Systemprompt + Werkzeugliste + CLI). */
const UEBERGABE_GRUNDLAST_STANDARD = 20_000;
const UEBERGABE_ANTEIL_FENSTER = 0.2;
let letzteUebergabe: { thought_id: string; anlass: string; zuege: number; tokens: number; am: string } | null = null;

interface UebergabeZeile { id: string; rolle: VerlaufRolle; weg: VerlaufWeg; quelle_ref: string | null; antwort_auf: string | null; text: string;
  werkzeuge: VerlaufWerkzeuge; meta: Record<string, unknown>; absender: Record<string, unknown> | null; erstellt_am: Date }

function werkzeugText(name: unknown, input: unknown, output: unknown): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
  return `[Werkzeug ${String(name ?? 'werkzeug')}] Eingabe: ${s(input)}` + (output === undefined ? '' : `\n[Ergebnis] ${s(output)}`);
}

/**
 * Uebergabe aus dem Verlauf (nicht aus dem CLI-Gedaechtnis): letzte N Zuege VOLL (Ausloeser, Antwort, Werkzeug-Ein/Ausgaben)
 * plus Kurzstand (juengster eigener Handoff bzw. hands_off-Thought, offene Auftraege, Ausloeser der letzten Zuege). Budget =
 * min(20 % des Zielfensters, Handoff-Schwelle - Grundlast - Reserve), gezaehlt mit dem Verfahren der Zielfamilie; ein Zug, der
 * nicht mehr passt, wird nicht gekuerzt, sondern per Verlaufs-ID genannt. Ankunft: Thought (Tags session-uebergabe,
 * verlauf-uebergabe) -> chat(anmelden) liefert ihn dem neuen Lauf als Handoff. Dazu Verlaufseintrag 'Wechsel X -> Y'.
 * Nur Schalter verlauf_uebergabe EIN. Wirft nie.
 */
export async function erzeugeVerlaufUebergabe(identity_id: string, ziel: { runtime?: string | null; modell?: string | null; effort?: string | null }, anlass: string,
  handoff_thought_id?: string | null): Promise<{ thought_id: string; zuege: number; tokens: number } | null> {
  try {
    if (!(await leseVerlaufStufe2Schalter('verlauf_uebergabe')).aktiv) return null;
    const pool = getPool();
    const vonModell = await aktuellesMainModell(identity_id);
    const vonRuntime = await zugewieseneMainRuntime().catch(() => null);
    const zielModell = ziel.modell ?? vonModell ?? 'unbekannt';
    const familie = modellFamilie(ziel.runtime ?? vonRuntime, zielModell);
    const faktor = (await leseKalibrierung(identity_id, familie))?.faktor ?? null;
    const schwellen = (await pruefeRespawnKorridor({ model: zielModell, tokens: 0 })).schwellen;
    const budget = Math.max(0, Math.min(Math.floor(schwellen.ceiling * UEBERGABE_ANTEIL_FENSTER),
      schwellen.handoffTokens - UEBERGABE_GRUNDLAST_STANDARD - UEBERGABE_RESERVE));
    // Kurzstand
    const eigen = handoff_thought_id
      ? await pool.query<{ id: string; content: string }>('SELECT id, content FROM thoughts WHERE id::text = $1', [handoff_thought_id])
      : await pool.query<{ id: string; content: string }>(
        `SELECT id, content FROM thoughts WHERE project = $1 AND (source_identity_id = $2 OR source = 'hauptagent')
           AND tags && ARRAY['auto-handoff','session-state','session-uebergabe']::text[] AND NOT ('verlauf-uebergabe' = ANY(tags))
         ORDER BY "timestamp" DESC LIMIT 1`, [HAUPTAGENT_PROJEKT, identity_id]);
    const auftraege = await pool.query<{ art: string; status: string; gewuenscht: unknown }>(
      `SELECT art, status, gewuenscht FROM agent_runtime_auftraege WHERE identity_id = $1 AND status IN ('pending','claimed','accepted') ORDER BY erstellt_am`,
      [identity_id]).catch(() => ({ rows: [] as Array<{ art: string; status: string; gewuenscht: unknown }> }));
    // Zuege: Ausloeser (Web-UI-User oder Nachricht, nicht die Sitzungs-Eintraege) mit Antwort und Werkzeugschritten dazwischen.
    const ausloeser = (await pool.query<UebergabeZeile>(
      `SELECT id::text AS id, rolle, weg, quelle_ref, antwort_auf::text AS antwort_auf, text, werkzeuge, meta, absender, erstellt_am
         FROM hauptagent_verlauf WHERE identity_id = $1 AND rolle IN ('user','nachricht') AND (quelle_ref IS NULL OR quelle_ref NOT LIKE 'jsonl:%')
        ORDER BY hauptagent_verlauf.id DESC LIMIT 200`, [identity_id])).rows;
    const bloecke: string[] = [];
    const verwiesen: string[] = [];
    let summe = 0;
    for (const a of ausloeser) {
      const antwort = (await pool.query<UebergabeZeile>(
        `SELECT id::text AS id, rolle, weg, quelle_ref, antwort_auf::text AS antwort_auf, text, werkzeuge, meta, absender, erstellt_am
           FROM hauptagent_verlauf WHERE antwort_auf = $1::bigint`, [a.id])).rows[0];
      const schritte = antwort ? (await pool.query<UebergabeZeile>(
        `SELECT id::text AS id, rolle, weg, quelle_ref, antwort_auf::text AS antwort_auf, text, werkzeuge, meta, absender, erstellt_am
           FROM hauptagent_verlauf WHERE identity_id = $1 AND quelle_ref LIKE 'jsonl:%' AND weg = 'werkzeug'
            AND id > $2::bigint AND id < $3::bigint ORDER BY hauptagent_verlauf.id`, [identity_id, a.id, antwort.id])).rows : [];
      const teile = [`### Zug ${a.id} · ${a.weg} · ${a.erstellt_am.toISOString()}${a.absender?.agent_id ? ' · von ' + String(a.absender.agent_id) : ''}`, a.text];
      for (const c of antwort?.werkzeuge?.calls ?? []) teile.push(werkzeugText(c.name, c.input, c.output));
      for (const sz of schritte) teile.push(sz.rolle === 'ausgabe' ? werkzeugText(sz.meta.name, sz.meta.inhalt ?? sz.text, undefined) : '[Ergebnis] ' + sz.text);
      teile.push('--- Antwort ---', antwort?.text ?? '(keine Antwort)');
      const block = teile.join('\n');
      const t = (await zaehleTokens(block, familie, faktor)).tokens;
      if (summe + t > budget || verwiesen.length) { verwiesen.push(a.id); continue; }
      bloecke.unshift(block);
      summe += t;
    }
    const kurz = [
      '## Kurzstand',
      '- Juengster eigener Handoff: ' + (eigen.rows[0] ? `(thought ${eigen.rows[0].id})\n${eigen.rows[0].content}` : 'keiner'),
      '- Offene Auftraege: ' + (auftraege.rows.length ? auftraege.rows.map((x) => `${x.art} (${x.status}) ${JSON.stringify(x.gewuenscht)}`).join('; ') : 'keine'),
      '- Letzte Anliegen: ' + (ausloeser.slice(0, 10).map((x) => `[${x.id}] ${x.text.split('\n').find((z) => z.trim())?.trim() ?? ''}`).join(' | ') || 'keine'),
    ].join('\n');
    const von = `${vonRuntime ?? '?'}/${vonModell ?? '?'}`;
    const nach = `${ziel.runtime ?? vonRuntime ?? '?'}/${zielModell}`;
    // P22-T65: Effort-Aenderung sichtbar ('Effort X -> Y'); X = gespeicherte Stufe des bisherigen Modells bzw. Standard.
    const vonEffort = ziel.effort && vonModell
      ? (await pool.query<{ e: string | null }>(`SELECT startrezept->'effort_je_modell'->>$2 AS e FROM agent_identitaeten WHERE id = $1`,
        [identity_id, vonModell]).catch(() => ({ rows: [] as Array<{ e: string | null }> }))).rows[0]?.e ?? null : null;
    const effortText = ziel.effort ? `, Effort ${vonEffort ?? 'Standard'} -> ${ziel.effort}` : '';
    const inhalt = [
      `VERLAUF-UEBERGABE (Synapse, Anlass ${anlass}, ${von} -> ${nach}, ${new Date().toISOString()})`,
      'Startkontext aus deinem vollstaendigen Verlauf: die letzten Zuege in voller Laenge, darunter ein Kurzstand. Arbeite daran weiter.',
      kurz, `## Letzte ${bloecke.length} Zuege (voll, ~${summe} Tokens, ${familie})`, ...bloecke,
      ...(verwiesen.length ? [`## Weitere Zuege im Verlauf (nicht mitgegeben, Verlaufs-IDs): ${verwiesen.join(', ')}`] : []),
    ].join('\n\n');
    const thought = await addThought(HAUPTAGENT_PROJEKT, HAUPTAGENT_AGENT_NAME as ThoughtSource, inhalt, ['session-uebergabe', 'verlauf-uebergabe', 'anlass:' + anlass]);
    await pool.query('UPDATE thoughts SET source_identity_id = $2 WHERE id = $1', [thought.id, identity_id]);
    await pool.query(
      `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, status, text, meta, zaehlt, runtime, modell)
       VALUES ($1,'system','intern','wechsel','fertig',$2,$3::jsonb,false,$4,$5)`,
      [identity_id, `Wechsel ${von} -> ${nach}${effortText}, Kontext uebergeben (${bloecke.length} Zuege, ~${summe} Tokens)`,
        JSON.stringify({ von, nach, ...(ziel.effort ? { effort_von: vonEffort, effort: ziel.effort } : {}), anlass, thought_id: thought.id, zuege: bloecke.length, tokens: summe, verfahren: familie, budget, verwiesen: verwiesen.length }),
        ziel.runtime ?? vonRuntime, zielModell]);
    letzteUebergabe = { thought_id: thought.id, anlass, zuege: bloecke.length, tokens: summe, am: new Date().toISOString() };
    return { thought_id: thought.id, zuege: bloecke.length, tokens: summe };
  } catch (error) {
    merkeFehler('uebergabe', error);
    return null;
  }
}
const HAUPTAGENT_AGENT_NAME = 'hauptagent';

// ---------------------------------------------------------------------------------------------
// Stufe 2 A3: vollstaendige Sitzung des Main (Wrapper meldet die Session-JSONL)
// ---------------------------------------------------------------------------------------------
export interface SitzungsEintragEingabe {
  ref: string;
  art: 'eingabe' | 'text' | 'werkzeug_aufruf' | 'werkzeug_ergebnis' | 'denken';
  name?: string | null;
  inhalt: unknown;
  werkzeug_id?: string | null;
  zeit?: string | null;
  modell?: string | null;
  fehler?: boolean;
  /** P22-T67: Bilder eines Werkzeug-Ergebnisses als Asset-Verweis; uebernommen nur ueber bilderAusStrom (nie Daten). */
  bilder?: unknown;
}

const SITZUNGS_ABBILD: Record<SitzungsEintragEingabe['art'], { rolle: VerlaufRolle; richtung: VerlaufRichtung; weg: VerlaufWeg; zaehlt: boolean }> = {
  eingabe: { rolle: 'nachricht', richtung: 'ein', weg: 'lauf', zaehlt: true },
  text: { rolle: 'ausgabe', richtung: 'aus', weg: 'lauf', zaehlt: true },
  werkzeug_aufruf: { rolle: 'ausgabe', richtung: 'aus', weg: 'werkzeug', zaehlt: true },
  werkzeug_ergebnis: { rolle: 'nachricht', richtung: 'ein', weg: 'werkzeug', zaehlt: true },
  // Denkphasen gehen nicht in den Kontext der naechsten Zuege (nur Ausgabe des Zugs).
  denken: { rolle: 'ausgabe', richtung: 'intern', weg: 'lauf', zaehlt: false },
};

/**
 * Sitzungs-Eintraege des dauerhaften Main aufnehmen (quelle_ref jsonl:<ref>, idempotent), voller Inhalt, Lauf = aktuelle
 * Anmeldung. Das ist die vollstaendige Quelle fuer eigene Ausgaben (Channel-Posts/DMs sind Werkzeugaufrufe) und die Zaehlung
 * des dauerhaften Wegs; die Web-UI-/Zustell-Zeilen desselben Zugs sind dann Spiegel (zaehlt false). Nur die Main-Identitaet
 * (sonst grund nicht_main), nur bei hauptagent_verlauf und verlauf_alle_richtungen EIN (sonst funktion_aus).
 */
export async function importiereSitzungsEintraege(identity_id: string | null, eintraege: unknown[], o: { runtime?: string | null } = {}):
  Promise<{ aufgenommen: number; grund: string | null }> {
  const main = await hauptagentIdentitaetsId().catch(() => null);
  if (!identity_id || !main || identity_id !== main) return { aufgenommen: 0, grund: 'nicht_main' };
  if (!(await leseVerlaufSchalter()).aktiv || !(await leseVerlaufStufe2Schalter('verlauf_alle_richtungen')).aktiv) {
    return { aufgenommen: 0, grund: 'funktion_aus' };
  }
  const lauf = await aktuellerMainLauf(identity_id);
  const zaehlen = (await leseTokenZaehlSchalter()).aktiv;
  let aufgenommen = 0;
  for (const roh of eintraege) {
    const e = (roh ?? {}) as Partial<SitzungsEintragEingabe>;
    if (typeof e.ref !== 'string' || !e.ref || !e.art || !(e.art in SITZUNGS_ABBILD)) continue;
    const abbild = SITZUNGS_ABBILD[e.art];
    const text = typeof e.inhalt === 'string' ? e.inhalt : JSON.stringify(e.inhalt ?? null);
    const bilder = e.art === 'werkzeug_ergebnis' ? bilderAusStrom(e.bilder) : [];
    const modell = typeof e.modell === 'string' ? e.modell : await aktuellesMainModell(identity_id);
    let berechnet: Record<string, unknown> | null = null;
    if (zaehlen) {
      const familie = modellFamilie(o.runtime, modell);
      const faktor = (await leseKalibrierung(identity_id, familie))?.faktor ?? null;
      berechnet = zaehlungJson(await zaehleTokens(text, familie, faktor));
    }
    const r = await getPool().query(
      `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, absender, quelle_ref, status, text, meta, tokens, zaehlt, lauf_id,
         runtime, modell, hauptagent_weg, erstellt_am)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'fertig',$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,'dauerhaft',COALESCE($14::timestamptz, NOW()))
       ON CONFLICT (identity_id, quelle_ref) DO NOTHING`,
      [identity_id, abbild.rolle, abbild.richtung, abbild.weg,
        e.art === 'werkzeug_ergebnis' ? JSON.stringify({ agent_id: 'werkzeug' }) : null, 'jsonl:' + e.ref, text,
        JSON.stringify({ quelle: 'jsonl', art: e.art, ...(e.name ? { name: e.name } : {}), ...(e.werkzeug_id ? { werkzeug_id: e.werkzeug_id } : {}),
          ...(e.fehler ? { fehler: true } : {}), ...(bilder.length ? { bilder } : {}),
          ...(typeof e.inhalt === 'string' ? {} : { inhalt: e.inhalt ?? null }) }),
        JSON.stringify(berechnet ? { berechnet } : {}), abbild.zaehlt, lauf, o.runtime ?? null, modell,
        typeof e.zeit === 'string' && !Number.isNaN(Date.parse(e.zeit)) ? e.zeit : null]);
    aufgenommen += r.rowCount ?? 0;
  }
  return { aufgenommen, grund: null };
}

// ---------------------------------------------------------------------------------------------
// Stufe 2 A2: Zustellungen (inbox/chat/channel/event) und die Antwort des Main
// ---------------------------------------------------------------------------------------------
/**
 * Eine erfolgreich zugestellte Nachricht (Ledger agent_zustellungen, wird nicht kopiert, quelle_ref verweist darauf) als
 * Eintrag rolle nachricht/richtung ein mit vollem Inhalt und Absender, dazu die Antwort des Main als Antwortzeile mit
 * gemessenen Tokens (Wrapper-Ergebnis) und eigener Zaehlung. Idempotent (quelle_ref). Nur bei hauptagent_verlauf EIN und
 * verlauf_alle_richtungen EIN. Wirft nie.
 */
export async function schreibeZustellVerlauf(identity_id: string, ledger_id: string | number, z: Zustellung,
  ergebnis: { response?: unknown; tokens?: { input?: unknown; output?: unknown; kontext?: unknown } | null } | null): Promise<{ nachricht_id: string; antwort_id: string | null } | null> {
  try {
    if (!(await leseVerlaufSchalter()).aktiv || !(await leseVerlaufStufe2Schalter('verlauf_alle_richtungen')).aktiv) return null;
    const lauf = await aktuellerMainLauf(identity_id);
    const modell = await aktuellesMainModell(identity_id);
    const absender = { ...z.absender, ...(z.channel ? { channel: z.channel } : {}), ...(z.event_typ ? { event_typ: z.event_typ } : {}),
      ...(z.prioritaet ? { prioritaet: z.prioritaet } : {}) };
    const n = await getPool().query<{ id: string }>(
      `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, absender, quelle_ref, status, text, meta, lauf_id, modell, hauptagent_weg)
       VALUES ($1,'nachricht','ein',$2,$3::jsonb,$4,'fertig',$5,$6::jsonb,$7,$8,'dauerhaft')
       ON CONFLICT (identity_id, quelle_ref) DO NOTHING RETURNING id::text AS id`,
      [identity_id, z.weg, JSON.stringify(absender), 'zustellung:' + ledger_id, z.inhalt,
        JSON.stringify({ message_id: z.message_id, gesendet_am: z.gesendet_am }), lauf, modell]);
    if (!n.rows[0]) return null;
    const nachricht_id = n.rows[0].id;
    if (typeof ergebnis?.response !== 'string') return { nachricht_id, antwort_id: null };
    const a = await getPool().query<{ id: string }>(
      `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, antwort_auf, status, lauf_id, modell, hauptagent_weg)
       VALUES ($1,'agent','aus',$2,$3::bigint,'laeuft',$4,$5,'dauerhaft') RETURNING id::text AS id`, [identity_id, z.weg, nachricht_id, lauf, modell]);
    const antwort_id = a.rows[0].id;
    const w = starteVerlaufAntwort(antwort_id, { modell, identity_id, user_id: nachricht_id, user_text: z.inhalt, runtime: null, lauf_id: lauf });
    w.ereignis('runtime', { hauptagent: { weg: 'dauerhaft' } });
    w.ereignis('delta', { content: ergebnis.response });
    const t = ergebnis.tokens ?? {};
    if (zahl(t.input) + zahl(t.output) > 0) w.ereignis('usage', { inputTokens: t.input, outputTokens: t.output, kontextTokens: t.kontext });
    await w.abschliessen('fertig');
    return { nachricht_id, antwort_id };
  } catch (error) {
    merkeFehler('zustellung_verlauf', error);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------------------------
export interface VerlaufAbfrage {
  limit?: unknown;
  /** Seite: nur Eintraege mit id < vor_id (aeltere nachladen). */
  vor_id?: unknown;
  /** Live-Abgleich: nur seit diesem Stand geaenderte Eintraege. */
  seit_rev?: unknown;
  /** Live-Abgleich: nur Eintraege ab dieser id (aeltere als die geladene Seite interessieren nicht). */
  ab_id?: unknown;
}
export interface VerlaufAntwort {
  verfuegbar: boolean;
  grund?: VerlaufNichtVerfuegbar;
  schalter: VerlaufSchalter;
  identity_id: string | null;
  /** Aufsteigend nach id; nur Eintraege nach dem Ausblenden. */
  eintraege: VerlaufEintrag[];
  /** Nur Seite: es gibt aeltere (sichtbare) Eintraege. */
  mehr: boolean;
  max_rev: string;
  geleert_rev: string;
}

function ganzzahl(v: unknown): string | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(Math.trunc(v)) : typeof v === 'string' ? v.trim() : '';
  return /^\d{1,18}$/.test(s) ? s : null;
}

export async function leseVerlauf(a: VerlaufAbfrage = {}): Promise<VerlaufAntwort> {
  const v = await verfuegbareIdentitaet();
  const leer: VerlaufAntwort = { verfuegbar: false, schalter: v.schalter, identity_id: null, eintraege: [], mehr: false, max_rev: '0', geleert_rev: '0' };
  if ('grund' in v) return { ...leer, grund: v.grund };
  const pool = getPool();
  // Verwaiste laufende Antworten (API neu gestartet, Strom weg) ehrlich abschliessen statt ewig "antwortet …" zu zeigen.
  // P22-T73: kam die Zeile aus der Warteschlange (meta.warteschlange), geht sie dorthin zurueck statt verloren (lieber doppelt
  // zugestellt als nie beantwortet).
  await pool.query(
    `UPDATE hauptagent_verlauf SET status = CASE WHEN meta ? 'warteschlange' THEN 'wartet' ELSE 'abgebrochen' END,
       hinweise = hinweise || CASE WHEN meta ? 'warteschlange' THEN '[]'::jsonb ELSE '["Antwort ohne Abschluss (Strom auf dem Server beendet)"]'::jsonb END,
       rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
     WHERE identity_id = $1 AND status = 'laeuft' AND aktualisiert_am < NOW() - $2::int * interval '1 second'
       AND NOT (id::text = ANY($3::text[]))`,
    [v.identity_id, VERWAIST_NACH_SEKUNDEN, [...aktiveAntworten]]).catch((error) => merkeFehler('verwaist_abschliessen', error));
  const stand = await pool.query<{ geleert_rev: string; ausgeblendet_bis_id: string; max_rev: string }>(
    `SELECT COALESCE((SELECT geleert_rev FROM hauptagent_verlauf_stand WHERE identity_id = $1), 0)::text AS geleert_rev,
            COALESCE((SELECT ausgeblendet_bis_id FROM hauptagent_verlauf_stand WHERE identity_id = $1), 0)::text AS ausgeblendet_bis_id,
            COALESCE((SELECT MAX(rev) FROM hauptagent_verlauf WHERE identity_id = $1), 0)::text AS max_rev`, [v.identity_id]);
  const { geleert_rev, ausgeblendet_bis_id } = stand.rows[0];
  const max_rev = Number(stand.rows[0].max_rev) > Number(geleert_rev) ? stand.rows[0].max_rev : geleert_rev;
  const seit = ganzzahl(a.seit_rev);
  if (seit !== null) {
    // Aenderungen. Zusaetzlich die Zeilen der letzten Sekunden: eine spaeter festgeschriebene Transaktion kann eine kleinere
    // rev tragen als eine schon gesehene; so geht sie nicht verloren (Doppelte fuehrt die Anzeige ueber die id zusammen).
    const ab = Math.max(Number(ganzzahl(a.ab_id) ?? '0'), Number(ausgeblendet_bis_id) + 1);
    const r = await pool.query<Zeile>(
      `SELECT ${SPALTEN} FROM hauptagent_verlauf
        WHERE identity_id = $1 AND id >= $2::bigint AND (rev > $3::bigint OR aktualisiert_am > NOW() - interval '3 seconds')
        ORDER BY hauptagent_verlauf.id LIMIT ${VERLAUF_SEITE_MAX}`,
      [v.identity_id, String(ab), seit]);
    return { ...leer, verfuegbar: true, identity_id: v.identity_id, eintraege: r.rows.map(eintrag), max_rev, geleert_rev };
  }
  const limit = Math.min(VERLAUF_SEITE_MAX, Math.max(1, Number(ganzzahl(a.limit) ?? VERLAUF_SEITE_STANDARD)));
  const r = await pool.query<Zeile>(
    `SELECT ${SPALTEN} FROM hauptagent_verlauf
      WHERE identity_id = $1 AND id > $2::bigint AND ($3::bigint IS NULL OR id < $3::bigint)
      ORDER BY hauptagent_verlauf.id DESC LIMIT $4`,
    [v.identity_id, ausgeblendet_bis_id, ganzzahl(a.vor_id), limit + 1]);
  const mehr = r.rows.length > limit;
  const eintraege = r.rows.slice(0, limit).reverse().map(eintrag);
  return { ...leer, verfuegbar: true, identity_id: v.identity_id, eintraege, mehr, max_rev, geleert_rev };
}

/**
 * 'Verlauf leeren' der Web-UI: nur der User, nur mit bestaetigt:true. Blendet alle bisherigen Eintraege AUS (Anzeige auf
 * allen Geraeten); die Daten bleiben vollstaendig erhalten (Zaehlbasis, Uebergabe), agent_verbrauch wird nicht beruehrt.
 */
export async function leereVerlauf(akteur: AusweisAkteur | null, e: { bestaetigt?: unknown }): Promise<{ ausgeblendet: number; ausgeblendet_bis_id: string; geleert_rev: string }> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Nur der User leert den Verlauf' });
  if (e.bestaetigt !== true) fehler('bestaetigung_fehlt');
  const identity_id = await hauptagentIdentitaetsId();
  if (!identity_id) fehler('keine_hauptagent_identitaet');
  const r = await getPool().query<{ geleert_rev: string; ausgeblendet_bis_id: string; anzahl: number }>(
    `WITH alt AS (SELECT COALESCE((SELECT ausgeblendet_bis_id FROM hauptagent_verlauf_stand WHERE identity_id = $1), 0) AS bis),
          neu AS (SELECT COALESCE(MAX(id), 0) AS bis, COUNT(*) FILTER (WHERE id > (SELECT bis FROM alt))::int AS anzahl
                    FROM hauptagent_verlauf WHERE identity_id = $1)
     INSERT INTO hauptagent_verlauf_stand (identity_id, geleert_rev, ausgeblendet_bis_id, geleert_am, geleert_von, geleert_anzahl)
     SELECT $1, nextval('hauptagent_verlauf_rev'), GREATEST(neu.bis, (SELECT bis FROM alt)), NOW(), 'user', neu.anzahl FROM neu
     ON CONFLICT (identity_id) DO UPDATE SET geleert_rev = EXCLUDED.geleert_rev, ausgeblendet_bis_id = EXCLUDED.ausgeblendet_bis_id,
       geleert_am = EXCLUDED.geleert_am, geleert_von = EXCLUDED.geleert_von, geleert_anzahl = EXCLUDED.geleert_anzahl
     RETURNING geleert_rev::text AS geleert_rev, ausgeblendet_bis_id::text AS ausgeblendet_bis_id, geleert_anzahl AS anzahl`,
    [identity_id]);
  const z = r.rows[0];
  return { ausgeblendet: z.anzahl, ausgeblendet_bis_id: z.ausgeblendet_bis_id, geleert_rev: z.geleert_rev };
}

export interface VerlaufStatus {
  schalter: VerlaufSchalter;
  identity_id: string | null;
  anzahl: number | null;
  sichtbar: number | null;
  laufend: number | null;
  aktiv_in_diesem_prozess: number;
  geleert_am: string | null;
  letzter_fehler: { code: string; am: string } | null;
  lesefehler: string | null;
  /** P22-T63 B: Schalter verlauf_token_zaehlung, Kalibrierung je Familie/Grundlasten, letzte Abweichung ueber der Befundgrenze. */
  token_zaehlung?: { schalter: { aktiv: boolean; quelle: string; letzter_fehler: string | null }; kalibrierung: Record<string, unknown> | null; letzter_befund: { text: string; am: string } | null };
  /** P22-T63 D: letzte Uebergabe dieses Prozesses. */
  letzte_uebergabe?: { thought_id: string; anlass: string; zuege: number; tokens: number; am: string } | null;
  /** P22-T73: Antwortzeilen in der Warteschlange (status 'wartet'). */
  wartend?: number | null;
}

/** Debug-Stand (GET /api/main-agent/verlauf/status). */
export async function verlaufStatus(): Promise<VerlaufStatus> {
  const schalter = await leseVerlaufSchalter();
  const basis: VerlaufStatus = { schalter, identity_id: null, anzahl: null, sichtbar: null, laufend: null, aktiv_in_diesem_prozess: aktiveAntworten.size,
    geleert_am: null, letzter_fehler: letzterSchreibfehler, lesefehler: null };
  try {
    const identity_id = await hauptagentIdentitaetsId();
    if (!identity_id) return basis;
    const r = await getPool().query<{ anzahl: number; sichtbar: number; laufend: number; wartend: number; geleert_am: Date | null }>(
      `WITH s AS (SELECT ausgeblendet_bis_id, geleert_am FROM hauptagent_verlauf_stand WHERE identity_id = $1)
       SELECT (SELECT COUNT(*)::int FROM hauptagent_verlauf WHERE identity_id = $1) AS anzahl,
              (SELECT COUNT(*)::int FROM hauptagent_verlauf WHERE identity_id = $1 AND id > COALESCE((SELECT ausgeblendet_bis_id FROM s), 0)) AS sichtbar,
              (SELECT COUNT(*)::int FROM hauptagent_verlauf WHERE identity_id = $1 AND status = 'laeuft') AS laufend,
              (SELECT COUNT(*)::int FROM hauptagent_verlauf WHERE identity_id = $1 AND status = 'wartet') AS wartend,
              (SELECT geleert_am FROM s) AS geleert_am`, [identity_id]);
    const z = r.rows[0];
    const ts = await leseTokenZaehlSchalter();
    const kal = await getPool().query<{ kalibrierung: Record<string, unknown> }>('SELECT kalibrierung FROM hauptagent_verlauf_stand WHERE identity_id = $1', [identity_id]);
    return { ...basis, identity_id, anzahl: z.anzahl, sichtbar: z.sichtbar, laufend: z.laufend, wartend: z.wartend, geleert_am: z.geleert_am ? z.geleert_am.toISOString() : null,
      token_zaehlung: { schalter: { aktiv: ts.aktiv, quelle: ts.quelle, letzter_fehler: ts.letzter_fehler }, kalibrierung: kal.rows[0]?.kalibrierung ?? null,
        letzter_befund: letzterZaehlBefund }, letzte_uebergabe: letzteUebergabe };
  } catch (error) {
    return { ...basis, lesefehler: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}
