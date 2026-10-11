/**
 * MODUL: Fehlermuster-Pflege (P15-T37, 11.10.2026)
 *
 * ZWECK: Fehlermuster mit allen E1-Feldern (P15-T17: titel, warum, erkennung, geltung, verweise,
 * beispiel_falsch/-richtig, status) anlegen und gezielt aendern - ueber das Tool code_check statt
 * per SQL. Qualitaetssicherung VOR dem Speichern (Konzept 6236baf2, Abschnitt 4):
 *
 *   SELBSTTEST   Hat ein Muster eine Signatur (erkennung.art regex), muss sie beispiel_falsch treffen
 *                und beispiel_richtig nicht treffen. Sonst Ablehnung mit Begruendung (error 'selbsttest').
 *   DUBLETTEN    Ablehnung mit ID (error 'dublette'):
 *                  hart       gleiche Signatur (signatur + gegen_signatur + flags) oder gleiche description
 *                  uebergehbar gleicher Titel, oder ein aktives Signatur-Muster erkennt beispiel_falsch
 *                             schon (dublette_ok:true uebergeht das)
 *                Aehnliches Thema per Embedding (Schwelle des Modellprofils, Zweck error_patterns):
 *                nur Hinweis (aehnlich[]), keine Ablehnung.
 *   SEVERITY     Neue Muster starten IMMER als warning (User 37673ac6); error nur per aendereMuster mit
 *                grund und nur fuer aktive Signatur-Muster. Der Grund steht in statistik.severity_error.
 *   STATUS       nur aktiv | themenhinweis | stillgelegt. aktiv braucht eine Signatur mit bestandenem
 *                Selbsttest; stillgelegt braucht grund (-> stillgelegt_grund). Ohne Signatur: themenhinweis.
 *   MODEL_SCOPE  wird beim Anlegen aus found_in_model abgeleitet (deriveModelScope) und danach NIE
 *                geaendert (User-Entscheidung E-c, thought 215ff1dc).
 *
 * Eine Stelle fuer beide Strecken (MCP stdio und REST): Dispatcher in code-check-tool.ts.
 */

import { getPool } from '../db/client.js';
import { COLLECTIONS } from '../types/index.js';
import { embed, scoreSchwelleOderHinweis } from '../embeddings/index.js';
import { searchVectors } from '../qdrant/operations.js';
import {
  deriveModelScope,
  embeddeErrorPatternNach,
  type MusterVerweis,
} from './error-patterns.js';
import {
  pruefeErkennung,
  selbsttest,
  validiereErkennung,
  type Erkennung,
  type Geltung,
  type SelbsttestErgebnis,
} from './fehlermuster-erkennung.js';
import { _signaturMusterCacheLeeren } from './fehlermuster-pruefung.js';

export const PFLEGE_STATUS = ['aktiv', 'themenhinweis', 'stillgelegt'] as const;
export type PflegeStatus = (typeof PFLEGE_STATUS)[number];
export const PFLEGE_SEVERITY = ['error', 'warning', 'info'] as const;
export type PflegeSeverity = (typeof PFLEGE_SEVERITY)[number];
export const TITEL_MAX = 80;
/** Mindestlaenge fuer grund (severity error, stillgelegt). */
export const GRUND_MIN = 10;
const VERWEIS_ARTEN = ['memory', 'thought', 'doku', 'datei', 'skill'] as const;
const GELTUNG_SCHLUESSEL = ['sprachen', 'dateimuster', 'projekte', 'frameworks'] as const;

/** Felder, die add_pattern/update_pattern setzen koennen (undefined = nicht angegeben). */
export interface MusterFelder {
  titel?: string | null;
  description?: string;
  warum?: string | null;
  fix?: string;
  erkennung?: Erkennung | null;
  geltung?: Geltung | null;
  verweise?: MusterVerweis[] | null;
  beispiel_falsch?: string | null;
  beispiel_richtig?: string | null;
  status?: PflegeStatus;
  severity?: PflegeSeverity;
  /** Pflicht fuer severity error und status stillgelegt. */
  grund?: string;
  /** Uebergeht die uebergehbaren Dubletten (gleicher Titel, beispiel_falsch schon erkannt). */
  dublette_ok?: boolean;
}

