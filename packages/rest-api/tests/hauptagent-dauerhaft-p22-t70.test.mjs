/**
 * P22-T70 (nur synapse_test:5433, eigenes privates Schema, Fake-Daemon + Fake-Katalog, kein Netz/Docker):
 *  A Artefakte auf dem dauerhaften Weg: der Main ruft artefakt mit Session 'identitaet-<id>' (MCP ohne Session-Header);
 *    der Aufruf erreicht waehrend des Turns den Chat-Strom der echten Session und landet im Verlauf. Ohne Turn: PG-Zeile an
 *    der zuletzt benutzten Session, kein Strom; ohne Session: session_unbekannt.
 *  B Modell: User-Wahl (startrezept.modell_je_runtime claude-haiku-5-5) schlaegt das Profil-Modell (modell_bestaetigt sonnet);
 *    ohne User-Wahl bleibt das Profil-Modell.
 *  C Kontext je Zug: Wrapper-Kontextstand (tokens.kontext) -> Verlauf kontext gemessen; ohne Messung auf dem dauerhaften Weg
 *    kein Kontext ('nicht gemessen' statt 0 %); Altweg unveraendert (input + cache + output).
 *   node packages/rest-api/tests/hauptagent-dauerhaft-p22-t70.test.mjs
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { baueUmgebung, load } from './helfer-hauptagent-modelle.mjs';

const U = await baueUmgebung('p22_t70');
const { C, pool, main, HP, check, section, schalterCli, startrezept } = U;
const MAIN = main.identity_id;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ergebnis = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

for (const file of ['agent-verbrauch-schema', 'agent-zustellungen-schema']) {
  const mod = await load('packages/core/dist/db/' + file + '.js');
  const sql = Object.values(mod).find((v) => typeof v === 'string');
  await pool.query(sql); await pool.query(sql);
}
await pool.query(C.HAUPTAGENT_VERLAUF_SCHEMA_SQL);
// Isolation wie im Produktivschema: rev zaehlt mit EINER Sequenz (die Tabellenkopie bekam sonst die private Ersatz-Sequenz).
await pool.query("ALTER TABLE hauptagent_verlauf ALTER COLUMN rev SET DEFAULT nextval('hauptagent_verlauf_rev')");

const DM = await load('packages/rest-api/dist/services/agent-runtime/dauerhafter-main.js');
const AT = await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
const AS = await load('packages/rest-api/dist/services/agent-runtime/artifact-stream.js');

// Runtime-Instanzen + frischer Container-Daemon (Lebenszeichen = auth_tokens.last_used_at), Claude ist Main-Runtime.
for (const [rt, m] of [['claude', true], ['codex', false]]) {
  await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES($1,$1,'main','/mnt/z/x','img','synapse-runtime-'||$1,$2) ON CONFLICT DO NOTHING", [rt, m]);
}
const h = createHash('sha256').update('claude-p22-t70-' + process.pid).digest('hex');
await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,last_used_at) VALUES($1,'service','runtime-daemon:claude',NOW())", [h]);
await pool.query('INSERT INTO daemon_restore_host_bindings(token_hash,hostname) VALUES($1,$2) ON CONFLICT DO NOTHING', [h, 'synapse-runtime-claude']);

const wrapper = async (status) => {
  await pool.query('DELETE FROM agent_identitaet_wrapper_status WHERE identity_id=$1', [MAIN]);
  if (status) await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled) VALUES($1,$2,'hauptagent',$3,false,NOW(),false)", [MAIN, HP, status]);
};
const neueSession = async () => {
  const id = randomUUID();
  await pool.query("INSERT INTO agent_runtime_sessions(id,agent_role,runtime,status,identity_id) VALUES($1,'main','claude','running',$2)", [id, MAIN]);
  return id;
};
/** Fake-Container-Daemon: claimt Jobs der Claude-Runtime und beantwortet sie mit handler(job). */
function fakeDaemon(handler) {
  let aus = false;
  const lauf = (async () => {
    while (!aus) {
      const job = await C.claimPendingSpecialistJob(HP, 'daemon-synapse-runtime-claude-t70', undefined, 'claude').catch(() => null);
      if (job) await C.completeSpecialistJob(job.id, await handler(job)); else await pause(30);
    }
  })();
  return { stop: async () => { aus = true; await lauf; } };
}
/** Ein Chat-Turn wie die messages-Route: Verlauf + Artefakt-Strom der Session, dann dauerhafterMainTurn. */
async function chatTurn(sessionId, text, modell = 'claude-haiku-5-5') {
  const session = { id: sessionId, runtime: 'claude', identityId: MAIN, runtimeSessionId: null, context: null };
  const turn = await C.legeVerlaufTurnAn({ identity_id: MAIN, text, session_id: sessionId, runtime: 'claude', modell, lauf_id: 'altweg:' + sessionId });
  const verlauf = turn.gespeichert ? C.starteVerlaufAntwort(turn.antwort_id, { drossel_ms: 20, modell, identity_id: MAIN, user_id: turn.user_id, user_text: text, runtime: 'claude', lauf_id: 'altweg:' + sessionId }) : null;
  const sse = [];
  AS.registerArtifactStream(sessionId, (item) => { verlauf?.ereignis(item.event, item.data); sse.push(item); });
  let result = null;
  let fehler = null;
  try {
    result = await DM.dauerhafterMainTurn('claude', session, text, 'sonnet', (item) => { verlauf?.ereignis(item.event, item.data); sse.push(item); });
    await verlauf?.abschliessen('fertig', { laufkontext: result?.context });
  } catch (e) {
    fehler = e;
    await verlauf?.abschliessen('fehler', { fehler: e.message });
  } finally {
    AS.unregisterArtifactStream(sessionId);
  }
  const zeile = turn.gespeichert ? (await pool.query('SELECT artefakte, kontext, tokens, hauptagent_weg FROM hauptagent_verlauf WHERE id=$1::bigint', [turn.antwort_id])).rows[0] : null;
  return { sse, result, fehler, zeile, turn };
}

