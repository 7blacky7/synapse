/**
 * P15-T36 (11.10.2026): EINE Pfad-Normalisierung fuer alles, was ueber files/files_batch hereinkommt,
 * plus F3 (Schreiben auf gesperrte Pfade wird abgelehnt). Konzept 36b53139, User-Entscheidung dc7dcfb8.
 *
 * ZUSAGEN:
 *   U1  normalisiereProjektPfad: '..' nur als ganzes Segment; a..b.ts / ...  / ..a / [...all] bleiben;
 *       './a//b/' -> 'a/b'; Backslash ist Trenner; Gross/Klein und Unicode (NFD) unveraendert.
 *   U2  Ablehnung NUR bei ausbruch | absolut (auch unter dem Projekt-Root, streng) | steuerzeichen (+ leer).
 *   U3  Idempotenz: norm(norm(p)) == norm(p) fuer 5000 Zufallspfade.
 *   U4  liegtImProjekt (Daemon-Schutz): '../x', '/abs', 'a/../../x' liegen ausserhalb.
 *   U5  normalisiereOps: Fehler tragen 'Op <i>:', F3 je Op nur fuer Schreibziele (delete / move-Quelle frei).
 *   R1-R14 REST /mcp tools/call files bzw. files_batch (mcp.ts): normalisiert gespeichert, Ablehnungen
 *       ohne Schreiben, F3 pfad_gesperrt (Standard + Projektregel modus gesperrt), ausgeblendete Regel
 *       unveraendert, .env.example schreibbar (Ausnahme in der Sperre), delete auf gesperrter Bestandszeile
 *       erlaubt, Reservierungen ueber dieselbe Funktion.
 *   F1-F3 REST /api/projects/:name/files (routes/files.ts): dieselben Regeln, 400 mit code.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama hart auf 127.0.0.1:9.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/projekt-pfad-p15-t36.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 * Braucht gebautes packages/core/dist und packages/rest-api/dist.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('projekt-pfad-p15-t36.test');
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

const PROJECT = 'pfad-t36';
const AGENT = 'pfad-t36-agent';
const wurzel = mkdtempSync(join(tmpdir(), 'pfad-t36-'));
const pool = core.getPool();

let ok = 0;
const fehler = [];
const pruefe = (bed, text, detail) => {
  if (bed) { ok++; console.log('OK  ' + text); return; }
  fehler.push(text);
  console.log('FEHLER ' + text + (detail !== undefined ? '\n   ' + JSON.stringify(detail).slice(0, 900) : ''));
};

async function aufraeumen() {
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'project_ignore_rules']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]).catch(() => {});
  }
}
const zeilen = async () => (await pool.query(
  'SELECT file_path FROM code_files WHERE project = $1 AND deleted_at IS NULL ORDER BY file_path', [PROJECT],
)).rows.map((r) => r.file_path);

await aufraeumen();
await core.registerProject(PROJECT, wurzel);
// Regeln VOR dem ersten Aufruf anlegen (Regel-Cache 30 s).
await pool.query(
  `INSERT INTO project_ignore_rules (project, pattern, enabled, modus, sort_order) VALUES
     ($1, 'geheim/', true, 'gesperrt', 100), ($1, 'versteckt/', true, 'ausgeblendet', 101)`,
  [PROJECT],
);
// Gesperrte BESTANDSZEILE (wie die Altlast vor 0a1a0ef) direkt anlegen.
await pool.query(
  `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at)
   VALUES ($1, $2, '.synapse/alt.md', 'alt.md', 'md', 'alt', $3, 3, NOW())`,
  [`${PROJECT}:.synapse/alt.md`, PROJECT, core.contentHash('alt')],
);

// ───────────────────────── U: reine Funktionen ─────────────────────────
const norm = core.normalisiereProjektPfad;
if (typeof norm !== 'function') {
  pruefe(false, 'U0: core exportiert normalisiereProjektPfad');
} else {
  const ergebnis = (p) => { try { return norm(p).pfad; } catch (e) { return `!${e.grund ?? e.message}`; } };
  const faelle = [
    ['a..b.ts', 'a..b.ts'], ['..a/x', '..a/x'], ['a/.../x', 'a/.../x'], ['src/app/api/auth/[...all]/route.ts', 'src/app/api/auth/[...all]/route.ts'],
    ['coedit-test/../packages/x', 'packages/x'], ['./a//b/', 'a/b'], ['a\\b\\c.ts', 'a/b/c.ts'],
    ['Äpfel/Café.ts', 'Äpfel/Café.ts'], ['Cafe\u0301.ts', 'Cafe\u0301.ts'], ['README.MD', 'README.MD'], [' a.ts', ' a.ts'],
  ];
  for (const [ein, soll] of faelle) pruefe(ergebnis(ein) === soll, `U1: ${JSON.stringify(ein)} -> ${JSON.stringify(soll)}`, ergebnis(ein));
  const abgelehnt = [
    ['../x', 'ausbruch'], ['a/../../x', 'ausbruch'], ['a\\..\\..\\x', 'ausbruch'], ['..', 'ausbruch'],
    ['/etc/passwd', 'absolut'], [`${wurzel}/unter-root.ts`, 'absolut'], ['C:\\x.ts', 'absolut'], ['\\\\srv\\x', 'absolut'],
    ['a\nb.ts', 'steuerzeichen'], ['a\u0000b', 'steuerzeichen'], ['a\tb', 'steuerzeichen'], ['a\u007fb', 'steuerzeichen'],
    ['', 'leer'], ['a/..', 'leer'], ['./', 'leer'],
  ];
  for (const [ein, grund] of abgelehnt) pruefe(ergebnis(ein) === `!${grund}`, `U2: ${JSON.stringify(ein)} -> ${grund}`, ergebnis(ein));
  // Meldungen nennen Position/Codepoint bzw. den Ausbruch
  try { norm('ab\ncd'); } catch (e) { pruefe(/U\+000A/.test(e.message) && /Position 2/.test(e.message), 'U2: Steuerzeichen-Meldung nennt U+000A und Position', e.message); }
  // Idempotenz
  const segmente = ['a', '..', '.', '', 'a..b', '...', 'B', 'ü', '\\'];
  let idem = 0; let zufall = 1;
  const rnd = () => { zufall = (zufall * 48271) % 2147483647; return zufall; };
  for (let i = 0; i < 5000; i++) {
    const p = Array.from({ length: 1 + (rnd() % 6) }, () => segmente[rnd() % segmente.length]).join('/');
    const e1 = ergebnis(p);
    if (e1.startsWith('!') || ergebnis(e1) === e1) idem++;
  }
  pruefe(idem === 5000, 'U3: idempotent fuer 5000 Zufallspfade', idem);
}
if (typeof core.liegtImProjekt !== 'function') {
  pruefe(false, 'U4: core exportiert liegtImProjekt');
} else {
  pruefe(core.liegtImProjekt(wurzel, 'a/b.ts') && core.liegtImProjekt(wurzel, 'a..b.ts'), 'U4: liegtImProjekt erlaubt a/b.ts und a..b.ts');
  pruefe(!core.liegtImProjekt(wurzel, '../x') && !core.liegtImProjekt(wurzel, 'a/../../x') && !core.liegtImProjekt(wurzel, '/etc/x') && !core.liegtImProjekt(wurzel, ''),
    'U4: liegtImProjekt lehnt ../x, a/../../x, /etc/x und leer ab');
}
if (typeof core.normalisiereOps !== 'function') {
  pruefe(false, 'U5: core exportiert normalisiereOps');
} else {
  const ops = await core.normalisiereOps(PROJECT, [
    { file_path: 'x/../ok.ts', action: 'create', content: '' },
    { file_path: '.synapse/alt.md', action: 'delete' },
    { file_path: '.synapse/alt.md', action: 'copy', new_path: 'kopie/./alt.md' },
  ]);
  pruefe(ops[0].file_path === 'ok.ts' && ops[1].file_path === '.synapse/alt.md' && ops[2].new_path === 'kopie/alt.md',
    'U5: normalisiereOps normalisiert, delete und move/copy-Quelle auf gesperrtem Pfad erlaubt', ops);
  let meldung = '';
  try { await core.normalisiereOps(PROJECT, [{ file_path: 'a.ts', action: 'create' }, { file_path: '../b.ts', action: 'update' }]); } catch (e) { meldung = e.message; }
  pruefe(/^Op 1: /.test(meldung) && /verlaesst das Projekt/.test(meldung), 'U5: Fehler nennt "Op 1:" und den Ausbruch', meldung);
  meldung = '';
  try { await core.normalisiereOps(PROJECT, [{ file_path: 'a.ts', action: 'move', new_path: 'geheim/a.ts' }]); } catch (e) { meldung = e.message; }
  pruefe(/^Op 0: /.test(meldung) && /gesperrt/.test(meldung), 'U5: move-ZIEL auf gesperrtem Pfad -> Op 0: gesperrt', meldung);
}

// ───────────────────────── R: REST /mcp tools/call ─────────────────────────
const requireRest = createRequire(join(repo, 'packages', 'rest-api', 'package.json'));
const Fastify = requireRest('fastify');
const { mcpRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
const { filesRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'files.js');
const app = Fastify({ logger: false });
await app.register(mcpRoutes);
await app.register(filesRoutes);
await app.ready();
const tool = async (name, args) => {
  const res = await app.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: PROJECT, agent_id: AGENT, ...args } } } });
  const body = res.json();
  try { return JSON.parse(body.result.content[0].text); } catch { return body; }
};
const files = (args) => tool('files', args);
const istFehler = (r, code, grund) => r?.success === false && r?.error === code && (grund === undefined || r?.grund === grund);

try {
  let r = await files({ action: 'create', file_path: 'x/../y.txt', content: 'y\n' });
  let z = await zeilen();
  pruefe(r?.success === true && z.includes('y.txt') && !z.some((p) => p.includes('..')), 'R1: create x/../y.txt wird als y.txt gespeichert', { r, z });

  r = await files({ action: 'create', file_path: '../aus.txt', content: 'x' });
  pruefe(istFehler(r, 'pfad_ungueltig', 'ausbruch') && !(await zeilen()).some((p) => p.includes('aus.txt')), 'R2: create ../aus.txt -> pfad_ungueltig/ausbruch, nichts geschrieben', r);

  r = await files({ action: 'create', file_path: '/tmp/pfad-t36-abs.txt', content: 'x' });
  pruefe(istFehler(r, 'pfad_ungueltig', 'absolut'), 'R3: create /tmp/... -> pfad_ungueltig/absolut', r);
  r = await files({ action: 'create', file_path: `${wurzel}/unter-root.txt`, content: 'x' });
  pruefe(istFehler(r, 'pfad_ungueltig', 'absolut') && !(await zeilen()).some((p) => p.includes('unter-root')), 'R3b: absolut UNTER dem Projekt-Root wird streng abgelehnt (kein Umrechnen)', r);

  r = await files({ action: 'create', file_path: 'a\nb.txt', content: 'x' });
  pruefe(istFehler(r, 'pfad_ungueltig', 'steuerzeichen'), 'R4: Steuerzeichen im Pfad -> pfad_ungueltig/steuerzeichen', r);

  r = await files({ action: 'create', file_path: '.synapse/probe.md', content: 'x' });
  pruefe(istFehler(r, 'pfad_gesperrt') && r?.herkunft === 'standard' && !(await zeilen()).includes('.synapse/probe.md'),
    'R5: create .synapse/probe.md -> pfad_gesperrt (Standard), nichts geschrieben', r);

  r = await files({ action: 'create', file_path: 'w\\v.txt', content: 'v\n' });
  pruefe(r?.success === true && (await zeilen()).includes('w/v.txt'), 'R6: Backslash ist Trenner (w\\v.txt -> w/v.txt)', r);

  r = await files({ action: 'create', file_path: '.env.example', content: 'A=\n' });
  pruefe(r?.success === true && (await zeilen()).includes('.env.example'), 'R7: .env.example ist schreibbar (Ausnahme in der Standard-Sperre)', r);
  r = await files({ action: 'create', file_path: '.env', content: 'A=1\n' });
  pruefe(istFehler(r, 'pfad_gesperrt'), 'R7b: .env bleibt gesperrt', r);

  r = await files({ action: 'move', file_path: 'y.txt', new_path: '.synapse/z.md' });
  pruefe(istFehler(r, 'pfad_gesperrt') && (await zeilen()).includes('y.txt'), 'R8: move auf gesperrtes Ziel -> pfad_gesperrt, Quelle bleibt', r);

  r = await files({ action: 'delete', file_path: '.synapse/alt.md' });
  pruefe(r?.success === true && !(await zeilen()).includes('.synapse/alt.md'), 'R9: delete auf gesperrter Bestandszeile bleibt erlaubt', r);

  r = await files({ action: 'read', file_path: 'q/../y.txt' });
  pruefe(r?.success === true && r?.file_path === 'y.txt' && /y/.test(r?.content ?? ''), 'R10: read q/../y.txt liest y.txt', r);

  const planVorher = (await pool.query('SELECT count(*)::int AS n FROM file_batch_plans WHERE project = $1', [PROJECT])).rows[0].n;
  r = await tool('files_batch', { action: 'plan', ops: [{ file_path: 'ok.txt', action: 'create', content: 'o' }, { file_path: '../x.txt', action: 'create', content: 'x' }] });
  const planNachher = (await pool.query('SELECT count(*)::int AS n FROM file_batch_plans WHERE project = $1', [PROJECT])).rows[0].n;
  pruefe(r?.success === false && /Op 1: /.test(JSON.stringify(r)) && planNachher === planVorher, 'R11: files_batch plan mit ../x.txt -> "Op 1:", kein Plan angelegt', { r, planVorher, planNachher });
  r = await files({ action: 'plan', ops: [{ file_path: './p//q.txt', action: 'create', content: 'q' }] });
  const gespeichert = r?.plan_id ? (await pool.query('SELECT ops FROM file_batch_plans WHERE id = $1::bigint', [r.plan_id])).rows[0]?.ops : null;
  pruefe(r?.success === true && gespeichert?.[0]?.file_path === 'p/q.txt', 'R11b: plan speichert ./p//q.txt als p/q.txt', { r, gespeichert });
  if (r?.plan_id) await files({ action: 'cancel', plan_id: r.plan_id });

  r = await files({ action: 'create', file_path: 'geheim/a.txt', content: 'x' });
  pruefe(istFehler(r, 'pfad_gesperrt') && r?.herkunft === 'datenbank' && r?.regel === 'geheim/', 'R12: Projektregel modus gesperrt -> pfad_gesperrt (herkunft datenbank, regel geheim/)', r);

  r = await files({ action: 'create', file_path: 'versteckt/a.txt', content: 'x' });
  pruefe(r?.success === true && r?.ignoriert === true && (await zeilen()).includes('versteckt/a.txt'), 'R13: ausgeblendete Regel unveraendert (geschrieben, ignoriert:true)', r);

  r = await files({ action: 'reservation_add', file_path: ['r\\s.ts', 'r/./s.ts'] });
  pruefe(r?.success === true && r?.count === 1 && r?.reservations?.[0]?.file_path === 'r/s.ts', 'R14: Reservierung normalisiert und dedupliziert (r\\s.ts, r/./s.ts -> r/s.ts)', r);
  r = await files({ action: 'reservation_add', file_path: ['../r.ts'] });
  pruefe(r?.success === false && /verlaesst das Projekt/.test(JSON.stringify(r)), 'R14b: Reservierung ../r.ts abgelehnt mit Ausbruch-Meldung', r);
  await files({ action: 'reservation_release', file_path: ['r/s.ts'] });

  // ───────────────────────── F: REST /api/projects/:name/files ─────────────────────────
  let res = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT}/files`, payload: { file_path: '../f.txt', content: 'x' } });
  pruefe(res.statusCode === 400 && res.json()?.error?.code === 'pfad_ungueltig', 'F1: POST ../f.txt -> 400 pfad_ungueltig', { s: res.statusCode, b: res.json() });
  res = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT}/files`, payload: { file_path: 'f/../f2.txt', content: 'x' } });
  pruefe(res.statusCode === 200 && (await zeilen()).includes('f2.txt'), 'F2: POST f/../f2.txt -> gespeichert als f2.txt', { s: res.statusCode, b: res.json() });
  res = await app.inject({ method: 'PUT', url: `/api/projects/${PROJECT}/files`, payload: { file_path: 'f2.txt', operation: 'move', new_path: 'node_modules/f.txt' } });
  pruefe(res.statusCode === 400 && res.json()?.error?.code === 'pfad_gesperrt' && (await zeilen()).includes('f2.txt'), 'F3: PUT move nach node_modules/ -> 400 pfad_gesperrt', { s: res.statusCode, b: res.json() });
} finally {
  await app.close().catch(() => {});
  await aufraeumen();
  await pool.query('DELETE FROM projects WHERE name = $1', [PROJECT]).catch(() => {});
  rmSync(wurzel, { recursive: true, force: true });
}

console.log(`\n${ok} OK, ${fehler.length} FEHLER`);
await pool.end().catch(() => {});
process.exit(fehler.length === 0 ? 0 : 1);
