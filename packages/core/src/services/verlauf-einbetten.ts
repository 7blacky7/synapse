/**
 * P22-T157 (User 25.10.2026, Entwurf e8d2f0dc Fassung 2, GO mit R1-R8): Sitzungsverlaeufe semantisch durchsuchbar.
 *
 * QUELLE: hauptagent_verlauf (Schema 124; CLI-Transkript ueber cli-verlauf P22-T133, Wrapper, Zustellungen). PG bleibt die
 *   Wahrheit. Zerlegt und eingebettet werden NUR Identitaeten MIT Ausweis (aktiv, nicht widerrufener Ausweis); Legacy-Agenten
 *   bleiben aussen vor. Subagenten-Verlaeufe (P22-T158) kommen ohne Aenderung mit, sobald sie in hauptagent_verlauf stehen.
 * SPEICHER (Schema 153): verlauf_stuecke = geschwaerzte Stuecke (genau der eingebettete Text), verlauf_einbett_stand = Schnitt
 *   je Identitaet. Qdrant: EINE Collection 'agent_verlauf' mit Pflichtfilter identity_id (Payload-Index is_tenant). Den Filter
 *   setzt NUR sucheVerlauf, immer aus dem Ausweis-Principal, nie aus Tool-Parametern.
 * AUSLOESER (R6): chat(anmelden) setzt den alten Lauf auf 'abgeloest'; der naechste Nachzug-Tick zerlegt alle noch nicht
 *   zerlegten Zeilen bis zum Schnitt. Zeilen des AKTIVEN Laufs erst ab VERLAUF_EINBETTEN_ALTER (Standard 6 h). Schnitt nach
 *   hauptagent_verlauf.id; er bleibt vor der ersten Zeile mit status laeuft/wartet stehen, eine angefangene Turn-Gruppe wartet.
 *   Kein Eingriff in den Anmeldeweg (agent-identitaet.ts).
 * ZERLEGUNG: Turn-Gruppe = Eingabe (User, Nachricht, CLI-Eingabe) bis zur naechsten Eingabe. Eigene Ausgaben voll, Werkzeug-
 *   aufrufe verdichtet (300 Zeichen, Schreibwerkzeuge 1500), Werkzeugergebnisse 200 Zeichen (R7), keine Denkphasen. Stuecke
 *   2000 Zeichen mit 200 Ueberlappung plus Kopf. Schwaerzung VOR dem Speichern (wie logToolCall, Ausweise, Erklaerungs-Maske).
 * PRIORITAET GANZ HINTEN: eigener Worker 'verlauf_nachzug' im Parser-Tick nach dem Wissens-Nachzug; eingebettet wird nur, wenn
 *   kein Wissens-Rueckstand, kein offener Code-Chunk (aktive Projekte), die Embedding-Queue leer ist und der intern-Schalter
 *   embedding nicht anhaelt. Stapel klein (SYNAPSE_VERLAUF_STAPEL, Standard 32), priority background.
 * SCHALTER (Produkt-Schalter, Standard AUS, nur ausdruecklich): verlauf_einbetten (Zerlegen + Einbetten), verlauf_suche
 *   (search action verlauf). DEBUG: verlaufEinbettStatus() ueber intern(status) Quelle verlauf_einbetten.
 */
