/**
 * P15 Kleinkram C (11.10.2026): Versionseintraege des Einzel-Schreibwegs (Befund 184ca6f3, Version 177137).
 *
 * BEFUND: files(versions) zeigte nach search_replace Hash und Groesse VOR der Aenderung und edit_action
 * "update". Der Hash/die Groesse sind kein Fehler fuer sich: eine Zeile in file_versions haelt den Stand VOR
 * dem Schreiben (content, content_hash, size_bytes passen zueinander; restore braucht genau das, der PG->FS-
 * Sync erkennt bekannte Plattenstaende an content_hash). Fehler waren:
 *   (a) Die Einzel-Ops (REST mcp.ts und stdio files.ts) gaben edit_action nicht weiter -> immer "update".
 *   (b) Die Liste nannte den Stand NACH der Aenderung nirgends -> Hash/Groesse wurden als Ergebnis gelesen.
 *
 * ZUSAGEN:
 *   V1 REST: jede Einzel-Op schreibt edit_action = Op-Name (update, search_replace, replace_lines,
 *      insert_after, delete_lines, search_replace_batch).
 *   V2 versions: content_hash/size_bytes bleiben der Stand VOR der Op (= Hash/Groesse von get_version.content);
 *      neu: nachher {content_hash, size_bytes, quelle} = Stand NACH der Op (naechste Version bzw. aktueller Stand).
 *   V3 history traegt dasselbe nachher.
 *   V4 restore der search_replace-Version liefert den Stand davor (Semantik unveraendert).
 *   V5 stdio filesTool search_replace -> edit_action search_replace, nachher = aktueller Stand.
 * POSITIVKONTROLLE: am Stand vor der Aenderung schlagen V1 (ausser update), V2/V3 (nachher fehlt) und V5 fehl;
 *   V4 und die Vorher-Semantik in V2 bleiben gruen.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama hart auf 127.0.0.1:9.
 * AUFRUF: set -a; . <test-db.env>; set +a; node scripts/test-versions-einzelweg.mjs
 * Braucht gebautes packages/core/dist, packages/rest-api/dist und packages/mcp-server/dist.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.FEHLERMUSTER_WARTE_MS = '0';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const core = await lade(repo, 'packages', 'core', 'dist', 'index.js');
const { getConfig } = await lade(repo, 'packages', 'core', 'dist', 'config.js');
if (/192\.168\.50\.65/.test(getConfig().qdrant.url + getConfig().embeddings.ollama.url)) {
  console.error('ABBRUCH: Qdrant/Ollama zeigen nicht auf die Test-Attrappen.');
  process.exit(2);
}

const PROJECT = 'zz-versions-einzel';
const AGENT = 'zz-versions-agent';
const wurzel = mkdtempSync(join(tmpdir(), 'versions-einzel-'));
const pool = core.getPool();
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const groesse = (s) => Buffer.byteLength(s, 'utf8');

let fehler = 0;
const pruefe = (bed, text, detail) => {
  if (bed) { console.log('OK      ' + text); return; }
  fehler++;
  console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 900) : ''));
};
async function aufraeumen() {
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]).catch(() => {});
  }
}
const pgInhalt = async (f) => (await pool.query('SELECT content FROM code_files WHERE project = $1 AND file_path = $2', [PROJECT, f])).rows[0]?.content;

await aufraeumen();
await core.registerProject(PROJECT, wurzel);

const Fastify = createRequire(join(repo, 'packages', 'rest-api', 'package.json'))('fastify');
const { mcpRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
const app = Fastify({ logger: false });
await app.register(mcpRoutes);
await app.ready();
const files = async (args) => {
  const res = await app.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'files', arguments: { project: PROJECT, agent_id: AGENT, ...args } } } });
  const body = res.json();
  try { return JSON.parse(body.result.content[0].text); } catch { return body; }
};

try {
  const F = 'v.txt';
  // Folge von Einzel-Ops; je Schritt der Stand danach.
  const schritte = [
    ['create', { content: 'eins\nzwei\ndrei\n' }],
    ['update', { content: 'eins\nzwei\ndrei\nvier\n' }],
    ['search_replace', { search: 'zwei', replace: 'ZWEI-lang-ersetzt' }],
    ['replace_lines', { line_start: 1, line_end: 1, content: 'EINS' }],
    ['insert_after', { after_line: 2, content: 'eingefuegt' }],
    ['delete_lines', { line_start: 5, line_end: 5 }],
    ['search_replace_batch', { edits: [{ search: 'drei', replace: '3' }, { search: 'EINS', replace: '1' }] }],
  ];
  const staende = []; // Stand NACH Schritt i
  for (const [action, args] of schritte) {
    const r = await files({ action, file_path: F, reason: `test ${action}`, ...args });
    if (r?.success !== true) pruefe(false, `Aufbau: ${action} erfolgreich`, r);
    staende.push(await pgInhalt(F));
  }
  const vers = (await files({ action: 'versions', file_path: F, limit: 50 }))?.versions ?? [];
  const aufsteigend = [...vers].reverse();
  pruefe(aufsteigend.length === schritte.length, `Aufbau: ${schritte.length} Versionseintraege`, aufsteigend.map((v) => v.edit_action));

  // V1 edit_action je Op
  for (let i = 1; i < schritte.length; i++) {
    const v = aufsteigend[i];
    pruefe(v?.edit_action === schritte[i][0], `V1 REST ${schritte[i][0]}: edit_action = ${schritte[i][0]}`, v?.edit_action);
  }

  // V2 vorher bleibt, nachher neu
  for (let i = 0; i < schritte.length; i++) {
    const v = aufsteigend[i];
    if (!v) continue;
    const vorher = i === 0 ? '' : staende[i - 1];
    pruefe(v.content_hash === sha(vorher) && Number(v.size_bytes) === groesse(vorher),
      `V2 ${schritte[i][0]}: content_hash/size_bytes = Stand VOR der Op`, { hash: v.content_hash.slice(0, 8), soll: sha(vorher).slice(0, 8), size: v.size_bytes });
    const quelleSoll = i === schritte.length - 1 ? 'aktueller_stand' : 'naechste_version';
    pruefe(v.nachher?.content_hash === sha(staende[i]) && v.nachher?.size_bytes === groesse(staende[i]) && v.nachher?.quelle === quelleSoll,
      `V2 ${schritte[i][0]}: nachher = Stand NACH der Op (${quelleSoll})`, { nachher: v.nachher, soll: sha(staende[i]).slice(0, 8), size: groesse(staende[i]) });
  }
  const srVersion = aufsteigend[2];
  const gv = await files({ action: 'get_version', version_id: srVersion?.id });
  pruefe(gv?.success !== false && sha(gv?.version?.content ?? gv?.content ?? '#') === srVersion?.content_hash,
    'V2 get_version: content passt zum gespeicherten content_hash (Vorher-Stand)', { keys: Object.keys(gv ?? {}) });
  pruefe((gv?.version?.nachher ?? gv?.nachher)?.content_hash === sha(staende[2]), 'V2 get_version traegt nachher', gv?.version?.nachher ?? gv?.nachher);

  // V3 history
  const hist = (await files({ action: 'history', file_path: F, limit: 50 }))?.entries ?? [];
  const hSr = hist.find((h) => h.id === srVersion?.id);
  pruefe(hSr?.nachher?.content_hash === sha(staende[2]), 'V3 history: Eintrag traegt nachher', hSr ?? Object.keys(hist[0] ?? {}));

  // V4 restore
  const rs = await files({ action: 'restore', version_id: srVersion?.id, reason: 'test restore' });
  pruefe(rs?.success !== false && (await pgInhalt(F)) === staende[1], 'V4 restore der search_replace-Version -> Stand davor', rs);

  // V5 stdio
  const { filesTool } = await lade(repo, 'packages', 'mcp-server', 'dist', 'tools', 'consolidated', 'files.js');
  let r5;
  try { r5 = await filesTool.handler({ action: 'search_replace', project: PROJECT, agent_id: AGENT, file_path: F, search: 'vier', replace: 'VIER-stdio', reason: 'test stdio' }); } catch (e) { r5 = { fehler: e.message }; }
  const nachStdio = await pgInhalt(F);
  const v5 = (await files({ action: 'versions', file_path: F, limit: 1 }))?.versions?.[0];
  pruefe(/VIER-stdio/.test(nachStdio ?? '') && v5?.edit_action === 'search_replace', 'V5 stdio search_replace: edit_action search_replace', { r5, edit_action: v5?.edit_action });
  pruefe(v5?.nachher?.content_hash === sha(nachStdio ?? '') && v5?.nachher?.quelle === 'aktueller_stand', 'V5 stdio: nachher = aktueller Stand', v5?.nachher);
} finally {
  await app.close();
  await aufraeumen();
  rmSync(wurzel, { recursive: true, force: true });
}

console.log(fehler === 0 ? 'ALLE ZUSAGEN ERFUELLT' : `${fehler} FEHLER`);
await pool.end().catch(() => {});
process.exit(fehler === 0 ? 0 : 1);
