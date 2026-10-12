/**
 * P15-T36 Teil 2 (User-Entscheidung 11.10.2026, thought 58492366): Werte von .env-Dateien erscheinen in
 * KEINER Ausgabe. Gilt fuer echte .env/.env.* und die Vorlagen .env.example/.env.sample/.env.template.
 *
 * REINE AUSGABE-SCHICHT: In PostgreSQL und auf der Platte bleibt der echte Inhalt. Der Daemon-Abgleich,
 * restore und commit arbeiten mit echten Werten. Maskiert wird nur, was an einen Aufrufer geht (code_intel,
 * files read/versions/history/get_version, Plan-Diffs, plan_status, Fehlermeldungen) und was in den
 * Suchindex geht (code_chunks/Embeddings).
 *
 * FORMAT: NAME=[WERT]. Variablennamen, export-Praefix, Kommentare, Leerzeilen und LEERE Werte bleiben
 * sichtbar. Mehrzeilige Werte in Anfuehrungszeichen: Folgezeilen werden [WERT]. Zeilen, die weder
 * Zuweisung noch Kommentar sind, werden ganz [WERT] (lieber zu viel verborgen). Zeilenzahl und CRLF
 * bleiben gleich — Zeilennummern, Zeilen-Ops und Anker funktionieren in der maskierten Sicht.
 *
 * ZURUECKSCHREIBEN: Wer maskiert liest und zurueckschreibt (read -> aendern -> write), schickt NAME=[WERT].
 * Der Platzhalter heisst "unveraendert lassen": entmaskiereEnv setzt die Originalzeile(n) von NAME ein.
 * Invariante: entmaskiereEnv(maskiereEnv(x), x) === x. Ein Platzhalter ohne bekannten Wert bleibt als
 * Text stehen und wird gemeldet.
 *
 * HINWEISE statt Abbruch: Ueberschreibt/entfernt ein Schreibvorgang (oder restore) eine Variable mit
 * vorhandenem Wert, nennt die Antwort "NAME: Wert ueberschrieben/entfernt/zurueckgesetzt, per
 * files(restore) wiederherstellbar" — nur Namen, nie Werte.
 */

import {SHELL_KV_ZEILE as KV,SHELL_BEARER,SHELL_SSHPASS,SHELL_JSON_FREI,SHELL_KV_FREI,holeShellLiteralMatcher,sammleShellMaskenTreffer,shellIstLeerWert,type ShellMaskenTreffer} from './shell-masken-katalog.js';
import { getPool } from '../db/client.js';
import { getFileContentFromPg } from './code-write.js';
import { entmaskiereMcpJson, istMcpJsonDatei, maskiereMcpJson, maskiereMcpJsonDiffText, maskiereMcpJsonFragment, mcpJsonHinweise, mcpJsonSicht, mcpJsonWerte, MCP_JSON_PFAD_REGEX_SQL, maskiereUrl, istShellGeheimnisName, istShellJsonGeheimnisName, SHELL_LITERAL_MIN_LAENGE, shellUrlPasswoerter } from './mcp-json-maske.js';
export { entmaskiereMcpJson, istMcpJsonDatei, maskiereMcpJson, maskiereMcpJsonDiffText, mcpJsonHinweise, mcpJsonSicht } from './mcp-json-maske.js';

export {istShellGeheimnisName,SHELL_LITERAL_MIN_LAENGE} from './mcp-json-maske.js';

/** Der Platzhalter fuer jeden verborgenen Wert. */
export const ENV_PLATZHALTER = '[WERT]';

/** Dieselbe Regel als PostgreSQL-Regex (Basename .env oder .env.*). */
export const ENV_PFAD_REGEX_SQL = '(^|/)\\.env(\\.[^/]*)?$';

/** .env oder .env.* (Basename), egal in welchem Verzeichnis. */
export function istEnvDatei(pfad: string | null | undefined): boolean {
  if (typeof pfad !== 'string' || pfad === '') return false;
  const name = pfad.replace(/\\/g, '/').split('/').pop() ?? '';
  return name === '.env' || name.startsWith('.env.');
}

export function istMaskierteDatei(pfad: string | null | undefined): boolean {
  return istEnvDatei(pfad) || istMcpJsonDatei(pfad);
}


type Stueck =
  | { art: 'kv'; name: string; praefix: string; trenner: string; wert: string; zeilen: string[]; leer: boolean }
  | { art: 'text'; zeilen: string[] }
  | { art: 'sonst'; zeilen: string[] };

