/**
 * P22-T141 (User 25.10.2026, inbox:1046/1048): Artefakt-Bewertung als globales Design-Gedaechtnis aller Agenten.
 * Bewertet wird nur Design und Aufmachung, nicht der Inhalt. Quellen: Hauptagent-Artefakt (agent_artifacts), HTML-Antwort eines
 * Agenten an den User per Inbox (specialist_inbox) und HTML aus dem Verlauf einer Identitaet (hauptagent_verlauf).
 * ZUSTAND: hoch -> vorbild; runter + Kommentar -> ueberarbeiten; runter ohne Kommentar -> verbannt (bleibt, bis der User neu
 *   bewertet). Zu 'ueberarbeiten' verknuepft der Agent den naechsten Versuch (artefakt zeigen mit ueberarbeitet_aus bzw.
 *   artefakt(action:'versuch')) -> versuch_gezeigt: das Original verlaesst die Liste, der Versuch ist normal bewertbar. Kein
 *   Zeitablauf. Eine Neubewertung ersetzt den Stand (auch die Verknuepfung); jede Aenderung steht in artefakt_bewertungen_historie.
 * SCHNAPPSCHUSS: HTML, Titel und Urheber liest der Server aus der Quelle, nie aus dem Client. Inbox nur Agent -> 'user' der
 *   genannten Identitaet, Verlauf nur Ausgaben dieser Identitaet; alles andere ist quelle_unbekannt.
 * AGENTEN (artefakt-Tool, rest-api artefakt-tool.ts): leseDesignVorlieben (kompakt, ohne HTML), ladeBewertungHtml (Abruf eines
 *   Beispiels, gekappt), verknuepfeVersuch; designVorliebenZeile/-Zahlen fuer Anmeldung und artefakt(zeigen).
 * P22-T147 (User 25.10.2026): Die Bewertung haengt am Artefakt, nicht am Urheber. Wer ein bewertetes Artefakt per ID nutzt
 *   (zeigen mit artefakt_id: bewertungFuerArtefakt; vorbild: ladeBewertungHtml), bekommt Zustand, Kommentar, bewertet_am und einen
 *   Hinweis je Zustand mit - jeder Agent, keine aktive Nachricht (melden bleibt davon getrennt). Nur ueber explizite IDs.
 * SCHALTER: Produkt-Schalter artefakt_bewertung (global, Standard AUS, nur ausdruecklich): AUS = nichts schreiben
 *   (funktion_aus), Lesen leer (aktiv false), keine Hinweise. artefakt_bewertung_melden (Standard AUS): jede Bewertung als
 *   Inbox-Nachricht (Zustand + Kommentar) an den Urheber.
 * DEBUG: leseDesignVorlieben.debug {anzahl je zustand, gekappt, quelle, schalter_quelle}; leseBewertungen.schalter_quelle.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ARTEFAKT_HTML_MAX } from './artefakt.js';

export const ARTEFAKT_BEWERTUNG_FUNKTION = 'artefakt_bewertung' as const;
export const ARTEFAKT_BEWERTUNG_MELDEN_FUNKTION = 'artefakt_bewertung_melden' as const;
export const BEWERTUNGS_QUELLEN = ['artefakt', 'inbox', 'verlauf'] as const;
export type BewertungsQuelle = typeof BEWERTUNGS_QUELLEN[number];
export type Urteil = 'hoch' | 'runter';
export type BewertungsZustand = 'vorbild' | 'ueberarbeiten' | 'verbannt' | 'versuch_gezeigt';
/** Standard-Kappung der Vorlieben je Gruppe; der Abruf kann limit setzen (hoechstens VORLIEBEN_MAX). */
export const VORLIEBEN_STANDARD = { vorbild: 5, ueberarbeiten: 5, verbannt: 10 } as const;
const VORLIEBEN_MAX = 50;
const KOMMENTAR_MAX = 4000;
const QUELLEN_MAX = 100;
/** Abruf eines Beispiels (artefakt vorbild): HTML hoechstens so viele Zeichen (Kontextbudget). */
export const VORBILD_HTML_MAX = 60_000;

export class BewertungsFehler extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

const ZUSTAND_TEXT: Record<BewertungsZustand, string> = {
  vorbild: 'Vorbild', ueberarbeiten: 'wird ueberarbeitet', verbannt: 'verbannt (nie wieder verwenden)', versuch_gezeigt: 'neuer Versuch gezeigt',
};

/** Zustand aus dem Urteil: hoch -> vorbild; runter + Kommentar -> ueberarbeiten; runter ohne Kommentar -> verbannt. Rein. */
export function zustandAus(urteil: Urteil, kommentar?: string | null): BewertungsZustand {
  if (urteil === 'hoch') return 'vorbild';
  return kommentar && kommentar.trim() ? 'ueberarbeiten' : 'verbannt';
}

export interface DesignMerkmale {
  farben: string[]; schriften: string[]; layout: string[]; rundung: boolean; schatten: boolean; rahmen: boolean;
  grundton: 'hell' | 'dunkel' | 'unbekannt'; zeichen: number;
}

