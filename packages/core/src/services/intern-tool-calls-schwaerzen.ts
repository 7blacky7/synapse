/**
 * MODUL: intern tool_calls_nachschwaerzen (P10-T74, 14.10.2026)
 * ZWECK: Bestehende tool_calls-Zeilen (args_preview, result, error) mit DERSELBEN Schwaerzung neu schreiben,
 *        die logToolCall seit P10-T72 vor jedem INSERT anwendet (schwaerzeToolLogText aus tool-args-schwaerzen.ts).
 *        Anlass: project(projekt_db)-Antworten mit Passwort/DATABASE_URL stehen im Altbestand ungeschwaerzt.
 *
 * ERKENNUNG: Eine Zeile gilt als betroffen, wenn schwaerzeToolLogText mindestens eines ihrer drei Felder
 *   veraendern wuerde. Keine eigene Regel, keine Zusatzmuster - genau die Funktion des Schreibwegs.
 *
 * ABLAUF:
 *   - Standard = Vorschau: zaehlt geprueft/betroffen je Feld und je Tool, listet IDs mit Feldnamen (bis 200),
 *     bei ids-Filter auch gefunden / nicht_gefunden / ohne_treffer. NIEMALS Inhalte, Ausschnitte oder Hashes.
 *   - ausfuehren:true: je Zeile EINE Transaktion (lock_timeout 3 s, statement_timeout 30 s), FOR UPDATE,
 *     Neuberechnung aus dem gesperrten Stand, nur geaenderte Felder werden geschrieben. limit = Stapelgroesse
 *     (geschriebene Zeilen je Aufruf). Ein zweiter Lauf aendert nichts mehr. Scheitert eine Zeile (Sperre,
 *     Timeout), meldet die Antwort vollstaendig:false und nicht_geschrieben_ids (nur IDs) - erneut ausfuehren.
 *   - Filter: ids, project, tools, seit/bis (tool_calls.ts), ab_id (Fortsetzung).
 *   - SCAN-GRENZE (Pruefung N1): Ohne ids laeuft der Scan in ID-Fenstern (je hoechstens 200 IDs, PK-Bereich
 *     id > a AND id <= b). max_pruefen begrenzt die gescannte ID-SPANNE je Aufruf (Standard 20000, max 500000),
 *     unabhaengig davon, wie duenn der Filter ist; naechste_ab_id setzt fort. Einzige ungefensterte Abfrage ist
 *     die Startsuche (erste passende ID, ORDER BY id LIMIT 1) ohne ab_id - sie ist durch statement_timeout 60 s
 *     begrenzt. Mit ids gibt es keine Spannen-Grenze (hoechstens 1000 IDs).
 *   - Vorschau UND Ausfuehren nur fuer Koordinator/User (die ID-Liste zeigt, wo Geheimnisse lagen).
 *   - max_pruefen und limit muessen positive ganze Zahlen sein (0, negativ, Text -> parameter_ungueltig).
 *   - P10-T76: regeln:[...] wendet nur diese Regel-Kennungen an (SCHWAERZ_REGELN aus tool-args-schwaerzen.ts,
 *     unbekannte -> parameter_ungueltig). Die Antwort nennt je_regel, je_schluessel (normalisierte Namen, nie
 *     Werte) und je ID die Regeln mit Treffern. Ohne regeln gilt weiter: Erkennung = Schreibweg.
 * NICHT UMKEHRBAR: geschwaerzte Werte sind danach weg (wie bei neuen Eintraegen). result_bytes bleibt die
 *   Originalgroesse, result_truncated bleibt unveraendert.
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { schwaerzeToolLogTextMitRegeln, SCHWAERZ_REGELN, TOOL_LOG_PLATZHALTER } from './tool-args-schwaerzen.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';

export const TOOL_CALLS_SCHWAERZEN_ACTIONS = ['tool_calls_nachschwaerzen'] as const;
export type ToolCallsSchwaerzenAction = (typeof TOOL_CALLS_SCHWAERZEN_ACTIONS)[number];

export function istToolCallsSchwaerzenAction(action: string): action is ToolCallsSchwaerzenAction {
  return (TOOL_CALLS_SCHWAERZEN_ACTIONS as readonly string[]).includes(action);
}

export const TOOL_CALLS_SCHWAERZEN_BESCHREIBUNG =
  'TOOL_CALLS-ALTBESTAND: tool_calls_nachschwaerzen (ids, project, tools, seit, bis, ab_id, max_pruefen, regeln, ausfuehren, limit): ' +
  'bestehende tool_calls-Zeilen (args_preview, result, error) mit derselben Schwaerzung wie logToolCall neu schreiben; ' +
  'betroffen = die Schwaerzung wuerde ein Feld aendern. Standard Vorschau: Anzahl, IDs mit Feldnamen, je Tool, bei ids ' +
  'gefunden/nicht_gefunden/ohne_treffer - nie Inhalte. ausfuehren:true je Zeile Sperre (lock_timeout) und Neuberechnung, ' +
  'limit = Zeilen je Aufruf, nicht umkehrbar; gescheiterte Zeilen -> vollstaendig:false + nicht_geschrieben_ids. ' +
  'max_pruefen = gescannte ID-Spanne je Aufruf, Fortsetzung mit ab_id. Vorschau und Ausfuehren nur Koordinator/User. ' +
  'regeln:[' + SCHWAERZ_REGELN.join(',') + '] = nur diese Regeln anwenden; Antwort je_regel, je_schluessel und je ID regeln. ';

/** Nur NEUE Parameter (project, tools, seit, bis, limit, ausfuehren gibt es schon). */
export const TOOL_CALLS_SCHWAERZEN_PARAMETER: Record<string, unknown> = {
  ids: { type: ['array', 'string'], items: { type: ['number', 'string'] }, description: 'tool_calls_nachschwaerzen: nur diese tool_calls-IDs (hoechstens 1000)' },
  ab_id: { type: ['number', 'string'], description: 'tool_calls_nachschwaerzen: erst nach dieser ID weiterpruefen (naechste_ab_id der letzten Antwort)' },
  max_pruefen: { type: 'number', description: 'tool_calls_nachschwaerzen: hoechstens diese ID-Spanne je Aufruf scannen (positive ganze Zahl, Standard 20000, max 500000; mit ids ohne Grenze)' },
  regeln: { type: ['array', 'string'], items: { type: 'string', enum: [...SCHWAERZ_REGELN] }, description: 'tool_calls_nachschwaerzen: nur diese Regel-Kennungen anwenden (' + SCHWAERZ_REGELN.join(', ') + '); ohne = alle wie logToolCall' },
};

