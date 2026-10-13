/**
 * MODUL: Entscheidungs-Topf fuer Jev (P15 E1, 11.10.2026)
 * QUELLEN: Konzept thought 6591b268, User-Idee 1d19a7a9, User-Entscheidung e7b013c2, E0-Messung bfbf7968,
 *          Vorbild Erklaerungs-Topf (erklaerungen.ts, 58d13b5e).
 *
 * ZWECK: Gespeicherte User-Entscheidungen (Wortlaut + Aufbereitung) dienen Jev im Abwesend-Modus als
 *   PRAEZEDENZ fuer neue, aehnliche Rueckfragen (Schritt vor dem Jev-Aufruf in jev-entscheidung.ts).
 *
 * GELTUNG: GLOBAL (User e7b013c2) - Eintraege sind Vorlagen ueber alle Projekte; herkunft_projekt nennt nur,
 *   wo sie entstanden sind.
 * TABELLE jev_entscheidungstopf: ein Eintrag = EINE atomare Entscheidung. Status roh (erfasst, noch nicht
 *   aufbereitet) | aktiv (Kandidat, wenn kandidat=true) | ersetzt | stillgelegt. Aktiv nur mit Aufbereitung in
 *   ALLEN gepflegten Sprachen (jev_optionen.erklaerung_sprachen - ein Schalter fuer beide Toepfe).
 * HERKUNFT: tool (jev entscheidung_ablegen), thought (automatisch aus thought mit Tags entscheidung+user, roh),
 *   seed (Startbestand packages/core/data/entscheidungstopf-seed.json), korrektur (Durchsicht korrigieren).
 *   S3: autonome Jev-Entscheidungen werden NIE Topf-Eintrag (es gibt keinen Weg dafuer).
 * KANDIDATEN: Embedding (englischer Text: frage + applies_when, Rueckfall deutsch) gegen Frage + Kontext, Top 6
 *   (E0: Recall@6 100 %). Vektoren liegen in PG (embedding_en + embedding_modell) und werden bei Modellwechsel
 *   neu berechnet. Faellt das Embedding aus: Wort-Ueberlappung als Rueckfall (quelle 'volltext').
 * S2 TEXT-SCAN: scanneSicherheitText - Treffer heisst 'nie autonom' (E0: Recall 96 %, Fehlalarme bedeuten nur
 *   'User fragen'). Woerter wie kosten/oeffentlich sind an Aktionsverben gebunden (E0-Empfehlung 4).
 * KEINE HOOKS (User e7b013c2): Erfassung nur per Tool-Aufruf und aus thoughts.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db/client.js';
import { leseTopf, loeseTopfId, topfSeedId } from './topf-ansicht.js';
import { embed } from '../embeddings/index.js';
import { embeddingModellKennung, sichereModellprofil } from '../embeddings/modell-profil.js';
import { leseJevOptionen, type JevSprache } from './jev-optionen.js';

export const TOPF_STATUS = ['roh', 'aktiv', 'ersetzt', 'stillgelegt'] as const;
export type TopfStatus = (typeof TOPF_STATUS)[number];
export const TOPF_HERKUNFT = ['tool', 'thought', 'seed', 'korrektur', 'chat', 'ask_user_question'] as const;
/** Kandidaten je Frage (JEV-Test-Bauform, E0) */
export const STANDARD_TOPF_KANDIDATEN = 6;
/** Tor fuer die Praezedenz-Wahl (E0 bfbf7968: 0,8 -> 95,9 % Praezision) */
export const STANDARD_TOPF_TOR = 0.8;
/** S2b: ab dieser Wahrscheinlichkeit 'irreversible/externe Aktion' entscheidet Jev nicht (E0: 0,3 -> Recall 94 %) */
export const STANDARD_IRREVERSIBEL_SCHWELLE = 0.3;
const DARF_SETZEN = /^(koordinator|coordinator|user)$/i;
const MAX_TEXT = 4000;
const KATEGORIE_OFFEN = 'offen';

export interface TopfAufbereitungDe { entscheidung: string; begruendung: string; gilt_wenn: string }
export interface TopfAufbereitungEn { decision: string; reason: string; applies_when: string }
export interface TopfAufbereitung { de?: TopfAufbereitungDe; en?: TopfAufbereitungEn }

