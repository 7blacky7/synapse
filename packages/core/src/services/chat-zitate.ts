/**
 * P22-T168 (User 25.10.2026, Entwurf b75a72bb Fassung 2, GO c32285ce F1-F8): Zitat-Anhaenge im Chat der Web-UI.
 * Der User haengt an seine Nachricht Verweise (Task, Plan, Thought, Memory, ...) bzw. markierte Ausschnitte mit eigener Anmerkung.
 * Sie gehen NUR mit dieser einen Nachricht an den EINEN Empfaenger des Chatfensters (Klarstellung inbox 1210, kein Rundversand).
 * TEXTBLOCK (F1, eine Wahrheit fuer jede Agentenart; baueZitatBlock) unter dem Nachrichtentext:
 *   [Synapse-Zitate: 2]
 *   1) Task P22-T158
 *      Projekt: synapse
 *      Titel: <Titel zum Zeitpunkt der Auswahl>
 *      Quelle: Nachricht inbox:1203          (optional)
 *      Ausschnitt: <markierter Text>         (optional; Folgezeilen 5 Leerzeichen eingerueckt)
 *      Anmerkung: <Text des Users>           (Folgezeilen 5 Leerzeichen eingerueckt)
 *   [/Synapse-Zitate] <Lesehinweis>
 *   Zeilen im Text/in Werten, die wie Kopf oder Ende des Blocks beginnen, werden entschaerft ('[zitiert: Synapse-Zitate').
 *   Main: Turn-Text = Nachricht + Block; Verlauf: text ohne Block, anhaenge = Zitate (art 'zitat'); die Warteschlange baut den Block
 *   aus anhaenge neu (mainTurnText). Inbox (Koordinator/Spezialisten lokal und im Container): specialist_inbox.content = Nachricht +
 *   Block; Daemon, Wrapper und Mod-Inbox bleiben unveraendert. Anzeige: web-ui zitat-logik.ts zerlegeZitatBlock (Golden-Test).
 * PRUEFUNG (F6): nur Format und Laenge, keine Existenzpruefung. Titel wird gekuerzt (debug gekuerzt), zu lange Anmerkung/Ausschnitt
 *   oder zu viele Zitate werden abgelehnt (kein stiller Verlust).
 * SCHALTER chat_zitate (Produkt-Schalter, Projekt des Empfaengers vor global; Main = global; Standard AUS, nur ausdruecklich);
 *   interner Test-Override gleichen Namens (intern_schalter, freigegeben, befristet) nur bei aktivem intern-Tool. AUS: eine Senderoute
 *   mit zitate antwortet 409 funktion_aus.
 * EINSTELLUNGEN (F8, Regel 7): Tabelle chat_zitate_einstellungen (Schema 157), Code-Standard CHAT_ZITATE_EINSTELLUNGEN, Quelle je
 *   Wert; setzen nur der User (REST PUT /api/main-agent/chat-zitate/einstellungen).
 * DEBUG: GET /api/main-agent/chat-zitate (Schalter mit Quelle, Grenzen mit Quelle, letzter Fehler); Senderouten antworten mit
 *   zitate {anzahl, block_zeichen, gekuerzt, schalter_quelle, empfaenger}.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';

type Q = import('pg').QueryConfig & { query_timeout: number };

export const CHAT_ZITATE_FUNKTION = 'chat_zitate' as const;
export const ZITAT_ARTEN = ['thought', 'memory', 'task', 'plan', 'doc', 'event', 'nachricht', 'chat', 'asset', 'ausschnitt'] as const;
export type ZitatArt = typeof ZITAT_ARTEN[number];
/** Name je Art im Block (ohne Leerzeichen); die Web-UI (zitat-logik.ts) kennt dieselbe Tabelle. */
export const ZITAT_ART_LABEL: Record<ZitatArt, string> = {
  thought: 'Thought', memory: 'Memory', task: 'Task', plan: 'Plan', doc: 'Doku', event: 'Event', nachricht: 'Channel-Nachricht',
  chat: 'Chat-Nachricht', asset: 'Bild', ausschnitt: 'Ausschnitt',
};
export const ZITAT_BLOCK_HINWEIS = 'Inhalte bei Bedarf über die IDs lesen (plan get, thought get, memory read …).';

