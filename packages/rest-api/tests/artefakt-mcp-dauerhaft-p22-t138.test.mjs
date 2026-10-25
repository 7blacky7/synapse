/**
 * P22-T138 (nur synapse_test:5433, eigenes privates Schema, kein Netz/Docker): artefakt ueber den ECHTEN MCP-Weg
 * (POST / und /mcp/messages -> mainToolAccess -> fuehreToolsCallAus -> zeigeArtefakt).
 *  A Dauerhafter Main: Profil main-synapse mit Identitaets-Bearer + Ausweis, OHNE Session-Header, waehrend eines Turns
 *    -> success + stream_zugestellt, SSE artifact im Strom der Turn-Session, Artefakt im Verlauf der Antwort.
 *  B Regression Altweg: artefakt-only mit Header X-Synapse-Hauptagent-Session -> weiterhin ok (PG-Zeile an dieser Session).
 *  C Negativproben: ohne main-synapse mit session_id in args -> kein_hauptagent_kontext (auch 'identitaet-<id>');
 *    falscher Ausweis -> abgelehnt, kein Artefakt.
 *   node packages/rest-api/tests/artefakt-mcp-dauerhaft-p22-t138.test.mjs
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { baueUmgebung, load, repo } from './helfer-hauptagent-modelle.mjs';

const U = await baueUmgebung('p22_t138');
const { C, pool, main, check, section } = U;
const MAIN = main.identity_id;
const AUSWEIS = main.token;

await pool.query(C.HAUPTAGENT_VERLAUF_SCHEMA_SQL);
await pool.query("ALTER TABLE hauptagent_verlauf ALTER COLUMN rev SET DEFAULT nextval('hauptagent_verlauf_rev')");

const AS = await load('packages/rest-api/dist/services/agent-runtime/artifact-stream.js');
const M = await load('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
const { mcpRoutes } = await load('packages/rest-api/dist/routes/mcp.js');
const Fastify = createRequire(join(repo, 'packages/rest-api/package.json'))('fastify');
const app = Fastify({ logger: false });
await app.register(mcpRoutes);
await app.ready();

await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES('claude','claude','main','/mnt/z/x','img','synapse-runtime-claude',true) ON CONFLICT DO NOTHING");
// Identitaets-Bearer des dauerhaften Main (wie runtime-daemon/Spawn ihn ausstellt): service-Token mit Scope hauptagent-identitaet.
const BEARER = 'p22-t138-' + randomUUID();
await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'service',$2,NOW()+interval '1 hour')",
  [createHash('sha256').update(BEARER).digest('hex'), M.hauptagentIdentitaetScope(MAIN)]);
const DAUERHAFT = { authorization: 'Bearer ' + BEARER, [M.MAIN_PROFILE_HEADER]: 'main-synapse', 'x-synapse-agent-token': AUSWEIS };

const neueSession = async () => {
  const id = randomUUID();
  await pool.query("INSERT INTO agent_runtime_sessions(id,agent_role,runtime,status,identity_id) VALUES($1,'main','claude','running',$2)", [id, MAIN]);
  return id;
};
let rpcId = 0;
/** tools/call ueber die echte Route; Antwort = Fachobjekt (structuredContent bzw. Text). */
async function rufe(args, headers = {}, url = '/') {
  const r = await app.inject({ method: 'POST', url, headers,
    payload: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'artefakt', arguments: args } } });
  const res = r.json().result ?? r.json();
  if (res?.structuredContent) return res.structuredContent;
  try { return JSON.parse(res?.content?.[0]?.text ?? 'null'); } catch { return res; }
}
/** Turn wie die messages-Route + dauerhafterMainTurn: Verlauf, Artefakt-Strom der Session, Turn-Zuordnung der Identitaet. */
async function imTurn(sessionId, fn) {
  const turn = await C.legeVerlaufTurnAn({ identity_id: MAIN, text: 'Zeig ein Artefakt', session_id: sessionId, runtime: 'claude', modell: 'claude-haiku-5-5', lauf_id: 'altweg:' + sessionId });
  const verlauf = turn.gespeichert ? C.starteVerlaufAntwort(turn.antwort_id, { drossel_ms: 20, modell: 'claude-haiku-5-5', identity_id: MAIN, user_id: turn.user_id, user_text: 'Zeig ein Artefakt', runtime: 'claude', lauf_id: 'altweg:' + sessionId }) : null;
  const sse = [];
  AS.registerArtifactStream(sessionId, (item) => { verlauf?.ereignis(item.event, item.data); sse.push(item); });
  AS.merkeMainTurnSession(MAIN, sessionId);
  let r;
  try {
    r = await fn();
  } finally {
    AS.vergissMainTurnSession(MAIN, sessionId);
    AS.unregisterArtifactStream(sessionId);
  }
  await verlauf?.abschliessen('fertig', { laufkontext: { hauptagent_weg: 'dauerhaft' } });
  const zeile = turn.gespeichert ? (await pool.query('SELECT artefakte FROM hauptagent_verlauf WHERE id=$1::bigint', [turn.antwort_id])).rows[0] : null;
  return { r, sse, zeile, turn };
}
const pgSession = async (id) => (await pool.query('SELECT session_id::text AS s FROM agent_artifacts WHERE id=$1', [id])).rows[0]?.s ?? null;
const anzahl = async () => (await pool.query('SELECT count(*)::int AS n FROM agent_artifacts')).rows[0].n;