const FELDER = ['args_preview', 'result', 'error'] as const;
type Feld = (typeof FELDER)[number];
const SEITE = 200;
const IDS_MAX = 1000;
const ANZEIGE_MAX = 200;
const PRUEF_STANDARD = 20_000;
const PRUEF_MAX = 500_000;
const LIMIT_MAX = 1_000_000;

export interface NachschwaerzenOptionen {
  ids?: string[];
  project?: string;
  tools?: string[];
  seit?: string;
  bis?: string;
  abId?: string;
  maxPruefen?: number;
  /** P10-T76: nur diese Regel-Kennungen (SCHWAERZ_REGELN); ohne = alle (= Schreibweg). */
  regeln?: string[];
  ausfuehren: boolean;
  limit?: number;
}

export class NachschwaerzenFehler extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function zaehlePlatzhalter(s: string): number {
  let n = 0;
  for (let i = s.indexOf(TOOL_LOG_PLATZHALTER); i >= 0; i = s.indexOf(TOOL_LOG_PLATZHALTER, i + 1)) n++;
  return n;
}

/** Schwaerzt die drei Felder einer Zeile wie logToolCall (bzw. nur mit regeln). Liefert nur geaenderte Felder,
 * dazu Treffer je Regel-Kennung und je Schluesselname (P10-T76). */