export interface DublettenTreffer {
  id: string;
  titel: string | null;
  grund: string;
  hart: boolean;
}

export interface AehnlichTreffer {
  id: string;
  titel: string | null;
  score: number;
}

export interface PflegeErgebnis {
  success: boolean;
  error?: 'ungueltig' | 'selbsttest' | 'dublette' | 'nicht_gefunden' | 'grund_fehlt' | 'keine_aenderung';
  message: string;
  id?: string;
  model_scope?: string;
  status?: string;
  severity?: string;
  fehler?: string[];
  selbsttest?: SelbsttestErgebnis;
  dubletten?: DublettenTreffer[];
  aehnlich?: AehnlichTreffer[];
  geaendert?: string[];
  hinweise?: string[];
}

// ─── Eingaben normalisieren (Tool-Argumente kommen als Objekt oder JSON-String) ─────────────────

function alsObjekt(roh: unknown, name: string): { wert?: unknown; fehler?: string } {
  if (typeof roh === 'string') {
    const t = roh.trim();
    if (t === '' || t === 'null') return { wert: null };
    try { return { wert: JSON.parse(t) }; } catch { return { fehler: `${name}: kein gueltiges JSON` }; }
  }
  return { wert: roh };
}

const alsListe = (v: unknown): unknown =>
  typeof v === 'string' ? [v] : v;

/** erkennung: Objekt/JSON; signatur/gegen_signatur duerfen einzelne Strings sein; art Standard regex. */
export function normalisiereErkennung(roh: unknown): { wert?: Erkennung | null; fehler: string[] } {
  if (roh === undefined) return { fehler: [] };
  const o = alsObjekt(roh, 'erkennung');
  if (o.fehler) return { fehler: [o.fehler] };
  if (o.wert === null) return { wert: null, fehler: [] };
  if (!o.wert || typeof o.wert !== 'object' || Array.isArray(o.wert)) return { fehler: ['erkennung muss ein Objekt sein {art, signatur[], gegen_signatur[], flags, fenster}'] };
  const e = { ...(o.wert as Record<string, unknown>) };
  const erlaubt = ['art', 'signatur', 'gegen_signatur', 'flags', 'fenster', 'version'];
  const fremd = Object.keys(e).filter((k) => !erlaubt.includes(k));
  if (fremd.length) return { fehler: [`erkennung: unbekannte Felder ${fremd.join(', ')} (erlaubt: ${erlaubt.join(', ')})`] };
  if (e.art === undefined) e.art = 'regex';
  if (e.signatur !== undefined) e.signatur = alsListe(e.signatur);
  if (e.gegen_signatur !== undefined) e.gegen_signatur = alsListe(e.gegen_signatur);
  const fehler = validiereErkennung(e);
  return fehler.length ? { fehler: fehler.map((f) => 'erkennung: ' + f) } : { wert: e as unknown as Erkennung, fehler: [] };
}

/** geltung: {sprachen, dateimuster, projekte, frameworks} - je Liste von Strings (einzelner String erlaubt). */
export function normalisiereGeltung(roh: unknown): { wert?: Geltung | null; fehler: string[] } {
  if (roh === undefined) return { fehler: [] };
  const o = alsObjekt(roh, 'geltung');
  if (o.fehler) return { fehler: [o.fehler] };
  if (o.wert === null) return { wert: null, fehler: [] };
  if (!o.wert || typeof o.wert !== 'object' || Array.isArray(o.wert)) return { fehler: ['geltung muss ein Objekt sein {sprachen, dateimuster, projekte, frameworks}'] };
  const fehler: string[] = [];
  const g: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(o.wert as Record<string, unknown>)) {
    if (!(GELTUNG_SCHLUESSEL as readonly string[]).includes(k)) { fehler.push(`geltung: unbekanntes Feld ${k} (erlaubt: ${GELTUNG_SCHLUESSEL.join(', ')})`); continue; }
    const liste = alsListe(v);
    if (!Array.isArray(liste) || liste.some((x) => typeof x !== 'string' || x.trim() === '')) { fehler.push(`geltung.${k} muss eine Liste nicht-leerer Strings sein`); continue; }
    if (liste.length) g[k] = liste.map((x: string) => x.trim());
  }
  if (fehler.length) return { fehler };
  return { wert: Object.keys(g).length ? (g as Geltung) : null, fehler: [] };
}