function haeufigste(werte: string[], n: number): string[] {
  const zahl = new Map<string, number>();
  for (const w of werte) zahl.set(w, (zahl.get(w) ?? 0) + 1);
  return [...zahl.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}

function hexHelligkeit(hex: string): number | null {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Kompakte Design-Merkmale aus dem HTML (Farben, Schriften, Aufbau, Rundung/Schatten/Rahmen, Grundton). Rein, ohne DOM. */
export function designMerkmale(html: string): DesignMerkmale {
  const t = html.toLowerCase();
  const farben = haeufigste((t.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? []).map((f) => f.replace(/\s+/g, '')), 5);
  const schriften = haeufigste([...t.matchAll(/font-family\s*:\s*([^;"}]+)/g)]
    .map((m) => m[1].replace(/&quot;/g, '').split(',')[0].trim().replace(/^['"]|['"]$/g, '')).filter(Boolean), 3);
  const layout = [
    /display\s*:\s*(?:inline-)?grid/.test(t) ? 'grid' : '', /display\s*:\s*(?:inline-)?flex/.test(t) ? 'flex' : '',
    /<table\b/.test(t) ? 'tabelle' : '', /<(?:ul|ol)\b/.test(t) ? 'liste' : '', /<(?:h1|h2|h3)\b/.test(t) ? 'ueberschriften' : '',
    /<svg\b/.test(t) ? 'svg' : '', /<img\b/.test(t) ? 'bild' : '',
  ].filter(Boolean);
  const hintergrund = /background(?:-color)?\s*:\s*(#[0-9a-f]{3,8})\b/.exec(t);
  const hell = hintergrund ? hexHelligkeit(hintergrund[1]) : null;
  return {
    farben, schriften, layout,
    rundung: /border-radius\s*:\s*(?!0(?:px)?\s*[;"'}])[^;"'}]+/.test(t),
    schatten: /box-shadow\s*:\s*(?!none)[^;"'}]+/.test(t),
    rahmen: /border(?:-(?:top|right|bottom|left))?\s*:\s*[^;"'}]*\b(?:solid|dashed|dotted|double)\b/.test(t),
    grundton: hell === null ? 'unbekannt' : hell < 0.45 ? 'dunkel' : 'hell',
    zeichen: html.length,
  };
}

/** Merkmale als kurze Zeile fuer Agenten (Kontextbudget). Rein. */
export function merkmalText(m: Partial<DesignMerkmale> | null | undefined): string {
  if (!m) return '';
  return [
    m.farben?.length ? 'Farben ' + m.farben.join(' ') : '',
    m.schriften?.length ? 'Schrift ' + m.schriften.join(', ') : '',
    m.layout?.length ? 'Aufbau ' + m.layout.join(', ') : '',
    [m.rundung ? 'gerundet' : '', m.schatten ? 'Schatten' : '', m.rahmen ? 'Rahmen' : ''].filter(Boolean).join(', '),
    m.grundton && m.grundton !== 'unbekannt' ? m.grundton : '',
  ].filter(Boolean).join('; ');
}

/** Titel aus dem HTML (title/h1-h3), sonst null. Rein. */
function titelAus(html: string): string | null {
  const m = /<(title|h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  const t = m ? m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, 120) : null;
}

/** 'artefakt:<id>,inbox:12,verlauf:34' -> Liste (Unbekanntes faellt weg, hoechstens 100). Rein. */
export function zerlegeQuellenListe(roh: unknown): Array<{ art: BewertungsQuelle; ref: string }> {
  if (typeof roh !== 'string') return [];
  const aus: Array<{ art: BewertungsQuelle; ref: string }> = [];
  for (const teil of roh.split(',')) {
    const i = teil.indexOf(':');
    if (i < 1) continue;
    const art = teil.slice(0, i).trim();
    const ref = gueltigeRef(art, teil.slice(i + 1).trim());
    if (istQuelle(art) && ref) aus.push({ art, ref });
    if (aus.length >= QUELLEN_MAX) break;
  }
  return aus;
}

const istQuelle = (v: unknown): v is BewertungsQuelle => typeof v === 'string' && (BEWERTUNGS_QUELLEN as readonly string[]).includes(v);

function gueltigeRef(art: string, ref: unknown): string | null {
  const s = typeof ref === 'number' && Number.isInteger(ref) ? String(ref) : typeof ref === 'string' ? ref.trim() : '';
  return (art === 'artefakt' ? /^[A-Za-z0-9-]{1,100}$/ : /^\d{1,18}$/).test(s) ? s : null;
}

function quelleRef(art: BewertungsQuelle, ref: unknown): string {
  const s = gueltigeRef(art, ref);
  if (!s) throw new BewertungsFehler('quelle_ref_ungueltig', 'quelle_ref fehlt oder passt nicht zu quelle_art ' + art + ' (artefakt: Artefakt-ID, inbox/verlauf: Zahl)');
  return s;
}

function bewertungsId(v: unknown): string {
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,18}$/.test(s)) throw new BewertungsFehler('bewertung_id_fehlt', 'bewertung_id (Zahl aus artefakt(action:"vorlieben")) angeben');
  return s;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const meldung = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function schalter(funktion: typeof ARTEFAKT_BEWERTUNG_FUNKTION | typeof ARTEFAKT_BEWERTUNG_MELDEN_FUNKTION) {
  const s = await leseProfilProduktSchalter(funktion, null);
  return { aktiv: s.aktiv && !s.letzter_fehler, quelle: s.quelle, letzter_fehler: s.letzter_fehler };
}
/** Wirksamer Stand des Produkt-Schalters artefakt_bewertung (global; Lesefehler = AUS mit letzter_fehler). */
export function artefaktBewertungSchalter() { return schalter(ARTEFAKT_BEWERTUNG_FUNKTION); }

async function brauchtSchalter(): Promise<void> {
  if (!(await artefaktBewertungSchalter()).aktiv) throw new BewertungsFehler('funktion_aus', 'Artefakt-Bewertung ist aus (Produkt-Schalter artefakt_bewertung)', 409);
}

interface QuelleDaten { html: string; titel: string | null; project: string | null; urheber_agent: string | null; urheber_identity_id: string | null; revision: number | null }

/** Schnappschuss aus der Quelle (nie aus dem Client). Inbox/Verlauf nur fuer die genannte Identitaet. */
async function ladeQuelle(db: PoolClient, art: BewertungsQuelle, ref: string, identityId: string | null): Promise<QuelleDaten> {
  let z: Record<string, unknown> | undefined;
  if (art === 'artefakt') {
    z = (await db.query(`SELECT a.html, a.title AS titel, a.revision, a.created_by AS urheber_agent, a.created_by_identity_id AS urheber_identity_id, i.project
        FROM agent_artifacts a LEFT JOIN agent_identitaeten i ON i.id = a.created_by_identity_id WHERE a.id = $1`, [ref])).rows[0];
  } else {
    if (!identityId || !/^[a-f0-9-]{36}$/.test(identityId)) throw new BewertungsFehler('identity_id_fehlt', 'Fuer quelle_art ' + art + ' die identity_id des Agenten angeben');
    z = (await db.query(art === 'inbox'
      ? `SELECT s.content AS html, NULL::int AS revision, s.from_agent AS urheber_agent, i.id AS urheber_identity_id, i.project
           FROM specialist_inbox s JOIN agent_identitaeten i ON i.id = $2
          WHERE s.id = $1::bigint AND s.project = i.project AND s.to_agent = 'user' AND s.from_agent <> 'user'
            AND (s.from_identity_id = i.id OR (s.from_identity_id IS NULL AND s.from_agent = i.agent_id))`
      : `SELECT v.text AS html, NULL::int AS revision, i.agent_id AS urheber_agent, i.id AS urheber_identity_id, i.project
           FROM hauptagent_verlauf v JOIN agent_identitaeten i ON i.id = v.identity_id
          WHERE v.id = $1::bigint AND v.identity_id = $2 AND (v.rolle IN ('agent', 'ausgabe') OR v.richtung = 'aus')`, [ref, identityId])).rows[0];
  }
  if (!z) throw new BewertungsFehler('quelle_unbekannt', 'Quelle ' + art + ':' + ref + ' nicht gefunden (oder nicht von diesem Agenten an den User)', 404);
  const html = typeof z.html === 'string' ? z.html : '';
  if (!/<[a-z][\s\S]*>/i.test(html)) throw new BewertungsFehler('keine_html_quelle', 'Die Quelle enthaelt kein HTML; bewertet werden nur HTML-Bloecke');
  if (html.length > ARTEFAKT_HTML_MAX) throw new BewertungsFehler('html_zu_gross', 'HTML der Quelle ist groesser als ' + ARTEFAKT_HTML_MAX + ' Zeichen');
  return { html, titel: text(z.titel) ?? titelAus(html), project: text(z.project), urheber_agent: text(z.urheber_agent),
    urheber_identity_id: text(z.urheber_identity_id), revision: z.revision === null || z.revision === undefined ? null : Number(z.revision) };
}

export interface BewertungsStand {
  id: string; quelle_art: BewertungsQuelle; quelle_ref: string; urteil: Urteil; kommentar: string | null; zustand: BewertungsZustand;
  titel: string | null; bewertet_am: string; anzahl_bewertungen: number; nachfolger: { art: string; ref: string } | null;
}

function stand(z: Record<string, unknown>): BewertungsStand {
  return {
    id: String(z.id), quelle_art: z.quelle_art as BewertungsQuelle, quelle_ref: String(z.quelle_ref), urteil: z.urteil as Urteil,
    kommentar: text(z.kommentar), zustand: z.zustand as BewertungsZustand, titel: text(z.titel),
    bewertet_am: new Date(z.bewertet_am as string | Date).toISOString(), anzahl_bewertungen: Number(z.anzahl_bewertungen),
    nachfolger: z.nachfolger_art ? { art: String(z.nachfolger_art), ref: String(z.nachfolger_ref) } : null,
  };
}

/** P22-T147: Bewertung eines genutzten Artefakts fuer den Agenten (am Artefakt, nicht am Urheber). */
export interface BewertungsHinweis {
  id: string; zustand: BewertungsZustand; kommentar: string | null; bewertet_am: string; titel?: string; nachfolger?: { art: string; ref: string };
  hinweis: string;
}

/** P22-T147: Was der Agent mit einem bewerteten Design tun soll, je Zustand. Rein. */
export function bewertungsHinweisText(s: Pick<BewertungsStand, 'id' | 'zustand' | 'nachfolger'>): string {
  const vorne = 'Bewertung des Users (nur Design/Aufmachung): ';
  if (s.zustand === 'vorbild') return vorne + 'Vorbild - diesen Stil gern weiterverwenden.';
  if (s.zustand === 'ueberarbeiten') {
    return vorne + 'ueberarbeiten - Kommentar umsetzen und den neuen Block mit ueberarbeitet_aus:' + s.id + ' verknuepfen (artefakt zeigen; fuer HTML per '
      + 'Inbox/Verlauf artefakt(action:"versuch", bewertung_id:' + s.id + ', quelle_art, quelle_ref)).';
  }
  if (s.zustand === 'verbannt') return vorne + 'verbannt - dieses Design nicht weiterverwenden.';
  return vorne + 'versuch_gezeigt - ein neuer Versuch ist schon verknuepft' + (s.nachfolger ? ' (' + s.nachfolger.art + ':' + s.nachfolger.ref + ')' : '')
    + '; der User bewertet ihn, das Original nicht erneut ueberarbeiten.';
}

function bewertungsHinweis(s: BewertungsStand): BewertungsHinweis {
  return { id: s.id, zustand: s.zustand, kommentar: s.kommentar, bewertet_am: s.bewertet_am, ...(s.titel ? { titel: s.titel } : {}),
    ...(s.nachfolger ? { nachfolger: s.nachfolger } : {}), hinweis: bewertungsHinweisText(s) };
}

/** P22-T147: Bewertung eines Hauptagent-Artefakts per ID (artefakt zeigen mit artefakt_id). Schalter AUS bzw. unbewertet -> null. */
export async function bewertungFuerArtefakt(artefaktId: unknown): Promise<BewertungsHinweis | null> {
  const ref = gueltigeRef('artefakt', artefaktId);
  if (!ref || !(await artefaktBewertungSchalter()).aktiv) return null;
  const z = (await getPool().query(
    `SELECT id, quelle_art, quelle_ref, urteil, kommentar, zustand, titel, bewertet_am, anzahl_bewertungen, nachfolger_art, nachfolger_ref
       FROM artefakt_bewertungen WHERE quelle_art = 'artefakt' AND quelle_ref = $1`, [ref])).rows[0] as Record<string, unknown> | undefined;
  return z ? bewertungsHinweis(stand(z)) : null;
}

export interface BewertungsEingabe { quelle_art: unknown; quelle_ref: unknown; identity_id?: unknown; urteil: unknown; kommentar?: unknown }
export interface MeldeErgebnis { gemeldet: boolean; grund?: string; inbox_id?: number }

/**
 * Bewertung des Users (Aufrufer: REST-Route mit interaktiver User-Session). Schnappschuss aus der Quelle, Upsert je Quelle plus
 * Historie in einer Transaktion. Danach (Schalter artefakt_bewertung_melden) Nachricht an den Urheber; ein Fehler dabei kippt die
 * Bewertung nicht, er steht in gemeldet.
 */
export async function bewerteArtefakt(e: BewertungsEingabe): Promise<{ bewertung: BewertungsStand; gemeldet: MeldeErgebnis | null }> {
  await brauchtSchalter();
  if (!istQuelle(e.quelle_art)) throw new BewertungsFehler('quelle_art_ungueltig', 'quelle_art: artefakt | inbox | verlauf');
  const art = e.quelle_art;
  const ref = quelleRef(art, e.quelle_ref);
  if (e.urteil !== 'hoch' && e.urteil !== 'runter') throw new BewertungsFehler('urteil_ungueltig', 'urteil: hoch | runter');
  if (e.kommentar !== undefined && e.kommentar !== null && typeof e.kommentar !== 'string') throw new BewertungsFehler('kommentar_ungueltig', 'kommentar muss Text sein');
  const kommentar = typeof e.kommentar === 'string' && e.kommentar.trim() ? e.kommentar.trim() : null;
  if (kommentar && kommentar.length > KOMMENTAR_MAX) throw new BewertungsFehler('kommentar_zu_lang', 'kommentar laenger als ' + KOMMENTAR_MAX + ' Zeichen');
  const urteil: Urteil = e.urteil;
  const zustand = zustandAus(urteil, kommentar);
  const identityId = typeof e.identity_id === 'string' && e.identity_id.trim() ? e.identity_id.trim() : null;
  const client = await getPool().connect();
  let zeile: Record<string, unknown>;
  try {
    await client.query('BEGIN');
    const q = await ladeQuelle(client, art, ref, identityId);
    zeile = (await client.query(
      `INSERT INTO artefakt_bewertungen (quelle_art, quelle_ref, quelle_revision, project, urheber_agent, urheber_identity_id, titel, html,
         merkmale, urteil, kommentar, zustand, bewertet_von)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'user')
       ON CONFLICT (quelle_art, quelle_ref) DO UPDATE SET quelle_revision = EXCLUDED.quelle_revision, project = EXCLUDED.project,
         urheber_agent = EXCLUDED.urheber_agent, urheber_identity_id = EXCLUDED.urheber_identity_id, titel = EXCLUDED.titel,
         html = EXCLUDED.html, merkmale = EXCLUDED.merkmale, urteil = EXCLUDED.urteil, kommentar = EXCLUDED.kommentar,
         zustand = EXCLUDED.zustand, nachfolger_art = NULL, nachfolger_ref = NULL, versuch_von = NULL, versuch_am = NULL,
         bewertet_von = EXCLUDED.bewertet_von, bewertet_am = NOW(), anzahl_bewertungen = artefakt_bewertungen.anzahl_bewertungen + 1
       RETURNING *`,
      [art, ref, q.revision, q.project, q.urheber_agent, q.urheber_identity_id, q.titel, q.html, JSON.stringify(designMerkmale(q.html)),
        urteil, kommentar, zustand])).rows[0] as Record<string, unknown>;
    await client.query(`INSERT INTO artefakt_bewertungen_historie (bewertung_id, urteil, kommentar, zustand, von) VALUES ($1, $2, $3, $4, 'user')`,
      [zeile.id, urteil, kommentar, zustand]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const gemeldet = await meldeBewertung(zeile).catch((error): MeldeErgebnis => ({ gemeldet: false, grund: meldung(error) }));
  return { bewertung: stand(zeile), gemeldet };
}

/** Schalter artefakt_bewertung_melden: Zustand + Kommentar als Inbox-Nachricht vom user an den Urheber (Identitaet, sonst Name). */
async function meldeBewertung(z: Record<string, unknown>): Promise<MeldeErgebnis | null> {
  if (!(await schalter(ARTEFAKT_BEWERTUNG_MELDEN_FUNKTION)).aktiv) return null;
  const project = text(z.project);
  const agent = text(z.urheber_agent);
  const identity = text(z.urheber_identity_id);
  if (!project || !agent) return { gemeldet: false, grund: 'urheber_unbekannt' };
  const s = stand(z);
  const nachricht = '[Design-Bewertung] ' + (s.titel ?? s.quelle_art + ':' + s.quelle_ref) + ': ' + ZUSTAND_TEXT[s.zustand]
    + (s.kommentar ? ' - Kommentar des Users: ' + s.kommentar : '') + '. Bewertet wird nur Design/Aufmachung, nicht der Inhalt. '
    + 'Beispiel abrufen: artefakt(action:"vorbild", bewertung_id:' + s.id + ')'
    + (s.zustand === 'ueberarbeiten' ? '; beim naechsten Design umsetzen und den Versuch verknuepfen (artefakt zeigen mit ueberarbeitet_aus:' + s.id
      + ' bzw. artefakt(action:"versuch", bewertung_id:' + s.id + ', quelle_art, quelle_ref)).' : '.');
  const { postToInbox } = await import('./inbox.js');
  const { leseAgentBezugModus, mitAgentAufrufKontext } = await import('./agent-bezug.js');
  const bezug = await leseAgentBezugModus();
  const r = identity && bezug.modus !== 'alt'
    ? await mitAgentAufrufKontext({ principal: null, bezug }, () =>
      postToInbox('user', { art: 'identity', project, agent_id: agent, identity_id: identity }, nachricht, project))
    : await postToInbox('user', agent, nachricht, project);
  return { gemeldet: true, inbox_id: r.id };
}

/** Stand je angezeigtem Block (Web-UI). Schalter AUS -> aktiv false, leer. */
export async function leseBewertungen(quellen: Array<{ art: unknown; ref: unknown }>):
  Promise<{ aktiv: boolean; bewertungen: BewertungsStand[]; schalter_quelle: string }> {
  const s = await artefaktBewertungSchalter();
  if (!s.aktiv) return { aktiv: false, bewertungen: [], schalter_quelle: s.quelle };
  const arten: string[] = [];
  const refs: string[] = [];
  for (const q of quellen.slice(0, QUELLEN_MAX)) {
    const ref = istQuelle(q.art) ? gueltigeRef(q.art, q.ref) : null;
    if (ref) { arten.push(q.art as string); refs.push(ref); }
  }
  if (!arten.length) return { aktiv: true, bewertungen: [], schalter_quelle: s.quelle };
  const r = await getPool().query(
    `SELECT id, quelle_art, quelle_ref, urteil, kommentar, zustand, titel, bewertet_am, anzahl_bewertungen, nachfolger_art, nachfolger_ref
       FROM artefakt_bewertungen WHERE (quelle_art, quelle_ref) IN (SELECT * FROM unnest($1::text[], $2::text[]))`, [arten, refs]);
  return { aktiv: true, bewertungen: r.rows.map((z: Record<string, unknown>) => stand(z)), schalter_quelle: s.quelle };
}

const VORLIEBEN_HINWEIS = 'Nur Design und Aufmachung, nicht der Inhalt. vorbilder: diesen Stil gern wieder verwenden. ueberarbeiten: den '
  + 'Kommentar beim naechsten Design umsetzen und den Versuch verknuepfen (artefakt zeigen mit ueberarbeitet_aus:<id> bzw. '
  + 'artefakt(action:"versuch", bewertung_id, quelle_art, quelle_ref) fuer HTML per Inbox/Channel). verbannt: diese Merkmale nie wieder '
  + 'verwenden. HTML eines Eintrags: artefakt(action:"vorbild", bewertung_id).';

/** Kompakte Vorlieben fuer Agenten (ohne HTML), juengste zuerst; Schalter AUS -> aktiv false, leer. */
export async function leseDesignVorlieben(o: { limit?: unknown } = {}) {
  const s = await artefaktBewertungSchalter();
  const anzahl: Record<BewertungsZustand, number> = { vorbild: 0, ueberarbeiten: 0, verbannt: 0, versuch_gezeigt: 0 };
  const debug = { anzahl, gekappt: false, quelle: 'pg', schalter_quelle: s.quelle, ...(s.letzter_fehler ? { letzter_fehler: s.letzter_fehler } : {}) };
  if (!s.aktiv) {
    return { aktiv: false, vorbilder: [], ueberarbeiten: [], verbannt: [], hinweis: 'Artefakt-Bewertung ist aus (Produkt-Schalter artefakt_bewertung).', debug };
  }
  const n = Number(o.limit);
  const grenze = (standard: number) => (Number.isFinite(n) && n > 0 ? Math.min(VORLIEBEN_MAX, Math.trunc(n)) : standard);
  for (const z of (await getPool().query('SELECT zustand, count(*)::int AS n FROM artefakt_bewertungen GROUP BY zustand')).rows as Array<{ zustand: BewertungsZustand; n: number }>) {
    if (z.zustand in anzahl) anzahl[z.zustand] = z.n;
  }
  const liste = async (zustand: BewertungsZustand, limit: number) => (await getPool().query(
    `SELECT id, titel, merkmale, urheber_agent, kommentar FROM artefakt_bewertungen WHERE zustand = $1 ORDER BY bewertet_am DESC, id DESC LIMIT $2`,
    [zustand, limit])).rows as Array<Record<string, unknown>>;
  const eintrag = (z: Record<string, unknown>, mitKommentar: boolean) => ({
    id: String(z.id), ...(text(z.titel) ? { titel: z.titel } : {}), ...(merkmalText(z.merkmale as DesignMerkmale) ? { merkmale: merkmalText(z.merkmale as DesignMerkmale) } : {}),
    ...(mitKommentar && text(z.kommentar) ? { kommentar: z.kommentar } : {}), ...(text(z.urheber_agent) ? { urheber: z.urheber_agent } : {}),
  });
  const vorbilder = (await liste('vorbild', grenze(VORLIEBEN_STANDARD.vorbild))).map((z) => eintrag(z, false));
  const ueberarbeiten = (await liste('ueberarbeiten', grenze(VORLIEBEN_STANDARD.ueberarbeiten))).map((z) => eintrag(z, true));
  const verbannt = (await liste('verbannt', grenze(VORLIEBEN_STANDARD.verbannt))).map((z) => eintrag(z, false));
  debug.gekappt = vorbilder.length < anzahl.vorbild || ueberarbeiten.length < anzahl.ueberarbeiten || verbannt.length < anzahl.verbannt;
  return { aktiv: true, vorbilder, ueberarbeiten, verbannt, hinweis: VORLIEBEN_HINWEIS, debug };
}

/**
 * HTML eines bewerteten Designs (Beispiel fuer Agenten), gekappt auf VORBILD_HTML_MAX. P22-T147: dazu bewertung (Zustand,
 * Kommentar, bewertet_am, Hinweis je Zustand) wie bei artefakt zeigen mit artefakt_id.
 */
export async function ladeBewertungHtml(idRoh: unknown) {
  await brauchtSchalter();
  const id = bewertungsId(idRoh);
  const z = (await getPool().query(
    `SELECT id, titel, zustand, kommentar, html, merkmale, quelle_art, quelle_ref, urteil, bewertet_am, anzahl_bewertungen, nachfolger_art, nachfolger_ref
       FROM artefakt_bewertungen WHERE id = $1::bigint`, [id])).rows[0] as Record<string, unknown> | undefined;
  if (!z) throw new BewertungsFehler('bewertung_unbekannt', 'Bewertung ' + id + ' nicht gefunden', 404);
  const html = String(z.html);
  const gekappt = html.length > VORBILD_HTML_MAX;
  return {
    id: String(z.id), titel: text(z.titel), zustand: z.zustand as BewertungsZustand, kommentar: text(z.kommentar),
    merkmale: merkmalText(z.merkmale as DesignMerkmale), quelle: z.quelle_art + ':' + z.quelle_ref,
    html: gekappt ? html.slice(0, VORBILD_HTML_MAX) : html, ...(gekappt ? { gekappt: true, html_zeichen: html.length } : {}),
    bewertung: bewertungsHinweis(stand(z)),
  };
}

/**
 * Agent verknuepft den naechsten Versuch zu einem 'ueberarbeiten'. Der Versuch muss existieren; dieselbe Quelle wie das Original
 * gilt nur fuer ein Artefakt mit neuerer Revision (Block ersetzt). Danach: versuch_gezeigt + Nachfolger, Historie.
 */
export async function verknuepfeVersuch(e: { bewertung_id: unknown; quelle_art: unknown; quelle_ref: unknown; von?: string | null }):
  Promise<{ bewertung: BewertungsStand; hinweis: string }> {
  await brauchtSchalter();
  const id = bewertungsId(e.bewertung_id);
  if (!istQuelle(e.quelle_art)) throw new BewertungsFehler('quelle_art_ungueltig', 'quelle_art des Versuchs: artefakt | inbox | verlauf');
  const art = e.quelle_art;
  const ref = quelleRef(art, e.quelle_ref);
  const von = 'agent:' + (e.von && e.von.trim() ? e.von.trim() : 'unbekannt');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const nachfolger = (await client.query(art === 'artefakt' ? 'SELECT revision FROM agent_artifacts WHERE id = $1'
      : art === 'inbox' ? 'SELECT NULL::int AS revision FROM specialist_inbox WHERE id = $1::bigint' : 'SELECT NULL::int AS revision FROM hauptagent_verlauf WHERE id = $1::bigint', [ref])).rows[0] as { revision: number | null } | undefined;
    if (!nachfolger) throw new BewertungsFehler('nachfolger_unbekannt', 'Versuch ' + art + ':' + ref + ' nicht gefunden', 404);
    const z = (await client.query('SELECT * FROM artefakt_bewertungen WHERE id = $1::bigint FOR UPDATE', [id])).rows[0] as Record<string, unknown> | undefined;
    if (!z) throw new BewertungsFehler('bewertung_unbekannt', 'Bewertung ' + id + ' nicht gefunden', 404);
    if (z.zustand !== 'ueberarbeiten') {
      throw new BewertungsFehler(z.zustand === 'versuch_gezeigt' ? 'versuch_schon_gezeigt' : 'nicht_ueberarbeiten',
        z.zustand === 'versuch_gezeigt' ? 'Zu dieser Bewertung ist schon ein Versuch verknuepft (' + z.nachfolger_art + ':' + z.nachfolger_ref + ')'
          : 'Nur Designs im Zustand ueberarbeiten bekommen einen Versuch (Zustand: ' + z.zustand + ')', 409);
    }
    if (z.quelle_art === art && String(z.quelle_ref) === ref
      && !(art === 'artefakt' && nachfolger.revision !== null && z.quelle_revision !== null && Number(nachfolger.revision) > Number(z.quelle_revision))) {
      throw new BewertungsFehler('nachfolger_gleich_original', 'Der Versuch ist das bewertete Original selbst (ohne neue Revision)');
    }
    const neu = (await client.query(
      `UPDATE artefakt_bewertungen SET zustand = 'versuch_gezeigt', nachfolger_art = $2, nachfolger_ref = $3, versuch_von = $4, versuch_am = NOW()
        WHERE id = $1::bigint RETURNING *`, [id, art, ref, von])).rows[0] as Record<string, unknown>;
    await client.query(`INSERT INTO artefakt_bewertungen_historie (bewertung_id, urteil, kommentar, zustand, nachfolger_art, nachfolger_ref, von)
      VALUES ($1, $2, $3, 'versuch_gezeigt', $4, $5, $6)`, [id, neu.urteil, neu.kommentar, art, ref, von]);
    await client.query('COMMIT');
    return { bewertung: stand(neu), hinweis: 'Original aus "ueberarbeiten" genommen; der neue Versuch ist normal bewertbar.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Zahlen je Gruppe fuer Hinweise (Anmeldung, artefakt zeigen); Schalter AUS -> null. */
export async function designVorliebenZahlen(): Promise<{ vorbilder: number; ueberarbeiten: number; verbannt: number } | null> {
  if (!(await artefaktBewertungSchalter()).aktiv) return null;
  const z = { vorbilder: 0, ueberarbeiten: 0, verbannt: 0 };
  for (const r of (await getPool().query("SELECT zustand, count(*)::int AS n FROM artefakt_bewertungen WHERE zustand IN ('vorbild','ueberarbeiten','verbannt') GROUP BY zustand")).rows as Array<{ zustand: string; n: number }>) {
    if (r.zustand === 'vorbild') z.vorbilder = r.n; else if (r.zustand === 'ueberarbeiten') z.ueberarbeiten = r.n; else z.verbannt = r.n;
  }
  return z;
}

/** Eine Zeile fuer die Anmeldung; null bei Schalter AUS oder ohne Eintraege. */
export async function designVorliebenZeile(): Promise<string | null> {
  const z = await designVorliebenZahlen();
  if (!z || z.vorbilder + z.ueberarbeiten + z.verbannt === 0) return null;
  return 'Design-Vorlieben des Users (global, nur Design/Aufmachung): ' + z.vorbilder + ' Vorbild(er), ' + z.ueberarbeiten + ' zu ueberarbeiten, '
    + z.verbannt + ' verbannt. Vor jeder HTML-Antwort lesen: artefakt(action:"vorlieben").';
}

/*
 * P22-T161 (User 25.10.2026, inbox:1152/1153, Entwurf 14a0ca9b, Praezisierung 21f9eb78): TOP-ARTEFAKTE je Projekt des Arbeitsraums aus
 *   den Bewertungen (keine zweite Bewertungslogik). Hinein kommt, was mit Daten dieses Projekts entstanden ist: bewertung.project = P
 *   (Projekt der Urheber-Identitaet) ODER (Quelle artefakt) agent_artifacts.standard_project = P. Rangfolge: Standard nur 'vorbild';
 *   alle:true zeigt auch die anderen Zustaende (vorbild, ueberarbeiten, versuch_gezeigt, verbannt ganz unten). Innerhalb: Saldo aus der
 *   Historie (hoch minus runter, nur Urteile des Users), dann juengste Bewertung, dann id. Weg je Eintrag: vorlage | main | ausweis |
 *   inbox | verlauf. Revision: bewertet_revision gegen die aktuelle des Artefakts (veraendert_seit_bewertung). Liste ohne HTML; den
 *   bewerteten Schnappschuss liefert leseBewertungsSchnappschuss. LIVE: Trigger notify_artefakt_bewertung (Schema 156) meldet jede
 *   Aenderung auf ARTEFAKT_BEWERTUNG_KANAL; den Strom baut die rest-api (artefakt-bewertung-live.ts).
 * SCHALTER: haengt an artefakt_bewertung (AUS -> aktiv false, leer; Schnappschuss funktion_aus).
 * DEBUG: debug {anzahl je zustand im Projekt, gekappt, filter, sortierung, schalter_quelle, dauer_ms}.
 */
export const ARTEFAKT_BEWERTUNG_KANAL = 'synapse_artefakt_bewertung' as const;
export type TopWeg = 'vorlage' | 'main' | 'ausweis' | 'inbox' | 'verlauf';
export const TOP_ARTEFAKTE_STANDARD = 30;
const TOP_ARTEFAKTE_MAX = 100;
const KOMMENTAR_VORSCHAU = 160;
export const TOP_ZUSTAND_RANG: Record<BewertungsZustand, number> = { vorbild: 0, ueberarbeiten: 1, versuch_gezeigt: 2, verbannt: 3 };
export const TOP_SORTIERUNG = 'zustand (vorbild, ueberarbeiten, versuch_gezeigt, verbannt), saldo DESC, bewertet_am DESC, id DESC';

export interface TopArtefakt {
  bewertung_id: string; rang: number; quelle: { art: BewertungsQuelle; ref: string }; titel: string | null;
  zustand: BewertungsZustand; urteil: Urteil; kommentar_vorschau: string | null; kommentar_gekuerzt: boolean;
  urheber_agent: string | null; urheber_identity_id: string | null; project: string | null; standard_project: string | null;
  modus: 'fest' | 'stand' | 'live'; hat_vorlage: boolean; weg: TopWeg; artefakt_fehlt: boolean;
  bewertet_revision: number | null; aktuelle_revision: number | null; veraendert_seit_bewertung: boolean;
  bewertet_am: string; anzahl_bewertungen: number; saldo: number;
}

/** Weg eines bewerteten Blocks. Rein. */
export function topWeg(z: { quelle_art: string; hat_vorlage?: boolean | null; session_id?: string | null }): TopWeg {
  if (z.quelle_art === 'inbox') return 'inbox';
  if (z.quelle_art === 'verlauf') return 'verlauf';
  if (z.hat_vorlage) return 'vorlage';
  return z.session_id ? 'main' : 'ausweis';
}

/** Kommentar-Vorschau (eine Zeile, gekappt). Rein. */
export function kommentarVorschau(k: unknown): { text: string | null; gekuerzt: boolean } {
  const t = typeof k === 'string' ? k.replace(/\s+/g, ' ').trim() : '';
  if (!t) return { text: null, gekuerzt: false };
  return t.length > KOMMENTAR_VORSCHAU ? { text: t.slice(0, KOMMENTAR_VORSCHAU - 1).trimEnd() + '…', gekuerzt: true } : { text: t, gekuerzt: false };
}

/** Rangfolge wie die SQL-Sortierung (fuer Tests und Web-UI). Rein. */
export function vergleicheTop(a: Pick<TopArtefakt, 'zustand' | 'saldo' | 'bewertet_am' | 'bewertung_id'>, b: Pick<TopArtefakt, 'zustand' | 'saldo' | 'bewertet_am' | 'bewertung_id'>): number {
  return (TOP_ZUSTAND_RANG[a.zustand] - TOP_ZUSTAND_RANG[b.zustand]) || (b.saldo - a.saldo)
    || (Date.parse(b.bewertet_am) - Date.parse(a.bewertet_am)) || (Number(b.bewertung_id) - Number(a.bewertung_id));
}

function topProjekt(roh: unknown): string {
  const p = typeof roh === 'string' ? roh.trim() : '';
  if (!p || p.length > 200) throw new BewertungsFehler('project_fehlt', 'project (Projekt des Arbeitsraums) angeben');
  return p;
}

const TOP_FILTER = `(b.project = $1 OR a.standard_project = $1)`;
const TOP_JOIN = `FROM artefakt_bewertungen b LEFT JOIN agent_artifacts a ON b.quelle_art = 'artefakt' AND a.id::text = b.quelle_ref`;

/** P22-T161: Rangliste der bewerteten Artefakte eines Projekts (ohne HTML). Schalter AUS -> aktiv false, leer. */
export async function leseTopArtefakte(o: { project: unknown; alle?: unknown; limit?: unknown }) {
  const start = Date.now();
  const project = topProjekt(o.project);
  const alle = o.alle === true || o.alle === 'true' || o.alle === '1' || o.alle === 1;
  const n = Number(o.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(TOP_ARTEFAKTE_MAX, Math.trunc(n)) : TOP_ARTEFAKTE_STANDARD;
  const s = await artefaktBewertungSchalter();
  const anzahl: Record<BewertungsZustand, number> = { vorbild: 0, ueberarbeiten: 0, verbannt: 0, versuch_gezeigt: 0 };
  const debug = { anzahl, gekappt: false, alle, limit, filter: 'bewertung.project = project ODER artefakt.standard_project = project', sortierung: TOP_SORTIERUNG,
    schalter_quelle: s.quelle, dauer_ms: 0, ...(s.letzter_fehler ? { letzter_fehler: s.letzter_fehler } : {}) };
  if (!s.aktiv) { debug.dauer_ms = Date.now() - start; return { aktiv: false, project, eintraege: [] as TopArtefakt[], debug }; }
  for (const z of (await getPool().query(`SELECT b.zustand, count(*)::int AS n ${TOP_JOIN} WHERE ${TOP_FILTER} GROUP BY b.zustand`, [project])).rows as Array<{ zustand: BewertungsZustand; n: number }>) {
    if (z.zustand in anzahl) anzahl[z.zustand] = z.n;
  }
  const r = await getPool().query(
    `SELECT b.id, b.quelle_art, b.quelle_ref, b.quelle_revision, b.project, b.urheber_agent, b.urheber_identity_id, b.titel, b.urteil, b.kommentar,
            b.zustand, b.bewertet_am, b.anzahl_bewertungen, a.id IS NOT NULL AS artefakt_da, a.title AS artefakt_titel, a.revision AS artefakt_revision,
            a.session_id, a.modus, a.standard_project, (a.vorlage IS NOT NULL) AS hat_vorlage, COALESCE(h.saldo, 0)::int AS saldo
       ${TOP_JOIN}
       LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE x.urteil = 'hoch') - count(*) FILTER (WHERE x.urteil = 'runter') AS saldo
                            FROM artefakt_bewertungen_historie x WHERE x.bewertung_id = b.id AND x.von = 'user') h ON TRUE
      WHERE ${TOP_FILTER} AND ($2::boolean OR b.zustand = 'vorbild')
      ORDER BY CASE b.zustand WHEN 'vorbild' THEN 0 WHEN 'ueberarbeiten' THEN 1 WHEN 'versuch_gezeigt' THEN 2 ELSE 3 END,
               saldo DESC, b.bewertet_am DESC, b.id DESC
      LIMIT $3`, [project, alle, limit]);
  const eintraege: TopArtefakt[] = (r.rows as Array<Record<string, unknown>>).map((z, i) => {
    const k = kommentarVorschau(z.kommentar);
    const istArtefakt = z.quelle_art === 'artefakt';
    const bewertet = z.quelle_revision === null || z.quelle_revision === undefined ? null : Number(z.quelle_revision);
    const aktuell = istArtefakt && z.artefakt_da === true && z.artefakt_revision !== null ? Number(z.artefakt_revision) : null;
    const modus = z.modus === 'stand' || z.modus === 'live' ? z.modus : 'fest';
    return {
      bewertung_id: String(z.id), rang: i + 1, quelle: { art: z.quelle_art as BewertungsQuelle, ref: String(z.quelle_ref) },
      titel: text(z.artefakt_titel) ?? text(z.titel), zustand: z.zustand as BewertungsZustand, urteil: z.urteil as Urteil,
      kommentar_vorschau: k.text, kommentar_gekuerzt: k.gekuerzt, urheber_agent: text(z.urheber_agent), urheber_identity_id: text(z.urheber_identity_id),
      project: text(z.project), standard_project: text(z.standard_project), modus, hat_vorlage: z.hat_vorlage === true,
      weg: topWeg({ quelle_art: String(z.quelle_art), hat_vorlage: z.hat_vorlage === true, session_id: text(z.session_id) }),
      artefakt_fehlt: istArtefakt && z.artefakt_da !== true, bewertet_revision: bewertet, aktuelle_revision: aktuell,
      veraendert_seit_bewertung: bewertet !== null && aktuell !== null && aktuell !== bewertet,
      bewertet_am: new Date(z.bewertet_am as string | Date).toISOString(), anzahl_bewertungen: Number(z.anzahl_bewertungen), saldo: Number(z.saldo),
    };
  });
  const sichtbar = alle ? anzahl.vorbild + anzahl.ueberarbeiten + anzahl.verbannt + anzahl.versuch_gezeigt : anzahl.vorbild;
  debug.gekappt = eintraege.length < sichtbar;
  debug.dauer_ms = Date.now() - start;
  return { aktiv: true, project, eintraege, debug };
}

/** P22-T161: der bewertete Schnappschuss (HTML so, wie der User es bewertet hat), fuer den Umschalter in der Top-Liste. */
export async function leseBewertungsSchnappschuss(idRoh: unknown) {
  await brauchtSchalter();
  const id = bewertungsId(idRoh);
  const z = (await getPool().query(
    `SELECT id, titel, html, quelle_art, quelle_ref, quelle_revision, project, urheber_agent, zustand, bewertet_am FROM artefakt_bewertungen WHERE id = $1::bigint`,
    [id])).rows[0] as Record<string, unknown> | undefined;
  if (!z) throw new BewertungsFehler('bewertung_unbekannt', 'Bewertung ' + id + ' nicht gefunden', 404);
  return {
    bewertung_id: String(z.id), titel: text(z.titel), html: String(z.html), quelle: { art: z.quelle_art as BewertungsQuelle, ref: String(z.quelle_ref) },
    bewertet_revision: z.quelle_revision === null || z.quelle_revision === undefined ? null : Number(z.quelle_revision), project: text(z.project),
    urheber_agent: text(z.urheber_agent), zustand: z.zustand as BewertungsZustand, bewertet_am: new Date(z.bewertet_am as string | Date).toISOString(),
  };
}