export function schwaerzeToolCallZeile(zeile: Partial<Record<Feld, string | null>>, regeln?: readonly string[]): {
  neu: Partial<Record<Feld, string>>; felder: Feld[]; ersetzungen: number; regeln: Record<string, number>; schluessel: Record<string, number>;
} {
  const neu: Partial<Record<Feld, string>> = {};
  const felder: Feld[] = [];
  let ersetzungen = 0;
  const jeRegel: Record<string, number> = {};
  const jeSchluessel: Record<string, number> = {};
  for (const f of FELDER) {
    const alt = zeile[f];
    if (typeof alt !== 'string' || alt === '') continue;
    const bericht = schwaerzeToolLogTextMitRegeln(alt, { regeln });
    const geschwaerzt = bericht.text;
    if (typeof geschwaerzt !== 'string' || geschwaerzt === alt) continue;
    neu[f] = geschwaerzt;
    felder.push(f);
    ersetzungen += Math.max(0, zaehlePlatzhalter(geschwaerzt) - zaehlePlatzhalter(alt));
    for (const [r, n] of Object.entries(bericht.treffer)) jeRegel[r] = (jeRegel[r] ?? 0) + (n ?? 0);
    for (const [s, n] of Object.entries(bericht.schluessel)) jeSchluessel[s] = (jeSchluessel[s] ?? 0) + n;
  }
  return { neu, felder, ersetzungen, regeln: jeRegel, schluessel: jeSchluessel };
}

/** P10-T76: regeln-Parameter pruefen (Liste oder Komma-Text; unbekannte Kennung -> parameter_ungueltig). */
function regelListe(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  let roh: unknown = v;
  if (typeof roh === 'string') {
    const t = roh.trim();
    if (t === '') return undefined;
    if (t.startsWith('[')) { try { roh = JSON.parse(t); } catch { throw new NachschwaerzenFehler('parameter_ungueltig', 'regeln: JSON-Liste nicht lesbar'); } }
    else roh = t.split(',');
  }
  if (!Array.isArray(roh)) throw new NachschwaerzenFehler('parameter_ungueltig', 'regeln: Liste von Regel-Kennungen erwartet');
  const l = [...new Set(roh.map((x) => String(x).trim()).filter(Boolean))];
  const unbekannt = l.filter((r) => !(SCHWAERZ_REGELN as readonly string[]).includes(r));
  if (unbekannt.length) {
    throw new NachschwaerzenFehler('parameter_ungueltig', 'regeln: unbekannt ' + unbekannt.join(', ') + ' (erlaubt: ' + SCHWAERZ_REGELN.join(', ') + ')');
  }
  return l.length ? l : undefined;
}

const SCHLUESSEL_ANZEIGE_MAX = 50;

function pruefeZeit(name: string, wert?: string): void {
  if (wert !== undefined && (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(wert) || !Number.isFinite(Date.parse(wert)))) {
    throw new NachschwaerzenFehler('parameter_ungueltig', name + ' muss ein gueltiger ISO-Zeitpunkt sein');
  }
}