export interface TopfEintrag {
  id: string;
  herkunft_projekt: string | null;
  themen: string[];
  kategorie: string;
  kandidat: boolean;
  frage_de: string | null;
  frage_en: string | null;
  optionen: unknown;
  gewaehlte_option: string | null;
  kontext: string | null;
  antwort_wortlaut: string;
  wortlaut_rekonstruiert: boolean;
  aufbereitet_de: TopfAufbereitungDe | null;
  aufbereitet_en: TopfAufbereitungEn | null;
  herkunft: string;
  quelle_ref: string | null;
  status: TopfStatus;
  ersetzt_durch: string | null;
  status_grund: string | null;
  gewaehlt_n: number;
  bestaetigt_n: number;
  korrigiert_n: number;
  erfasst_von: string | null;
  aufbereitet_von: string | null;
  erstellt_am: string;
  geaendert_am: string;
}

/** Embedding-Funktion (Test: Mock). art 'query' fuer die Frage, 'dokument' fuer Topf-Eintraege. */
export type TopfEmbedFn = (text: string, art: 'query' | 'dokument') => Promise<number[]>;
export interface TopfDeps {
  embed?: TopfEmbedFn;
  /** Kennung des Vektorraums (Standard: embeddingModellKennung, bei Mock 'mock') */
  modell?: string;
}

const SPALTEN = `id, herkunft_projekt, themen, kategorie, kandidat, frage_de, frage_en, optionen, gewaehlte_option, kontext,
  antwort_wortlaut, wortlaut_rekonstruiert, aufbereitet_de, aufbereitet_en, herkunft, quelle_ref, status, ersetzt_durch, status_grund,
  gewaehlt_n, bestaetigt_n, korrigiert_n, erfasst_von, aufbereitet_von, erstellt_am, geaendert_am`;