// ---------------------------------------------------------------------------------------------
// Einstellungen (Regel 7: PG vor Code-Standard, Quelle je Wert)
// ---------------------------------------------------------------------------------------------
export const CHAT_ZITATE_EINSTELLUNGEN = {
  /** Zitate je Nachricht. */
  max_anzahl: { standard: 10, min: 1, max: 50 },
  /** Anmerkung je Zitat in Zeichen. */
  anmerkung_max: { standard: 2000, min: 50, max: 20000 },
  /** Markierter Ausschnitt je Zitat in Zeichen. */
  ausschnitt_max: { standard: 600, min: 50, max: 5000 },
  /** Titel je Zitat (Stand der Auswahl); laenger wird gekuerzt. */
  titel_max: { standard: 160, min: 20, max: 1000 },
} as const;
export type ChatZitateEinstellung = keyof typeof CHAT_ZITATE_EINSTELLUNGEN;
export type ChatZitateWerte = Record<ChatZitateEinstellung, number>;
export interface ChatZitateEinstellungenStand {
  werte: ChatZitateWerte;
  einstellungen: Record<string, { wert: number; quelle: 'standard' | 'einstellung'; min: number; max: number; gesetzt_von?: string; gesetzt_am?: string }>;
  letzter_fehler: string | null;
}

function standardEinstellungen(): ChatZitateEinstellungenStand {
  const werte = {} as ChatZitateWerte;
  const einstellungen: ChatZitateEinstellungenStand['einstellungen'] = {};
  for (const [name, d] of Object.entries(CHAT_ZITATE_EINSTELLUNGEN)) {
    werte[name as ChatZitateEinstellung] = d.standard;
    einstellungen[name] = { wert: d.standard, quelle: 'standard', min: d.min, max: d.max };
  }
  return { werte, einstellungen, letzter_fehler: null };
}

function gueltigerWert(name: string, wert: unknown): number | null {
  const d = CHAT_ZITATE_EINSTELLUNGEN[name as ChatZitateEinstellung];
  const n = typeof wert === 'number' ? wert : typeof wert === 'string' && wert.trim() ? Number(wert) : NaN;
  return d && Number.isInteger(n) && n >= d.min && n <= d.max ? n : null;
}

/** Wirksame Einstellungen (PG vor Code-Standard). Lesefehler -> Standard mit letzter_fehler. Wirft nie. */
export async function leseChatZitateEinstellungen(): Promise<ChatZitateEinstellungenStand> {
  const stand = standardEinstellungen();
  try {
    const r = await getPool().query<{ name: string; wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(
      'SELECT name, wert, gesetzt_von, gesetzt_am FROM chat_zitate_einstellungen');
    const ungueltig: string[] = [];
    for (const z of r.rows) {
      const w = gueltigerWert(z.name, z.wert);
      if (w === null) { ungueltig.push(z.name); continue; }
      stand.werte[z.name as ChatZitateEinstellung] = w;
      const d = CHAT_ZITATE_EINSTELLUNGEN[z.name as ChatZitateEinstellung];
      stand.einstellungen[z.name] = { wert: w, quelle: 'einstellung', min: d.min, max: d.max, gesetzt_von: z.gesetzt_von,
        gesetzt_am: z.gesetzt_am instanceof Date ? z.gesetzt_am.toISOString() : String(z.gesetzt_am) };
    }
    if (ungueltig.length) stand.letzter_fehler = 'einstellung_ungueltig: ' + ungueltig.join(', ');
  } catch (error) {
    stand.letzter_fehler = 'einstellungen_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error));
  }
  return stand;
}

/** Einstellungen setzen (nur der User, die Route prueft das). werte {name: zahl|null}; null = zurueck auf den Code-Standard. */
export async function setzeChatZitateEinstellungen(werte: unknown, grund: unknown, von: string): Promise<ChatZitateEinstellungenStand> {
  if (!werte || typeof werte !== 'object' || Array.isArray(werte)) throw new ProfilVerwaltungFehler('werte_fehlen', { erlaubt: Object.keys(CHAT_ZITATE_EINSTELLUNGEN) });
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < 5) throw new ProfilVerwaltungFehler('grund_fehlt');
  const eintraege = Object.entries(werte as Record<string, unknown>);
  for (const [name, wert] of eintraege) {
    if (!(name in CHAT_ZITATE_EINSTELLUNGEN)) throw new ProfilVerwaltungFehler('einstellung_unbekannt', { name, erlaubt: Object.keys(CHAT_ZITATE_EINSTELLUNGEN) });
    if (wert !== null && gueltigerWert(name, wert) === null) {
      const d = CHAT_ZITATE_EINSTELLUNGEN[name as ChatZitateEinstellung];
      throw new ProfilVerwaltungFehler('wert_ungueltig', { name, min: d.min, max: d.max });
    }
  }
  const setzen = eintraege.filter(([, w]) => w !== null).map(([n, w]) => [n, gueltigerWert(n, w)] as const);
  const entfernen = eintraege.filter(([, w]) => w === null).map(([n]) => n);
  const pool = getPool();
  if (setzen.length) {
    await pool.query(
      `INSERT INTO chat_zitate_einstellungen (name, wert, grund, gesetzt_von)
       SELECT n, to_jsonb(w), $3, $4 FROM unnest($1::text[], $2::int[]) AS t(n, w)
       ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW()`,
      [setzen.map(([n]) => n), setzen.map(([, w]) => w), g, von]);
  }
  if (entfernen.length) await pool.query('DELETE FROM chat_zitate_einstellungen WHERE name = ANY($1::text[])', [entfernen]);
  return leseChatZitateEinstellungen();
}

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface ChatZitateSchalter {
  funktion: typeof CHAT_ZITATE_FUNKTION;
  project: string | null;
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  ebene: 'global' | 'projekt' | null;
  bis: string | null;
  letzter_fehler: string | null;
}

/** intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (projekt > global) > AUS. Frisch je Aufruf, wirft nie. */
export async function leseChatZitateSchalter(project?: string | null): Promise<ChatZitateSchalter> {
  const p = typeof project === 'string' && project.trim() ? project.trim() : null;
  const basis: ChatZitateSchalter = { funktion: CHAT_ZITATE_FUNKTION, project: p, aktiv: false, quelle: 'standard', ebene: null, bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  try {
    // Dynamisch wie runtime-ueberwachung.ts (Importzyklus ueber intern-tool).
    const { internToolAktiv } = await import('./intern-tool.js');
    if (internToolAktiv()) {
      try {
        const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
          text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
          values: [CHAT_ZITATE_FUNKTION], query_timeout: 2000,
        } as Q);
        const z = r.rows[0];
        if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
      } catch { letzter = 'schalter_nicht_erreichbar'; }
    }
    const s = await leseProfilProduktSchalter(CHAT_ZITATE_FUNKTION, p);
    if (s.quelle === 'produkt-schalter' && !s.letzter_fehler) return { ...basis, aktiv: s.aktiv, quelle: 'produkt-schalter', ebene: s.ebene, letzter_fehler: letzter };
    return { ...basis, letzter_fehler: letzter ?? s.letzter_fehler };
  } catch (error) {
    return { ...basis, letzter_fehler: 'schalter_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

// ---------------------------------------------------------------------------------------------
// Pruefung (F6: Format und Laenge)
// ---------------------------------------------------------------------------------------------
export interface GeprueftesZitat {
  art: ZitatArt;
  /** null nur bei art 'ausschnitt' ohne erkannten Verweis. */
  id: string | null;
  projekt: string;
  titel: string;
  ausschnitt: string | null;
  /** Nachricht, aus der der Ausschnitt stammt (z. B. 'inbox:1203' oder 'verlauf:<id>'). */
  quelle: string | null;
  anmerkung: string;
}
export type ZitatPruefung = { ok: true; zitate: GeprueftesZitat[]; gekuerzt: string[] }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

const istArt = (v: unknown): v is ZitatArt => typeof v === 'string' && (ZITAT_ARTEN as readonly string[]).includes(v);
const einzeilig = (v: string): string => v.replace(/\s+/g, ' ').trim();
const ID_MAX = 300, PROJEKT_MAX = 120, QUELLE_MAX = 80;

/** Rohe Zitate eines Senders pruefen. undefined/null/[] = keine Zitate. Rein (ohne PG). */
export function pruefeZitate(roh: unknown, grenzen: ChatZitateWerte): ZitatPruefung {
  if (roh === undefined || roh === null) return { ok: true, zitate: [], gekuerzt: [] };
  if (!Array.isArray(roh)) return { ok: false, code: 'zitate_ungueltig', message: 'zitate muss eine Liste sein' };
  if (roh.length > grenzen.max_anzahl) return { ok: false, code: 'zu_viele_zitate', message: 'Höchstens ' + grenzen.max_anzahl + ' Zitate je Nachricht', details: { max_anzahl: grenzen.max_anzahl, anzahl: roh.length } };
  const zitate: GeprueftesZitat[] = [];
  const gekuerzt: string[] = [];
  for (const [i, e] of roh.entries()) {
    const nr = i + 1;
    const fehler = (code: string, message: string, details: Record<string, unknown> = {}): ZitatPruefung => ({ ok: false, code, message: 'Zitat ' + nr + ': ' + message, details: { zitat: nr, ...details } });
    if (!e || typeof e !== 'object' || Array.isArray(e)) return fehler('zitat_ungueltig', 'kein Objekt');
    const o = e as Record<string, unknown>;
    if (!istArt(o.art)) return fehler('zitat_art_ungueltig', 'unbekannte Art', { erlaubt: ZITAT_ARTEN });
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (o.art !== 'ausschnitt' && !id) return fehler('zitat_id_fehlt', 'ID fehlt');
    if (id.length > ID_MAX || /[\r\n]/.test(id)) return fehler('zitat_id_ungueltig', 'ID ungültig (einzeilig, höchstens ' + ID_MAX + ' Zeichen)');
    const projekt = typeof o.projekt === 'string' ? o.projekt.trim() : '';
    if (!projekt || projekt.length > PROJEKT_MAX || /\s/.test(projekt)) return fehler('zitat_projekt_ungueltig', 'Projekt fehlt oder ist ungültig');
    let titel = typeof o.titel === 'string' ? einzeilig(o.titel) : '';
    if (titel.length > grenzen.titel_max) { titel = titel.slice(0, grenzen.titel_max - 1).trimEnd() + '…'; gekuerzt.push(nr + ':titel'); }
    const ausschnitt = typeof o.ausschnitt === 'string' ? o.ausschnitt.replace(/\r\n/g, '\n').trim() : '';
    if (o.art === 'ausschnitt' && !ausschnitt) return fehler('zitat_ausschnitt_fehlt', 'markierter Ausschnitt fehlt');
    if (ausschnitt.length > grenzen.ausschnitt_max) return fehler('zitat_ausschnitt_zu_lang', 'Ausschnitt länger als ' + grenzen.ausschnitt_max + ' Zeichen', { ausschnitt_max: grenzen.ausschnitt_max });
    const q = o.quelle && typeof o.quelle === 'object' ? (o.quelle as Record<string, unknown>).nachricht : o.quelle;
    const quelle = typeof q === 'string' && /^[A-Za-z0-9:._-]{1,80}$/.test(q.trim()) ? q.trim().slice(0, QUELLE_MAX) : null;
    const anmerkung = typeof o.anmerkung === 'string' ? o.anmerkung.replace(/\r\n/g, '\n').trim() : '';
    if (anmerkung.length > grenzen.anmerkung_max) return fehler('zitat_anmerkung_zu_lang', 'Anmerkung länger als ' + grenzen.anmerkung_max + ' Zeichen', { anmerkung_max: grenzen.anmerkung_max });
    zitate.push({ art: o.art, id: o.art === 'ausschnitt' ? (id || null) : id, projekt, titel, ausschnitt: ausschnitt || null, quelle, anmerkung });
  }
  return { ok: true, zitate, gekuerzt };
}

export interface ZitatDebug { anzahl: number; gekuerzt: string[]; schalter_quelle: string }
export type ZitatAnfrage = { ok: true; zitate: GeprueftesZitat[]; debug: ZitatDebug | null }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

/** Zitate einer Senderoute: ohne Zitate nichts lesen; sonst Schalter (Projekt des Empfaengers, Main = null) und Grenzen. Wirft nie. */
export async function pruefeChatZitateAnfrage(roh: unknown, project: string | null): Promise<ZitatAnfrage> {
  if (roh === undefined || roh === null || (Array.isArray(roh) && roh.length === 0)) return { ok: true, zitate: [], debug: null };
  const schalter = await leseChatZitateSchalter(project);
  if (!schalter.aktiv) {
    return { ok: false, status: 409, code: 'funktion_aus', message: 'Zitat-Anhänge sind aus (chat_zitate)', details: { schalter } };
  }
  const p = pruefeZitate(roh, (await leseChatZitateEinstellungen()).werte);
  if (!p.ok) return { ok: false, status: 400, code: p.code, message: p.message, ...(p.details ? { details: p.details } : {}) };
  return { ok: true, zitate: p.zitate, debug: { anzahl: p.zitate.length, gekuerzt: p.gekuerzt, schalter_quelle: schalter.quelle } };
}

// ---------------------------------------------------------------------------------------------
// Textblock
// ---------------------------------------------------------------------------------------------
/** Zeilen, die wie Kopf/Ende des Blocks beginnen (auch nach Leerraum, Gross/klein egal), entschaerfen. Rein. */
export function entschaerfeZitatZeilen(text: string): string {
  return text.replace(/^([^\S\n]*)\[(\/?)synapse-zitate/gim, '$1[zitiert: $2Synapse-Zitate');
}

const einruecken = (wert: string): string => entschaerfeZitatZeilen(wert).split('\n').map((z, i) => (i === 0 ? z : '     ' + z)).join('\n');

/** Block fuer die Zitate (leer ohne Zitate). Rein. */
export function baueZitatBlock(zitate: readonly GeprueftesZitat[]): string {
  if (!zitate.length) return '';
  const zeilen = ['[Synapse-Zitate: ' + zitate.length + ']'];
  zitate.forEach((z, i) => {
    zeilen.push((i + 1) + ') ' + ZITAT_ART_LABEL[z.art] + (z.id ? ' ' + z.id : ''));
    zeilen.push('   Projekt: ' + z.projekt);
    if (z.titel) zeilen.push('   Titel: ' + entschaerfeZitatZeilen(z.titel));
    if (z.quelle) zeilen.push('   Quelle: Nachricht ' + z.quelle);
    if (z.ausschnitt) zeilen.push('   Ausschnitt: ' + einruecken(z.ausschnitt));
    zeilen.push('   Anmerkung:' + (z.anmerkung ? ' ' + einruecken(z.anmerkung) : ''));
  });
  zeilen.push('[/Synapse-Zitate] ' + ZITAT_BLOCK_HINWEIS);
  return zeilen.join('\n');
}

/** Nachricht + Block (ohne Zitate unveraendert). Mit Zitaten wird der freie Text entschaerft. Rein. */
export function textMitZitaten(text: string, zitate: readonly GeprueftesZitat[]): string {
  if (!zitate.length) return text;
  const t = entschaerfeZitatZeilen(text ?? '').trimEnd();
  const block = baueZitatBlock(zitate);
  return t ? t + '\n\n' + block : block;
}

// ---------------------------------------------------------------------------------------------
// Verlauf (Main): Zitate als anhaenge der User-Zeile
// ---------------------------------------------------------------------------------------------
export interface VerlaufZitatAnhang {
  art: 'zitat'; verweis_art: ZitatArt; id: string | null; projekt: string; titel: string; ausschnitt: string | null; quelle: string | null; anmerkung: string;
}

export function zitatAlsVerlaufAnhang(z: GeprueftesZitat): VerlaufZitatAnhang {
  return { art: 'zitat', verweis_art: z.art, id: z.id, projekt: z.projekt, titel: z.titel, ausschnitt: z.ausschnitt, quelle: z.quelle, anmerkung: z.anmerkung };
}

const kappe = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Gespeicherten Anhang (art 'zitat') normalisieren; sonst null. Laengen grob gekappt (gepruefte Werte bleiben unveraendert). Rein. */
export function verlaufZitatAnhang(v: unknown): VerlaufZitatAnhang | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  if (!o || o.art !== 'zitat' || !istArt(o.verweis_art)) return null;
  const projekt = kappe(o.projekt, PROJEKT_MAX).trim();
  if (!projekt) return null;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, ID_MAX) : null;
  if (o.verweis_art !== 'ausschnitt' && !id) return null;
  return {
    art: 'zitat', verweis_art: o.verweis_art, id, projekt, titel: kappe(o.titel, CHAT_ZITATE_EINSTELLUNGEN.titel_max.max),
    ausschnitt: typeof o.ausschnitt === 'string' && o.ausschnitt ? o.ausschnitt.slice(0, CHAT_ZITATE_EINSTELLUNGEN.ausschnitt_max.max) : null,
    quelle: typeof o.quelle === 'string' && o.quelle ? o.quelle.slice(0, QUELLE_MAX) : null,
    anmerkung: kappe(o.anmerkung, CHAT_ZITATE_EINSTELLUNGEN.anmerkung_max.max),
  };
}

/** Zitate aus den anhaenge einer Verlaufszeile (Reihenfolge bleibt). Rein. */
export function zitateAusVerlaufAnhaengen(anhaenge: unknown): GeprueftesZitat[] {
  if (!Array.isArray(anhaenge)) return [];
  return anhaenge.flatMap((a) => {
    const z = verlaufZitatAnhang(a);
    return z ? [{ art: z.verweis_art, id: z.id, projekt: z.projekt, titel: z.titel, ausschnitt: z.ausschnitt, quelle: z.quelle, anmerkung: z.anmerkung }] : [];
  });
}

/** Turn-Text einer gespeicherten User-Zeile des Main (Warteschlange): Text + Block aus den Zitat-Anhaengen. Rein. */
export function mainTurnText(text: string, anhaenge: unknown): string {
  return textMitZitaten(text, zitateAusVerlaufAnhaengen(anhaenge));
}