/** Lesende Abfrage in eigener READ-ONLY-Transaktion mit statement_timeout. */
async function lies(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const c: PoolClient = await getPool().connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SET LOCAL statement_timeout = '60s'");
    const rows = (await c.query(sql, params)).rows as Array<Record<string, unknown>>;
    await c.query('COMMIT');
    return rows;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const SPALTEN = 'SELECT id::text AS id, project, tool_name, args_preview, result, error FROM tool_calls';

export async function toolCallsNachschwaerzen(opt: NachschwaerzenOptionen): Promise<Record<string, unknown>> {
  pruefeZeit('seit', opt.seit);
  pruefeZeit('bis', opt.bis);
  if (opt.ids && opt.ids.length > IDS_MAX) throw new NachschwaerzenFehler('parameter_ungueltig', 'ids: hoechstens ' + IDS_MAX + ' IDs je Aufruf');
  for (const [name, wert, max] of [['limit', opt.limit, LIMIT_MAX], ['max_pruefen', opt.maxPruefen, PRUEF_MAX]] as const) {
    if (wert !== undefined && (!Number.isInteger(wert) || wert <= 0 || wert > max)) {
      throw new NachschwaerzenFehler('parameter_ungueltig', `${name}: positive ganze Zahl bis ${max} erwartet`);
    }
  }
  const grenze = opt.limit ?? Infinity;
  const maxPruefen = opt.maxPruefen ?? PRUEF_STANDARD;
  const pool = getPool();
  const beginn = Date.now();

  let geprueft = 0, gescannt = 0, betroffen = 0, geschrieben = 0, uebersprungen = 0, fehler = 0, ersetzungen = 0;
  const jeFeld: Record<Feld, number> = { args_preview: 0, result: 0, error: 0 };
  const jeTool: Record<string, number> = {};
  const jeRegel: Record<string, number> = {};
  const jeSchluessel: Record<string, number> = {};
  const liste: Array<{ id: string; tool: string; project: string | null; felder: Feld[]; regeln: string[] }> = [];
  let listeGekappt = false;
  const nichtGeschrieben: string[] = [];
  const gefunden = new Set<string>();
  const mitTreffer = new Set<string>();

  // Filter ohne ids und ohne ID-Bereich; params wird fortlaufend befuellt.
  const filter = (params: unknown[]): string[] => {
    const w: string[] = [];
    if (opt.project) { params.push(opt.project); w.push('project = $' + params.length); }
    if (opt.tools && opt.tools.length) { params.push(opt.tools); w.push('tool_name = ANY($' + params.length + '::text[])'); }
    if (opt.seit) { params.push(opt.seit); w.push('ts >= $' + params.length + '::timestamptz'); }
    if (opt.bis) { params.push(opt.bis); w.push('ts < $' + params.length + '::timestamptz'); }
    return w;
  };

  /** Eine Zeile pruefen und ggf. schreiben. true = limit erreicht (abbrechen). */
  const verarbeite = async (r: Record<string, unknown>): Promise<boolean> => {
    const id = String(r.id);
    geprueft++;
    gefunden.add(id);
    const { felder, ersetzungen: n, regeln: zr, schluessel: zs } = schwaerzeToolCallZeile(r as Partial<Record<Feld, string | null>>, opt.regeln);
    if (felder.length === 0) return false;
    betroffen++;
    ersetzungen += n;
    for (const [k, c] of Object.entries(zr)) jeRegel[k] = (jeRegel[k] ?? 0) + c;
    for (const [k, c] of Object.entries(zs)) jeSchluessel[k] = (jeSchluessel[k] ?? 0) + c;
    mitTreffer.add(id);
    for (const f of felder) jeFeld[f]++;
    const tool = String(r.tool_name ?? '');
    jeTool[tool] = (jeTool[tool] ?? 0) + 1;
    if (liste.length < ANZEIGE_MAX) liste.push({ id, tool, project: (r.project as string | null) ?? null, felder, regeln: Object.keys(zr).sort() });
    else listeGekappt = true;
    if (!opt.ausfuehren) return false;
    const k = await pool.connect();
    try {
      await k.query('BEGIN');
      await k.query("SET LOCAL lock_timeout = '3s'");
      await k.query("SET LOCAL statement_timeout = '30s'");
      await k.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const akt = (await k.query('SELECT args_preview, result, error FROM tool_calls WHERE id = $1::bigint FOR UPDATE', [id])).rows[0];
      const neu = akt ? schwaerzeToolCallZeile(akt, opt.regeln).neu : {};
      const spalten = Object.keys(neu) as Feld[];
      if (spalten.length === 0) { uebersprungen++; await k.query('ROLLBACK'); }
      else {
        await k.query('UPDATE tool_calls SET ' + spalten.map((s, i) => s + ' = $' + (i + 1)).join(', ') + ' WHERE id = $' + (spalten.length + 1) + '::bigint',
          [...spalten.map((s) => neu[s]), id]);
        await k.query('COMMIT');
        geschrieben++;
      }
    } catch (e) {
      await k.query('ROLLBACK').catch(() => {});
      fehler++;
      nichtGeschrieben.push(id);
      console.error('[intern tool_calls_nachschwaerzen]', id, (e as { code?: string }).code ?? (e as Error).name);
    } finally {
      k.release();
    }
    return geschrieben >= grenze;
  };

  let scanFertig = true;
  let naechste: string | null = null;

  if (opt.ids) {
    // ids-Modus: hoechstens 1000 IDs, in Seiten a 200, keine Spannen-Grenze.
    const sortiert = [...opt.ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    ids: for (let i = 0; i < sortiert.length; i += SEITE) {
      const params: unknown[] = [sortiert.slice(i, i + SEITE)];
      const w = ['id = ANY($1::bigint[])', ...filter(params)];
      const zeilen = await lies(SPALTEN + ' WHERE ' + w.join(' AND ') + ' ORDER BY id', params);
      for (const r of zeilen) {
        if (await verarbeite(r)) {
          // ids-Modus kennt kein ab_id: Fortsetzung = dieselben ids erneut (idempotent), naechste_ab_id bleibt null.
          if (sortiert.some((x) => BigInt(x) > BigInt(String(r.id)))) scanFertig = false;
          break ids;
        }
      }
    }
  } else {
    // Fenster-Modus (N1): PK-Bereiche, max_pruefen = gescannte ID-Spanne.
    const maxId = BigInt(String((await lies('SELECT COALESCE(max(id), 0)::text AS m FROM tool_calls', []))[0].m));
    let nach: bigint;
    if (opt.abId !== undefined) nach = BigInt(opt.abId);
    else {
      const p: unknown[] = [];
      const w = filter(p);
      const erste = await lies('SELECT (id - 1)::text AS s FROM tool_calls' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY id LIMIT 1', p);
      nach = erste.length ? BigInt(String(erste[0].s)) : maxId;
    }
    fenster: while (nach < maxId) {
      const rest = maxPruefen - gescannt;
      if (rest <= 0) { scanFertig = false; naechste = nach.toString(); break; }
      const breite = BigInt(Math.min(SEITE, rest));
      const obere = nach + breite < maxId ? nach + breite : maxId;
      const params: unknown[] = [nach.toString(), obere.toString()];
      const w = ['id > $1::bigint', 'id <= $2::bigint', ...filter(params)];
      const zeilen = await lies(SPALTEN + ' WHERE ' + w.join(' AND ') + ' ORDER BY id', params);
      for (const r of zeilen) {
        if (await verarbeite(r)) {
          const id = BigInt(String(r.id));
          gescannt += Number(id - nach);
          if (id < maxId) { scanFertig = false; naechste = id.toString(); }
          break fenster;
        }
      }
      gescannt += Number(obere - nach);
      nach = obere;
    }
  }

  const vollstaendig = scanFertig && fehler === 0;
  const schluesselSortiert = Object.entries(jeSchluessel).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const schluesselTop = Object.fromEntries(schluesselSortiert.slice(0, SCHLUESSEL_ANZEIGE_MAX));
  const schluesselGekappt = schluesselSortiert.length > SCHLUESSEL_ANZEIGE_MAX;
  const angefragt = opt.ids
    ? {
      angefragt: opt.ids.length,
      gefunden: gefunden.size,
      nicht_gefunden: opt.ids.filter((i) => !gefunden.has(i)),
      ohne_treffer: opt.ids.filter((i) => gefunden.has(i) && !mitTreffer.has(i)),
    }
    : undefined;
  let hinweis: string;
  if (!opt.ausfuehren) {
    hinweis = 'Nur gezaehlt, keine Inhalte. Schreiben mit ausfuehren:true (nicht umkehrbar).' +
      (scanFertig ? '' : ' Grenze erreicht: mit ab_id:naechste_ab_id fortsetzen.');
  } else if (fehler === 0 && !scanFertig && opt.ids) {
    hinweis = 'limit erreicht: mit denselben ids erneut ausfuehren (bereits geschwaerzte Zeilen zaehlen nicht mehr).';
  } else if (fehler > 0) {
    hinweis = `${fehler} Zeile(n) NICHT geschrieben (Sperre/Timeout), Klartext bleibt dort: erneut ausfuehren, z. B. mit ids:nicht_geschrieben_ids` +
      (scanFertig ? '' : opt.ids ? ', danach dieselben ids erneut' : ', danach mit ab_id:naechste_ab_id fortsetzen') + '. Danach muss die Vorschau 0 betroffene Zeilen liefern.';
  } else {
    hinweis = scanFertig ? 'Fertig. Ein weiterer Lauf muss 0 betroffene Zeilen finden.' : 'Weitere Zeilen offen: erneut mit ab_id:naechste_ab_id aufrufen.';
  }
  return {
    success: true,
    action: 'tool_calls_nachschwaerzen',
    modus: opt.ausfuehren ? 'ausgefuehrt' : 'vorschau',
    filter: {
      ...(opt.ids ? { ids: opt.ids.length } : {}),
      ...(opt.project ? { project: opt.project } : {}),
      ...(opt.tools?.length ? { tools: opt.tools } : {}),
      ...(opt.seit ? { seit: opt.seit } : {}),
      ...(opt.bis ? { bis: opt.bis } : {}),
      ...(opt.abId ? { ab_id: opt.abId } : {}),
      ...(opt.regeln?.length ? { regeln: opt.regeln } : {}),
    },
    ...(opt.ids ? {} : { gescannt_id_spanne: gescannt, max_pruefen: maxPruefen }),
    geprueft,
    betroffen,
    felder: jeFeld,
    je_tool: jeTool,
    je_regel: jeRegel,
    je_schluessel: schluesselTop,
    je_schluessel_gekappt: schluesselGekappt,
    ersetzungen,
    ids: liste,
    ids_gekappt: listeGekappt,
    ...(angefragt ? { angefragte_ids: angefragt } : {}),
    ...(opt.ausfuehren ? { geschrieben, uebersprungen, fehler, nicht_geschrieben_ids: nichtGeschrieben } : {}),
    vollstaendig,
    naechste_ab_id: naechste,
    sekunden: Math.round((Date.now() - beginn) / 1000),
    hinweis,
  };
}

function idListe(v: unknown): string[] | undefined {
  let roh: unknown = v;
  if (typeof roh === 'string') {
    const t = roh.trim();
    if (t === '') return undefined;
    if (t.startsWith('[')) { try { roh = JSON.parse(t); } catch { throw new NachschwaerzenFehler('parameter_ungueltig', 'ids: JSON-Liste nicht lesbar'); } }
    else roh = t.split(',');
  }
  if (typeof roh === 'number') roh = [roh];
  if (roh === undefined || roh === null) return undefined;
  if (!Array.isArray(roh)) throw new NachschwaerzenFehler('parameter_ungueltig', 'ids: Liste von Zahlen erwartet');
  const ids = roh.map((x) => String(x).trim()).filter((x) => x !== '');
  for (const id of ids) if (!/^\d{1,18}$/.test(id)) throw new NachschwaerzenFehler('parameter_ungueltig', 'ids: nur ganze Zahlen erlaubt');
  return ids.length ? [...new Set(ids.map((x) => String(BigInt(x))))] : undefined;
}

function textListe(v: unknown): string[] | undefined {
  let roh: unknown = v;
  if (typeof roh === 'string') {
    const t = roh.trim();
    if (t.startsWith('[')) { try { roh = JSON.parse(t); } catch { roh = t.split(','); } }
    else roh = t.split(',');
  }
  if (!Array.isArray(roh)) return undefined;
  const l = roh.map((x) => String(x).trim()).filter(Boolean);
  return l.length ? l : undefined;
}

/** N2: fehlt -> undefined; sonst MUSS es eine positive ganze Zahl sein (0, negativ, Text -> Fehler). */
function positiveGanzzahl(name: string, v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new NachschwaerzenFehler('parameter_ungueltig', name + ': positive ganze Zahl erwartet');
  return n;
}

/** Dispatcher-Anteil. Wirft nie. */
export async function fuehreToolCallsSchwaerzenAus(action: ToolCallsSchwaerzenAction, a: Record<string, unknown>, agentId?: string): Promise<Record<string, unknown>> {
  try {
    if (!darfKoordinatorOderUser(agentId)) {
      return { success: false, action, error: 'nicht_erlaubt', message: 'tool_calls_nachschwaerzen nur fuer Koordinator oder User (auch die Vorschau).' };
    }
    const ausfuehren = a.ausfuehren === true || a.ausfuehren === 'true';
    const project = typeof a.project === 'string' && a.project.trim() !== '' ? a.project.trim() : undefined;
    const abRoh = a.ab_id;
    let abId: string | undefined;
    if (abRoh !== undefined && abRoh !== null && String(abRoh).trim() !== '') {
      if (!/^\d{1,18}$/.test(String(abRoh).trim())) throw new NachschwaerzenFehler('parameter_ungueltig', 'ab_id: ganze Zahl erwartet');
      abId = String(BigInt(String(abRoh).trim()));
    }
    return await toolCallsNachschwaerzen({
      ids: idListe(a.ids),
      project,
      tools: textListe(a.tools ?? a.tool),
      seit: typeof a.seit === 'string' && a.seit.trim() !== '' ? a.seit.trim() : undefined,
      bis: typeof a.bis === 'string' && a.bis.trim() !== '' ? a.bis.trim() : undefined,
      abId,
      maxPruefen: positiveGanzzahl('max_pruefen', a.max_pruefen),
      regeln: regelListe(a.regeln),
      ausfuehren,
      limit: positiveGanzzahl('limit', a.limit),
    });
  } catch (e) {
    const code = e instanceof NachschwaerzenFehler ? e.code : 'fehler';
    return { success: false, action, error: code, message: (e as Error).message };
  }
}