/**
 * verweise: Liste von {art, name|id|url|file_path...}. Kurzform als String: 'memory:<name>',
 * 'thought:<id>', 'skill:<name>', 'datei:<pfad>[:zeile]', http(s)-URL = doku.
 */
export function normalisiereVerweise(roh: unknown): { wert?: MusterVerweis[] | null; fehler: string[] } {
  if (roh === undefined) return { fehler: [] };
  const o = typeof roh === 'string' && roh.trim().startsWith('[') ? alsObjekt(roh, 'verweise') : { wert: alsListe(roh) };
  if (o.fehler) return { fehler: [o.fehler] };
  if (o.wert === null) return { wert: null, fehler: [] };
  if (!Array.isArray(o.wert)) return { fehler: ['verweise muss eine Liste sein'] };
  const fehler: string[] = [];
  const liste: MusterVerweis[] = [];
  for (const [i, v] of o.wert.entries()) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^https?:\/\//.test(s)) { liste.push({ art: 'doku', url: s }); continue; }
      const m = /^(memory|thought|skill|datei):(.+)$/.exec(s);
      if (!m) { fehler.push(`verweise[${i}]: Kurzform memory:<name>, thought:<id>, skill:<name>, datei:<pfad>[:zeile] oder URL`); continue; }
      if (m[1] === 'thought') liste.push({ art: 'thought', id: m[2] });
      else if (m[1] === 'datei') {
        const d = /^(.*?)(?::(\d+))?$/.exec(m[2])!;
        liste.push({ art: 'datei', file_path: d[1], ...(d[2] ? { zeile: Number(d[2]) } : {}) });
      } else liste.push({ art: m[1] as 'memory' | 'skill', name: m[2] });
      continue;
    }
    if (!v || typeof v !== 'object') { fehler.push(`verweise[${i}] muss Objekt oder String sein`); continue; }
    const r = v as Record<string, unknown>;
    if (!(VERWEIS_ARTEN as readonly string[]).includes(String(r.art))) { fehler.push(`verweise[${i}].art muss ${VERWEIS_ARTEN.join('|')} sein`); continue; }
    if (![r.name, r.id, r.url, r.file_path].some((x) => typeof x === 'string' && x.trim() !== '')) { fehler.push(`verweise[${i}]: name, id, url oder file_path fehlt`); continue; }
    liste.push(r as unknown as MusterVerweis);
  }
  if (fehler.length) return { fehler };
  return { wert: liste.length ? liste : null, fehler: [] };
}

// ─── Pruefungen ──────────────────────────────────────────────────────────────────────────────────

const hatSignatur = (e: Erkennung | null | undefined): e is Erkennung =>
  !!e && e.art === 'regex' && Array.isArray(e.signatur) && e.signatur.length > 0;