await section('A0 Zugang des dauerhaften Main', async () => {
  const a = await M.mainToolAccess(DAUERHAFT);
  check(a.profile === 'main-synapse' && !a.error && a.sessionId === 'identitaet-' + MAIN && a.identityId === MAIN, 'mainToolAccess: main-synapse, identitaet-<id>', a);
});

await section('A dauerhafter Main ohne Session-Header im Turn -> success + stream_zugestellt + Verlauf', async () => {
  for (const url of ['/', '/mcp/messages']) {
    const S0 = await neueSession();
    const S = await neueSession();
    await pool.query("UPDATE agent_runtime_sessions SET updated_at = NOW() + interval '1 hour' WHERE id=$1", [S0]);
    // session_id in args wird ueberschrieben (keine Behauptung von aussen).
    const t = await imTurn(S, () => rufe({ action: 'zeigen', html: '<p>T138 ' + url + '</p>', titel: 'Probe', session_id: S0 }, DAUERHAFT, url));
    check(t.r?.success === true && t.r.stream_zugestellt === true, url + ': success + stream_zugestellt', t.r);
    const art = t.sse.find((e) => e.event === 'artifact');
    check(art?.data?.id === t.r?.artefakt_id && art.data.html === '<p>T138 ' + url + '</p>' && art.data.title === 'Probe', url + ': SSE artifact im Strom der Turn-Session', art);
    check(await pgSession(t.r?.artefakt_id) === S, url + ': PG-Zeile an der Turn-Session, nicht an der behaupteten', await pgSession(t.r?.artefakt_id));
    const a = t.zeile?.artefakte ?? [];
    check(a.length === 1 && a[0].id === t.r?.artefakt_id, url + ': Artefakt im Verlauf der Antwort', a);
  }
});

await section('A2 dauerhafter Main ausserhalb eines Turns -> PG an der zuletzt benutzten Session, kein Strom', async () => {
  const S = await neueSession();
  await pool.query("UPDATE agent_runtime_sessions SET updated_at = NOW() + interval '2 hours' WHERE id=$1", [S]);
  const r = await rufe({ action: 'zeigen', html: '<p>spaet</p>' }, DAUERHAFT);
  check(r?.success === true && r.stream_zugestellt === false && await pgSession(r.artefakt_id) === S, 'ohne Turn: success, kein Strom, PG an letzter Session', r);
});

await section('B Regression Altweg: artefakt-only mit Header', async () => {
  const S = await neueSession();
  const sse = [];
  AS.registerArtifactStream(S, (item) => sse.push(item));
  let r;
  try {
    r = await rufe({ action: 'zeigen', html: '<p>altweg</p>', session_id: randomUUID() }, { 'x-synapse-hauptagent-session': S });
  } finally {
    AS.unregisterArtifactStream(S);
  }
  check(r?.success === true && r.stream_zugestellt === true && await pgSession(r.artefakt_id) === S, 'Altweg: success, Strom, PG an der Header-Session', r);
  check(sse.some((e) => e.event === 'artifact' && e.data.id === r?.artefakt_id), 'Altweg: SSE artifact');
  const anderes = await rufe({ action: 'zeigen', html: '<p>x</p>' }, { 'x-synapse-hauptagent-session': S }).catch((e) => e);
  check(anderes?.success === true, 'Altweg ohne offenen Strom weiter ok', anderes);
});

await section('C Negativproben', async () => {
  const S = await neueSession();
  const vor = await anzahl();
  const r1 = await rufe({ action: 'zeigen', html: '<p>n1</p>', session_id: S });
  check(r1?.success === false && r1.error === 'kein_hauptagent_kontext', 'ohne main-synapse, session_id in args -> kein_hauptagent_kontext', r1);
  const r2 = await imTurn(S, () => rufe({ action: 'zeigen', html: '<p>n2</p>', session_id: 'identitaet-' + MAIN }));
  check(r2.r?.success === false && r2.r.error === 'kein_hauptagent_kontext' && r2.sse.length === 0, 'ohne main-synapse, identitaet-<id> in args (sogar im Turn) -> kein_hauptagent_kontext', r2.r);
  const r3 = await rufe({ action: 'zeigen', html: '<p>n3</p>', session_id: S }, { ...DAUERHAFT, 'x-synapse-agent-token': 'sai_falsch' + randomUUID().slice(0, 8) });
  check(r3?.success === false, 'main-synapse mit falschem Ausweis -> abgelehnt', r3);
  const r4 = await rufe({ action: 'zeigen', html: '<p>n4</p>', session_id: S }, { ...DAUERHAFT, authorization: 'Bearer falsch' });
  check(r4?.success === false, 'main-synapse ohne gueltigen Identitaets-Bearer -> abgelehnt', r4);
  check(await anzahl() === vor, 'keine Artefakt-Zeile aus den Negativproben');
});

// Livebild rendert ueber den ki-browser (fetch); im Test gesperrt und erwartet uebersprungen, kein echter Netzaufruf.
U.net.n = 0;
await app.close();
await U.ende('P22-T138');