function ohneCr(zeile: string): { text: string; cr: string } {
  return zeile.endsWith('\r') ? { text: zeile.slice(0, -1), cr: '\r' } : { text: zeile, cr: '' };
}

const istLeerWert=shellIstLeerWert;

/** true, wenn ein mit quote begonnener Wert in rest (Text nach dem oeffnenden Zeichen) NICHT schliesst. */
function bleibtOffen(rest: string, quote: string): boolean {
  for (let i = 0; i < rest.length; i++) {
    if (quote === '"' && rest[i] === '\\') { i++; continue; }
    if (rest[i] === quote) return false;
  }
  return true;
}

/** Zerlegt einen .env-Text in Stuecke (Zuweisung inkl. Folgezeilen, Kommentar/Leerzeile, sonstige Zeile). */
function zerlegeEnv(text: string): Stueck[] {
  const zeilen = text.split('\n');
  const out: Stueck[] = [];
  for (let i = 0; i < zeilen.length; i++) {
    const roh = zeilen[i];
    const t = ohneCr(roh).text;
    const trim = t.trim();
    if (trim === '' || trim.startsWith('#')) { out.push({ art: 'text', zeilen: [roh] }); continue; }
    const m = KV.exec(t);
    if (!m) { out.push({ art: 'sonst', zeilen: [roh] }); continue; }
    const [, praefix, name, trenner, wert] = m;
    const stueckZeilen = [roh];
    const w = wert.trimStart();
    const q = w[0];
    if ((q === '"' || q === "'" || q === '`') && bleibtOffen(w.slice(1), q)) {
      while (i + 1 < zeilen.length) {
        i++;
        stueckZeilen.push(zeilen[i]);
        if (!bleibtOffen(ohneCr(zeilen[i]).text, q)) break;
      }
    }
    const ganzerWert = [wert, ...stueckZeilen.slice(1).map((z) => ohneCr(z).text)].join('\n');
    out.push({ art: 'kv', name, praefix, trenner, wert: ganzerWert, zeilen: stueckZeilen, leer: stueckZeilen.length === 1 && istLeerWert(wert) });
  }
  return out;
}

/** Maskiert einen .env-Text: NAME=[WERT], leere Werte und Kommentare bleiben. Zeilenzahl/CRLF unveraendert. */
export function maskiereEnv(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  const aus: string[] = [];
  for (const s of zerlegeEnv(text)) {
    if (s.art === 'text') { aus.push(s.zeilen[0]); continue; }
    if (s.art === 'sonst') { aus.push(ENV_PLATZHALTER + ohneCr(s.zeilen[0]).cr); continue; }
    if (s.leer) { aus.push(s.zeilen[0]); continue; }
    s.zeilen.forEach((z, k) => {
      aus.push((k === 0 ? `${s.praefix}${s.name}${s.trenner}${ENV_PLATZHALTER}` : ENV_PLATZHALTER) + ohneCr(z).cr);
    });
  }
  return aus.join('\n');
}

/** maskiereEnv nur fuer .env-Pfade, sonst unveraendert. */
export function maskiereDatei(pfad: string | null | undefined, text: string): string {
  if (istEnvDatei(pfad)) return maskiereEnv(text);
  return mcpJsonSicht(pfad, text);
}

export function entmaskiereSensibleDatei(pfad: string | null | undefined, neu: string, alt: string): { inhalt: string; hinweise: string[] } {
  if (istEnvDatei(pfad)) return entmaskiereEnv(neu, alt);
  if (istMcpJsonDatei(pfad)) return entmaskiereMcpJson(neu, alt);
  return { inhalt: neu, hinweise: [] };
}

export function envSicht(pfad: string | null | undefined, text: string): string {
  return maskiereDatei(pfad, text);
}

/**
 * Setzt Platzhalter wieder ein: NAME=[WERT] -> Originalzeile(n) von NAME aus alt (bei Duplikaten in
 * Reihenfolge), alleinstehendes [WERT] -> naechste sonstige Zeile aus alt bzw. Folgezeilen eines
 * mehrzeiligen Werts. Platzhalter ohne Gegenstueck bleiben als Text stehen (hinweise).
 */