await schalterCli(true);

await section('A0 Abbildung identitaet-<id>', async () => {
  check(AS.identitaetAusSessionId('identitaet-' + MAIN) === MAIN && AS.identitaetAusSessionId(randomUUID()) === null, 'identitaet-<id> erkannt, echte Session-ID nicht');
  AS.merkeMainTurnSession(MAIN, 's-a');
  AS.merkeMainTurnSession(MAIN, 's-b');
  AS.vergissMainTurnSession(MAIN, 's-a');
  check(AS.aktiveMainTurnSession(MAIN) === 's-b', 'Ende eines alten Turns loescht die neuere Zuordnung nicht');
  AS.vergissMainTurnSession(MAIN, 's-b');
  check(AS.aktiveMainTurnSession(MAIN) === null, 'nach dem Turn keine Zuordnung');
  check(await AT.loeseArtefaktSession('identitaet-' + MAIN) === null, 'ohne Turn und ohne Session -> null');
  const r = await AT.zeigeArtefakt({ action: 'zeigen', session_id: 'identitaet-' + MAIN, html: '<p>x</p>' });
  check(r.success === false && r.error === 'session_unbekannt', 'ohne Session: session_unbekannt', r);
});

let S1;
await section('A Artefakt im Turn -> Chat-Strom + Verlauf (dauerhafter Weg)', async () => {
  S1 = await neueSession();
  const S0 = await neueSession();
  await pool.query("UPDATE agent_runtime_sessions SET updated_at = NOW() - interval '1 hour' WHERE id=$1", [S0]);
  await wrapper('running');
  let tool = null;
  const d = fakeDaemon(async (job) => {
    if (job.action !== 'wake') return { status: 'failed', error: 'unerwartet' };
    // Session 'identitaet-<id>' wie aus mcp.ts (mainToolAccess ohne Header); den MCP-Weg selbst prueft artefakt-mcp-dauerhaft-p22-t138.
    tool = await AT.zeigeArtefakt({ action: 'zeigen', session_id: 'identitaet-' + MAIN, html: '<p>Artefakt P22-T70</p>', titel: 'Probe' }, 'hauptagent');
    return { status: 'done', result: ergebnis({ success: true, response: 'Hier ist das Artefakt.', tokens: { input: 3, output: 40, kontext: 120000 } }) };
  });
  const t = await chatTurn(S1, 'Zeig mir ein Artefakt');
  await d.stop();
  check(!t.fehler, 'Turn ohne Fehler', t.fehler?.message);
  check(tool?.success === true && tool.stream_zugestellt === true, 'artefakt mit identitaet-Session: success + stream_zugestellt', tool);
  const art = t.sse.find((e) => e.event === 'artifact');
  check(art?.data?.id === tool?.artefakt_id && art.data.html === '<p>Artefakt P22-T70</p>' && art.data.title === 'Probe', 'SSE artifact im Chat-Strom der echten Session', art);
  const pg = (await pool.query('SELECT session_id::text AS s FROM agent_artifacts WHERE id=$1', [tool?.artefakt_id])).rows[0];
  check(pg?.s === S1, 'PG-Zeile an der Turn-Session (nicht der zuletzt benutzten aelteren)', pg);
  const a = t.zeile?.artefakte ?? [];
  check(a.length === 1 && a[0].id === tool?.artefakt_id && a[0].revision === tool?.revision, 'Artefakt im Verlauf der Antwort (gleiche id/revision)', a);
  check(t.zeile?.hauptagent_weg === 'dauerhaft', 'Antwort auf dem dauerhaften Weg', t.zeile?.hauptagent_weg);
  check(AS.aktiveMainTurnSession(MAIN) === null, 'Zuordnung nach dem Turn entfernt');
  // C: Kontextstand des Wrappers -> gemessen
  check(t.zeile?.kontext?.tokens === 120000 && t.zeile.kontext.quelle === 'gemessen' && t.zeile.kontext.prozent > 0, 'C: Kontext aus Wrapper-Kontextstand (120k, gemessen, > 0 %)', t.zeile?.kontext);
  check(t.zeile?.tokens?.gemessen?.kontext === 120000, 'C: gemessen.kontext gespeichert', t.zeile?.tokens);
});

