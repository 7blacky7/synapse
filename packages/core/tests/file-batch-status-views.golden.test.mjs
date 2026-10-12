/**
 * Golden-Regressionsvertrag fuer plan_status/shared_plan_status ueber REST und stdio.
 * Vor Feature-Aenderung: STATUS_VIEWS_CAPTURE=1 erzeugt die normalisierten SHA-256-Baselines.
 * Danach bleiben Aufrufe ohne ansicht byte-identisch; bei jedem Szenario muessen beide Transporte
 * eigene ALT-Baseline gehasht. Nur Testprojekt status-views-golden.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';


const hier = dirname(fileURLToPath(import.meta.url));
const coreDist = join(hier, '..', 'dist');
const batch = await import(join(coreDist, 'services', 'file-batch.js'));
const reservations = await import(join(coreDist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(coreDist, 'db', 'client.js'));
const { filesTool } = await import(join(hier, '..', '..', 'mcp-server', 'dist', 'tools', 'consolidated', 'files.js'));
const repo = join(hier, '..', '..', '..');
const requireRest = createRequire(join(repo, 'packages', 'rest-api', 'package.json'));
const Fastify = requireRest('fastify');
const { mcpRoutes } = await import(join(hier, '..', '..', 'rest-api', 'dist', 'routes', 'mcp.js'));
const restServer = Fastify({ logger: false });
await restServer.register(mcpRoutes);
await restServer.ready();
const pool = getPool();
const PROJECT = 'status-views-golden';
const AGENT = 'luna-2';
const GOLDEN = {
  'plan-klein-rest': 'aadbc3d8f49e0c068a3cdfc6152fe14931eee29ac98799a395ca9fa766926f5e',
  'plan-klein-stdio': '7200d4c78cd459f6be14e51f430131890789ac01d6eab88352402e1efd8353bb',
  'op-index-rest': '0d99c610ba3a6cdcdb8b6d215a708831484f3f6bc76506deb358c994e00be1bc',
  'op-index-stdio': '0d99c610ba3a6cdcdb8b6d215a708831484f3f6bc76506deb358c994e00be1bc',
  'plan-befund-rest': '60a22fca0c198fb6f4add2f6bca7305036100207b598968b47233b927be949c8',
  'plan-befund-stdio': 'fad5fc3f8ea8bcfeeae10b505b96820ec8d8d8f051bb4b91bee847a7be7433be',
  'plan-coedit-rest': '665ebb83ea73bd7705453866778314c3e99a39983fb8c81f0f34536edfd40c1b',
  'plan-coedit-stdio': '59d25232cfdb716c50b41a8f56b524d81da04fa51771bd0e547c51aebd7053d4',
  'shared-status-rest': '13b43ceb05f440c16ee1f5a02c92e4661b94015db9cefe8567e3718d1d5089b5',
  'shared-status-stdio': 'b06c099b46eb707e8be92ffdfbb77050e548432912096ef0035ba928a79d9ab8',
};

function pruefe(bedingung, text, detail) {
  if (!bedingung) throw new Error(`${text}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}
async function aufraeumen() {
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)', [PROJECT]);
  for (const tabelle of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) {
    await pool.query(`DELETE FROM ${tabelle} WHERE project = $1`, [PROJECT]);
  }
}
async function dateiAnlegen(path, content, agent = 'gold-setup') {
  const plan = await batch.planBatch({ project: PROJECT, agent_id: agent, ops: [{ file_path: path, action: 'create', content }] });
  const commit = await batch.commitBatch({ plan_id: plan.plan_id, agent_id: agent });
  pruefe(commit.success === true, 'Fixture-Datei angelegt', commit);
}
async function routeCall(args) {
  const response = await restServer.inject({ method: 'POST', url: '/', payload: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'files', arguments: args },
  } });
  const body = response.json();
  const text = body?.result?.content?.find((block) => block.type === 'text')?.text;
  return typeof text === 'string' ? JSON.parse(text) : body?.result?.structuredContent ?? body?.result ?? body;
}
async function beide(args, key, planId) {
  const input = { project: PROJECT, agent_id: AGENT, ...args };
  const stdio = await filesTool.handler(input);
  const rest = await routeCall(input);
  const normalisiere = (antwort) => JSON.stringify(antwort, (name, value) => {
    if (['created_at', 'committed_at', 'geprueft_am', 'expires_at', 'ready_at', 'createdAt', 'updatedAt', 'expiresAt', 'readyAt'].includes(name)) return '<ZEIT>'; 
    if (name === 'dauer_ms' || name === 'ms') return '<MS>';
    if (name === 'alter') return '<ALTER>';
    if (name === 'waited_seconds') return '<SEK>';
    if (name === 'wait_token') return '<WAIT_TOKEN>';
    if (['plan_id', 'primary_plan_id', 'source_plan_id', 'target_plan_id'].includes(name)) return '<PLAN_ID>'; 
    if (typeof value !== 'string') return value;
    return value
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ZEIT>')
      .replaceAll(String(planId ?? ''), '<PLAN_ID>');
  });
  // Der generische REST-Wrapper haengt Laufzeit-Anhaenge an (offene Plaene, Shell-Aktivitaet,
  // Events, Skill-Hinweise). Sie stammen nicht aus plan_status und wechseln von Lauf zu Lauf.
  const WRAPPER_ANHAENGE = ['open_plans', 'shell_activity', 'pending_events', 'skill_suggestions',
    'skill_hook_metrics', 'jev_modus', 'hinweis_agent_id', 'agentOnboarding', 'erklaerung_faelle'];
  const restKern = Object.fromEntries(Object.entries(rest ?? {}).filter(([k]) => !WRAPPER_ANHAENGE.includes(k)));
  const restNormalisiert = normalisiere(restKern);
  const stdioNormalisiert = normalisiere(stdio);
  const stdioSha = createHash('sha256').update(stdioNormalisiert).digest('hex');
  console.log(`GOLDEN ${key} STDIO ${stdioSha}`);
  // REST ohne Wrapper-Anhaenge liefert dieselbe plan_status-Antwort wie stdio.
  assert.equal(restNormalisiert, stdioNormalisiert, `${key}: REST-Kern gleich stdio`);
  // stdio-Hashes wurden am Stand VOR P6-T22 (28cee10) erfasst und sind dort wie hier gleich.
  if (process.env.STATUS_VIEWS_CAPTURE !== '1' && Object.hasOwn(GOLDEN, `${key}-stdio`)) {
    assert.equal(stdioSha, GOLDEN[`${key}-stdio`], `${key}: stdio-Ausgabe unveraendert`);
  }
  return rest;
}

try {
  await aufraeumen();

  // Kleiner Plan.
  await dateiAnlegen('src/small.ts', 'export const value = 1;\n');
  const small = await batch.planBatch({ project: PROJECT, agent_id: 'gold-owner', reason: 'kleine Aenderung', ops: [
    { file_path: 'src/small.ts', action: 'search_replace', search: 'value = 1', replace: 'value = 2', reason: 'Wert anpassen' },
  ] });
  await beide({ action: 'plan_status', plan_id: small.plan_id }, 'plan-klein', small.plan_id);
  await beide({ action: 'plan_status', plan_id: small.plan_id, op_index: 0 }, 'op-index', small.plan_id);

  // Gespeicherter Befund an einer Op.
  await dateiAnlegen('src/finding.ts', 'export const finding = 1;\\n');
  const befundePlan = await batch.planBatch({ project: PROJECT, agent_id: 'gold-find', ops: [
    { file_path: 'src/finding.ts', action: 'search_replace', search: 'finding = 1', replace: 'finding = 3' },
  ] });
  await pool.query('UPDATE file_batch_plans SET befunde = $2::jsonb WHERE id = $1::bigint', [befundePlan.plan_id, JSON.stringify({
    status: 'fertig', dauer_ms: 0, befunde: [{ id: 'gold-befund', pruefer: 'golden', datei: 'src/finding.ts', op_index: 0,
      agent_id: 'gold-find', severity: 'warning', code: 'gold-warning', message: 'Golden-Befund', status: 'offen', ergebnis_hash: 'gold-hash' }],
    altlasten: 0, ergebnis_hashes: {}, geprueft_am: '2026-01-01T00:00:00.000Z',
  })]);
  await beide({ action: 'plan_status', plan_id: befundePlan.plan_id }, 'plan-befund', befundePlan.plan_id);

  // .env.example-Befund: auch reason und zitierter Wert muessen maskiert bleiben.
  await dateiAnlegen('.env.example', 'API_TOKEN=\n');
  const envInhalt = 'API_TOKEN=golden-secret-value\nNOTE=old\n';
  const envHash = createHash('sha256').update(envInhalt).digest('hex');
  const envDatei = await pool.query(
    'UPDATE code_files SET content = $3, content_hash = $4, file_size = $5 WHERE project = $1 AND file_path = $2',
    [PROJECT, '.env.example', envInhalt, envHash, Buffer.byteLength(envInhalt, 'utf8')],
  );
  pruefe(envDatei.rowCount === 1, 'Klartext-Fixture in Test-DB gesetzt', envDatei.rowCount);
  const envPlan = await batch.planBatch({ project: PROJECT, agent_id: 'gold-env', reason: 'Wert golden-secret-value pruefen', ops: [
    { file_path: '.env.example', action: 'search_replace', search: 'API_TOKEN=[WERT]', replace: 'API_TOKEN=[WERT]\nNOTE=new', reason: 'Op prueft golden-secret-value' },
  ] });
  await pool.query('UPDATE file_batch_plans SET befunde = $2::jsonb WHERE id = $1::bigint', [envPlan.plan_id, JSON.stringify({
    status: 'fertig', dauer_ms: 0, befunde: [{ id: 'env-secret-finding', pruefer: 'golden', datei: '.env.example', op_index: 0,
      agent_id: 'gold-env', severity: 'warning', code: 'env-secret', message: 'gefunden: golden-secret-value', status: 'offen', ergebnis_hash: 'env-hash' }],
    altlasten: 0, ergebnis_hashes: {}, geprueft_am: '2026-01-01T00:00:00.000Z',
  })]);
  if (process.env.STATUS_VIEWS_BASELINE !== '1') {
    const envKompakt = await beide({ action: 'plan_status', plan_id: envPlan.plan_id, ansicht: 'befunde' }, 'env-compact', envPlan.plan_id);
    const envText = JSON.stringify(envKompakt);
    pruefe(!envText.includes('golden-secret-value'), 'Kompaktansicht verbirgt .env.example-Wert');
    pruefe(envText.includes('[WERT]'), 'Kompaktansicht markiert maskierten .env.example-Wert');
  }

  // Gemeinsamer Plan mit Co-Edit-Wait und shared_plan_status.
  await dateiAnlegen('src/shared.ts', 'export const shared = 1;\n');
  await reservations.addFileReservations({ project: PROJECT, agentId: 'gold-owner', filePaths: ['src/shared.ts'] });
  const owner = await batch.planBatch({ project: PROJECT, agent_id: 'gold-owner', ops: [
    { file_path: 'src/shared.ts', action: 'search_replace', search: 'shared = 1', replace: 'shared = 2' },
  ] });
  const waiting = await batch.planBatch({ project: PROJECT, agent_id: 'gold-waiter', ops: [
    { file_path: 'src/shared.ts', action: 'search_replace', search: 'shared = 1', replace: 'shared = 3' },
  ] });
  const waitToken = waiting.coedit_waits?.[0]?.wait_token;
  pruefe(Boolean(waitToken), 'Co-Edit-Wait angelegt', waiting);
  await beide({ action: 'plan_status', plan_id: owner.plan_id }, 'plan-coedit', owner.plan_id);
  await beide({ action: 'shared_plan_status', wait_token: waitToken, agent_id: 'gold-waiter' }, 'shared-status', owner.plan_id);

  if (process.env.STATUS_VIEWS_CAPTURE !== '1') {
    for (const key of ['plan-klein', 'op-index', 'plan-befund', 'plan-coedit', 'shared-status']) {
      pruefe(Boolean(GOLDEN[`${key}-stdio`]), `stdio-ALT-Golden fuer ${key} eingetragen`);
    }
  }
  console.log('ERGEBNIS Golden-Transporte: je Transportweg gegen ALT-Baseline geprueft.');
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await aufraeumen().catch(() => null);
  await restServer.close().catch(() => null);
  const count = await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1) + (SELECT COUNT(*) FROM file_batch_waits WHERE project=$1) + (SELECT COUNT(*) FROM file_reservations WHERE project=$1) + (SELECT COUNT(*) FROM file_versions WHERE project=$1) + (SELECT COUNT(*) FROM code_files WHERE project=$1) + (SELECT COUNT(*) FROM agent_events WHERE project=$1) AS n`, [PROJECT]);
  pruefe(Number(count.rows[0]?.n) === 0, 'Golden-Testprojekt sauber', count.rows[0]?.n);
}


// REST-Router-Importe lassen im Repo neben dem Pool weitere Handles offen.
setTimeout(() => process.exit(process.exitCode ?? 0), 1000);