import { v5 as uuidv5 } from 'uuid';
import { createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { embed, getEmbeddingQueueStats } from '../embeddings/index.js';
import { aktivesModellprofil } from '../embeddings/modell-profil.js';
import { ensureCollection, collectionExists, searchVectors, getQdrantClient } from '../qdrant/index.js';
import { betteStapelEin, type NachzugPunkt, type NachzugQuelle } from './embed-nachzug.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { schalterHaeltAn } from './intern-schalter.js';
import { schwaerzeToolLogTextMitRegeln } from './tool-args-schwaerzen.js';
import { maskiereAusweise } from './agent-profil-dienst-a.js';
import { schwaerzeGeheimnisse } from './masken-katalog.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';

export const VERLAUF_EINBETTEN_FUNKTION = 'verlauf_einbetten' as const;
export const VERLAUF_SUCHE_FUNKTION = 'verlauf_suche' as const;
export const VERLAUF_COLLECTION = 'agent_verlauf';
export const VERLAUF_STUECK_ZEICHEN = 2000;
export const VERLAUF_STUECK_OVERLAP = 200;
/** Bei Aenderung von Zerlegung/Grenzen erhoehen (neue Stueck-IDs, Altbestand bleibt bis zum Neuaufbau). */
export const VERLAUF_ZERLEGER_VERSION = '1:2000:200:v1';
const WERKZEUG_AUFRUF_MAX = 300;
const SCHREIBWERKZEUG_MAX = 1500;
const WERKZEUG_ERGEBNIS_MAX = 200;
const SCHREIBWERKZEUG = /(^|__)(thought|channel|plan|memory|chat|proposal)$|^(SendMessage|Agent|Task)$/;
const NAMENSRAUM = '5f0c8b52-3c1e-4d7a-9b61-7e2a1c9d4f30';
const STANDARD_SPANNE_TAGE = 7;
const STANDARD_SCORE = 0.3;

function envZahl(name: string, ersatz: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : ersatz;
}
/** Zeilen des aktiven Laufs werden erst ab diesem Alter zerlegt (lange laufende Koordinatoren). */
export function verlaufEinbettenAlterMs(): number { return envZahl('SYNAPSE_VERLAUF_EINBETTEN_ALTER_MIN', 360) * 60_000; }
function stapelGroesse(): number { return Math.floor(envZahl('SYNAPSE_VERLAUF_STAPEL', 32)); }
const ZEILEN_JE_LAUF = 2000;
const IDENTITAETEN_JE_TICK = 5;

// ---------------------------------------------------------------------------------------------
// Reine Teile: Zeilentext, Zerlegung, Stuecke, Schwaerzung
// ---------------------------------------------------------------------------------------------
export interface VerlaufZeileRoh {
  id: string;
  rolle: string;
  richtung: string;
  weg: string;
  status: string;
  text: string | null;
  meta: Record<string, unknown> | null;
  absender: Record<string, unknown> | null;
  lauf_id: string | null;
  erstellt_am: Date | string;
  context_epoch?: number | null;
}
export interface VerlaufGruppe {
  von_id: string;
  bis_id: string;
  zeit_von: Date;
  zeit_bis: Date;
  lauf_id: string | null;
  context_epoch: number | null;
  rollen: string[];
  zeilen: string[];
}

const zeitMs = (z: VerlaufZeileRoh): number => new Date(z.erstellt_am).getTime();
function einzeilig(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + ' …' : t;
}
/** Beginnt mit dieser Zeile eine neue Turn-Gruppe (Eingabe von aussen)? */
export function istGruppenStart(z: Pick<VerlaufZeileRoh, 'rolle' | 'weg'>): boolean {
  return z.rolle === 'user' || (z.rolle === 'nachricht' && z.weg !== 'werkzeug');
}

/** Eine Verlaufszeile als Textzeile der Gruppe (null = nicht einbetten, z. B. Denkphase). Rein. */
export function verlaufZeileText(z: VerlaufZeileRoh): string | null {
  const text = (z.text ?? '').trim();
  const meta = z.meta ?? {};
  const art = typeof meta.art === 'string' ? meta.art : null;
  if (z.richtung === 'intern' && z.weg === 'lauf') return null;
  if (z.rolle === 'ausgabe' && z.weg === 'werkzeug') {
    const name = typeof meta.name === 'string' && meta.name ? meta.name : 'werkzeug';
    return `→ ${name}: ${einzeilig(text, SCHREIBWERKZEUG.test(name) ? SCHREIBWERKZEUG_MAX : WERKZEUG_AUFRUF_MAX)}`;
  }
  if (z.rolle === 'nachricht' && z.weg === 'werkzeug') return `← ${meta.fehler ? 'fehler' : 'ok'}: ${einzeilig(text, WERKZEUG_ERGEBNIS_MAX)}`;
  if (!text) return null;
  if (z.rolle === 'user') return `User: ${text}`;
  if (z.rolle === 'nachricht') {
    const ab = z.absender ?? {};
    const von = typeof ab.agent_id === 'string' && ab.agent_id ? ab.agent_id : null;
    if (ab.herkunft === 'cli') return `User (CLI): ${text}`;
    if (art === 'eingabe' && !von) return `Eingabe: ${text}`;
    return `Nachricht${z.weg !== 'lauf' ? ` (${z.weg})` : ''}${von ? ` von ${von}` : ''}: ${text}`;
  }
  if (z.rolle === 'agent' || z.rolle === 'ausgabe') return `Agent: ${text}`;
  if (z.rolle === 'system') return `[System] ${einzeilig(text, 300)}`;
  return null;
}

export interface ZerlegeOptionen {
  /** lauf_id des aktiven Laufs der Identitaet (null = keiner). */
  aktiverLauf: string | null;
  jetztMs: number;
  alterMs: number;
  /** true = es gibt weitere, nicht geladene Zeilen hinter dem Ausschnitt. */
  mehrVorhanden: boolean;
}

/**
 * Zerlegt einen aufsteigenden Ausschnitt in fertige Turn-Gruppen (rein). bis_id = letzte Zeile der letzten FERTIGEN Gruppe
 * (null = noch nichts schnittreif). Reif ist eine Zeile, wenn sie nicht laeuft/wartet und ihr Lauf abgeloest bzw. sie alt genug ist.
 */
export function zerlegeVerlauf(zeilen: readonly VerlaufZeileRoh[], o: ZerlegeOptionen): { gruppen: VerlaufGruppe[]; bis_id: string | null } {
  const reif = (z: VerlaufZeileRoh) => z.status !== 'laeuft' && z.status !== 'wartet'
    && (z.lauf_id === null || z.lauf_id !== o.aktiverLauf || o.jetztMs - zeitMs(z) >= o.alterMs);
  let n = 0;
  while (n < zeilen.length && reif(zeilen[n])) n++;
  const praefix = zeilen.slice(0, n);
  const naechste = n < zeilen.length ? zeilen[n] : null;
  const gruppen: VerlaufGruppe[] = [];
  let akt: VerlaufGruppe | null = null;
  for (const z of praefix) {
    if (!akt || istGruppenStart(z)) {
      akt = { von_id: z.id, bis_id: z.id, zeit_von: new Date(z.erstellt_am), zeit_bis: new Date(z.erstellt_am), lauf_id: z.lauf_id,
        context_epoch: z.context_epoch ?? null, rollen: [], zeilen: [] };
      gruppen.push(akt);
    }
    akt.bis_id = z.id;
    if (zeitMs(z) > akt.zeit_bis.getTime()) akt.zeit_bis = new Date(z.erstellt_am);
    if (zeitMs(z) < akt.zeit_von.getTime()) akt.zeit_von = new Date(z.erstellt_am);
    if (!akt.lauf_id && z.lauf_id) akt.lauf_id = z.lauf_id;
    if (akt.context_epoch === null && typeof z.context_epoch === 'number') akt.context_epoch = z.context_epoch;
    if (!akt.rollen.includes(z.rolle)) akt.rollen.push(z.rolle);
    const zeile = verlaufZeileText(z);
    if (zeile) akt.zeilen.push(zeile);
  }
  if (gruppen.length) {
    // Letzte Gruppe fertig? Folgt eine geladene Zeile, nur wenn sie eine neue Gruppe beginnt; fehlen geladene Zeilen
    // (Ausschnitt voll), wartet sie - ausser sie ist die einzige (Riesengruppe ueber den ganzen Ausschnitt).
    const fertig = naechste ? istGruppenStart(naechste) : !o.mehrVorhanden;
    if (!fertig && !(gruppen.length === 1 && !naechste && o.mehrVorhanden)) gruppen.pop();
  }
  return { gruppen, bis_id: gruppen.length ? gruppen[gruppen.length - 1].bis_id : null };
}

/** Text in Stuecke (2000 Zeichen, 200 Ueberlappung), zeichenweise wie wissen-stuecke. Rein. */
export function teileVerlaufText(text: string): string[] {
  const zeichen = Array.from(text);
  const stuecke: string[] = [];
  for (let start = 0; start < zeichen.length; start += VERLAUF_STUECK_ZEICHEN - VERLAUF_STUECK_OVERLAP) {
    const ende = Math.min(zeichen.length, start + VERLAUF_STUECK_ZEICHEN);
    stuecke.push(zeichen.slice(start, ende).join(''));
    if (ende === zeichen.length) break;
  }
  return stuecke;
}

/** Schwaerzung vor jedem Speichern: wie logToolCall (schwaerzeToolLogText), Ausweise, Erklaerungs-Maske. Rein. */
export function schwaerzeVerlaufText(text: string): { text: string; treffer: number } {
  const b = schwaerzeToolLogTextMitRegeln(text);
  let t = typeof b.text === 'string' ? b.text : text;
  let treffer = Object.values(b.treffer).reduce<number>((s, n) => s + (n ?? 0), 0);
  const ohneAusweis = maskiereAusweise(t);
  if (ohneAusweis !== t) { treffer += (t.match(/sai_[A-Za-z0-9_-]{8,}/g) ?? []).length || 1; t = ohneAusweis; }
  const g = schwaerzeGeheimnisse(t);
  return { text: g.text, treffer: treffer + g.treffer };
}

function kopfZeit(d: Date): string { return d.toISOString().slice(0, 16).replace('T', ' '); }

export interface VerlaufStueckEntwurf { stueck_nr: number; text: string; schwaerz_treffer: number }
/** Geschwaerzte Stuecke einer Gruppe mit Kopf [agent · von–bis UTC · Lauf]. Leere Gruppen ergeben nichts. Rein. */
export function verlaufStueckeAus(g: VerlaufGruppe, agent: string): VerlaufStueckEntwurf[] {
  const roh = g.zeilen.join('\n');
  if (!roh.trim()) return [];
  const s = schwaerzeVerlaufText(roh);
  const kopf = `[${agent} · ${kopfZeit(g.zeit_von)}–${kopfZeit(g.zeit_bis)} UTC · Lauf ${(g.lauf_id ?? '-').slice(0, 8)}]`;
  return teileVerlaufText(s.text).map((t, i) => ({ stueck_nr: i, text: kopf + '\n' + t, schwaerz_treffer: i === 0 ? s.treffer : 0 }));
}

/** Deterministische Stueck-ID (= Qdrant-Punkt-ID): gleiche Zerlegung -> gleiche ID, Neuaufbau ersetzt statt verdoppelt. */
export function verlaufStueckId(identity_id: string, von_id: string, stueck_nr: number): string {
  return uuidv5(`${identity_id}:${von_id}:${stueck_nr}:${VERLAUF_ZERLEGER_VERSION}`, NAMENSRAUM);
}

// ---------------------------------------------------------------------------------------------
// Abhaengigkeiten (Embedding/Qdrant); Tests ersetzen sie, die Logik bleibt dieselbe
// ---------------------------------------------------------------------------------------------
export interface VerlaufAbhaengigkeiten {
  embedQuery(text: string): Promise<number[]>;
  sucheVektoren(vektor: number[], limit: number, filter: Record<string, unknown>): Promise<Array<{ id: string; score: number }>>;
  betteEin(ids: string[]): Promise<number>;
}
let collectionBereit = false;
async function sichereVerlaufCollection(): Promise<void> {
  if (collectionBereit) return;
  await ensureCollection(VERLAUF_COLLECTION);
  const c = getQdrantClient();
  try {
    await c.createPayloadIndex(VERLAUF_COLLECTION, { field_name: 'identity_id', field_schema: { type: 'keyword', is_tenant: true } as never, wait: true });
  } catch {
    await c.createPayloadIndex(VERLAUF_COLLECTION, { field_name: 'identity_id', field_schema: 'keyword', wait: true }).catch(() => undefined);
  }
  for (const f of ['zeit_von_ts', 'zeit_bis_ts']) {
    await c.createPayloadIndex(VERLAUF_COLLECTION, { field_name: f, field_schema: 'integer', wait: true }).catch(() => undefined);
  }
  collectionBereit = true;
}
const STANDARD_ABH: VerlaufAbhaengigkeiten = {
  embedQuery: (text) => embed(text, { art: 'query' }),
  async sucheVektoren(vektor, limit, filter) {
    if (!(await collectionExists(VERLAUF_COLLECTION))) return [];
    const r = await searchVectors<Record<string, unknown>>(VERLAUF_COLLECTION, vektor, limit, filter);
    return r.map((x) => ({ id: String(x.id), score: x.score }));
  },
  async betteEin(ids) {
    await sichereVerlaufCollection();
    return betteStapelEin(verlaufStueckNachzug, ids, { priority: 'background', admissionSource: 'verlauf' });
  },
};
let abh: VerlaufAbhaengigkeiten = STANDARD_ABH;
/** NUR Tests: Embedding/Qdrant ersetzen (null = Standard). */
export function setzeVerlaufAbhaengigkeitenFuerTests(neu: Partial<VerlaufAbhaengigkeiten> | null): void {
  abh = neu ? { ...STANDARD_ABH, ...neu } : STANDARD_ABH;
}

/** Nachzug-Quelle der Stuecke (Stapelweg embed-nachzug). Payload ohne Text: Auszug kommt aus PG. */
export const verlaufStueckNachzug: NachzugQuelle = {
  tabelle: 'verlauf_stuecke',
  idSpalte: 'id',
  idTyp: 'uuid',
  standSql: 't.stand',
  modellSpalte: true,
  async lese(ids: string[]): Promise<NachzugPunkt[]> {
    if (!ids.length) return [];
    const { rows } = await getPool().query<{ id: string; identity_id: string; agent_id: string; project: string | null; lauf_id: string | null;
      context_epoch: number | null; von: string; bis: string; zeit_von: Date; zeit_bis: Date; rollen: string[]; text: string; stand: string }>(
      `SELECT t.id::text AS id, t.identity_id, t.agent_id, t.project, t.lauf_id, t.context_epoch, t.von_verlauf_id::text AS von,
              t.bis_verlauf_id::text AS bis, t.zeit_von, t.zeit_bis, t.rollen, t.text, t.stand
         FROM verlauf_stuecke t WHERE t.id = ANY($1::uuid[])`, [ids]);
    return rows.map((r) => ({
      id: r.id, project: r.project, collection: VERLAUF_COLLECTION, text: r.text, stand: r.stand,
      payload: { identity_id: r.identity_id, agent_id: r.agent_id, project: r.project, lauf_id: r.lauf_id, context_epoch: r.context_epoch,
        von_id: Number(r.von), bis_id: Number(r.bis), zeit_von_ts: r.zeit_von.getTime(), zeit_bis_ts: r.zeit_bis.getTime(),
        zeit_von: r.zeit_von.toISOString(), zeit_bis: r.zeit_bis.toISOString(), rollen: r.rollen, zerleger_version: VERLAUF_ZERLEGER_VERSION },
    }));
  },
};

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export async function leseVerlaufEinbettSchalter(art: 'einbetten' | 'suche'): Promise<{ funktion: string; aktiv: boolean; quelle: string; letzter_fehler: string | null }> {
  const funktion = art === 'einbetten' ? VERLAUF_EINBETTEN_FUNKTION : VERLAUF_SUCHE_FUNKTION;
  const s = await leseProfilProduktSchalter(funktion, null);
  return { funktion, aktiv: s.aktiv && !s.letzter_fehler, quelle: s.quelle, letzter_fehler: s.letzter_fehler ?? null };
}

// ---------------------------------------------------------------------------------------------
// Zerlegen (PG)
// ---------------------------------------------------------------------------------------------
interface ProzessStand {
  letzter_lauf: { am: string; dauer_ms: number; identitaeten: number; neue_stuecke: number; eingebettet: number } | null;
  wartegrund: string | null;
  wartegrund_am: string | null;
  letzter_fehler: { code: string; am: string } | null;
}
const prozess: ProzessStand = { letzter_lauf: null, wartegrund: null, wartegrund_am: null, letzter_fehler: null };
function merkeFehler(code: string, e: unknown): void {
  prozess.letzter_fehler = { code: code + ': ' + (e instanceof Error ? e.message : String(e)).slice(0, 300), am: new Date().toISOString() };
}

/** Faellige Identitaeten: aktiv, mit Ausweis, mit Verlaufszeilen hinter dem Schnitt. */
async function faelligeIdentitaeten(limit: number): Promise<Array<{ identity_id: string; agent_id: string; project: string | null }>> {
  const { rows } = await getPool().query<{ identity_id: string; agent_id: string; project: string | null }>(
    `SELECT i.id AS identity_id, i.agent_id, i.project
       FROM agent_identitaeten i
       LEFT JOIN verlauf_einbett_stand s ON s.identity_id = i.id
      WHERE i.status = 'aktiv'
        AND EXISTS (SELECT 1 FROM agent_identitaet_tokens t WHERE t.identity_id = i.id AND t.widerrufen_am IS NULL)
        AND EXISTS (SELECT 1 FROM hauptagent_verlauf v WHERE v.identity_id = i.id AND v.id > COALESCE(s.bis_verlauf_id, 0))
      ORDER BY s.zuletzt_am NULLS FIRST, i.id
      LIMIT $1`, [limit]);
  return rows;
}

/** Zerlegt den schnittreifen Teil des Verlaufs EINER Identitaet in Stuecke (idempotent, deterministische IDs). */
export async function zerlegeVerlaufVon(identity_id: string, o: { jetztMs?: number } = {}): Promise<{ neue_stuecke: number; bis_verlauf_id: string | null; zeilen: number }> {
  const t0 = Date.now();
  const pool = getPool();
  const ident = (await pool.query<{ agent_id: string; project: string | null }>(
    `SELECT i.agent_id, i.project FROM agent_identitaeten i WHERE i.id = $1 AND i.status = 'aktiv'
        AND EXISTS (SELECT 1 FROM agent_identitaet_tokens t WHERE t.identity_id = i.id AND t.widerrufen_am IS NULL)`, [identity_id])).rows[0];
  if (!ident) return { neue_stuecke: 0, bis_verlauf_id: null, zeilen: 0 };
  const stand = (await pool.query<{ bis: string }>('SELECT bis_verlauf_id::text AS bis FROM verlauf_einbett_stand WHERE identity_id = $1', [identity_id])).rows[0]?.bis ?? '0';
  const lauf = (await pool.query<{ id: string }>("SELECT id FROM agent_identitaet_laeufe WHERE identity_id = $1 AND status = 'aktiv'", [identity_id])).rows[0]?.id ?? null;
  const r = await pool.query<VerlaufZeileRoh>(
    `SELECT v.id::text AS id, v.rolle, v.richtung, v.weg, v.status, v.text, v.meta, v.absender, v.lauf_id, v.erstellt_am, l.context_epoch
       FROM hauptagent_verlauf v LEFT JOIN agent_identitaet_laeufe l ON l.id = v.lauf_id
      WHERE v.identity_id = $1 AND v.id > $2::bigint ORDER BY v.id LIMIT $3`, [identity_id, stand, ZEILEN_JE_LAUF + 1]);
  const mehr = r.rows.length > ZEILEN_JE_LAUF;
  const zeilen = r.rows.slice(0, ZEILEN_JE_LAUF);
  const { gruppen, bis_id } = zerlegeVerlauf(zeilen, { aktiverLauf: lauf, jetztMs: o.jetztMs ?? Date.now(), alterMs: verlaufEinbettenAlterMs(), mehrVorhanden: mehr });
  const client = await pool.connect();
  let neu = 0, treffer = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['verlauf_einbetten:' + identity_id]);
    // Ein Statement je Lauf (unnest); rollen als kommagetrennter Text, weil unnest keine Array-Spalten je Zeile kennt.
    const sp: { id: string[]; lauf: Array<string | null>; epoch: Array<number | null>; von: string[]; bis: string[]; zv: Date[]; zb: Date[];
      nr: number[]; rollen: string[]; text: string[]; stand: string[]; tr: number[] } =
      { id: [], lauf: [], epoch: [], von: [], bis: [], zv: [], zb: [], nr: [], rollen: [], text: [], stand: [], tr: [] };
    for (const g of gruppen) {
      for (const s of verlaufStueckeAus(g, ident.agent_id)) {
        sp.id.push(verlaufStueckId(identity_id, g.von_id, s.stueck_nr)); sp.lauf.push(g.lauf_id); sp.epoch.push(g.context_epoch);
        sp.von.push(g.von_id); sp.bis.push(g.bis_id); sp.zv.push(g.zeit_von); sp.zb.push(g.zeit_bis); sp.nr.push(s.stueck_nr);
        sp.rollen.push(g.rollen.join(',')); sp.text.push(s.text); sp.stand.push(createHash('md5').update(s.text).digest('hex'));
        sp.tr.push(s.schwaerz_treffer);
        treffer += s.schwaerz_treffer;
      }
    }
    if (sp.id.length) {
      const ins = await client.query(
        `INSERT INTO verlauf_stuecke (id, identity_id, agent_id, project, lauf_id, context_epoch, von_verlauf_id, bis_verlauf_id, zeit_von, zeit_bis,
           stueck_nr, rollen, text, stand, schwaerz_treffer, zerleger_version)
         SELECT u.id, $1::text, $2::text, $3::text, u.lauf, u.epoch, u.von, u.bis, u.zv, u.zb, u.nr, string_to_array(u.rollen, ','), u.text, u.stand, u.tr, $4::text
           FROM unnest($5::uuid[], $6::text[], $7::int[], $8::bigint[], $9::bigint[], $10::timestamptz[], $11::timestamptz[], $12::int[],
                       $13::text[], $14::text[], $15::text[], $16::int[])
                AS u(id, lauf, epoch, von, bis, zv, zb, nr, rollen, text, stand, tr)
         ON CONFLICT DO NOTHING`,
        [identity_id, ident.agent_id, ident.project, VERLAUF_ZERLEGER_VERSION, sp.id, sp.lauf, sp.epoch, sp.von, sp.bis, sp.zv, sp.zb, sp.nr,
          sp.rollen, sp.text, sp.stand, sp.tr]);
      neu = ins.rowCount ?? 0;
    }
    await client.query(
      `INSERT INTO verlauf_einbett_stand (identity_id, bis_verlauf_id, letzter_lauf, zuletzt_am, letzte_dauer_ms, stuecke_gesamt, schwaerz_treffer, letzter_fehler)
       VALUES ($1, COALESCE($2::bigint, 0), $3, NOW(), $4, $5, $6, NULL)
       ON CONFLICT (identity_id) DO UPDATE SET
         bis_verlauf_id = GREATEST(verlauf_einbett_stand.bis_verlauf_id, COALESCE($2::bigint, 0)),
         letzter_lauf = COALESCE($3, verlauf_einbett_stand.letzter_lauf), zuletzt_am = NOW(), letzte_dauer_ms = $4,
         stuecke_gesamt = verlauf_einbett_stand.stuecke_gesamt + $5, schwaerz_treffer = verlauf_einbett_stand.schwaerz_treffer + $6,
         letzter_fehler = NULL`,
      [identity_id, bis_id, lauf, Date.now() - t0, neu, treffer]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    await pool.query(
      `INSERT INTO verlauf_einbett_stand (identity_id, zuletzt_am, letzter_fehler) VALUES ($1, NOW(), $2)
       ON CONFLICT (identity_id) DO UPDATE SET zuletzt_am = NOW(), letzter_fehler = $2`,
      [identity_id, (e instanceof Error ? e.message : String(e)).slice(0, 300)]).catch(() => undefined);
    throw e;
  } finally { client.release(); }
  return { neue_stuecke: neu, bis_verlauf_id: bis_id, zeilen: zeilen.length };
}