export function entmaskiereEnv(neu: string, alt: string): { inhalt: string; hinweise: string[] } {
  if (typeof neu !== 'string' || !neu.includes(ENV_PLATZHALTER)) return { inhalt: neu, hinweise: [] };
  const proName = new Map<string, string[][]>();
  const sonst: string[][] = [];
  for (const s of zerlegeEnv(alt ?? '')) {
    if (s.art === 'kv' && !s.leer) {
      const liste = proName.get(s.name) ?? [];
      liste.push(s.zeilen);
      proName.set(s.name, liste);
    } else if (s.art === 'sonst') {
      sonst.push(s.zeilen);
    }
  }
  const zeilen = neu.split('\n');
  const aus: string[] = [];
  const hinweise = new Set<string>();
  for (let i = 0; i < zeilen.length; i++) {
    const t = ohneCr(zeilen[i]).text;
    const m = KV.exec(t);
    if (m && m[4].trim() === ENV_PLATZHALTER) {
      const quelle = proName.get(m[2])?.shift();
      if (quelle) {
        aus.push(...quelle);
        let folge = quelle.length - 1;
        while (folge > 0 && i + 1 < zeilen.length && ohneCr(zeilen[i + 1]).text.trim() === ENV_PLATZHALTER) { i++; folge--; }
        continue;
      }
      hinweise.add(`${m[2]}: Platzhalter ${ENV_PLATZHALTER} ohne bekannten Wert, als Text geschrieben`);
      aus.push(zeilen[i]);
      continue;
    }
    if (t.trim() === ENV_PLATZHALTER) {
      const quelle = sonst.shift();
      if (quelle) { aus.push(...quelle); continue; }
      hinweise.add(`Zeile ${aus.length + 1}: Platzhalter ${ENV_PLATZHALTER} ohne bekannten Inhalt, als Text geschrieben`);
    }
    aus.push(zeilen[i]);
  }
  return { inhalt: aus.join('\n'), hinweise: [...hinweise] };
}

/**
 * Variablen mit vorhandenem Wert, die neu ueberschreibt oder entfernt — nur Namen, nie Werte.
 * art 'restore': beides heisst "zurueckgesetzt". Neue Variablen und leere alte Werte erzeugen keinen Hinweis.
 */
export function envHinweise(alt: string, neu: string, art: 'schreiben' | 'restore'): string[] {
  if ((alt ?? '') === (neu ?? '')) return [];
  const werte = (text: string): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const s of zerlegeEnv(text ?? '')) {
      if (s.art !== 'kv') continue;
      const liste = map.get(s.name) ?? [];
      liste.push(s.leer ? '' : s.wert);
      map.set(s.name, liste);
    }
    return map;
  };
  const vorher = werte(alt);
  const nachher = werte(neu);
  const aus: string[] = [];
  for (const [name, liste] of vorher) {
    if (!liste.some((w) => w !== '')) continue;
    const jetzt = nachher.get(name);
    const was = !jetzt ? 'entfernt' : JSON.stringify(jetzt) !== JSON.stringify(liste) ? 'überschrieben' : null;
    if (!was) continue;
    aus.push(`${name}: Wert ${art === 'restore' ? 'zurückgesetzt' : was}, per files(restore) wiederherstellbar`);
  }
  return aus;
}

/** Unified-Diff-Text maskieren: Zeilen ' ', '+', '-' werden als .env-Zeile maskiert, Koepfe bleiben. */
export function maskiereEnvDiffText(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  return text.split('\n').map((z) => {
    if (z.startsWith('@@')) return z;
    const c = z[0];
    return c === ' ' || c === '+' || c === '-' ? c + maskiereEnv(z.slice(1)) : z;
  }).join('\n');
}

/** Diff-Eintrag (text) einer .env-Datei maskieren; andere Pfade unveraendert. */
export function maskiereEnvDiff<T extends { text?: string } | null | undefined>(pfad: string | null | undefined, diff: T): T {
  if (!diff || typeof diff.text !== 'string') return diff;
  if (istEnvDatei(pfad)) return { ...diff, text: maskiereEnvDiffText(diff.text) };
  if (istMcpJsonDatei(pfad)) return { ...diff, text: maskiereMcpJsonDiffText(diff.text) };
  return diff;
}