const normListe = (l: string[] | undefined): string => JSON.stringify([...(l ?? [])].map((s) => s.trim()).sort());
function gleicheSignatur(a: Erkennung, b: Erkennung): boolean {
  return normListe(a.signatur) === normListe(b.signatur)
    && normListe(a.gegen_signatur) === normListe(b.gegen_signatur)
    && [...(a.flags ?? '')].sort().join('') === [...(b.flags ?? '')].sort().join('');
}
const norm = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Dublettenpruefung gegen alle nicht stillgelegten, nicht zusammengelegten Muster (ohne eigeneId). */
export async function findeDubletten(kandidat: {
  titel?: string | null;
  description?: string | null;
  erkennung?: Erkennung | null;
  beispiel_falsch?: string | null;
}, eigeneId?: string): Promise<DublettenTreffer[]> {
  const { rows } = await getPool().query(
    `SELECT id::text AS id, titel, description, erkennung, status
       FROM error_patterns
      WHERE COALESCE(status, 'themenhinweis') <> 'stillgelegt' AND ersetzt_durch IS NULL
        AND ($1::uuid IS NULL OR id <> $1::uuid)`,
    [eigeneId ?? null],
  );
  const treffer: DublettenTreffer[] = [];
  for (const r of rows as Array<{ id: string; titel: string | null; description: string; erkennung: Erkennung | null; status: string | null }>) {
    const gruende: Array<[string, boolean]> = [];
    if (hatSignatur(kandidat.erkennung) && hatSignatur(r.erkennung) && gleicheSignatur(kandidat.erkennung, r.erkennung)) gruende.push(['gleiche Signatur', true]);
    if (kandidat.description && norm(kandidat.description) === norm(r.description)) gruende.push(['gleiche description', true]);
    if (kandidat.titel && r.titel && norm(kandidat.titel) === norm(r.titel)) gruende.push(['gleicher Titel', false]);
    if (kandidat.beispiel_falsch && r.status === 'aktiv' && hatSignatur(r.erkennung) && pruefeErkennung(r.erkennung, kandidat.beispiel_falsch).trifft) {
      gruende.push(['dieses aktive Muster erkennt beispiel_falsch bereits', false]);
    }
    if (gruende.length) treffer.push({ id: r.id, titel: r.titel, grund: gruende.map((g) => g[0]).join('; '), hart: gruende.some((g) => g[1]) });
  }
  return treffer;
}

/** Aehnliches Thema per Embedding (nur Hinweis). Best effort: ohne Schwelle/Embedding leer. */
export async function findeAehnliche(text: string, ausschluss: string[] = []): Promise<AehnlichTreffer[]> {
  try {
    const { schwelle } = await scoreSchwelleOderHinweis('error_patterns');
    if (schwelle === null || !text.trim()) return [];
    const warte = Number(process.env.FEHLERMUSTER_PFLEGE_EMBED_WARTE_MS);
    const vektor = await embed(text, { maxQueueWaitMs: Number.isFinite(warte) && warte >= 0 ? warte : 3000, art: 'query' });
    const hits = await searchVectors<Record<string, unknown>>(COLLECTIONS.globalErrorPatterns, vektor, 5);
    return hits
      .filter((h) => h.score > schwelle)
      .map((h) => ({ id: String(h.payload?.id ?? h.id), titel: (h.payload?.titel as string | null) ?? null, score: Math.round(h.score * 1000) / 1000 }))
      .filter((h) => !ausschluss.includes(h.id));
  } catch {
    return [];
  }
}

function pruefeGrund(grund: string | undefined, wofuer: string): string | null {
  return grund && grund.trim().length >= GRUND_MIN ? null : `${wofuer} braucht grund (mind. ${GRUND_MIN} Zeichen)`;
}

function dublettenAblehnung(dubletten: DublettenTreffer[], dubletteOk: boolean | undefined): PflegeErgebnis | null {
  const blockierend = dubletten.filter((d) => d.hart || !dubletteOk);
  if (!blockierend.length) return null;
  const hart = blockierend.some((d) => d.hart);
  return {
    success: false,
    error: 'dublette',
    message: `Aehnliches Muster vorhanden: ${blockierend.map((d) => `${d.id} (${d.grund})`).join(', ')}. ` +
      (hart ? 'Bestehendes Muster erweitern: code_check(action:"update_pattern", id:"<id>", ...).'
        : 'Bestehendes Muster erweitern (update_pattern) oder bewusst trotzdem anlegen mit dublette_ok:true.'),
    dubletten: blockierend,
  };
}

