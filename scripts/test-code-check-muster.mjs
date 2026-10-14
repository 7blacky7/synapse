/**
 * P15-T37 (11.10.2026): code_check nimmt alle E1-Felder an - add_pattern, update_pattern, list_patterns.
 *
 * ZUSAGEN:
 *   A1 add_pattern mit Signatur + Beispielen: gespeichert, status aktiv, severity warning (error verlangt -> warning
 *      + Hinweis), model_scope aus found_in_model, alle Felder in PG (Verweis-Kurzform aufgeloest), statistik.selbsttest_ok.
 *   A2 Selbsttest abgelehnt: Signatur trifft beispiel_falsch nicht / trifft beispiel_richtig -> error selbsttest, nichts gespeichert.
 *   A3 Dublette: gleiche Signatur -> error dublette mit ID (hart, auch mit dublette_ok); aktives Muster erkennt
 *      beispiel_falsch schon -> dublette, mit dublette_ok gespeichert.
 *   A4 aehnliches Thema (Embedding) -> nur Hinweis aehnlich[] mit ID; status aktiv ohne Signatur -> ungueltig;
 *      ungueltige erkennung (Regex, unbekanntes Feld) -> ungueltig.
 *   U1 update_pattern: gezielte Aenderung (geaendert[]), model_scope bleibt (auch wenn angegeben, mit Hinweis);
 *      severity error ohne grund -> grund_fehlt, mit grund -> statistik.severity_error; error auf Themenhinweis -> ungueltig;
 *      Signatur-Aenderung, die den Selbsttest bricht -> selbsttest, PG unveraendert; stillgelegt mit grund; keine_aenderung.
 *   L1 list_patterns kompakt (signatur-Kurzform, ohne erkennung-Objekt), detail:true mit allen Feldern, status-Filter.
 *   S1 Strecken: stdio (echter MCP-Server, InMemory, inkl. PA-1) nimmt erkennung/geltung an; Definition stdio = core;
 *      REST MCP_TOOLS code_check = core-Definition.
 * POSITIVKONTROLLE (vor dem Bau): die alte stdio-Definition kannte kein erkennung/beispiel_falsch, core hatte keinen Dispatcher.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node scripts/test-code-check-muster.mjs  (core, rest-api, mcp-server bauen)
 */
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from './lib/test-db-schutz.mjs';
pruefeTestDbUrl('test-code-check-muster');

const MODELL = 'fake-t37-embed:latest';
const AGENT = 'zz-t37';
const PRAEFIX = 'ZZ-T37';
let AEHNLICH_ID = '';
let ERRP = '';

const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: MODELL, model: MODELL, digest: 'cd'.repeat(32), size: 1000 }] }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } }));
    if (req.url === '/api/embed') {
      const a = JSON.parse(body);
      const liste = Array.isArray(a.input) ? a.input : [a.input];
      return res.end(JSON.stringify({ embeddings: liste.map((t) => (/AEHNLICH/.test(t) ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0])) }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
const qdrant = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return res.end(JSON.stringify({ title: 'qdrant', version: '1.13.0' }));
    const m = /^\/collections\/([^/]+)\/points\/search$/.exec(u.pathname);
    if (m) {
      const b = JSON.parse(body || '{}');
      if (decodeURIComponent(m[1]) !== ERRP || b.vector?.[0] !== 1 || !AEHNLICH_ID) return res.end(JSON.stringify({ status: 'ok', time: 0, result: [] }));
      return res.end(JSON.stringify({ status: 'ok', time: 0, result: [
        { id: AEHNLICH_ID, version: 0, score: 0.9, payload: { id: AEHNLICH_ID, titel: PRAEFIX + ' aehnlich', model_scope: 'all' } }] }));
    }
    res.end(JSON.stringify({ status: 'ok', time: 0, result: {} }));
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
process.env.OLLAMA_MODEL = MODELL;
process.env.QDRANT_URL = `http://127.0.0.1:${qdrant.address().port}`;
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SCORE_SCHWELLE_ERROR_PATTERNS = '0.5';
for (const name of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE',
  'SYNAPSE_AGENT_NAME', 'SYNAPSE_DEFAULT_AGENT_ID', 'FEHLERMUSTER_PFLEGE_EMBED_WARTE_MS']) delete process.env[name];
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const dist = join(repo, 'packages', 'core', 'dist');
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) {
  console.error('ABBRUCH: Ollama/Qdrant zeigen auf Produktion.');
  process.exit(2);
}
const tool = await lade(dist, 'services', 'code-check-tool.js');
const db = await lade(dist, 'db', 'client.js');
const { COLLECTIONS } = await lade(dist, 'types', 'index.js');
ERRP = COLLECTIONS.globalErrorPatterns;
const pool = db.getPool();
const cc = (args) => tool.fuehreCodeCheckAus(args, AGENT);

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1500) : '')); }
}
const zeile = async (id) => (await pool.query('SELECT * FROM error_patterns WHERE id = $1', [id])).rows[0];
const anzahl = async () => Number((await pool.query(`SELECT count(*) FROM error_patterns WHERE description LIKE $1`, [PRAEFIX + '%'])).rows[0].count);
async function aufraeumen() {
  await pool.query(`DELETE FROM error_patterns WHERE description LIKE $1`, [PRAEFIX + '%']);
}