/** Op-Felder (content, search, replace, anchor_*, edits) einer Op auf eine .env-Datei maskieren. */
export function maskiereEnvOp<T extends object>(op: T): T {
  const o = op as Record<string, unknown>;
  const pfad = istMaskierteDatei(o.file_path as string) ? o.file_path as string : o.new_path as string;
  if (!istMaskierteDatei(pfad)) return op;
  const m = (text: string): string => istEnvDatei(pfad) ? maskiereEnv(text) : maskiereMcpJsonFragment(text);
  const kopie: Record<string, unknown> = { ...o };
  for (const feld of ['content', 'search', 'replace', 'anchor_text', 'anchor_contains']) {
    if (typeof kopie[feld] === 'string') kopie[feld] = m(kopie[feld] as string);
  }
  if (Array.isArray(kopie.edits)) {
    kopie.edits = (kopie.edits as Array<Record<string, unknown>>).map((e) => ({
      ...e,
      ...(typeof e.search === 'string' ? { search: m(e.search) } : {}),
      ...(typeof e.replace === 'string' ? { replace: m(e.replace) } : {}),
    }));
  }
  return kopie as T;
}

/**
 * Einzelschreibweg (files create/update/search_replace/replace_lines/... in REST und stdio): lese() liefert
 * den Stand in der Sicht des Agenten (bei .env maskiert), schreibInhalt() loest Platzhalter gegen den echten
 * Stand auf und sammelt die Hinweise, felder() haengt sie an die Antwort.
 */
export class EnvSchreibweg {
  readonly istEnv: boolean;
  readonly istMaskiert: boolean;
  private real: string | null | undefined = undefined;
  hinweise: string[] = [];

  constructor(private readonly project: string, private readonly filePath: string) {
    this.istEnv = istEnvDatei(filePath);
    this.istMaskiert = istMaskierteDatei(filePath);
  }

  async lese(): Promise<string | null> {
    this.real = await getFileContentFromPg(this.project, this.filePath);
    if (this.real === null) return null;
    return this.istMaskiert ? maskiereDatei(this.filePath, this.real) : this.real;
  }

  async schreibInhalt(neu: string): Promise<string> {
    if (!this.istMaskiert) return neu;
    if (this.real === undefined) this.real = await getFileContentFromPg(this.project, this.filePath);
    const alt = this.real ?? '';
    const r = entmaskiereSensibleDatei(this.filePath, neu, alt);
    this.hinweise = this.istEnv
      ? [...envHinweise(alt, r.inhalt, 'schreiben'), ...r.hinweise]
      : [...mcpJsonHinweise(alt, r.inhalt, 'schreiben'), ...r.hinweise];
    return r.inhalt;
  }

  felder(): Record<string, unknown> {
    return this.hinweise.length > 0 ? { env_hinweise: this.hinweise } : {};
  }
}

/** Hinweise eines committeten Batches: Stand vor dem commit (file_versions) gegen den Endstand (code_files). */
export async function envHinweiseFuerBatch(batchId: string): Promise<string[]> {
  const rows = (await getPool().query<{ file_path: string; vorher: string | null; nachher: string | null; weg: boolean | null }>(
    `SELECT DISTINCT ON (v.file_path) v.file_path, v.content AS vorher, cf.content AS nachher, (cf.deleted_at IS NOT NULL) AS weg
       FROM file_versions v
       LEFT JOIN code_files cf ON cf.project = v.project AND cf.file_path = v.file_path
      WHERE v.batch_id = $1::bigint AND (v.file_path ~ $2 OR v.file_path ~ $3)
      ORDER BY v.file_path, v.id`,
    [batchId, ENV_PFAD_REGEX_SQL, MCP_JSON_PFAD_REGEX_SQL],
  )).rows;
  const aus: string[] = [];
  for (const row of rows) {
    if (!istMaskierteDatei(row.file_path)) continue;
    const neu = row.weg || row.nachher === null ? '' : row.nachher;
    const vorher = row.vorher ?? '';
    const hinweise = istEnvDatei(row.file_path)
      ? envHinweise(vorher, neu, 'schreiben')
      : mcpJsonHinweise(vorher, neu, 'schreiben');
    for (const h of hinweise) aus.push(rows.length > 1 ? `${row.file_path} – ${h}` : h);
  }
  return aus;
}

// ─── Sicherheitsnetz: bekannte Werte aus einer Antwort schwaerzen ─────────────────────────────────

const WERT_MIN_LAENGE = 6;