await section('A2 artefakt ausserhalb eines Turns', async () => {
  const S2 = await neueSession();
  const r = await AT.zeigeArtefakt({ action: 'zeigen', session_id: 'identitaet-' + MAIN, html: '<p>spaet</p>' }, 'hauptagent');
  const pg = (await pool.query('SELECT session_id::text AS s FROM agent_artifacts WHERE id=$1', [r.artefakt_id])).rows[0];
  check(r.success === true && r.stream_zugestellt === false && pg?.s === S2, 'ohne Turn: PG-Zeile an der zuletzt benutzten Session, kein Strom', { r, pg });
  const echt = await AT.zeigeArtefakt({ action: 'zeigen', session_id: S1, html: '<p>altweg</p>' });
  const pe = (await pool.query('SELECT session_id::text AS s FROM agent_artifacts WHERE id=$1', [echt.artefakt_id])).rows[0];
  check(echt.success === true && pe?.s === S1, 'echte Session-ID (Altweg) unveraendert', pe);
});
// Livebild rendert ueber den ki-browser (fetch); im Test gesperrt und erwartet uebersprungen, kein echter Netzaufruf.
U.net.n = 0;

await section('C2 ohne Wrapper-Kontextstand: nicht gemessen statt 0 %', async () => {
  const S3 = await neueSession();
  await wrapper('running');
  const d = fakeDaemon(async () => ({ status: 'done', result: ergebnis({ success: true, response: 'ok', tokens: { input: 3, output: 40 } }) }));
  const t = await chatTurn(S3, 'Ohne Messung');
  await d.stop();
  check(!t.fehler && t.zeile?.tokens?.gemessen?.input === 3, 'Zug mit CLI-usage', t.fehler?.message ?? t.zeile?.tokens);
  check(t.zeile?.kontext === null, 'dauerhafter Weg ohne Kontextstand -> kein Kontext (Anzeige: nicht gemessen)', t.zeile?.kontext);
  const st = C.neuerAntwortStand();
  C.wendeStromEreignisAn(st, 'usage', { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 });
  const alt = await C.kontextAusGemessen('opus', st.gemessen);
  check(alt?.tokens === 135 && alt.quelle === 'gemessen', 'Altweg unveraendert: input + cache + output', alt);
  check(await C.kontextAusGemessen('opus', st.gemessen, { dauerhaft: true }) === null, 'dauerhaft ohne kontext -> null');
  C.wendeStromEreignisAn(st, 'usage', { inputTokens: 3, outputTokens: 5, kontextTokens: 50000 });
  check((await C.kontextAusGemessen('opus', st.gemessen, { dauerhaft: true }))?.tokens === 50000, 'kontextTokens geht vor der usage-Summe');
});

