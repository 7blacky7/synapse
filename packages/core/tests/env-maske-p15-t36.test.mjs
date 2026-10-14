/**
 * P15-T36 Teil 2 (11.10.2026, User-Entscheidung 58492366): Werte von .env-Dateien (echte .env, .env.* und
 * die Vorlagen .env.example/.env.sample/.env.template) erscheinen in KEINER Ausgabe, nur als NAME=[WERT].
 * Reine Ausgabe-Schicht: PG behaelt die echten Werte. Ein zurueckgeschriebener Platzhalter [WERT] heisst
 * "unveraendert lassen". Ueberschreiben/Entfernen/restore einer Variable mit Wert -> Hinweis (nur Namen).
 *
 * ZUSAGEN:
 *   U1  maskiereEnv: Kommentare, Namen, leere Werte bleiben; Werte (auch mehrzeilig, export, Duplikate,
 *       sonstige Zeilen) werden [WERT]; Zeilenzahl und CRLF bleiben gleich.
 *   U2  entmaskiereEnv(maskiereEnv(x), x) === x (Identitaet) fuer mehrere schwierige Inhalte.
 *   U3  envHinweise nennt geaenderte/entfernte Namen, nie Werte; neue/leere Variablen ohne Hinweis.
 *   M1  code_intel file auf .env (Bestandszeile, nicht ausgeblendet): maskiert, Kommentar/leer sichtbar.
 *   M2  code_intel search (Volltext): Trefferzeilen und headline ohne Wert.
 *   M3  files read .env.example: maskiert.
 *   M4  files search_replace PORT=[WERT] -> PORT=neu: PG hat neuen PORT, alle anderen Werte echt; Hinweis.
 *   M5  replace_lines / update mit Platzhaltern (Einzelweg + Plan): echte Werte bleiben erhalten.
 *   M6  create auf vorhandene .env.example (Planmodus): aktueller_inhalt maskiert, Plan-Diff maskiert,
 *       plan_status op_index ohne Wert; commit schreibt echte Werte + Hinweis.
 *   M7  versions / history / get_version / restore_batch vorschau: ohne Wert.
 *   M8  restore: PG wieder alter Stand, Hinweis 'zurückgesetzt', ohne Wert.
 *   M9  Fehlermeldungen (Anker-Mismatch, search 0 Treffer): ohne Wert.
 *   M10 Sperre: .env.sample und .env.template schreibbar, .env.local bleibt gesperrt.
 *   M11 Chunks: parseAndEmbed legt fuer .env keine Werte in code_chunks ab.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama hart auf 127.0.0.1:9.
 * Testwerte sind Zufallsmarker; Ausgaben ersetzen sie durch <GEHEIM>, damit auch ein Leck nichts zeigt.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/env-maske-p15-t36.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('env-maske-p15-t36.test');
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.FEHLERMUSTER_WARTE_MS = '0';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);

const core = await lade(dist, 'index.js');
const { getConfig } = await lade(dist, 'config.js');
const wirksam = getConfig();
if (/192\.168\.50\.65/.test(wirksam.qdrant.url) || /192\.168\.50\.65/.test(wirksam.embeddings.ollama.url)) {
  console.error('ABBRUCH: Qdrant/Ollama zeigen nicht auf die Test-Attrappen.');
  process.exit(2);
}

const PROJECT = 'env-t36';
const AGENT = 'env-t36-agent';
const wurzel = mkdtempSync(join(tmpdir(), 'env-t36-'));
const pool = core.getPool();

const zufall = () => Math.random().toString(36).slice(2, 10);
const G = {
  A: `GeheimA${zufall()}`, P: `GeheimP${zufall()}`, M1: `GeheimM1${zufall()}`, M2: `GeheimM2${zufall()}`,
  D: `GeheimD${zufall()}`, R: `GeheimR${zufall()}`, X: `GeheimX${zufall()}`, Y: `GeheimY${zufall()}`,
};
const GEHEIM = Object.values(G);
const schwaerze = (text) => GEHEIM.reduce((t, g) => t.split(g).join('<GEHEIM>'), String(text));
const frei = (wert) => { const s = JSON.stringify(wert) ?? ''; return !GEHEIM.some((g) => s.includes(g)); };

let ok = 0;
const fehler = [];
const pruefe = (bed, text, detail) => {
  if (bed) { ok++; console.log('OK  ' + text); return; }
  fehler.push(text);
  console.log('FEHLER ' + text + (detail !== undefined ? '\n   ' + schwaerze(JSON.stringify(detail)).slice(0, 900) : ''));
};

async function aufraeumen() {
  for (const t of ['code_chunks', 'code_symbols', 'file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'project_ignore_rules']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]).catch(() => {});
  }
}
const inhalt = async (p) => (await pool.query(
  'SELECT content FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [PROJECT, p],
)).rows[0]?.content ?? null;

const ENV = [
  '# Kommentar bleibt sichtbar',
  `export API_KEY=${G.A}`,
  `PORT=${G.P}`,
  'LEER=',
  'LEER2=""',
  `MULTI="erste ${G.M1}`,
  `${G.M2}"`,
  `API_KEY=${G.D}`,
  `rohe zeile ${G.R}`,
  '',
].join('\n');
const BEISPIEL = ['# Vorlage', `DB_URL=${G.X}`, `PORT=${G.P}`, 'LEER=', `TOKEN=${G.Y}`, ''].join('\n');

await aufraeumen();
await core.registerProject(PROJECT, wurzel);
// P10-T78: der Test schreibt nur ueber das files-Tool nach PG (kein Daemon spiegelt auf die Platte). Die
// Plattenpruefung vor plan/commit (P6-T3, file-fs-drift.ts) saehe sonst den leeren Temp-Ordner als Drift.
// Ein Host ohne lokalen/verbundenen Daemon liefert ehrlich 'ungeprueft'; die Masken-Zusagen bleiben gleich.
await pool.query('UPDATE projects SET hostname = $2 WHERE name = $1', [PROJECT, 'env-t36-ohne-daemon']);
// Bestands-.env wie in der Live-DB (EVALINK-MCP, saar-quiz): ignored=false, also auch in der Volltextsuche.
await pool.query(
  `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at, ignored)
   VALUES ($1, $2, '.env', '.env', 'env', $3, $4, $5, NOW(), false)`,
  [`${PROJECT}:.env`, PROJECT, ENV, core.contentHash(ENV), ENV.length],
);

// ───────────────────────── U: reine Funktionen ─────────────────────────
if (typeof core.maskiereEnv !== 'function' || typeof core.entmaskiereEnv !== 'function' || typeof core.envHinweise !== 'function') {
  pruefe(false, 'U0: core exportiert maskiereEnv, entmaskiereEnv, envHinweise');
} else {
  const m = core.maskiereEnv(ENV);
  const z = m.split('\n');
  pruefe(frei(m) && z.length === ENV.split('\n').length, 'U1: maskiert ohne Wert, Zeilenzahl gleich', m);
  pruefe(z[0] === '# Kommentar bleibt sichtbar' && z[1] === 'export API_KEY=[WERT]' && z[2] === 'PORT=[WERT]'
    && z[3] === 'LEER=' && z[4] === 'LEER2=""' && z[5] === 'MULTI=[WERT]' && z[6] === '[WERT]' && z[7] === 'API_KEY=[WERT]' && z[8] === '[WERT]',
  'U1: Kommentar, export, leer, mehrzeilig, Duplikat, sonstige Zeile', z);
  const crlf = `A=${G.A}\r\n# k\r\nB=\r\n`;
  const mc = core.maskiereEnv(crlf);
  pruefe(mc === 'A=[WERT]\r\n# k\r\nB=\r\n', 'U1: CRLF bleibt erhalten', mc);
  const faelle = [ENV, crlf, BEISPIEL, '', 'X=1', `K='a\nb'\nL=2`, 'kaputt="offen\nbis\nzum ende', `A=[WERT]\nB=${G.A}`, 'A=1 # inline\n  B = 2  \n'];
  pruefe(faelle.every((x) => core.entmaskiereEnv(core.maskiereEnv(x), x).inhalt === x), 'U2: entmaskiere(maskiere(x), x) === x');
  // Platzhalter = unveraendert, geaenderte Zeile gewinnt, neue Zeile bleibt
  const neu = core.maskiereEnv(BEISPIEL).replace('PORT=[WERT]', 'PORT=4711') + 'NEU=1\n';
  const e = core.entmaskiereEnv(neu, BEISPIEL).inhalt;
  pruefe(e.includes(`DB_URL=${G.X}`) && e.includes('PORT=4711') && e.includes(`TOKEN=${G.Y}`) && e.includes('NEU=1') && !e.includes('[WERT]'),
    'U2: Platzhalter behalten echte Werte, Aenderung und neue Zeile kommen an', e);
  const h = core.envHinweise(BEISPIEL, BEISPIEL.replace(`PORT=${G.P}`, 'PORT=1').replace(`TOKEN=${G.Y}\n`, '') + 'NEU=x\n', 'schreiben');
  pruefe(frei(h) && h.length === 2 && h.some((x) => /^PORT: Wert überschrieben, per files\(restore\) wiederherstellbar$/.test(x)) && h.some((x) => /^TOKEN: /.test(x)),
    'U3: Hinweise nur fuer PORT (ueberschrieben) und TOKEN (entfernt), nie Werte', h);
}

// ───────────────────────── M: REST /mcp tools/call ─────────────────────────
const requireRest = createRequire(join(repo, 'packages', 'rest-api', 'package.json'));
const Fastify = requireRest('fastify');
const { mcpRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
const app = Fastify({ logger: false });
await app.register(mcpRoutes);
await app.ready();
const tool = async (name, args) => {
  const res = await app.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: PROJECT, agent_id: AGENT, ...args } } } });
  const body = res.json();
  try { return JSON.parse(body.result.content[0].text); } catch { return body; }
};
const files = (args) => tool('files', args);
const hinweiseVon = (r) => JSON.stringify(r?.env_hinweise ?? []);

try {
  // M1 code_intel file
  let r = await tool('code_intel', { action: 'file', file_path: '.env' });
  pruefe(frei(r) && /export API_KEY=\[WERT\]/.test(r?.content ?? '') && /# Kommentar bleibt sichtbar/.test(r?.content ?? '') && /LEER=\n/.test(r?.content ?? ''),
    'M1: code_intel file .env maskiert, Kommentar und leerer Wert sichtbar', r);

  // M2 Volltextsuche
  r = await tool('code_intel', { action: 'search', query: 'API_KEY' });
  const envTreffer = (r?.results ?? []).find((x) => x.file_path === '.env');
  pruefe(Boolean(envTreffer) && frei(r), 'M2: code_intel search findet .env, Trefferzeilen/headline ohne Wert', r);
  r = await tool('code_intel', { action: 'search', query: G.A });
  pruefe(frei(r), 'M2: Suche nach dem Wert selbst liefert ihn nicht aus', r);

  // M3 files read (neue Vorlage)
  r = await files({ action: 'create', file_path: '.env.example', content: BEISPIEL });
  pruefe(r?.success === true && (await inhalt('.env.example')) === BEISPIEL && frei(r), 'M3: create .env.example speichert echten Inhalt, Antwort ohne Wert', r);
  r = await files({ action: 'read', file_path: '.env.example' });
  pruefe(frei(r) && /DB_URL=\[WERT\]/.test(r?.content ?? '') && /LEER=/.test(r?.content ?? ''), 'M3: files read .env.example maskiert', r);
  r = await files({ action: 'read', file_path: '.env' });
  pruefe(frei(r) && /PORT=\[WERT\]/.test(r?.content ?? ''), 'M3: files read .env (Bestand) maskiert', r);

  // M4 search_replace in der maskierten Sicht
  r = await files({ action: 'search_replace', file_path: '.env.example', search: 'PORT=[WERT]', replace: 'PORT=8080' });
  let jetzt = await inhalt('.env.example');
  pruefe(r?.success === true && jetzt === BEISPIEL.replace(`PORT=${G.P}`, 'PORT=8080') && frei(r) && /PORT: Wert überschrieben, per files\(restore\) wiederherstellbar/.test(hinweiseVon(r)),
    'M4: search_replace PORT=[WERT] -> PORT=8080, andere Werte echt, Hinweis ohne Wert', { r, jetzt });

  // M9 Fehlermeldungen
  r = await files({ action: 'search_replace', file_path: '.env.example', search: `TOKEN=${G.Y}x`, replace: 'TOKEN=1' });
  pruefe(r?.success === false && frei({ ...r, error: String(r?.error ?? '').split(`${G.Y}x`).join('') }), 'M9: search 0 Treffer -> Fehler ohne gespeicherten Wert (fuzzy aus der Maske)', r);
  r = await files({ action: 'update', file_path: '.env.example', content: 'X=1\n', anchor_text: 'GIBTSNICHT' });
  pruefe(r?.success === false && frei(r), 'M9: update mit falschem Anker -> Fehler ohne Wert', r);

  // M5 replace_lines mit Platzhalter + Einzelweg-Rueckschreiben
  r = await files({ action: 'replace_lines', file_path: '.env.example', line_start: 2, line_end: 2, content: 'DB_URL=[WERT]' });
  jetzt = await inhalt('.env.example');
  pruefe(r?.success === true && jetzt.includes(`DB_URL=${G.X}`) && !jetzt.includes('[WERT]') && (r?.env_hinweise ?? []).length === 0,
    'M5: replace_lines mit DB_URL=[WERT] laesst den echten Wert stehen, kein Hinweis', { r, jetzt });
  const lesen = await files({ action: 'read', file_path: '.env.example' });
  const geaendert = lesen.content.replace('TOKEN=[WERT]', 'TOKEN=[WERT]\nNEU=ja');
  r = await files({ action: 'plan', ops: [{ file_path: '.env.example', action: 'update', content: geaendert, anchor_contains: 'DB_URL=[WERT]' }] });
  pruefe(r?.success === true && frei(r), 'M5: plan update mit Platzhalter-Inhalt (Anker aus der Maske) ok, Antwort ohne Wert', r);
  const planId = r?.plan_id;
  if (planId) {
    const st = await files({ action: 'plan_status', plan_id: planId, op_index: 0 });
    pruefe(st?.success === true && frei(st), 'M6: plan_status op_index ohne Wert', st);
    const st2 = await files({ action: 'plan_status', plan_id: planId });
    const diffText = JSON.stringify(st2?.diff ?? {});
    pruefe(st2?.success === true && frei(st2) && /\+NEU=\[WERT\]/.test(diffText) && !/NEU=ja/.test(diffText), 'M6: plan_status Diff maskiert (auch der neue Wert), Aenderung als Name sichtbar', st2?.diff);
    r = await files({ action: 'commit', plan_id: planId });
    jetzt = await inhalt('.env.example');
    pruefe(r?.success === true && frei(r) && jetzt.includes(`DB_URL=${G.X}`) && jetzt.includes(`TOKEN=${G.Y}`) && jetzt.includes('NEU=ja') && !jetzt.includes('[WERT]'),
      'M5: commit mit Platzhaltern schreibt echte Werte zurueck', { r, jetzt });
  }

  // M6 create auf vorhandene Datei -> Planmodus
  r = await files({ action: 'create', file_path: '.env.example', content: '# neu\nDB_URL=[WERT]\nTOKEN=anders\n' });
  pruefe(r?.applied === false && frei(r) && /DB_URL=\[WERT\]/.test(r?.aktueller_inhalt ?? ''), 'M6: create auf vorhandene .env.example -> aktueller_inhalt maskiert', r);
  if (r?.plan_id) {
    const c = await files({ action: 'commit', plan_id: r.plan_id });
    jetzt = await inhalt('.env.example');
    const h = hinweiseVon(c);
    pruefe(c?.success === true && frei(c) && jetzt === `# neu\nDB_URL=${G.X}\nTOKEN=anders\n` && /TOKEN: Wert überschrieben/.test(h) && !/DB_URL/.test(h) && /PORT: Wert entfernt/.test(h),
      'M6: commit: DB_URL echt behalten, TOKEN ueberschrieben + PORT entfernt gemeldet', { c, jetzt });
  }

  // M7 versions / history / get_version
  const v = await files({ action: 'versions', file_path: '.env.example' });
  pruefe(v?.success === true && v.count >= 3 && frei(v), 'M7: versions ohne Wert (diff maskiert)', v);
  const hist = await files({ action: 'history', file_path: '.env.example' });
  pruefe(hist?.success === true && frei(hist), 'M7: history ohne Wert', hist);
  const mitInhalt = (await pool.query(`SELECT id::text AS id FROM file_versions WHERE project = $1 AND file_path = '.env.example' AND content = $2 ORDER BY id LIMIT 1`, [PROJECT, BEISPIEL])).rows[0]?.id;
  const gv = mitInhalt ? await files({ action: 'get_version', version_id: mitInhalt }) : null;
  pruefe(gv?.success === true && frei(gv) && /DB_URL=\[WERT\]/.test(gv?.version?.content ?? ''), 'M7: get_version content maskiert', gv);
  const batch = (await pool.query(`SELECT batch_id::text AS b FROM file_versions WHERE project = $1 AND batch_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [PROJECT])).rows[0]?.b;
  if (batch) {
    const vb = await files({ action: 'restore_batch', batch_id: batch, vorschau: true });
    pruefe(vb?.success === true && frei(vb), 'M7: restore_batch vorschau ohne Wert', vb);
  }

  // M8 restore auf die erste Version (BEISPIEL mit echtem PORT)
  const erste = (await pool.query(`SELECT id::text AS id FROM file_versions WHERE project = $1 AND file_path = '.env.example' AND content = $2 ORDER BY id LIMIT 1`, [PROJECT, BEISPIEL])).rows[0]?.id;
  r = erste ? await files({ action: 'restore', version_id: erste }) : null;
  jetzt = await inhalt('.env.example');
  pruefe(r?.success === true && frei(r) && jetzt === BEISPIEL && /TOKEN: Wert zurückgesetzt, per files\(restore\) wiederherstellbar/.test(hinweiseVon(r)),
    'M8: restore stellt echte Werte her, Hinweis zurückgesetzt ohne Wert', { r, jetzt });

  // M10 Sperre
  r = await files({ action: 'create', file_path: '.env.sample', content: 'A=\n' });
  const r2 = await files({ action: 'create', file_path: 'sub/.env.template', content: 'B=\n' });
  const r3 = await files({ action: 'create', file_path: '.env.local', content: 'C=1\n' });
  pruefe(r?.success === true && r2?.success === true && r3?.success === false && r3?.error === 'pfad_gesperrt',
    'M10: .env.sample/.env.template schreibbar, .env.local gesperrt', { r, r2, r3 });

  // M11 Chunks. Ohne Parser chunkt parseAndEmbed nicht — deshalb ein .env-Name MIT Parser-Endung (cfg/.env.ts,
  // faellt unter .env.*) und als ANKER dieselbe Zeile unter cfg/plain.ts: dort MUSS der Wert im Chunk stehen,
  // sonst beweist "kein Wert im Chunk" nichts (regel-nullzusagen-brauchen-anker).
  const codeMod = await lade(dist, 'services', 'code.js');
  const tsInhalt = `export const x = 1;\nAPI_KEY=${G.A}\n`;
  for (const p of ['cfg/.env.ts', 'cfg/plain.ts']) {
    await pool.query(
      `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at, ignored)
       VALUES ($1, $2, $3, $4, 'ts', $5, $6, $7, NOW(), false)`,
      [`${PROJECT}:${p}`, PROJECT, p, p.split('/').pop(), tsInhalt, core.contentHash(tsInhalt), tsInhalt.length],
    );
  }
  for (const p of ['.env', '.env.example', 'cfg/.env.ts', 'cfg/plain.ts']) {
    try { await codeMod.parseAndEmbed(PROJECT, p, { erzwingeParse: true }); } catch { /* Embedding-Attrappe 127.0.0.1:9 */ }
  }
  const ch = (await pool.query('SELECT file_path, content FROM code_chunks WHERE project = $1', [PROJECT])).rows;
  const anker = ch.filter((x) => x.file_path === 'cfg/plain.ts');
  const env = ch.filter((x) => x.file_path !== 'cfg/plain.ts');
  pruefe(anker.length > 0 && !frei(anker), 'M11 Anker: cfg/plain.ts wird gechunkt und traegt den Wert (Pruefung greift)', anker.length);
  pruefe(env.some((x) => x.file_path === 'cfg/.env.ts') && frei(env) && env.some((x) => /API_KEY=\[WERT\]/.test(x.content)),
    'M11: code_chunks von .env-Dateien (cfg/.env.ts) nur maskiert', env.map((x) => ({ p: x.file_path, c: x.content })));
  const sym = (await pool.query("SELECT file_path, name, value FROM code_symbols WHERE project = $1 AND file_path <> 'cfg/plain.ts'", [PROJECT])).rows;
  pruefe(frei(sym), 'M11: code_symbols von .env-Dateien ohne Wert', sym);
} finally {
  await app.close().catch(() => {});
  await aufraeumen();
  await pool.query('DELETE FROM projects WHERE name = $1', [PROJECT]).catch(() => {});
  rmSync(wurzel, { recursive: true, force: true });
}

console.log(`\n${ok} OK, ${fehler.length} FEHLER`);
await pool.end().catch(() => {});
process.exit(fehler.length === 0 ? 0 : 1);