async function nachSpeichern(id: string): Promise<void> {
  _signaturMusterCacheLeeren();
  try {
    await embeddeErrorPatternNach(null, id);
  } catch (err) {
    console.error('[fehlermuster-pflege] Qdrant upsert fehlgeschlagen (non-blocking, Nachzug holt nach):', err);
  }
}

// ─── Anlegen ─────────────────────────────────────────────────────────────────────────────────────

export async function legeMusterAn(eingabe: MusterFelder & {
  description: string;
  fix: string;
  found_by: string;
  found_in_model: string;
}): Promise<PflegeErgebnis> {
  const hinweise: string[] = [];
  const fehler: string[] = [];
  if (eingabe.titel && eingabe.titel.length > TITEL_MAX) fehler.push(`titel hoechstens ${TITEL_MAX} Zeichen (ist ${eingabe.titel.length})`);
  let severity: PflegeSeverity = eingabe.severity ?? 'warning';
  if (severity === 'error') {
    severity = 'warning';
    hinweise.push('Neue Muster starten als warning. Hochstufen auf error nur per update_pattern mit grund, wenn das Muster ohne Fehlalarme trifft.');
  }
  const signatur = hatSignatur(eingabe.erkennung);
  const status: PflegeStatus = eingabe.status ?? (signatur ? 'aktiv' : 'themenhinweis');
  if (status === 'aktiv' && !signatur) fehler.push('status aktiv braucht erkennung mit signatur (art regex) und bestandenem Selbsttest; ohne Signatur ist das Muster ein themenhinweis');
  if (status === 'stillgelegt') { const g = pruefeGrund(eingabe.grund, 'status stillgelegt'); if (g) fehler.push(g); }
  if (fehler.length) return { success: false, error: fehler.some((f) => f.includes('grund')) ? 'grund_fehlt' : 'ungueltig', message: fehler.join('; '), fehler };

  let test: SelbsttestErgebnis | undefined;
  if (signatur) {
    test = selbsttest(eingabe);
    if (!test.ok) {
      return {
        success: false, error: 'selbsttest', selbsttest: test, fehler: test.fehler,
        message: `Selbsttest nicht bestanden: ${test.fehler.join('; ')}. Die Signatur muss beispiel_falsch treffen und beispiel_richtig nicht treffen. Nichts gespeichert.`,
      };
    }
  }

  const dubletten = await findeDubletten(eingabe);
  const ablehnung = dublettenAblehnung(dubletten, eingabe.dublette_ok);
  if (ablehnung) return ablehnung;
  if (dubletten.length) hinweise.push(`Mit dublette_ok angelegt trotz: ${dubletten.map((d) => `${d.id} (${d.grund})`).join(', ')}`);

  const modelScope = deriveModelScope(eingabe.found_in_model);
  const statistik = {
    ...(test ? { selbsttest_ok: test.ok, geprueft_am: new Date().toISOString() } : {}),
    angelegt: { am: new Date().toISOString(), von: eingabe.found_by },
  };
  const { rows } = await getPool().query(
    `INSERT INTO error_patterns (description, fix, severity, model_scope, found_by, found_in_model,
                                 titel, warum, erkennung, geltung, verweise, beispiel_falsch, beispiel_richtig,
                                 status, stillgelegt_grund, statistik)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16::jsonb)
     RETURNING id::text AS id`,
    [
      eingabe.description, eingabe.fix, severity, modelScope, eingabe.found_by, eingabe.found_in_model,
      eingabe.titel ?? null, eingabe.warum ?? null,
      eingabe.erkennung ? JSON.stringify(eingabe.erkennung) : null,
      eingabe.geltung ? JSON.stringify(eingabe.geltung) : null,
      eingabe.verweise ? JSON.stringify(eingabe.verweise) : null,
      eingabe.beispiel_falsch ?? null, eingabe.beispiel_richtig ?? null,
      status, status === 'stillgelegt' ? eingabe.grund!.trim() : null, JSON.stringify(statistik),
    ],
  );
  const id = rows[0].id as string;
  await nachSpeichern(id);
  const aehnlich = await findeAehnliche([eingabe.titel, eingabe.description, eingabe.fix, eingabe.beispiel_falsch].filter(Boolean).join('\n\n'), [id, ...dubletten.map((d) => d.id)]);
  if (aehnlich.length) hinweise.push(`Thematisch aehnlich: ${aehnlich.map((a) => `${a.id}${a.titel ? ` "${a.titel}"` : ''} (${a.score})`).join(', ')} - ggf. zusammenlegen (update_pattern bzw. stilllegen mit grund "Dublette von <id>").`);
  if (!signatur) hinweise.push('Ohne Signatur meldet sich das Muster nur als Themenhinweis (Embedding). Fuer echte Fehlererkennung erkennung {signatur, gegen_signatur} + beispiel_falsch/beispiel_richtig ergaenzen (update_pattern).');
  return {
    success: true,
    message: `Muster gespeichert (status ${status}, severity ${severity}, scope ${modelScope})`,
    id, model_scope: modelScope, status, severity,
    ...(test ? { selbsttest: test } : {}),
    ...(aehnlich.length ? { aehnlich } : {}),
    ...(hinweise.length ? { hinweise } : {}),
  };
}