/** Werte eines .env-Texts, die als Klartext in einer Antwort nichts zu suchen haben (ab 6 Zeichen). */
function envWerteAus(text: string): string[] {
  const aus = new Set<string>();
  for (const s of zerlegeEnv(text ?? '')) {
    if (s.art !== 'kv' || s.leer) continue;
    const roh = s.wert.trim();
    const kandidaten = [roh, roh.replace(/^(["'`])([\s\S]*)\1$/, '$2'), ...roh.split('\n').map((z) => z.trim().replace(/^["'`]|["'`]$/g, ''))];
    for (const k of kandidaten) {
      if (k.length >= WERT_MIN_LAENGE && !/^(true|false|null|\d+)$/i.test(k)) aus.add(k);
    }
  }
  return [...aus];
}

function maskiertePfadeIn(wert: unknown, aus: Set<string>, tiefe = 0): void {
  if (tiefe > 12 || wert === null || typeof wert !== 'object') return;
  if (Array.isArray(wert)) { for (const w of wert) maskiertePfadeIn(w, aus, tiefe + 1); return; }
  for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
    if (typeof v === 'string' && (k === 'file_path' || k === 'new_path' || k === 'datei') && istMaskierteDatei(v)) aus.add(v);
    else if (typeof v === 'object') maskiertePfadeIn(v, aus, tiefe + 1);
  }
}

function ersetzeInStrings<T>(wert: T, werte: string[]): T {
  if (typeof wert === 'string') {
    let s: string = wert;
    for (const w of werte) if (s.includes(w)) s = s.split(w).join(ENV_PLATZHALTER);
    return s as unknown as T;
  }
  if (Array.isArray(wert)) return wert.map((w) => ersetzeInStrings(w, werte)) as unknown as T;
  if (wert && typeof wert === 'object') {
    const aus: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wert as Record<string, unknown>)) aus[k] = ersetzeInStrings(v, werte);
    return aus as T;
  }
  return wert;
}

/**
 * Sicherheitsnetz fuer Antworten von files/files_batch/code_intel: sind .env-Pfade beteiligt (Argumente
 * oder Felder file_path/new_path/datei der Antwort), werden deren aktuelle Werte in allen Strings der
 * Antwort durch [WERT] ersetzt. Faengt Stellen, die die strukturierte Maskierung nicht kennt (z. B. eine
 * Fehlermeldung, die eine Zeile zitiert). Ohne .env-Bezug unveraendert und ohne DB-Zugriff.
 * ENV_SICHERHEITSNETZ=0 schaltet es ab (nur fuer Tests: so wird die strukturierte Maskierung allein geprueft).
 */
export async function schwaerzeEnvWerteInAntwort<T>(project: string | undefined, antwort: T, argPfade: Array<string | undefined> = []): Promise<T> {
  if (!project || process.env.ENV_SICHERHEITSNETZ === '0') return antwort;
  const pfade = new Set<string>(argPfade.filter((p): p is string => istMaskierteDatei(p)));
  maskiertePfadeIn(antwort, pfade);
  if (pfade.size === 0) return antwort;
  try {
    const rows = (await getPool().query<{ file_path: string; content: string | null }>(
      'SELECT file_path, content FROM code_files WHERE project = $1 AND file_path = ANY($2::text[])',
      [project, [...pfade]],
    )).rows;
    const werte = [...new Set(rows.flatMap((r) => istEnvDatei(r.file_path)
      ? envWerteAus(r.content ?? '')
      : mcpJsonWerte(r.content ?? '')))].sort((a, b) => b.length - a.length);
    if (werte.length === 0) return antwort;
    return ersetzeInStrings(antwort, werte);
  } catch (fehler) {
    console.error(`[env-maske] Sicherheitsnetz uebersprungen: ${(fehler as Error).message}`);
    return antwort;
  }
}

/** P10-T33: dieselbe P15-Maske auch fuer freie Shell-Ausgaben; Bestandsformate bleiben erhalten. */
export function shellGeheimWerte(envText: string, jsonText = ''): string[] {
  const aus=new Set<string>();
  const sammle=(roh:string,sensibel:boolean)=>{
    const varianten=[roh.trim(),roh.trim().replace(/^(["'\x60])([\s\S]*)\1$/,'$2'),
      ...roh.split('\n').map(z=>z.trim().replace(/^["'\x60]|["'\x60]$/g,''))];
    for(const w of varianten){
      if(sensibel && w.length>=SHELL_LITERAL_MIN_LAENGE && w!==ENV_PLATZHALTER)aus.add(w);
      const bearer=/^Bearer\s+(.+)$/i.exec(w);if(sensibel && bearer && bearer[1].length>=SHELL_LITERAL_MIN_LAENGE)aus.add(bearer[1]);
      for(const pass of shellUrlPasswoerter(w))aus.add(pass);
    }
  };
  for(const w of mcpJsonWerte(jsonText,SHELL_LITERAL_MIN_LAENGE,true))sammle(w,true);
  for(const teil of zerlegeEnv(envText))if(teil.art==='kv' && !teil.leer)sammle(teil.wert,istShellGeheimnisName(teil.name));
  return [...aus];
}
export function maskiereShellText(text: string, bekannteWerte: readonly string[] = []): {text: string; maskiert: number} {
  let maskiert=0, aus=text;
  const matcher=holeShellLiteralMatcher(bekannteWerte);
  if(matcher instanceof RegExp)aus=aus.replace(matcher,(wert)=>{if(wert===ENV_PLATZHALTER)return wert;maskiert++;return ENV_PLATZHALTER;});
  else if(matcher)for(const wert of matcher){
    aus=aus.split(ENV_PLATZHALTER).map(teil=>teil.replaceAll(wert,()=>{maskiert++;return ENV_PLATZHALTER;})).join(ENV_PLATZHALTER);
  }
  const vorher=(aus.match(/\[WERT\]/g)??[]).length;
  if(/^\s*[\[{]/.test(aus))try {
    const original=JSON.parse(aus),strukturiert=maskiereMcpJson(aus,true);
    maskiert+=Math.max(0,(strukturiert.match(/\[WERT\]/g)??[]).length-vorher);
    const walk=(v:unknown):unknown=>{
      if(typeof v==='string'){const r=maskiereShellText(v,bekannteWerte);maskiert+=r.maskiert;return r.text;}
      if(Array.isArray(v))return v.map(walk);
      if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,w])=>[k,walk(w)]));
      return v;
    };
    const safe=walk(JSON.parse(strukturiert));
    return {text:maskiert?JSON.stringify(safe,null,aus.includes('\n')?2:undefined)+(aus.endsWith('\n')?'\n':''):aus,maskiert};
  }catch { /* freie Logzeile statt vollstaendigem JSON */ }
  aus=maskiereMcpJsonFragment(aus,true);
  aus=maskiereUrl(aus);
  aus=aus.replace(SHELL_BEARER,(_,praefix:string)=>praefix+ENV_PLATZHALTER);
  // P10-T42: sshpass -p <passwort> (Fund aus dem Altbestand-Test). Schon maskierte Werte bleiben, Quotes bleiben.
  aus=aus.replace(SHELL_SSHPASS,(ganz,praefix:string,wert:string)=>{
    const q=wert[0]==='"'||wert[0]==="'"?wert[0]:'';
    const kern=q?wert.slice(1,-1):wert;
    return kern===ENV_PLATZHALTER?ganz:praefix+q+ENV_PLATZHALTER+q;
  });
  aus=aus.split('\n').map(zeile=>{
    const kv=KV.exec(ohneCr(zeile).text);
    if(kv && istShellGeheimnisName(kv[2])) return maskiereEnv(zeile);
    return zeile.replace(SHELL_JSON_FREI,
      (ganz,praefix:string,q:string,name:string,trenner:string,wert:string)=>
        istShellJsonGeheimnisName(name)
          ? praefix+q+name+q+trenner+wert[0]+ENV_PLATZHALTER+wert[0] : ganz);
  }).join('\n');
  aus=aus.replace(SHELL_KV_FREI,
    (ganz,praefix:string,name:string,trenner:string)=>
      istShellGeheimnisName(name)?praefix+name+trenner+ENV_PLATZHALTER:ganz);
  maskiert+=Math.max(0,(aus.match(/\[WERT\]/g)??[]).length-vorher);
  return {text:aus,maskiert};
}

/** Provenienzvariante: Ausgabe/Zähler bleiben exakt die bestehende Live-Maske. */
export function maskiereShellTextMitTreffern(text:string,werte:readonly string[]=[],opt:{name?:string;strukturiert?:boolean}={}):{text:string;maskiert:number;treffer:ShellMaskenTreffer[]} {
 const safe=maskiereShellText(text,werte);
 return {...safe,treffer:sammleShellMaskenTreffer(text,werte,opt)};
}