await section('C3 sendeMainTurn reicht tokens.kontext durch', async () => {
  await wrapper('running');
  const opt = { antwort: 'fertig', beschaeftigt: 'inbox', ohne_daemon: 'altweg', turn_warte_ms: 10_000 };
  let mit = true;
  const d = fakeDaemon(async () => ({ status: 'done', result: ergebnis({ success: true, response: 'x', tokens: mit ? { input: 1, output: 2, kontext: 7777 } : { input: 1, output: 2 } }) }));
  const r1 = await C.sendeMainTurn({ identity_id: MAIN, runtime: 'claude', nachricht: 'a', optionen: opt });
  mit = false;
  const r2 = await C.sendeMainTurn({ identity_id: MAIN, runtime: 'claude', nachricht: 'b', optionen: opt });
  await d.stop();
  check(r1.usage?.kontextTokens === 7777 && r1.usage.inputTokens === 1, 'mit Kontextstand: usage.kontextTokens', r1.usage);
  check(r2.usage && !('kontextTokens' in r2.usage), 'ohne Kontextstand: kein kontextTokens', r2.usage);
});

await section('B User-Wahl haiku schlaegt Profil-Modell sonnet', async () => {
  await startrezept({ modell_je_runtime: { claude: 'claude-haiku-5-5' } });
  await pool.query("UPDATE agent_identitaeten SET modell_bestaetigt='sonnet' WHERE id=$1", [MAIN]);
  const spawns = [];
  const d = fakeDaemon(async (job) => {
    if (job.action === 'spawn') { spawns.push(job.args); await wrapper('running'); return { status: 'done', result: ergebnis({ success: true }) }; }
    return { status: 'done', result: ergebnis({ success: true, response: 'ok', tokens: { input: 1, output: 1 } }) };
  });
  await wrapper(null);
  const t1 = await chatTurn(await neueSession(), 'Start mit User-Wahl');
  check(!t1.fehler && spawns.length === 1 && spawns[0].model === 'claude-haiku-5-5', 'Spawn mit User-Wahl claude-haiku-5-5 statt Profil sonnet', { f: t1.fehler?.message, spawns });
  await startrezept({ modell_je_runtime: {} });
  await wrapper(null);
  const t2 = await chatTurn(await neueSession(), 'Start ohne User-Wahl');
  await d.stop();
  check(!t2.fehler && spawns.length === 2 && /sonnet/.test(spawns[1].model), 'ohne User-Wahl: Profil-Modell (sonnet)', { f: t2.fehler?.message, m: spawns[1]?.model });
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE target_identity_id=$1 AND status IN ('pending','running')", [MAIN]);
  await wrapper(null);
  const ohne = await C.stelleMainLaufSicher({ identity_id: MAIN, runtime: 'claude', modell: 'claude-haiku-5-5', warte_ms: 0 });
  const args = (await pool.query('SELECT args FROM specialist_jobs WHERE id=$1', [ohne.spawn_job_id])).rows[0]?.args;
  check(/sonnet/.test(args?.model ?? ''), 'stelleMainLaufSicher ohne modell_explizit: Profil-Modell geht weiter vor (unveraendert)', args?.model);
});

await U.ende('P22-T70');