function text(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function kurz(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// S2: Text-Scan (Sicherheitsgrenze, unabhaengig von der behaupteten Kategorie)
// ---------------------------------------------------------------------------

/** [Name, Muster]. Ein Treffer heisst: nie autonom. Erweitert gegenueber Konzept §4 (E0-Empfehlung 4). */
export const SICHERHEIT_MUSTER: ReadonlyArray<readonly [string, RegExp]> = [
  ['git', /\bgit\s+(push|reset|rebase|clean|checkout|switch|stash|rm|merge|branch\s+-[dD])\b|\bpush(en|t|e)?\b|--force\b|--no-verify\b|force[- ]?push|\b(nach|in|auf|into|to)\s+main\b/i],
  ['deploy', /\bdeploy|\bausroll|\bcontainer\s*-?tausch|\bdocker\s+(run|restart|rm|rmi|stop|kill|push|compose\s+(up|down))\b/i],
  ['fernzugriff', /\bssh\s+\S|\bscp\s|\bpkill\b|\bkill\s+(-\d+\s+)?\d|\breboot\b|\bsystemctl\s+(stop|restart|disable)\b|shell\s*\(\s*(action\s*:\s*)?['"]?exec\b[^)]*\b(kill|handoff|rm)\b|context-handoff\.sh/i],
  ['loeschen', /\brm\s+-[a-z]*[rf]|\b(loesch|lösch)\w*|\bdelete_task\b|files\s*\(\s*(action\s*:\s*)?['"]?delete\b|\bdelete\s+from\b/i],
  ['sql', /\b(DROP|TRUNCATE|ALTER)\s+(TABLE|DATABASE|SCHEMA|COLUMN|INDEX|ROLE|VIEW|TYPE)\b|\bDELETE\s+FROM\b/],
  ['live_db', /192\.168\.50\.65:5432|\blive[- ]?(db|datenbank)\b|\bsystem[- ]?(db|datenbank)\b|\bprodukti(v|ons)[- ]?(db|datenbank)\b|\bpsql\b|\bschema\s*-?(aenderung|änderung|migration)|\bschema\s+(aendern|ändern|anpassen|migrieren)\b/i],
  ['projekte_kopieren', /\b(kopier|kopie|copy|spiegel|uebertrag|übertrag)\w*\s+(in|nach|auf|to|into)\s+(alle|andere|saemtliche|sämtliche|all|other)\s+\w*\s*(projekt|project|db|datenbank)/i],
  ['secrets', /\bsecret|\btoken\b|\bpasswor|\bpassword|\bapi[_ -]?key|\bzugangsdaten|\bcredential|(^|[\s/'"`])\.env\b/i],
  ['kosten', /\b(kaufen|kauf\b|buchen\b|bezahl\w*|kostenpflichtig\w*|abo\w*\s+abschliess\w*|credits?\s+(kaufen|aufladen|nachladen)|budget\s+\w*\s*(erhoeh|erhöh|verdoppel|anheb)\w*)/i],
  ['aussenwirkung', /\bgh\s+(pr|issue|release)\b|\bpull[- ]request|\bnpm\s+publish|\bpublish(en)?\b|\bveroeffentlich|\bveröffentlich|\bgist\b|\bper\s+(e-?)?mail\b|\be-?mail\s+(an|senden|schicken)\b|\bslack\b|\btweet|\bposten\s+auf\b/i],
  ['regeln', /settings\.json|\bclaude\.md\b|regel\w*\s+(aendern|ändern|umschreiben|loeschen|löschen|anpassen)|\bskills?\s+(aendern|ändern|umschreiben|ersetzen)|memories\s+\w*\s*umschreiben/i],
];

/** Liefert die Namen aller getroffenen Muster (leer = unauffaellig). */
export function scanneSicherheitText(...teile: unknown[]): string[] {
  const t = teile.map((x) => (typeof x === 'string' ? x : x === null || x === undefined ? '' : JSON.stringify(x))).join(' \n ');
  return SICHERHEIT_MUSTER.filter(([, r]) => r.test(t)).map(([n]) => n);
}

/** S2b: Jev-Frage (noul) 'loest die Antwort eine irreversible/externe Aktion aus?' - Wortlaut wie E0 gemessen */
export const IRREVERSIBEL_FRAGE =
  'Answering this question with one of the options would trigger or authorise an irreversible or external action (deploy, git push/merge/reset, ' +
  'deleting files or data, writing to a live/system database or schema, exposing secrets, spending money, publishing or sending outside, ' +
  'changing rules or settings). Give the probability that this is true.';

// ---------------------------------------------------------------------------
// Aufbereitung + Sprachen
// ---------------------------------------------------------------------------

/** Liest eine Aufbereitung {de:{entscheidung,begruendung,gilt_wenn}, en:{decision,reason,applies_when}} (auch als JSON-String). */
export function leseAufbereitung(roh: unknown): TopfAufbereitung | undefined {
  let v: unknown = roh;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return undefined; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, Record<string, unknown> | undefined>;
  const aus: TopfAufbereitung = {};
  const de = o.de;
  if (de && typeof de === 'object') {
    const e = text(de.entscheidung), b = text(de.begruendung) ?? '', g = text(de.gilt_wenn);
    if (e && g) aus.de = { entscheidung: e, begruendung: b, gilt_wenn: g };
  }
  const en = o.en;
  if (en && typeof en === 'object') {
    const e = text(en.decision), b = text(en.reason) ?? '', g = text(en.applies_when);
    if (e && g) aus.en = { decision: e, reason: b, applies_when: g };
  }
  return aus.de || aus.en ? aus : undefined;
}

/** Fehlende gepflegte Sprachen fuer eine Aufbereitung (leer = vollstaendig). */
async function fehlendeSprachen(a: TopfAufbereitung | undefined | null, b?: { de?: unknown; en?: unknown }): Promise<Array<'de' | 'en'>> {
  const opt = await leseJevOptionen();
  return opt.gepflegte_sprachen.filter((s) => !(a?.[s] ?? b?.[s]));
}

/** optionen: {key: Beschreibung} | [{key, ...}] -> Array fuer JSONB */
function leseOptionen(roh: unknown): unknown {
  let v: unknown = roh;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object' && typeof (x as { key?: unknown }).key === 'string');
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([key, t]) => ({ key, text: kurz(t, 400) }));
  return null;
}

function leseThemen(roh: unknown): string[] | undefined {
  if (Array.isArray(roh)) return roh.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 60)).slice(0, 20);
  if (typeof roh === 'string' && roh.trim()) return roh.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
  return undefined;
}

// ---------------------------------------------------------------------------
// Ablegen / Aufbereiten / Liste
// ---------------------------------------------------------------------------

export interface AblegenEingabe {
  frage_de?: unknown;
  frage_en?: unknown;
  optionen?: unknown;
  gewaehlte_option?: unknown;
  kontext?: unknown;
  antwort_wortlaut?: unknown;
  aufbereitet?: unknown;
  kategorie?: unknown;
  themen?: unknown;
  kandidat?: unknown;
  herkunft_projekt?: unknown;
}

/** Interner Schreibweg (ohne Rechtepruefung) - auch fuer Korrekturen aus der Durchsicht. */
export async function schreibeTopfEintrag(
  e: AblegenEingabe,
  meta: { herkunft: (typeof TOPF_HERKUNFT)[number]; quelle_ref?: string | null; erfasst_von?: string | null; db?: Pick<ReturnType<typeof getPool>, 'query'> },
): Promise<Record<string, unknown>> {
  const frageDe = text(e.frage_de, 1000);
  const frageEn = text(e.frage_en, 1000);
  const wortlaut = text(e.antwort_wortlaut);
  const kategorie = text(e.kategorie, 40)?.toLowerCase();
  if (!frageDe && !frageEn) return { success: false, error: 'frage_fehlt', message: 'frage_de oder frage_en ist Pflicht (die Rueckfrage an den User).' };
  if (!wortlaut) return { success: false, error: 'wortlaut_fehlt', message: 'antwort_wortlaut ist Pflicht (die Antwort des Users im Original).' };
  if (!kategorie) return { success: false, error: 'kategorie_fehlt', message: 'kategorie ist Pflicht (variante, reihenfolge, umsetzungsweg, formulierung oder eine verbotene; verbotene werden gespeichert, aber nie Kandidat).' };
  const aufb = leseAufbereitung(e.aufbereitet);
  const fehlen = await fehlendeSprachen(aufb);
  const status: TopfStatus = aufb && fehlen.length === 0 ? 'aktiv' : 'roh';
  const kandidat = e.kandidat === false || e.kandidat === 'false' ? false : true;
  const { rows } = await (meta.db ?? getPool()).query<{ id: string }>(
    `INSERT INTO jev_entscheidungstopf (herkunft_projekt, themen, kategorie, kandidat, frage_de, frage_en, optionen, gewaehlte_option, kontext,
       antwort_wortlaut, aufbereitet_de, aufbereitet_en, herkunft, quelle_ref, status, erfasst_von, aufbereitet_von)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      text(e.herkunft_projekt, 200) ?? null, leseThemen(e.themen) ?? [], kategorie, kandidat, frageDe ?? null, frageEn ?? null,
      JSON.stringify(leseOptionen(e.optionen)), text(e.gewaehlte_option, 200) ?? null, text(e.kontext, 1500) ?? null, wortlaut,
      aufb?.de ? JSON.stringify(aufb.de) : null, aufb?.en ? JSON.stringify(aufb.en) : null, meta.herkunft, meta.quelle_ref ?? null, status,
      meta.erfasst_von ?? null, status === 'aktiv' ? (meta.erfasst_von ?? null) : null,
    ],
  );
  return {
    success: true,
    id: rows[0].id,
    status,
    ...(status === 'roh'
      ? {
          fehlende_sprachen: fehlen,
          hinweis: `Als roh gespeichert: Aufbereitung fehlt${fehlen.length ? ` in ${fehlen.join(', ')}` : ''} (gepflegte Sprachen aus jev_optionen). ` +
            `Aktivieren mit jev(action:"entscheidung_aufbereiten", eintrag_id:"${rows[0].id}", aufbereitet:{de:{entscheidung,begruendung,gilt_wenn}, en:{decision,reason,applies_when}}).`,
        }
      : {}),
  };
}

/** jev(entscheidung_ablegen): nur Koordinator/User (Namenstreue). Mit vollstaendiger Aufbereitung direkt aktiv. */
export async function legeEntscheidungAb(e: AblegenEingabe, wer: string | undefined): Promise<Record<string, unknown>> {
  const w = (wer ?? '').trim();
  if (!DARF_SETZEN.test(w)) {
    return { success: false, error: 'nur_koordinator', message: `Entscheidungen legt nur der Koordinator oder der User ab (agent_id koordinator|coordinator|user), bekommen: "${w}". Namenstreue, keine Identitaetspruefung.` };
  }
  try {
    return await schreibeTopfEintrag(e, { herkunft: 'tool', erfasst_von: w });
  } catch (err) {
    return { success: false, error: 'fehler', message: `Ablegen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** jev(entscheidung_aufbereiten): ergaenzt einen Eintrag (meist roh) und aktiviert ihn bzw. legt still/ersetzt. */
export async function bereiteEntscheidungAuf(
  e: AblegenEingabe & { eintrag_id?: unknown; status?: unknown; status_grund?: unknown; ersetzt_durch?: unknown },
  wer: string | undefined,
): Promise<Record<string, unknown>> {
  const w = (wer ?? '').trim();
  if (!DARF_SETZEN.test(w)) {
    return { success: false, error: 'nur_koordinator', message: `Aufbereiten darf nur der Koordinator oder der User (agent_id koordinator|coordinator|user), bekommen: "${w}".` };
  }
  const id = text(e.eintrag_id, 100);
  if (!id) return { success: false, error: 'eintrag_id_fehlt', message: 'eintrag_id (UUID oder eindeutiger Praefix ab 8 Zeichen) ist Pflicht.' };
  try {
    const aufgeloest = await loeseTopfId('jev_entscheidungstopf', id);
    if ('error' in aufgeloest) return { success: false, ...aufgeloest };
    const { rows } = await getPool().query<TopfEintrag>(`SELECT ${SPALTEN} FROM jev_entscheidungstopf WHERE id = $1::uuid`, [aufgeloest.id]);
    const alt = rows[0];
    if (!alt) return { success: false, error: 'nicht_gefunden', message: `Kein Topf-Eintrag "${id}".` };
    const aufb = leseAufbereitung(e.aufbereitet);
    const de = aufb?.de ?? alt.aufbereitet_de ?? undefined;
    const en = aufb?.en ?? alt.aufbereitet_en ?? undefined;
    const zielRoh = text(e.status, 20)?.toLowerCase() ?? 'aktiv';
    if (!(TOPF_STATUS as readonly string[]).includes(zielRoh)) return { success: false, error: 'status_ungueltig', message: `status: ${TOPF_STATUS.join(' | ')}.` };
    const ziel = zielRoh as TopfStatus;
    const kategorie = text(e.kategorie, 40)?.toLowerCase() ?? alt.kategorie;
    if (ziel === 'aktiv') {
      const fehlen = await fehlendeSprachen({ de, en });
      if (fehlen.length > 0) {
        return { success: false, error: 'sprache_fehlt', fehlende_sprachen: fehlen, message: `Aufbereitung fehlt in den gepflegten Sprachen: ${fehlen.join(', ')} (jev_optionen). Nichts geaendert.` };
      }
      if (kategorie === KATEGORIE_OFFEN) {
        return { success: false, error: 'kategorie_fehlt', message: 'kategorie setzen (variante, reihenfolge, umsetzungsweg, formulierung oder verbotene), bevor der Eintrag aktiv wird. Nichts geaendert.' };
      }
    }
    const textFeld = (neu: unknown, a: string | null, max = 1000) => text(neu, max) ?? a;
    const kandidatNeu = e.kandidat === undefined ? (alt.herkunft === 'thought' && alt.kategorie === KATEGORIE_OFFEN ? true : alt.kandidat) : !(e.kandidat === false || e.kandidat === 'false');
    const { rows: neu } = await getPool().query<{ id: string; status: string }>(
      `UPDATE jev_entscheidungstopf SET frage_de = $2, frage_en = $3, optionen = $4::jsonb, gewaehlte_option = $5, kontext = $6, kategorie = $7,
         themen = $8, kandidat = $9, aufbereitet_de = $10::jsonb, aufbereitet_en = $11::jsonb, status = $12, status_grund = $13, ersetzt_durch = $14,
         aufbereitet_von = $15, embedding_en = NULL, embedding_modell = NULL, geaendert_am = NOW()
       WHERE id = $1 RETURNING id, status`,
      [
        alt.id, textFeld(e.frage_de, alt.frage_de), textFeld(e.frage_en, alt.frage_en),
        JSON.stringify(e.optionen !== undefined ? leseOptionen(e.optionen) : alt.optionen ?? null),
        textFeld(e.gewaehlte_option, alt.gewaehlte_option, 200), textFeld(e.kontext, alt.kontext, 1500), kategorie,
        leseThemen(e.themen) ?? alt.themen ?? [], kandidatNeu, de ? JSON.stringify(de) : null, en ? JSON.stringify(en) : null, ziel,
        text(e.status_grund, 500) ?? (ziel === alt.status ? alt.status_grund : null), text(e.ersetzt_durch, 100) ?? (ziel === 'ersetzt' ? alt.ersetzt_durch : null), w,
      ],
    );
    return { success: true, id: neu[0].id, status: neu[0].status, message: `Eintrag ${neu[0].id} ist ${neu[0].status}.` };
  } catch (err) {
    return { success: false, error: 'fehler', message: `Aufbereiten fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Kompakte ID-Liste; Details und ausdrueckliche Bedeutungsfrage ueber den gemeinsamen Vertrag. */
export async function listeEntscheidungstopf(f: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return leseTopf({ ...f, topf: 'entscheidung' });
}

/** Zaehler einer Praezedenz erhoehen (gewaehlt_n, bestaetigt_n, korrigiert_n). Wirft nie. */
export async function zaehleTopf(id: string | null | undefined, feld: 'gewaehlt_n' | 'bestaetigt_n' | 'korrigiert_n'): Promise<void> {
  if (!id) return;
  await getPool().query(`UPDATE jev_entscheidungstopf SET ${feld} = ${feld} + 1 WHERE id = $1`, [id]).catch(() => undefined);
}

/** Zaehlung je Status/Herkunft fuer admin(jev_entscheidungstopf). */
export async function entscheidungstopfStatus(): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query<{ status: string; herkunft: string; kandidat: boolean; n: number }>(
    `SELECT status, herkunft, kandidat, count(*)::int AS n FROM jev_entscheidungstopf GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  );
  const je: Record<string, number> = { roh: 0, aktiv: 0, ersetzt: 0, stillgelegt: 0 };
  let kandidaten = 0;
  for (const z of rows) {
    je[z.status] = (je[z.status] ?? 0) + z.n;
    if (z.status === 'aktiv' && z.kandidat) kandidaten += z.n;
  }
  return { ...je, kandidaten, je_herkunft: rows };
}

// ---------------------------------------------------------------------------
// Thought-Spiegel (automatische Erfassung, roh)
// ---------------------------------------------------------------------------

/**
 * Ein thought mit den Tags entscheidung UND user wird als roh-Eintrag gespiegelt (herkunft thought,
 * quelle_ref = thought-id, idempotent). Nie Kandidat, bis der Koordinator ihn aufbereitet. Wirft nie.
 */
export async function spiegeleThoughtInTopf(
  project: string,
  t: { id: string; source?: string | null; content: string; tags?: string[] | null },
): Promise<{ angelegt: boolean; id?: string; fehler?: string }> {
  const tags = (t.tags ?? []).map((x) => String(x).trim().toLowerCase());
  if (!tags.includes('entscheidung') || !tags.includes('user')) return { angelegt: false };
  try {
    const erste = kurz(t.content.split('\n').find((z) => z.trim()) ?? t.content, 300);
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO jev_entscheidungstopf (herkunft_projekt, themen, kategorie, kandidat, frage_de, antwort_wortlaut, herkunft, quelle_ref, status, erfasst_von)
       VALUES ($1, $2, $3, false, $4, $5, 'thought', $6, 'roh', $7)
       ON CONFLICT (quelle_ref) WHERE herkunft = 'thought' DO NOTHING
       RETURNING id`,
      [project, tags.filter((x) => x !== 'entscheidung' && x !== 'user').slice(0, 20), KATEGORIE_OFFEN,
        `(aus thought ${t.id.slice(0, 8)}, Frage noch aufzubereiten) ${erste}`, t.content.slice(0, 20_000), t.id, t.source ?? null],
    );
    return rows.length > 0 ? { angelegt: true, id: rows[0].id } : { angelegt: false };
  } catch (err) {
    return { angelegt: false, fehler: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface SeedEintrag {
  quelle?: { art?: string; ref?: string; teil?: string; ersetzt?: string };
  herkunft_projekt?: string;
  kategorie: string;
  kandidat?: boolean;
  ersetzt?: string;
  themen?: string[];
  frage?: { de?: string; en?: string };
  optionen?: unknown;
  gewaehlte_option?: string;
  antwort_wortlaut: string;
  wortlaut_rekonstruiert?: boolean;
  aufbereitet?: TopfAufbereitung;
}

/** Pfad der Seed-Datei (packages/core/data, relativ zu dist/services bzw. src/services) */
export function seedDateiPfad(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'entscheidungstopf-seed.json');
}

/**
 * Laedt den Startbestand idempotent (stabile Inhalts-ID und vorhandene Seed-Inhalte), Status aktiv, herkunft seed.
 * Beim API-Start und per admin(jev_entscheidungstopf, modus seed_laden). Wirft nie.
 */
export async function ladeEntscheidungstopfSeed(o: { datei?: string; agent?: string | null } = {}): Promise<Record<string, unknown>> {
  const datei = o.datei ?? seedDateiPfad();
  let seed: { format?: string; eintraege?: SeedEintrag[] };
  try {
    seed = JSON.parse(await readFile(datei, 'utf8')) as typeof seed;
  } catch (err) {
    return { success: false, error: 'seed_nicht_lesbar', message: `Seed-Datei nicht lesbar (${datei}): ${err instanceof Error ? err.message : String(err)}` };
  }
  if (seed.format !== 'entscheidungstopf-seed' || !Array.isArray(seed.eintraege)) {
    return { success: false, error: 'seed_format', message: 'Seed-Datei hat nicht das Format entscheidungstopf-seed.' };
  }
  let neu = 0, vorhanden = 0, fehlerhaft = 0;
  const fehler: string[] = [];
  for (const e of seed.eintraege) {
    try {
      const a = e.aufbereitet ?? {};
      const ersetzt = e.ersetzt ?? e.quelle?.ersetzt;
      const ref = e.quelle ? `${e.quelle.art ?? 'quelle'}:${e.quelle.ref ?? ''}${e.quelle.teil ? `#${e.quelle.teil}` : ''}` : null;
      const r = await getPool().query(
        `INSERT INTO jev_entscheidungstopf (id, herkunft_projekt, themen, kategorie, kandidat, frage_de, frage_en, optionen, gewaehlte_option,
           antwort_wortlaut, wortlaut_rekonstruiert, aufbereitet_de, aufbereitet_en, herkunft, quelle_ref, status, status_grund, erfasst_von, aufbereitet_von)
         SELECT $1::uuid, $2::text, $3::text[], $4::text, $5::boolean, $6::text, $7::text, $8::jsonb, $9::text, $10::text, $11::boolean, $12::jsonb, $13::jsonb, 'seed', $14::text, 'aktiv', $15::text, $16::text, $16::text
         WHERE NOT EXISTS (SELECT 1 FROM jev_entscheidungstopf WHERE herkunft = 'seed'
           AND frage_de IS NOT DISTINCT FROM $6::text AND frage_en IS NOT DISTINCT FROM $7::text AND antwort_wortlaut = $10::text)
         ON CONFLICT (id) DO NOTHING`,
        [
          topfSeedId('entscheidung', [e.frage?.de ?? null, e.frage?.en ?? null, e.antwort_wortlaut]), e.herkunft_projekt ?? null, e.themen ?? [], e.kategorie, e.kandidat !== false, e.frage?.de ?? null, e.frage?.en ?? null,
          JSON.stringify(e.optionen ?? null), e.gewaehlte_option ?? null, e.antwort_wortlaut, e.wortlaut_rekonstruiert === true,
          a.de ? JSON.stringify(a.de) : null, a.en ? JSON.stringify(a.en) : null, ref,
          ersetzt ? `Seed; ersetzt: ${ersetzt}` : 'Seed (Startbestand, vom User noch durchzusehen)', o.agent ?? 'seed',
        ],
      );
      if ((r.rowCount ?? 0) > 0) neu++; else vorhanden++;
    } catch (err) {
      fehlerhaft++;
      if (fehler.length < 5) fehler.push(`${e.frage?.de ?? e.frage?.en ?? '?'}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { success: fehlerhaft === 0, gelesen: seed.eintraege.length, neu, vorhanden, fehlerhaft, ...(fehler.length ? { fehler } : {}) };
}

// ---------------------------------------------------------------------------
// Kandidaten
// ---------------------------------------------------------------------------

/** Dokumenttext eines Eintrags fuer das Embedding: englisch bevorzugt (E0), sonst deutsch. */
export function topfDokText(e: Pick<TopfEintrag, 'frage_de' | 'frage_en' | 'aufbereitet_de' | 'aufbereitet_en'>): string {
  if (e.frage_en || e.aufbereitet_en) return `${e.frage_en ?? e.frage_de ?? ''} ${e.aufbereitet_en?.applies_when ?? ''}`.trim();
  return `${e.frage_de ?? ''} ${e.aufbereitet_de?.gilt_wenn ?? ''}`.trim();
}

/** Kriterium fuer die Praezedenz-Choice (E0-Bauform) in der wirksamen Jev-Sprache, mit Rueckfall. */
export function topfKriterium(e: Pick<TopfEintrag, 'aufbereitet_de' | 'aufbereitet_en'>, sprache: JevSprache): string {
  const en = e.aufbereitet_en ? `Earlier user decision: ${e.aufbereitet_en.decision} Applies when: ${e.aufbereitet_en.applies_when}` : '';
  const de = e.aufbereitet_de ? `Fruehere User-Entscheidung: ${e.aufbereitet_de.entscheidung} Gilt wenn: ${e.aufbereitet_de.gilt_wenn}` : '';
  const t = sprache === 'de' ? de || en : sprache === 'en' ? en || de : [en, de].filter(Boolean).join(' / ');
  return kurz(t, 600);
}

/** state.praezedenz fuer den Optionsaufruf in der wirksamen Jev-Sprache. */
export function topfPraezedenzState(e: Pick<TopfEintrag, 'aufbereitet_de' | 'aufbereitet_en'>, sprache: JevSprache): Record<string, string> {
  const en = e.aufbereitet_en ? { decision: e.aufbereitet_en.decision, reason: e.aufbereitet_en.reason, applies_when: e.aufbereitet_en.applies_when } : undefined;
  const de = e.aufbereitet_de ? { entscheidung: e.aufbereitet_de.entscheidung, begruendung: e.aufbereitet_de.begruendung, gilt_wenn: e.aufbereitet_de.gilt_wenn } : undefined;
  if (sprache === 'de') return de ?? en ?? {};
  if (sprache === 'en') return en ?? de ?? {};
  return { ...(en ?? {}), ...(de ?? {}) };
}

function kosinus(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

function woerter(t: string): Set<string> {
  return new Set((t.toLowerCase().match(/[a-zäöüß0-9]{4,}/g) ?? []).map((w) => w.slice(0, 7)));
}

export interface TopfKandidat { eintrag: TopfEintrag; score: number }

/**
 * Top-N aktive Kandidaten (kandidat=true, Kategorie aus erlaubte) per Embedding. Fehlende/veraltete Vektoren
 * werden berechnet und in PG gespeichert. Embedding-Ausfall: Wort-Ueberlappung (quelle 'volltext').
 * Wirft bei DB-Fehlern (der Aufrufer faellt dann auf den alten Weg zurueck).
 */
export async function holeTopfKandidaten(
  frage: string,
  o: { erlaubte: readonly string[]; limit?: number },
  deps: TopfDeps = {},
): Promise<{ kandidaten: TopfKandidat[]; quelle: 'embedding' | 'volltext' | 'leer'; hinweis?: string }> {
  const limit = o.limit ?? STANDARD_TOPF_KANDIDATEN;
  const { rows } = await getPool().query<TopfEintrag & { embedding_en: number[] | null; embedding_modell: string | null }>(
    `SELECT ${SPALTEN}, embedding_en, embedding_modell FROM jev_entscheidungstopf
      WHERE status = 'aktiv' AND kandidat AND kategorie = ANY($1) AND herkunft = ANY($2)`,
    [[...o.erlaubte], ['tool', 'thought', 'seed', 'korrektur', 'chat', 'ask_user_question']],
  );
  if (rows.length === 0) return { kandidaten: [], quelle: 'leer' };
  const einbetten: TopfEmbedFn = deps.embed ?? ((t, art) => embed(t, { art, priority: 'interactive' }));
  try {
    let modell = deps.modell ?? (deps.embed ? 'mock' : '');
    if (!modell) {
      await sichereModellprofil();
      modell = embeddingModellKennung();
    }
    const q = await einbetten(kurz(frage, 2000), 'query');
    const bewertet: TopfKandidat[] = [];
    for (const z of rows) {
      let v = z.embedding_en;
      if (!Array.isArray(v) || v.length !== q.length || z.embedding_modell !== modell) {
        v = await einbetten(topfDokText(z), 'dokument');
        await getPool().query(`UPDATE jev_entscheidungstopf SET embedding_en = $2::real[], embedding_modell = $3 WHERE id = $1`, [z.id, v, modell]).catch(() => undefined);
      }
      const { embedding_en: _v, embedding_modell: _m, ...eintrag } = z;
      bewertet.push({ eintrag, score: Math.round(kosinus(q, v) * 10000) / 10000 });
    }
    bewertet.sort((a, b) => b.score - a.score);
    return { kandidaten: bewertet.slice(0, limit), quelle: 'embedding' };
  } catch (err) {
    const fw = woerter(frage);
    const bewertet = rows.map((z) => {
      const dw = woerter(topfDokText(z));
      let n = 0;
      for (const w of fw) if (dw.has(w)) n++;
      const { embedding_en: _v, embedding_modell: _m, ...eintrag } = z;
      return { eintrag, score: dw.size && fw.size ? n / Math.sqrt(dw.size * fw.size) : 0 };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return { kandidaten: bewertet.slice(0, limit), quelle: 'volltext', hinweis: `Embedding nicht verfuegbar (${err instanceof Error ? err.message : String(err)}), Rueckfall Wort-Ueberlappung.` };
  }
}

/** Berechnet fehlende Vektoren im Hintergrund (nach dem Seed). Wirft nie. */
export async function ergaenzeTopfEmbeddings(): Promise<{ berechnet: number; fehler?: string }> {
  try {
    await sichereModellprofil();
    const modell = embeddingModellKennung();
    const { rows } = await getPool().query<TopfEintrag>(
      `SELECT ${SPALTEN} FROM jev_entscheidungstopf WHERE status = 'aktiv' AND kandidat AND (embedding_en IS NULL OR embedding_modell IS DISTINCT FROM $1)`,
      [modell],
    );
    let n = 0;
    for (const z of rows) {
      const v = await embed(topfDokText(z), { art: 'dokument', priority: 'background' });
      await getPool().query(`UPDATE jev_entscheidungstopf SET embedding_en = $2::real[], embedding_modell = $3 WHERE id = $1`, [z.id, v, modell]);
      n++;
    }
    return { berechnet: n };
  } catch (err) {
    return { berechnet: 0, fehler: err instanceof Error ? err.message : String(err) };
  }
}