// ---------------------------------------------------------------------------------------------
// Nachzug-Schritt (Worker verlauf_nachzug)
// ---------------------------------------------------------------------------------------------
/** Grund, warum der Verlauf gerade NICHT eingebettet wird (null = frei). Alles andere geht vor. */
export async function verlaufVorrangGrund(wissenRest: number): Promise<string | null> {
  if (await schalterHaeltAn('embedding', 'verlauf-nachzug')) return 'embedding_angehalten';
  if (wissenRest > 0) return 'wissen_rueckstand';
  const q = getEmbeddingQueueStats();
  if (q.active.interactive + q.active.background + q.queued.interactive + q.queued.background > 0) return 'queue_belegt';
  const c = await getPool().query<{ offen: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM code_chunks cc WHERE cc.embedded_at IS NULL
        AND EXISTS (SELECT 1 FROM projects p WHERE p.name = cc.project AND p.enabled)) AS offen`);
  if (c.rows[0]?.offen) return 'code_rueckstand';
  return null;
}

export interface VerlaufNachzugErgebnis {
  status: 'schalter_aus' | 'wartet' | 'ok' | 'fehler';
  identitaeten: number;
  neue_stuecke: number;
  eingebettet: number;
  wartegrund?: string | null;
  fehler?: string;
}

/**
 * Ein Nachzug-Schritt: faellige Identitaeten zerlegen (billig, nur PG), dann - nur wenn alles andere frei ist - einen
 * kleinen Stapel offener Stuecke einbetten. wissenRest = was der Wissens-Nachzug in diesem Tick noch vorfand.
 * erzwingen (worker_durchlauf): Vorrang uebergehen, nur der Schalter embedding haelt an.
 */
export async function verlaufNachzugSchritt(o: { wissenRest?: number; erzwingen?: boolean } = {}): Promise<VerlaufNachzugErgebnis> {
  const t0 = Date.now();
  const leer = { identitaeten: 0, neue_stuecke: 0, eingebettet: 0 };
  const schalter = await leseVerlaufEinbettSchalter('einbetten');
  if (!schalter.aktiv) { prozess.wartegrund = 'schalter_aus'; prozess.wartegrund_am = new Date().toISOString(); return { status: 'schalter_aus', ...leer }; }
  let identitaeten = 0, neue = 0, eingebettet = 0;
  try {
    for (const i of await faelligeIdentitaeten(IDENTITAETEN_JE_TICK)) {
      identitaeten++;
      try { neue += (await zerlegeVerlaufVon(i.identity_id)).neue_stuecke; } catch (e) { merkeFehler('zerlegen ' + i.agent_id, e); }
    }
    const grund = o.erzwingen ? ((await schalterHaeltAn('embedding', 'verlauf-nachzug')) ? 'embedding_angehalten' : null) : await verlaufVorrangGrund(o.wissenRest ?? 0);
    prozess.wartegrund = grund; prozess.wartegrund_am = new Date().toISOString();
    if (grund) return { status: 'wartet', identitaeten, neue_stuecke: neue, eingebettet: 0, wartegrund: grund };
    const ids = (await getPool().query<{ id: string }>(
      'SELECT id::text AS id FROM verlauf_stuecke WHERE embedded_at IS NULL ORDER BY zeit_von, id LIMIT $1', [stapelGroesse()])).rows.map((r) => r.id);
    if (ids.length) eingebettet = await abh.betteEin(ids);
    prozess.letzter_lauf = { am: new Date().toISOString(), dauer_ms: Date.now() - t0, identitaeten, neue_stuecke: neue, eingebettet };
    return { status: 'ok', identitaeten, neue_stuecke: neue, eingebettet, wartegrund: null };
  } catch (e) {
    merkeFehler('nachzug', e);
    return { status: 'fehler', identitaeten, neue_stuecke: neue, eingebettet, fehler: e instanceof Error ? e.message : String(e) };
  }
}

/** Debug (intern status, Quelle verlauf_einbetten): Schalter, Rueckstand je Identitaet, letzter Lauf, Wartegrund, Fehler. */
export async function verlaufEinbettStatus(): Promise<Record<string, unknown>> {
  const [einbetten, suche] = await Promise.all([leseVerlaufEinbettSchalter('einbetten'), leseVerlaufEinbettSchalter('suche')]);
  const basis = { schalter: { verlauf_einbetten: einbetten, verlauf_suche: suche }, collection: VERLAUF_COLLECTION,
    zerleger_version: VERLAUF_ZERLEGER_VERSION, alter_aktiver_lauf_min: verlaufEinbettenAlterMs() / 60_000, stapel: stapelGroesse(), ...prozess };
  try {
    const { rows } = await getPool().query(
      `SELECT i.agent_id, i.id AS identity_id, COALESCE(s.bis_verlauf_id, 0)::text AS bis_verlauf_id, s.letzter_lauf, s.zuletzt_am, s.letzte_dauer_ms,
              COALESCE(s.schwaerz_treffer, 0)::int AS schwaerz_treffer, s.letzter_fehler,
              (SELECT count(*)::int FROM hauptagent_verlauf v WHERE v.identity_id = i.id AND v.id > COALESCE(s.bis_verlauf_id, 0)) AS offene_zeilen,
              (SELECT count(*)::int FROM verlauf_stuecke st WHERE st.identity_id = i.id) AS stuecke,
              (SELECT count(*)::int FROM verlauf_stuecke st WHERE st.identity_id = i.id AND st.embedded_at IS NOT NULL) AS eingebettet
         FROM agent_identitaeten i LEFT JOIN verlauf_einbett_stand s ON s.identity_id = i.id
        WHERE EXISTS (SELECT 1 FROM hauptagent_verlauf v WHERE v.identity_id = i.id)
        ORDER BY i.agent_id`);
    const offen = rows.reduce((n: number, r: { stuecke: number; eingebettet: number }) => n + r.stuecke - r.eingebettet, 0);
    return { ...basis, stuecke_offen: offen, je_identitaet: rows };
  } catch (e) {
    return { ...basis, lesefehler: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Suche: search(action:'verlauf') - nur der eigene Verlauf je Ausweis
// ---------------------------------------------------------------------------------------------
/** Parameter der search-Action verlauf (REST- und stdio-Definition). */
export const VERLAUF_SUCHE_PROPERTIES = {
  seit: { type: 'string', description: 'verlauf: ab Zeitpunkt (ISO); Standard bis minus 7 Tage.' },
  bis: { type: 'string', description: 'verlauf: bis Zeitpunkt (ISO); Standard jetzt.' },
  lauf_id: { type: 'string', description: 'verlauf: nur dieser Lauf.' },
  verlauf_id: { type: 'string', description: 'verlauf: Verlaufszeile zum Nachlesen (mit umfeld), statt query.' },
  umfeld: { type: 'number', description: 'verlauf mit verlauf_id: Zeilen davor/danach (Standard 5, max 20).' },
} as const;

export interface VerlaufSucher { identity_id: string; agent_id: string }

function zeitParam(v: unknown): number | null | 'ungueltig' {
  if (v === undefined || v === null || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : 'ungueltig';
}
function ganzzahlText(v: unknown): string | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(Math.trunc(v)) : typeof v === 'string' ? v.trim() : '';
  return /^\d{1,18}$/.test(s) ? s : null;
}
function auszug(text: string, query: string): string {
  const koerper = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text;
  const woerter = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 4);
  const klein = koerper.toLowerCase();
  let pos = -1;
  for (const w of woerter) { const p = klein.indexOf(w); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
  const start = Math.max(0, pos - 80);
  const teil = koerper.slice(start, start + 300).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '… ' : '') + teil + (start + 300 < koerper.length ? ' …' : '');
}
async function scoreGrenze(): Promise<number> {
  const env = Number(process.env.SYNAPSE_VERLAUF_SCORE_MIN);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const p = await aktivesModellprofil() as unknown as { scoreSchwellen?: Record<string, unknown> } | null;
    const v = p?.scoreSchwellen?.verlauf;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  } catch { /* Standard */ }
  return STANDARD_SCORE;
}

/** Verlaufszeilen rund um verlauf_id (nur eigene Identitaet), geschwaerzt. */
async function leseVerlaufUmfeld(wer: VerlaufSucher, verlaufId: string, umfeld: number): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query<{ id: string; rolle: string; weg: string; lauf_id: string | null; erstellt_am: Date; text: string; meta: Record<string, unknown> }>(
    `SELECT * FROM (
       (SELECT id::text AS id, rolle, weg, lauf_id, erstellt_am, text, meta, id AS ord FROM hauptagent_verlauf
         WHERE identity_id = $1 AND id <= $2::bigint ORDER BY id DESC LIMIT $3)
       UNION ALL
       (SELECT id::text AS id, rolle, weg, lauf_id, erstellt_am, text, meta, id AS ord FROM hauptagent_verlauf
         WHERE identity_id = $1 AND id > $2::bigint ORDER BY id LIMIT $4)) u ORDER BY ord`,
    [wer.identity_id, verlaufId, umfeld + 1, umfeld]);
  if (!rows.some((r) => r.id === verlaufId)) {
    return { success: false, error: 'verlauf_id_unbekannt', hinweis: 'verlauf_id gehoert nicht zum eigenen Verlauf (oder existiert nicht). Nachlesen geht nur im eigenen Verlauf.' };
  }
  const MAX = 4000;
  return {
    success: true, action: 'verlauf', verlauf_id: verlaufId, umfeld,
    zeilen: rows.map((r) => {
      const s = schwaerzeVerlaufText(r.text ?? '');
      return { id: r.id, zeit: r.erstellt_am.toISOString(), rolle: r.rolle, weg: r.weg, lauf_id: r.lauf_id,
        ...(typeof r.meta?.name === 'string' ? { werkzeug: r.meta.name } : {}),
        text: s.text.length > MAX ? s.text.slice(0, MAX) + ' …' : s.text, ...(s.text.length > MAX ? { gekuerzt: true, zeichen: s.text.length } : {}) };
    }),
  };
}

/**
 * EINZIGE Stelle, die den Qdrant-Filter baut: identity_id kommt aus dem Ausweis-Principal (wer), nie aus args.
 * Ohne Ausweis keine Suche. Fremde Verlaeufe nur der User ueber REST/Web-UI (R2).
 */
export async function sucheVerlauf(wer: VerlaufSucher | null, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const schalter = await leseVerlaufEinbettSchalter('suche');
  if (!schalter.aktiv) {
    return { success: false, error: 'funktion_aus', funktion: VERLAUF_SUCHE_FUNKTION,
      hinweis: 'Produkt-Schalter verlauf_suche ist AUS (Standard). Einschalten nur ausdruecklich: admin(profil_schalter_setzen, funktion verlauf_suche).' };
  }
  if (!wer || !wer.identity_id) {
    return { success: false, error: 'verlauf_ausweis_noetig',
      hinweis: 'search(action:"verlauf") sucht nur im eigenen Verlauf und braucht den Ausweis (agent_kennung). Fremde Verlaeufe nur der User ueber die Web-UI.' };
  }
  const verlaufId = ganzzahlText(args.verlauf_id);
  if (args.verlauf_id !== undefined && args.verlauf_id !== null && args.verlauf_id !== '') {
    if (!verlaufId) return { success: false, error: 'verlauf_id_ungueltig', hinweis: 'verlauf_id ist die Zahl aus verlauf_ids eines Treffers.' };
    const u = Math.min(20, Math.max(0, Math.floor(Number(args.umfeld ?? 5)) || 0));
    return leseVerlaufUmfeld(wer, verlaufId, args.umfeld === undefined ? 5 : u);
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { success: false, error: 'query_fehlt', hinweis: 'search(action:"verlauf", query, seit?, bis?, lauf_id?) oder verlauf_id + umfeld zum Nachlesen.' };
  const bisP = zeitParam(args.bis), seitP = zeitParam(args.seit);
  if (bisP === 'ungueltig' || seitP === 'ungueltig') return { success: false, error: 'zeit_ungueltig', hinweis: 'seit/bis als ISO-Zeitpunkt, z. B. 2026-10-25T14:00:00Z.' };
  const bisMs = bisP ?? Date.now();
  const seitMs = seitP ?? bisMs - STANDARD_SPANNE_TAGE * 86_400_000;
  if (seitMs > bisMs) return { success: false, error: 'zeit_ungueltig', hinweis: 'seit liegt nach bis.' };
  const lauf = typeof args.lauf_id === 'string' && args.lauf_id.trim() ? args.lauf_id.trim() : null;
  const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit ?? 10)) || 10));
  const spanne = { seit: new Date(seitMs).toISOString(), bis: new Date(bisMs).toISOString(), standard: seitP === null || bisP === null };
  const pool = getPool();
  const st = (await pool.query<{ gesamt: number; zeilen_offen: number; stuecke_offen: number }>(
    `SELECT (SELECT count(*)::int FROM hauptagent_verlauf WHERE identity_id = $1) AS gesamt,
            (SELECT count(*)::int FROM hauptagent_verlauf v WHERE v.identity_id = $1
               AND v.id > COALESCE((SELECT bis_verlauf_id FROM verlauf_einbett_stand WHERE identity_id = $1), 0)
               AND v.erstellt_am BETWEEN $2 AND $3) AS zeilen_offen,
            (SELECT count(*)::int FROM verlauf_stuecke WHERE identity_id = $1 AND embedded_at IS NULL
               AND zeit_bis >= $2 AND zeit_von <= $3) AS stuecke_offen`,
    [wer.identity_id, new Date(seitMs), new Date(bisMs)])).rows[0];
  if (!st || st.gesamt === 0) {
    return { success: true, action: 'verlauf', ergebnis: 'kein_verlauf', treffer: [], spanne,
      hinweis: 'Fuer diesen Ausweis ist kein Sitzungsverlauf gespeichert (z. B. Claude-Subagenten bis P22-T158, Codex-Agenten am PC). Die Suche wird ohne Aenderung moeglich, sobald der Verlauf ankommt.' };
  }
  // Pflichtfilter: identity_id IMMER zuerst, aus dem Principal.
  const must: Array<Record<string, unknown>> = [
    { key: 'identity_id', match: { value: wer.identity_id } },
    { key: 'zeit_bis_ts', range: { gte: seitMs } },
    { key: 'zeit_von_ts', range: { lte: bisMs } },
  ];
  if (lauf) must.push({ key: 'lauf_id', match: { value: lauf } });
  let roh: Array<{ id: string; score: number }>;
  try {
    const vektor = await abh.embedQuery(query);
    roh = await abh.sucheVektoren(vektor, limit, { must });
  } catch (e) {
    return { success: false, error: 'verlauf_suche_fehlgeschlagen', hinweis: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
  const grenze = await scoreGrenze();
  const ueber = roh.filter((x) => x.score >= grenze);
  const zeilen = ueber.length ? (await pool.query<{ id: string; lauf_id: string | null; context_epoch: number | null; von: string; bis: string; zeit_von: Date; zeit_bis: Date; text: string }>(
    `SELECT id::text AS id, lauf_id, context_epoch, von_verlauf_id::text AS von, bis_verlauf_id::text AS bis, zeit_von, zeit_bis, text
       FROM verlauf_stuecke WHERE id = ANY($1::uuid[]) AND identity_id = $2`, [ueber.map((x) => x.id), wer.identity_id])).rows : [];
  const nachId = new Map(zeilen.map((z) => [z.id, z]));
  const treffer = ueber.flatMap((x) => {
    const z = nachId.get(x.id);
    if (!z) return [];
    return [{ score: Math.round(x.score * 1000) / 1000, zeit_von: z.zeit_von.toISOString(), zeit_bis: z.zeit_bis.toISOString(), lauf_id: z.lauf_id,
      context_epoch: z.context_epoch, auszug: auszug(z.text, query), verlauf_ids: [z.von, z.bis],
      nachlesen: `search(action:"verlauf", verlauf_id:"${z.von}", umfeld:5)` }];
  });
  return {
    success: true, action: 'verlauf', agent: wer.agent_id, spanne, ...(lauf ? { lauf_id: lauf } : {}), score_grenze: grenze, treffer,
    rueckstand: { zeilen_nicht_zerlegt: st.zeilen_offen, stuecke_nicht_eingebettet: st.stuecke_offen },
    ...(st.zeilen_offen + st.stuecke_offen > 0 ? { hinweis: 'Ein Teil der Spanne ist noch nicht eingebettet (Verlauf wird mit niedrigster Prioritaet nachgezogen, nach jeder Neuanmeldung bzw. nach 6 h im aktiven Lauf).' } : {}),
  };
}

/** Tool-Weg: Identitaet aus dem Ausweis-Principal des laufenden Aufrufs (Tool-Argumente sind nie ein Nachweis). */
export async function sucheVerlaufTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const p = aktuellerAgentPrincipal();
  return sucheVerlauf(p && p.art === 'identity' ? { identity_id: p.identity_id, agent_id: p.agent_id } : null, args);
}