const SIG = { signatur: '\\bzzT37Verboten\\(', gegen_signatur: ['//\\s*zzT37-ok'], fenster: 'zeile' };
const basis = {
  action: 'add_pattern', found_in_model: 'claude-opus-5', found_by: AGENT,
  beispiel_falsch: 'zzT37Verboten(1);', beispiel_richtig: 'zzT37Erlaubt(1);',
};

try {
  await aufraeumen();

  // ── A1 ───────────────────────────────────────────────────────────────────
  const a1 = await cc({
    ...basis, titel: PRAEFIX + ' verbotener Aufruf', description: PRAEFIX + ' A1 zzT37Verboten ist verboten',
    warum: 'Testmuster', fix: 'zzT37Erlaubt verwenden', erkennung: SIG, severity: 'error',
    geltung: { sprachen: ['ts', 'tsx'], projekte: 'zz-proj' },
    verweise: ['memory:zz-t37-regel', 'https://example.invalid/doku', { art: 'datei', file_path: 'a/b.ts', zeile: 3 }],
  });
  const r1 = a1.success ? await zeile(a1.id) : null;
  pruefe(a1.success && a1.status === 'aktiv' && a1.severity === 'warning' && a1.model_scope === 'all' && a1.modelScope === 'all'
    && a1.selbsttest?.ok === true && (a1.hinweise ?? []).some((h) => h.includes('starten als warning')),
  'A1 add mit Signatur: aktiv, warning statt error (mit Hinweis), scope all, Selbsttest ok', a1);
  pruefe(r1 && r1.severity === 'warning' && r1.status === 'aktiv' && r1.titel === PRAEFIX + ' verbotener Aufruf' && r1.warum === 'Testmuster'
    && r1.erkennung?.art === 'regex' && Array.isArray(r1.erkennung.signatur) && r1.erkennung.signatur[0] === '\\bzzT37Verboten\\('
    && r1.geltung?.projekte?.[0] === 'zz-proj' && r1.verweise?.length === 3 && r1.verweise[0].art === 'memory' && r1.verweise[1].art === 'doku'
    && r1.verweise[2].zeile === 3 && r1.beispiel_falsch === 'zzT37Verboten(1);' && r1.statistik?.selbsttest_ok === true && r1.found_by === AGENT,
  'A1 PG: alle E1-Felder gespeichert (signatur als Liste, Verweis-Kurzform aufgeloest, statistik)', r1);

  // ── A2 Selbsttest ─────────────────────────────────────────────────────────
  const vor = await anzahl();
  const a2 = await cc({ ...basis, description: PRAEFIX + ' A2', fix: 'x', erkennung: { signatur: ['zzT37Nie\\('] } });
  pruefe(!a2.success && a2.error === 'selbsttest' && a2.fehler?.includes('beispiel_falsch wird nicht erkannt') && (await anzahl()) === vor,
    'A2 Selbsttest: Signatur trifft beispiel_falsch nicht -> abgelehnt mit Begruendung, nichts gespeichert', a2);
  const a2b = await cc({ ...basis, description: PRAEFIX + ' A2b', fix: 'x', erkennung: { signatur: ['zzT37'] } });
  pruefe(!a2b.success && a2b.error === 'selbsttest' && a2b.fehler?.includes('beispiel_richtig wird faelschlich erkannt') && (await anzahl()) === vor,
    'A2b Selbsttest: Signatur trifft beispiel_richtig -> abgelehnt', a2b);
  const a2c = await cc({ ...basis, description: PRAEFIX + ' A2c', fix: 'x', erkennung: { signatur: ['zzT37Verboten\\('] }, beispiel_richtig: undefined });
  pruefe(!a2c.success && a2c.error === 'selbsttest' && a2c.fehler?.includes('beispiel_richtig fehlt'), 'A2c Signatur ohne beispiel_richtig -> abgelehnt', a2c);

  // ── A3 Dubletten ──────────────────────────────────────────────────────────
  const a3 = await cc({ ...basis, description: PRAEFIX + ' A3 andere Beschreibung', fix: 'x', erkennung: SIG, dublette_ok: true });
  pruefe(!a3.success && a3.error === 'dublette' && a3.dubletten?.[0]?.id === a1.id && a3.dubletten[0].hart === true && a3.message.includes(a1.id),
    'A3 gleiche Signatur -> dublette mit ID, hart (auch mit dublette_ok)', a3);
  const a3b = await cc({ ...basis, description: PRAEFIX + ' A3b', fix: 'x', erkennung: { signatur: ['zzT37Verboten\\(1'] } });
  pruefe(!a3b.success && a3b.error === 'dublette' && a3b.dubletten?.[0]?.id === a1.id && a3b.dubletten[0].hart === false
    && a3b.dubletten[0].grund.includes('erkennt beispiel_falsch bereits'),
  'A3b aktives Muster erkennt beispiel_falsch schon -> dublette (uebergehbar)', a3b);
  const a3c = await cc({ ...basis, description: PRAEFIX + ' A3c', fix: 'x', erkennung: { signatur: ['zzT37Verboten\\(1'] }, dublette_ok: true });
  pruefe(a3c.success && a3c.status === 'aktiv' && (a3c.hinweise ?? []).some((h) => h.includes(a1.id)),
    'A3c mit dublette_ok gespeichert, Hinweis nennt die ID', a3c);
  const a3d = await cc({ action: 'add_pattern', found_in_model: 'haiku', description: PRAEFIX + ' A1 zzT37Verboten ist verboten', fix: 'y' });
  pruefe(!a3d.success && a3d.error === 'dublette' && a3d.dubletten?.some((d) => d.id === a1.id && d.grund.includes('gleiche description')),
    'A3d gleiche description -> dublette (found_by aus agent_id)', a3d);

  // ── A4 Themen-Hinweis, Eingabefehler ──────────────────────────────────────
  AEHNLICH_ID = a1.id;
  const a4 = await cc({ action: 'add_pattern', found_in_model: 'haiku', description: PRAEFIX + ' A4 AEHNLICH Thema', fix: 'z' });
  pruefe(a4.success && a4.status === 'themenhinweis' && a4.model_scope === 'haiku' && a4.aehnlich?.[0]?.id === a1.id
    && (a4.hinweise ?? []).some((h) => h.includes('Thematisch aehnlich') && h.includes(a1.id)),
  'A4 aehnliches Thema per Embedding -> nur Hinweis mit ID, themenhinweis ohne Signatur', a4);
  AEHNLICH_ID = '';
  const a4b = await cc({ action: 'add_pattern', found_in_model: 'haiku', description: PRAEFIX + ' A4b', fix: 'z', status: 'aktiv' });
  pruefe(!a4b.success && a4b.error === 'ungueltig', 'A4b status aktiv ohne Signatur -> ungueltig', a4b);
  const a4c = await cc({ ...basis, description: PRAEFIX + ' A4c', fix: 'z', erkennung: { signatur: ['(a+)+'], foo: 1 } });
  pruefe(!a4c.success && a4c.error === 'ungueltig' && a4c.message.includes('foo'), 'A4c unbekanntes Feld in erkennung -> ungueltig', a4c);
  const a4d = await cc({ ...basis, description: PRAEFIX + ' A4d', fix: 'z', erkennung: { signatur: ['(a+)+'] } });
  pruefe(!a4d.success && a4d.error === 'ungueltig' && a4d.message.includes('verschachtelte Quantoren'), 'A4d gefaehrliche Regex -> ungueltig', a4d);
  const a4e = await cc({ action: 'add_pattern', found_in_model: 'haiku', description: PRAEFIX + ' A4e', fix: 'z', status: 'kaputt' });
  pruefe(!a4e.success && a4e.error === 'ungueltig' && a4e.message.includes('status nur'), 'A4e status ausserhalb aktiv|themenhinweis|stillgelegt -> ungueltig', a4e);

  // ── U1 update_pattern ─────────────────────────────────────────────────────
  const u1 = await cc({ action: 'update_pattern', id: a1.id, titel: PRAEFIX + ' neuer Titel', model_scope: 'haiku' });
  const ru1 = await zeile(a1.id);
  pruefe(u1.success && u1.geaendert?.join() === 'titel' && ru1.titel === PRAEFIX + ' neuer Titel' && ru1.model_scope === 'all'
    && (u1.hinweise ?? []).some((h) => h.includes('E-c')) && ru1.statistik?.letzte_aenderung?.von === AGENT,
  'U1 gezielte Aenderung (nur titel), model_scope bleibt all trotz Angabe, letzte_aenderung protokolliert', { u1, ru1 });
  const u2 = await cc({ action: 'update_pattern', id: a1.id, severity: 'error' });
  pruefe(!u2.success && u2.error === 'grund_fehlt' && (await zeile(a1.id)).severity === 'warning', 'U2 severity error ohne grund -> grund_fehlt, unveraendert', u2);
  const u3 = await cc({ action: 'update_pattern', id: a1.id, severity: 'error', grund: 'Test: keine Fehlalarme seit 2 Wochen' });
  const ru3 = await zeile(a1.id);
  pruefe(u3.success && ru3.severity === 'error' && ru3.statistik?.severity_error?.grund === 'Test: keine Fehlalarme seit 2 Wochen',
    'U3 severity error mit grund -> error, Grund in statistik.severity_error', { u3, s: ru3.statistik });
  const u4 = await cc({ action: 'update_pattern', id: a4.id, severity: 'error', grund: 'Themenhinweis hochstufen' });
  pruefe(!u4.success && u4.error === 'ungueltig' && u4.message.includes('nur fuer aktive Signatur-Muster'), 'U4 error auf Themenhinweis -> ungueltig', u4);
  const u5 = await cc({ action: 'update_pattern', id: a1.id, erkennung: { signatur: ['zzT37'] } });
  pruefe(!u5.success && u5.error === 'selbsttest' && (await zeile(a1.id)).erkennung.signatur[0] === '\\bzzT37Verboten\\(',
    'U5 Signatur-Aenderung bricht Selbsttest -> abgelehnt, PG unveraendert', u5);
  const u6 = await cc({ action: 'update_pattern', id: a1.id, beispiel_richtig: 'zzT37Erlaubt(2); // geaendert' });
  pruefe(u6.success && u6.selbsttest?.ok === true && u6.geaendert?.join() === 'beispiel_richtig', 'U6 Beispiel-Aenderung mit bestandenem Selbsttest', u6);
  const u7 = await cc({ action: 'update_pattern', id: a3c.id, status: 'stillgelegt' });
  pruefe(!u7.success && u7.error === 'grund_fehlt', 'U7 stillgelegt ohne grund -> grund_fehlt', u7);
  const u8 = await cc({ action: 'update_pattern', id: a3c.id, status: 'stillgelegt', grund: 'Dublette von ' + a1.id });
  const ru8 = await zeile(a3c.id);
  pruefe(u8.success && ru8.status === 'stillgelegt' && ru8.stillgelegt_grund === 'Dublette von ' + a1.id, 'U8 stillgelegt mit grund -> stillgelegt_grund', ru8);
  const u9 = await cc({ action: 'update_pattern', id: a1.id, titel: PRAEFIX + ' neuer Titel' });
  pruefe(!u9.success && u9.error === 'keine_aenderung', 'U9 gleicher Wert -> keine_aenderung', u9);
  const u10 = await cc({ action: 'update_pattern', id: '00000000-0000-4000-8000-000000000000', titel: 'x' });
  pruefe(!u10.success && u10.error === 'nicht_gefunden', 'U10 unbekannte id -> nicht_gefunden', u10);
  const u11 = await cc({ action: 'update_pattern', id: a4.id, warum: null, geltung: { sprachen: 'py' } });
  const ru11 = await zeile(a4.id);
  pruefe(u11.success && ru11.geltung?.sprachen?.[0] === 'py', 'U11 geltung per update (einzelner String -> Liste)', ru11.geltung);

  // ── P15-T38 Bedienbarkeit ─────────────────────────────────────────────────
  const u12 = await cc({ action: 'update_pattern', id: a4.id.slice(0, 8), warum: 'per Praefix' });
  pruefe(u12.success && u12.id === a4.id && (await zeile(a4.id)).warum === 'per Praefix', 'U12 update_pattern mit eindeutigem 8-Zeichen-Praefix', u12);
  const u13 = await cc({ action: 'update_pattern', id: a4.id.slice(0, 7), warum: 'zu kurz' });
  pruefe(!u13.success && u13.error === 'nicht_gefunden' && /8 Zeichen/.test(u13.message) && (await zeile(a4.id)).warum === 'per Praefix',
    'U13 Praefix unter 8 Zeichen -> nicht_gefunden mit Hinweis, nichts geaendert', u13);
  for (const s of ['1', '2']) {
    await pool.query(`INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model, status)
      VALUES ($1, $2, 'x', 'warning', 'all', 'zz', 'opus', 'themenhinweis')`, [`abcd0038-0000-4000-8000-00000000000${s}`, `${PRAEFIX} U14 ${s}`]);
  }
  const u14 = await cc({ action: 'update_pattern', id: 'abcd0038', warum: 'mehrdeutig' });
  const u14z = await pool.query(`SELECT count(*)::int AS n FROM error_patterns WHERE id::text LIKE 'abcd0038%' AND warum IS NULL`);
  pruefe(!u14.success && u14.error === 'mehrdeutig' && u14.kandidaten?.length === 2 && u14z.rows[0].n === 2,
    'U14 mehrdeutiger Praefix -> mehrdeutig mit Kandidaten, nichts geaendert', u14);
  const a5 = await cc({ ...basis, description: PRAEFIX + ' A5', fix: 'x', erkennung: { signatur: ['zzT37Verboten\\(', 'zzT37Gibtsnicht'] } });
  pruefe(!a5.success && a5.error === 'selbsttest' && /UND/.test(a5.message) && a5.message.includes("'A|B'") && /erkennung:\s*\{/.test(a5.message),
    'A5 Liste in signatur = UND: Selbsttest-Meldung erklaert UND, Alternation und das erkennung{}-Format', a5);
  // JSON-String-erkennung: JSON.parse macht aus \t ein Tab und aus \b ein Backspace -> zurueck in Regex-Escapes
  const a6 = await cc({
    ...basis, description: PRAEFIX + ' A6', fix: 'x', erkennung: '{"signatur": ["^[ \\t]*zzT38Tab\\\\(", "\\bzzT38Tab"]}',
    beispiel_falsch: '\tzzT38Tab(1);', beispiel_richtig: 'x zzT38Tab(1);',
  });
  const ra6 = a6.success ? await zeile(a6.id) : null;
  pruefe(a6.success && a6.selbsttest?.ok === true && ra6?.erkennung?.signatur?.[0] === '^[ \\t]*zzT38Tab\\(' && ra6?.erkennung?.signatur?.[1] === '\\bzzT38Tab',
    'A6 Tab/Backspace aus JSON-Escapes werden zu \\t/\\b in der Signatur, Selbsttest mit echtem Tab im Beispiel ok', { a6, sig: ra6?.erkennung });
  const a7 = await cc({ ...basis, description: PRAEFIX + ' A7', fix: 'x', erkennung: { signatur: ['^\\tzzT38Tab2\\('] }, beispiel_falsch: '\\tzzT38Tab2(1);', beispiel_richtig: 'zzT38Tab2(1);' });
  pruefe(!a7.success && a7.error === 'selbsttest' && /Tab/.test(a7.message) && /Backslash/.test(a7.message),
    'A7 beispiel_falsch mit Backslash+t statt Tab: Selbsttest-Meldung erklaert es', a7);
  const UP = await lade(dist, 'services', 'unbekannte-parameter.js');
  const erlaubt = new Set(Object.keys(tool.CODE_CHECK_DEFINITION.inputSchema.properties));
  const up = UP.pruefeUnbekannteParameter('code_check', erlaubt, { action: 'add_pattern', signatur: ['x'], fenster: 'zeile' });
  pruefe(up && /gehoert in erkennung/i.test(up.meldung) && /erkennung:\s*\{/.test(up.meldung) && /UND/.test(up.meldung),
    'U15 signatur/fenster auf oberster Ebene: Meldung verweist auf das erkennung{}-Format', up);
  pruefe(/UND/.test(tool.CODE_CHECK_DEFINITION.inputSchema.properties.erkennung.description) && /Praefix/.test(tool.CODE_CHECK_DEFINITION.inputSchema.properties.id.description),
    'U16 Definition: signatur-Liste = UND, id-Praefix dokumentiert');

  // ── L1 list_patterns ──────────────────────────────────────────────────────
  const l1 = await cc({ action: 'list_patterns', limit: 500 });
  const k1 = l1.patterns?.find((p) => p.id === a1.id);
  pruefe(l1.success && k1 && k1.signatur === 'regex 1 + gegen 1, fenster zeile' && k1.status === 'aktiv' && k1.severity === 'error'
    && k1.geltung === 'sprachen ts,tsx; projekte zz-proj' && k1.verweise === 3 && k1.beispiele === true && !('erkennung' in k1) && !('fix' in k1),
  'L1 kompakt: Signatur-Kurzform, geltung, verweise-Zahl, ohne Langfelder', k1);
  const l2 = await cc({ action: 'list_patterns', limit: 500, detail: true });
  const d1 = l2.patterns?.find((p) => p.id === a1.id);
  pruefe(d1 && d1.erkennung?.art === 'regex' && d1.warum === 'Testmuster' && d1.beispielRichtig?.includes('geaendert') && d1.statistik?.severity_error,
    'L2 detail:true: alle Felder', d1);
  const l3 = await cc({ action: 'list_patterns', limit: 500, status: 'stillgelegt' });
  pruefe(l3.patterns?.some((p) => p.id === a3c.id) && l3.patterns.every((p) => p.status === 'stillgelegt') && !l3.patterns.some((p) => p.id === a1.id),
    'L3 status-Filter stillgelegt', l3.count);

  // ── S1 Strecken ───────────────────────────────────────────────────────────
  const core = tool.CODE_CHECK_DEFINITION;
  const stdioMod = await lade(repo, 'packages', 'mcp-server', 'dist', 'tools', 'consolidated', 'code-check.js');
  pruefe(JSON.stringify(stdioMod.codeCheckTool.definition) === JSON.stringify(core), 'S1a stdio-Definition = core-Definition');
  const restMod = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
  const restDef = restMod.MCP_TOOLS.find((t) => t.name === 'code_check');
  pruefe(restDef && JSON.stringify(restDef.inputSchema) === JSON.stringify(core.inputSchema) && restDef.description.startsWith(core.description),
    'S1b REST MCP_TOOLS code_check = core-Definition (inputSchema)', restDef && Object.keys(restDef.inputSchema.properties));

  const sdk = join(repo, 'packages', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
  const { InMemoryTransport } = await import(pathToFileURL(join(sdk, 'inMemory.js')).href);
  const { Client } = await import(pathToFileURL(join(sdk, 'client', 'index.js')).href);
  const { createServer } = await lade(repo, 'packages', 'mcp-server', 'dist', 'server.js');
  const server = createServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 't37', version: '1.0' });
  await client.connect(c);
  const liste = (await client.listTools()).tools;
  const ld = liste.find((t) => t.name === 'code_check');
  pruefe(ld && ['erkennung', 'geltung', 'verweise', 'beispiel_falsch', 'status', 'grund'].every((k) => k in ld.inputSchema.properties)
    && ld.inputSchema.properties.action.enum.includes('update_pattern'), 'S1c stdio tools/list: code_check mit E1-Feldern und update_pattern');
  const sa = await client.callTool({ name: 'code_check', arguments: {
    ...basis, agent_id: AGENT, description: PRAEFIX + ' S1 stdio', fix: 'x', titel: PRAEFIX + ' stdio',
    erkennung: { signatur: ['zzT37Stdio\\('] }, beispiel_falsch: 'zzT37Stdio();', beispiel_richtig: 'ok();', geltung: { sprachen: ['ts'] },
  } });
  const sj = JSON.parse(sa.content[0].text);
  const rs = sj.success ? await zeile(sj.id) : null;
  pruefe(sj.success && sj.status === 'aktiv' && rs?.erkennung?.signatur?.[0] === 'zzT37Stdio\\(' && rs?.geltung?.sprachen?.[0] === 'ts',
    'S1d stdio add_pattern mit erkennung/geltung (PA-1 laesst sie durch) -> gespeichert', sj);
  const sd = JSON.parse((await client.callTool({ name: 'code_check', arguments: { action: 'delete_pattern', id: sj.id, agent_id: AGENT } })).content[0].text);
  pruefe(sd.success === true && !(await zeile(sj.id)), 'S1e stdio delete_pattern', sd);
  await client.close();
} catch (err) {
  fehler++;
  console.log('FEHLER  Ausnahme: ' + (err?.stack ?? err));
} finally {
  await aufraeumen().catch((e) => { fehler++; console.log('FEHLER  Aufraeumen: ' + e.message); });
  ollama.close();
  qdrant.close();
}
console.log(`\nERGEBNIS: ${ok} OK, ${fehler} FEHLER`);
process.exit(fehler ? 1 : 0);