// ─── Gezielt aendern ─────────────────────────────────────────────────────────────────────────────

const AENDERBAR = ['titel', 'description', 'warum', 'fix', 'erkennung', 'geltung', 'verweise', 'beispiel_falsch', 'beispiel_richtig', 'status', 'severity'] as const;
type Aenderbar = (typeof AENDERBAR)[number];

/**
 * Aendert nur die angegebenen Felder. model_scope, found_by und found_in_model bleiben unveraendert (E-c).
 * Selbsttest und Dublettenpruefung laufen, wenn Signatur, Beispiele, Status bzw. Titel/description sich aendern.
 */
export async function aendereMuster(id: string, aenderung: MusterFelder, vonAgent: string | null): Promise<PflegeErgebnis> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM error_patterns WHERE id::text = $1', [id]);
  if (!rows.length) return { success: false, error: 'nicht_gefunden', message: `Muster ${id} nicht gefunden` };
  const alt = rows[0] as Record<string, unknown>;
  const geaendert: Aenderbar[] = [];
  const neu: Record<string, unknown> = {};
  for (const feld of AENDERBAR) {
    const wert = (aenderung as Record<string, unknown>)[feld];
    if (wert === undefined) continue;
    const vorher = alt[feld] ?? null;
    if (JSON.stringify(vorher) === JSON.stringify(wert)) continue;
    neu[feld] = wert;
    geaendert.push(feld);
  }
  if (!geaendert.length) return { success: false, error: 'keine_aenderung', message: 'Keine Aenderung: alle angegebenen Felder haben schon diesen Wert (oder keines angegeben).' };
  const m = { ...alt, ...neu } as Record<string, unknown> & {
    titel: string | null; description: string; erkennung: Erkennung | null; beispiel_falsch: string | null; beispiel_richtig: string | null;
    status: string | null; severity: string;
  };
  const status = (m.status ?? 'themenhinweis') as string;
  const signatur = hatSignatur(m.erkennung);
  const fehler: string[] = [];
  if (m.titel && m.titel.length > TITEL_MAX) fehler.push(`titel hoechstens ${TITEL_MAX} Zeichen`);
  if (typeof m.description !== 'string' || !m.description.trim()) fehler.push('description darf nicht leer sein');
  if (typeof m.fix !== 'string' || !(m.fix as string).trim()) fehler.push('fix darf nicht leer sein');
  if (status === 'aktiv' && !signatur) fehler.push('status aktiv braucht erkennung mit signatur (art regex)');
  if (geaendert.includes('status') && status === 'stillgelegt') { const g = pruefeGrund(aenderung.grund, 'status stillgelegt'); if (g) fehler.push(g); }
  if (geaendert.includes('severity') && m.severity === 'error') {
    const g = pruefeGrund(aenderung.grund, 'severity error');
    if (g) fehler.push(g);
    if (status !== 'aktiv' || !signatur) fehler.push('severity error nur fuer aktive Signatur-Muster (Themenhinweise sperren nie)');
  }
  if (fehler.length) return { success: false, error: fehler.some((f) => f.includes('braucht grund')) ? 'grund_fehlt' : 'ungueltig', message: fehler.join('; '), fehler };

  let test: SelbsttestErgebnis | undefined;
  const testRelevant = geaendert.some((f) => ['erkennung', 'beispiel_falsch', 'beispiel_richtig', 'status'].includes(f));
  if (signatur && status !== 'stillgelegt' && testRelevant) {
    test = selbsttest(m);
    if (!test.ok) {
      return {
        success: false, error: 'selbsttest', selbsttest: test, fehler: test.fehler,
        message: `Selbsttest nicht bestanden: ${test.fehler.join('; ')}. Nichts geaendert.`,
      };
    }
  }

  const hinweise: string[] = [];
  if (status !== 'stillgelegt' && geaendert.some((f) => ['erkennung', 'beispiel_falsch', 'titel', 'description'].includes(f))) {
    const dubletten = await findeDubletten({
      titel: geaendert.includes('titel') ? m.titel : null,
      description: geaendert.includes('description') ? m.description : null,
      erkennung: geaendert.includes('erkennung') ? m.erkennung : null,
      beispiel_falsch: geaendert.some((f) => f === 'erkennung' || f === 'beispiel_falsch') ? m.beispiel_falsch : null,
    }, id);
    const ablehnung = dublettenAblehnung(dubletten, aenderung.dublette_ok);
    if (ablehnung) return ablehnung;
    if (dubletten.length) hinweise.push(`Mit dublette_ok geaendert trotz: ${dubletten.map((d) => `${d.id} (${d.grund})`).join(', ')}`);
  }

  const jetzt = new Date().toISOString();
  const statistikNeu: Record<string, unknown> = {
    letzte_aenderung: { am: jetzt, von: vonAgent, felder: geaendert, ...(aenderung.grund ? { grund: aenderung.grund.trim() } : {}) },
    ...(test ? { selbsttest_ok: test.ok, geprueft_am: jetzt } : {}),
    ...(geaendert.includes('severity') && m.severity === 'error' ? { severity_error: { am: jetzt, von: vonAgent, grund: aenderung.grund!.trim() } } : {}),
  };
  const stillgelegtGrund = status === 'stillgelegt'
    ? (geaendert.includes('status') ? aenderung.grund!.trim() : (alt.stillgelegt_grund as string | null) ?? null)
    : null;
  const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
  await pool.query(
    `UPDATE error_patterns
        SET titel = $2, description = $3, warum = $4, fix = $5, erkennung = $6::jsonb, geltung = $7::jsonb,
            verweise = $8::jsonb, beispiel_falsch = $9, beispiel_richtig = $10, status = $11, severity = $12,
            stillgelegt_grund = $13, statistik = COALESCE(statistik, '{}'::jsonb) || $14::jsonb
      WHERE id::text = $1`,
    [
      id, m.titel ?? null, m.description, m.warum ?? null, m.fix, json(m.erkennung), json(m.geltung), json(m.verweise),
      m.beispiel_falsch ?? null, m.beispiel_richtig ?? null, m.status ?? null, m.severity, stillgelegtGrund, JSON.stringify(statistikNeu),
    ],
  );
  await nachSpeichern(id);
  if (status === 'themenhinweis' && signatur) hinweise.push('Muster hat eine Signatur, steht aber auf themenhinweis - mit status aktiv meldet es sich ueber die Signatur.');
  return {
    success: true,
    message: `Muster ${id} geaendert (${geaendert.join(', ')}); model_scope unveraendert ${String(alt.model_scope)}`,
    id, model_scope: String(alt.model_scope), status, severity: m.severity, geaendert,
    ...(test ? { selbsttest: test } : {}),
    ...(hinweise.length ? { hinweise } : {}),
  };
}
