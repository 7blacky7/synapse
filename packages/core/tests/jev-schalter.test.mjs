/**
 * P15-T33 E0.5 (11.10.2026): JEV-SCHALTER, GEMEINSAMER JEV-CLIENT, KOSTEN, BUDGET.
 *
 * ZUSAGEN:
 *   M  Vorrangmatrix: ohne Zeile an; global '*' aus = ueberall aus (auch gegen Projekt-an);
 *      global <f> aus nur f; Projekt '*' aus nur dieses Projekt; Projekt <f> aus nur f dort.
 *   C  Client: aus -> KEIN fetch, grund aus; an -> genau ein fetch, jev_aufrufe-Zeile mit usd = usage.cost
 *      (quelle antwort); ohne cost -> input_tokens x Listenpreis (0,042 bzw. JEV_PREIS_JE_MIO_EINGABE);
 *      HTTP-Fehler -> Zeile ok=false, usd 0. Der Key steht nie in einer Antwort.
 *   K  Kostensummen je Tag/Monat/Projekt/Funktion stimmen mit den gebuchten Aufrufen ueberein.
 *   B  Budget: ohne Grenze keine Bremse; mit Grenze Pause nach Erreichen (kein fetch, Wirkung 'budget');
 *      nebenlaeufige Aufrufe ueberschreiten die Grenze nicht um mehr als die Reservierung; Entfernen hebt auf.
 *   H  Hinweise: jev_modus / jev_hinweis / leseAbwesenheit erscheinen bei an (ANKER), verschwinden bei
 *      global bzw. Projekt aus und erscheinen nach dem Wiedereinschalten wieder.
 *   E  entscheideRueckfrage bei Jev aus: grund jev_aus, kein fetch, keine Protokollzeile.
 *   A  admin-Actions: jev_schalten nur Koordinator/User, jev_status, jev_kosten, jev_budget; Kontostand
 *      (Fake-fetch) nur Whitelist-Felder.
 *   R  REST tools/list (beide Stellen): jev da bei an, fehlt bei global aus (ANKER: admin und code_intel
 *      stehen in derselben Liste), tools/call jev -> jev_aus; admin jev_status ueber REST erreichbar.
 *   S  stdio: jevTool.handler (mcp-server dist) lehnt bei Projekt aus ab; filtereJevTool entfernt jev.
 *   O  Jev-Optionen (a5fd30ea): Standard beide Sprachen + jev_sprache en; beide aus abgelehnt; jev_sprache
 *      ausserhalb en|de|mix abgelehnt; de aus + jev_sprache de -> Rueckfall en mit Hinweis; mix braucht beide;
 *      setzen nur Koordinator/User; jev_status zeigt die Optionen.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama 127.0.0.1:9. Kein echter
 * Jev-Aufruf: jeder fetch ist ein Fake. Tabellen mit der DDL aus dem gebauten SCHEMA_SQL.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/jev-schalter.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('jev-schalter.test');
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.JEV_SCHALTER_CACHE_MS = '0';
process.env.JEV_MODUS_CACHE_S = '0';
process.env.JEV_OPENROUTER_API_KEY = 'sk-or-test-GEHEIM-jevschalter-0123';
delete process.env.JEV_API_URL;
delete process.env.JEV_PREIS_JE_MIO_EINGABE;
delete process.env.JEV_BUDGET_RESERVE_USD;

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const KEY = process.env.JEV_OPENROUTER_API_KEY;
const P = 'jevschalter-test-p';
const Q = 'jevschalter-test-q';

// ── Kindprozess: REST-Strecke ──
if (process.argv[2] === 'rest') {
  const Fastify = createRequire(join(repo, 'packages', 'rest-api', 'package.json'))('fastify');
  const { mcpRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
  const f = Fastify();
  await f.register(mcpRoutes);
  await f.ready();
  const ergebnis = {};
  for (const url of ['/mcp/messages', '/']) {
    const rpc = async (method, params) =>
      (await f.inject({ method: 'POST', url, payload: { jsonrpc: '2.0', id: 1, method, params } })).json();
    const tools = (await rpc('tools/list')).result?.tools ?? [];
    const auspacken = (a) => { try { return JSON.parse(a.result.content[0].text); } catch { return a; } };
    const jev = auspacken(await rpc('tools/call', { name: 'jev', arguments: { action: 'protokoll', project: P, agent_id: 'jevschalter-test' } }));
    const admin = auspacken(await rpc('tools/call', { name: 'admin', arguments: { action: 'jev_status', project: P, agent_id: 'jevschalter-test' } }));
    ergebnis[url] = { namen: tools.map((t) => t.name), jev, admin };
  }
  console.log('ERGEBNIS ' + JSON.stringify(ergebnis));
  process.exit(0);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
async function versuche(text, fn) {
  try { await fn(); } catch (err) { fehler++; console.error('FEHLER  ' + text + ': ' + (err instanceof Error ? err.message : String(err))); }
}

const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const schemaJs = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
const ddl = ['jev_schalter', 'jev_aufrufe', 'jev_budget_stand', 'jev_optionen', 'jev_entscheidet', 'jev_entscheidungen']
  .map((t) => schemaJs.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`))?.[0]);
const fehlend = ['jev_schalter', 'jev_aufrufe', 'jev_budget_stand', 'jev_optionen'].filter((_, i) => !ddl[i]);
pruefe(fehlend.length === 0, 'DDL jev_schalter, jev_aufrufe, jev_budget_stand, jev_optionen im gebauten SCHEMA_SQL', fehlend);
if (fehlend.length > 0) {
  console.error(`${fehler} FEHLER (Abbruch: ohne Tabellen keine weiteren Zusagen pruefbar)`);
  process.exit(1);
}
await pool.query("SET lock_timeout = '5s'");
for (const d of ddl) if (d) await pool.query(d);
for (const a of ['ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS runde INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS erste_id BIGINT',
  'ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS offen_fuer_user BOOLEAN NOT NULL DEFAULT false',
  'ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS blocker BOOLEAN NOT NULL DEFAULT false']) await pool.query(a);
const aufraeumen = async () => {
  await pool.query('DELETE FROM jev_schalter');
  await pool.query('DELETE FROM jev_budget_stand');
  await pool.query('DELETE FROM jev_optionen');
  await pool.query('DELETE FROM jev_aufrufe WHERE project = ANY($1) OR project IS NULL', [[P, Q]]);
  await pool.query('DELETE FROM jev_entscheidet WHERE project = ANY($1)', [[P, Q]]);
  await pool.query('DELETE FROM jev_entscheidungen WHERE project = ANY($1)', [[P, Q]]);
};
await aufraeumen();

const S = await lade(dist, 'services', 'jev-schalter.js');
const K = await lade(dist, 'services', 'jev-kosten.js');
const C = await lade(dist, 'services', 'jev-client.js');
const A = await lade(dist, 'services', 'jev-admin.js');
const E = await lade(dist, 'services', 'jev-entscheidung.js');
const M = await lade(dist, 'services', 'jev-modus-hinweis.js');

/** Fake-fetch: zaehlt Aufrufe, antwortet mit usage nach Vorgabe */
function fakeFetch(antwort = () => ({ status: 200, body: { answers: { a: { choice: 'x', confidence: 0.9 } }, usage: { input_tokens: 1000, output_tokens: 70, cost: 0.000042 } } }), verzoegerung = 0) {
  const f = async (url, init) => {
    f.aufrufe.push({ url, init });
    if (verzoegerung) await new Promise((r) => setTimeout(r, verzoegerung));
    const a = antwort(f.aufrufe.length);
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  };
  f.aufrufe = [];
  return f;
}
const aufruf = (funktion, project, deps) => C.rufeJev({ funktion, project, agent_id: 'jevschalter-test', state: { x: 1 }, questions: { a: { type: 'noul', instructions: 'test' } } }, deps);
const setze = (o) => S.setzeJevSchalter({ agent: 'koordinator', grund: 'test', ...o });

try {
  // ── M Vorrangmatrix ──
  await versuche('M Vorrangmatrix', async () => {
    pruefe(JSON.stringify([...S.JEV_FUNKTIONEN]) === JSON.stringify(['empfehlung', 'entscheidung', 'plan_einordnen', 'erklaerungstopf', 'entscheidungstopf', 'tool']), 'M JEV_FUNKTIONEN = 6 Funktionen (P15 E1: + entscheidungstopf)', S.JEV_FUNKTIONEN);
    const alle = async (p) => Object.fromEntries(await Promise.all(S.JEV_FUNKTIONEN.map(async (f) => [f, (await S.jevWirksam(p, f)).an])));
    let w = await alle(P);
    pruefe(Object.values(w).every((x) => x === true), 'M ohne Zeile: alles an', w);
    await setze({ ebene: 'global', funktion: 'empfehlung', aktiv: false });
    pruefe((await S.jevWirksam(P, 'empfehlung')).an === false && (await S.jevWirksam(Q, 'empfehlung')).an === false
      && (await S.jevWirksam(P, 'entscheidung')).an === true, 'M global empfehlung aus: nur empfehlung aus, ueberall');
    await setze({ ebene: 'global', funktion: 'empfehlung', aktiv: true });
    await setze({ ebene: 'projekt', project: P, funktion: 'alle', aktiv: false });
    w = await alle(P);
    const wq = await alle(Q);
    pruefe(Object.values(w).every((x) => x === false) && Object.values(wq).every((x) => x === true), 'M Projekt P aus: P alles aus, Q alles an', { w, wq });
    const wp = await S.jevWirksam(P, 'tool');
    pruefe(wp.ebene === 'projekt' && /abgeschaltet/i.test(wp.text ?? ''), 'M Wirkung nennt Ebene projekt und Text', wp);
    await setze({ ebene: 'projekt', project: P, funktion: 'alle', aktiv: true });
    await setze({ ebene: 'projekt', project: P, funktion: 'tool', aktiv: false });
    pruefe((await S.jevWirksam(P, 'tool')).an === false && (await S.jevWirksam(P, 'empfehlung')).an === true, 'M Projekt P tool aus: nur tool aus');
    await setze({ ebene: 'projekt', project: P, funktion: 'tool', aktiv: true });
    await setze({ ebene: 'global', funktion: 'alle', aktiv: false });
    w = await alle(P);
    const g = await S.jevWirksam(P, 'empfehlung');
    pruefe(Object.values(w).every((x) => x === false) && g.ebene === 'global', 'M global aus schlaegt Projekt-an (P tool explizit an)', { w, g });
    await setze({ ebene: 'global', funktion: 'alle', aktiv: true });
    w = await alle(P);
    pruefe(Object.values(w).every((x) => x === true), 'M nach Wiedereinschalten alles an', w);
    let fehlerCode = null;
    try { await setze({ ebene: 'projekt', funktion: 'tool', aktiv: false }); } catch (e) { fehlerCode = e.code; }
    pruefe(fehlerCode === 'project_fehlt', 'M Projekt-Ebene ohne project -> project_fehlt', fehlerCode);
    try { await setze({ ebene: 'global', funktion: 'quatsch', aktiv: false }); fehlerCode = null; } catch (e) { fehlerCode = e.code; }
    pruefe(fehlerCode === 'funktion_unbekannt', 'M unbekannte Funktion -> funktion_unbekannt', fehlerCode);
  });

  // ── C Client ──
  await versuche('C Client', async () => {
    await pool.query('DELETE FROM jev_aufrufe WHERE project = ANY($1)', [[P, Q]]);
    await setze({ ebene: 'projekt', project: P, funktion: 'empfehlung', aktiv: false });
    let f = fakeFetch();
    let r = await aufruf('empfehlung', P, { fetch: f });
    pruefe(r.ok === false && r.grund === 'aus' && f.aufrufe.length === 0, 'C aus: kein fetch, grund aus', { r, n: f.aufrufe.length });
    await setze({ ebene: 'projekt', project: P, funktion: 'empfehlung', aktiv: true });
    f = fakeFetch();
    r = await aufruf('empfehlung', P, { fetch: f });
    pruefe(r.ok === true && f.aufrufe.length === 1 && r.daten?.answers?.a?.choice === 'x', 'C an: genau ein fetch, Antwort durchgereicht', { ok: r.ok, n: f.aufrufe.length });
    pruefe(f.aufrufe[0]?.url === 'https://openrouter.ai/api/v1/systemone' && f.aufrufe[0]?.init?.headers?.Authorization === `Bearer ${KEY}`, 'C URL systemone + Bearer-Key im Request');
    const body = JSON.parse(f.aufrufe[0]?.init?.body ?? '{}');
    pruefe(body.model === 'typesafe/jev-1.13-20260917' && body.state?.x === 1 && body.questions?.a, 'C Body {model, state, questions} wie bisher', body);
    let z = (await pool.query('SELECT * FROM jev_aufrufe WHERE project = $1 ORDER BY id', [P])).rows;
    pruefe(z.length === 1 && Number(z[0].usd) === 0.000042 && z[0].usd_quelle === 'antwort' && z[0].funktion === 'empfehlung'
      && z[0].input_tokens === 1000 && z[0].output_tokens === 70 && z[0].ok === true && z[0].agent_id === 'jevschalter-test', 'C Zeile: usd = usage.cost, Quelle antwort, Tokens, Funktion, Agent', z);
    f = fakeFetch(() => ({ status: 200, body: { answers: {}, usage: { input_tokens: 2000 } } }));
    r = await aufruf('plan_einordnen', P, { fetch: f });
    z = (await pool.query('SELECT * FROM jev_aufrufe WHERE project = $1 ORDER BY id', [P])).rows;
    pruefe(r.ok && Math.abs(Number(z[1]?.usd) - 2000 * 0.042 / 1e6) < 1e-12 && z[1]?.usd_quelle === 'listenpreis', 'C ohne cost: input_tokens x 0,042/M, Quelle listenpreis', z[1]);
    process.env.JEV_PREIS_JE_MIO_EINGABE = '1';
    await aufruf('plan_einordnen', P, { fetch: f });
    delete process.env.JEV_PREIS_JE_MIO_EINGABE;
    z = (await pool.query('SELECT * FROM jev_aufrufe WHERE project = $1 ORDER BY id', [P])).rows;
    pruefe(Math.abs(Number(z[2]?.usd) - 0.002) < 1e-12, 'C JEV_PREIS_JE_MIO_EINGABE=1 wirkt', z[2]);
    f = fakeFetch(() => ({ status: 500, body: `kaputt ${KEY}` }));
    r = await aufruf('entscheidung', P, { fetch: f });
    z = (await pool.query('SELECT * FROM jev_aufrufe WHERE project = $1 ORDER BY id', [P])).rows;
    pruefe(r.ok === false && r.grund === 'http' && r.status === 500 && !JSON.stringify(r).includes(KEY) && /Jev-Fehler HTTP 500/.test(r.message), 'C HTTP 500: grund http, Key geschwaerzt', r);
    pruefe(z[3]?.ok === false && Number(z[3]?.usd) === 0, 'C HTTP 500: Zeile ok=false, usd 0', z[3]);
    f = async () => { throw new Error(`netz weg ${KEY}`); };
    r = await aufruf('entscheidung', P, { fetch: f });
    pruefe(r.ok === false && r.grund === 'netz' && /Jev nicht erreichbar/.test(r.message) && !r.message.includes(KEY), 'C Netzfehler: grund netz, Key geschwaerzt', r);
  });

  // ── K Kostensummen ──
  await versuche('K Kosten', async () => {
    await pool.query('DELETE FROM jev_aufrufe WHERE project = ANY($1)', [[P, Q]]);
    const ok = fakeFetch(() => ({ status: 200, body: { answers: {}, usage: { input_tokens: 100, cost: 0.001 } } }));
    await aufruf('empfehlung', P, { fetch: ok });
    await aufruf('empfehlung', P, { fetch: ok });
    await aufruf('entscheidung', Q, { fetch: ok });
    await pool.query("UPDATE jev_aufrufe SET zeit = NOW() - INTERVAL '40 days' WHERE project = $1 AND funktion = 'entscheidung'", [Q]);
    const u = await K.jevKostenUebersicht({});
    const proj = Object.fromEntries((u.je_projekt ?? []).map((x) => [x.project, x]));
    const fn = Object.fromEntries((u.je_funktion ?? []).map((x) => [x.funktion, x]));
    pruefe(Math.abs(proj[P]?.usd - 0.002) < 1e-9 && proj[P]?.aufrufe === 2 && Math.abs(proj[Q]?.usd - 0.001) < 1e-9, 'K je Projekt: P 0,002 (2), Q 0,001', u.je_projekt);
    pruefe(fn.empfehlung?.aufrufe >= 2 && fn.entscheidung?.aufrufe >= 1, 'K je Funktion', u.je_funktion);
    pruefe(Array.isArray(u.je_tag) && u.je_tag.length >= 2 && Array.isArray(u.je_monat) && u.je_monat.length >= 1, 'K je Tag (2 Tage) und je Monat vorhanden', { tag: u.je_tag, monat: u.je_monat });
    const nurP = await K.jevKostenUebersicht({ project: P });
    pruefe(Math.abs(nurP.gesamt?.usd - 0.002) < 1e-9 && nurP.gesamt?.aufrufe === 2, 'K Filter project=P: gesamt 0,002 / 2', nurP.gesamt);
  });

  // ── B Budget ──
  await versuche('B Budget', async () => {
    await pool.query('DELETE FROM jev_aufrufe WHERE project = ANY($1)', [[P, Q]]);
    let st = await K.jevBudgetStand();
    pruefe(st.grenze_usd === null && st.pausiert === false, 'B ohne Grenze: keine Bremse', st);
    const teuer = fakeFetch(() => ({ status: 200, body: { answers: {}, usage: { input_tokens: 10, cost: 0.0004 } } }));
    await K.setzeJevBudget({ grenze_usd: 0.0005, agent: 'koordinator' });
    let r1 = await aufruf('empfehlung', P, { fetch: teuer });
    let r2 = await aufruf('empfehlung', P, { fetch: teuer });
    const r3 = await aufruf('empfehlung', P, { fetch: teuer });
    st = await K.jevBudgetStand();
    pruefe(r1.ok && r2.ok && r3.ok === false && r3.grund === 'budget' && teuer.aufrufe.length === 2, 'B Grenze 0,0005: 2 Aufrufe, der dritte pausiert ohne fetch', { r3, n: teuer.aufrufe.length });
    pruefe(st.pausiert === true && Math.abs(st.verbraucht_usd - 0.0008) < 1e-9, 'B Stand: pausiert, verbraucht 0,0008', st);
    const w = await S.jevWirksam(Q, 'entscheidung');
    pruefe(w.an === false && w.ebene === 'budget' && /Budget/.test(w.text ?? ''), 'B Pause wirkt global wie Schalter aus (ebene budget)', w);
    await K.setzeJevBudget({ grenze_usd: null, agent: 'koordinator' });
    r1 = await aufruf('empfehlung', P, { fetch: teuer });
    pruefe(r1.ok === true, 'B Grenze entfernt: Jev laeuft wieder', r1);
    // Nebenlaeufigkeit: Reserve 0,001, Grenze 0,0025 -> hoechstens 3 Reservierungen gleichzeitig
    process.env.JEV_BUDGET_RESERVE_USD = '0.001';
    await K.setzeJevBudget({ grenze_usd: 0.0025, agent: 'koordinator' });
    await pool.query('UPDATE jev_budget_stand SET verbraucht_usd = 0');
    const langsam = fakeFetch(() => ({ status: 200, body: { answers: {}, usage: { input_tokens: 10, cost: 0.001 } } }), 150);
    const alle = await Promise.all(Array.from({ length: 10 }, () => aufruf('empfehlung', P, { fetch: langsam })));
    const durch = alle.filter((x) => x.ok).length;
    pruefe(langsam.aufrufe.length === 3 && durch === 3, 'B 10 parallele Aufrufe bei Grenze 0,0025 / Reserve 0,001: genau 3 durch', { fetch: langsam.aufrufe.length, durch });
    delete process.env.JEV_BUDGET_RESERVE_USD;
    r2 = await K.setzeJevBudgetZurueck({ agent: 'koordinator' });
    st = await K.jevBudgetStand();
    pruefe(st.verbraucht_usd === 0 && st.pausiert === false, 'B zuruecksetzen: Zaehler 0, keine Pause', st);
    await K.setzeJevBudget({ grenze_usd: null, agent: 'koordinator' });
  });

  // ── H Hinweise ──
  await versuche('H Hinweise', async () => {
    await pool.query(`INSERT INTO jev_entscheidet (project, aktiv, seit, gesetzt_von) VALUES ($1, true, NOW(), 'koordinator')
                      ON CONFLICT (project) DO UPDATE SET aktiv = true, bis = NULL`, [P]);
    M.leereJevModusCache();
    const anker = await M.holeJevModusHinweis(P);
    const ankerOnb = await E.baueAbwesenheitsHinweis(P);
    const ankerStand = await E.leseAbwesenheit(P);
    pruefe(typeof anker === 'string' && anker.length > 10 && typeof ankerOnb === 'string' && ankerStand.aktiv === true, 'H ANKER: bei an tragen jev_modus, jev_hinweis und leseAbwesenheit den Hinweis', { anker, ankerOnb, ankerStand });
    await setze({ ebene: 'global', funktion: 'alle', aktiv: false });
    M.leereJevModusCache();
    const aus1 = await M.holeJevModusHinweis(P);
    const aus2 = await E.baueAbwesenheitsHinweis(P);
    const aus3 = await E.leseAbwesenheit(P);
    pruefe(aus1 === null && aus2 === undefined && aus3.aktiv === false && aus3.jev_aus, 'H global aus: alle drei Hinweise weg, leseAbwesenheit nennt jev_aus', { aus1, aus2, aus3 });
    await setze({ ebene: 'global', funktion: 'alle', aktiv: true });
    await setze({ ebene: 'projekt', project: P, funktion: 'entscheidung', aktiv: false });
    M.leereJevModusCache();
    pruefe(await M.holeJevModusHinweis(P) === null && await E.baueAbwesenheitsHinweis(P) === undefined, 'H Projekt P entscheidung aus: Hinweise weg');
    await setze({ ebene: 'projekt', project: P, funktion: 'entscheidung', aktiv: true });
    M.leereJevModusCache();
    const wieder = await M.holeJevModusHinweis(P);
    pruefe(wieder === anker && (await E.leseAbwesenheit(P)).aktiv === true, 'H wieder an: Hinweise wieder da');
    // Budget-Pause: Onboarding-Hinweis nennt das Budget statt still zu verschwinden
    await K.setzeJevBudget({ grenze_usd: 0.0001, agent: 'koordinator' });
    await pool.query('UPDATE jev_budget_stand SET verbraucht_usd = 0.0002');
    const b = await E.baueAbwesenheitsHinweis(P);
    pruefe(typeof b === 'string' && /Budget/.test(b) && await M.holeJevModusHinweis(P) === null, 'H Budget-Pause: jev_hinweis nennt Budget, jev_modus weg', b);
    await K.setzeJevBudget({ grenze_usd: null, agent: 'koordinator' });
  });

  // ── E Entscheidung bei aus ──
  await versuche('E Entscheidung', async () => {
    await setze({ ebene: 'projekt', project: P, funktion: 'entscheidung', aktiv: false });
    const f = fakeFetch();
    const vorher = Number((await pool.query('SELECT count(*) FROM jev_entscheidungen WHERE project = $1', [P])).rows[0].count);
    const r = await E.entscheideRueckfrage(P, { agent_id: 'jevschalter-test', frage: 'Die Aenderung bricht keine alten Aufrufe.', typ: 'noul', kategorie: 'variante' }, { fetch: f });
    const nachher = Number((await pool.query('SELECT count(*) FROM jev_entscheidungen WHERE project = $1', [P])).rows[0].count);
    pruefe(r.success === true && r.entschieden === false && r.grund === 'jev_aus' && f.aufrufe.length === 0 && nachher === vorher, 'E Jev aus: grund jev_aus, kein fetch, keine Protokollzeile', { r, n: f.aufrufe.length, vorher, nachher });
    await setze({ ebene: 'projekt', project: P, funktion: 'entscheidung', aktiv: true });
    const r2 = await E.entscheideRueckfrage(P, { agent_id: 'jevschalter-test', frage: 'Die Aenderung bricht keine alten Aufrufe.', typ: 'noul', kategorie: 'variante' },
      // P15 E1: ist der Entscheidungs-Topf lesbar, fragt Jev vorher 'irreversibel' (S2b) - die Antwort gehoert in den Fake
      { fetch: fakeFetch(() => ({ status: 200, body: { answers: { entscheidung: { noul: 0.95 }, irreversibel: { noul: 0.02 } }, usage: { input_tokens: 50, cost: 0.0000021 } } })) });
    const z = (await pool.query("SELECT * FROM jev_aufrufe WHERE project = $1 AND funktion = 'entscheidung' ORDER BY id DESC LIMIT 1", [P])).rows[0];
    pruefe(r2.entschieden === true && r2.wahl === 'ja' && z && Number(z.usd) === 0.0000021, 'E an: Entscheidung wie bisher + Kostenzeile funktion entscheidung', { r2, z });
  });

  // ── A admin ──
  await versuche('A admin', async () => {
    let r = await A.fuehreJevAdminAus('jev_schalten', { ebene: 'global', funktion: 'alle', aktiv: false }, 'p15-irgendwer');
    pruefe(r.success === false && /Koordinator/.test(r.message ?? ''), 'A jev_schalten nur Koordinator/User', r);
    r = await A.fuehreJevAdminAus('jev_schalten', { ebene: 'projekt', project: Q, funktion: 'tool', aktiv: false, grund: 'test' }, 'koordinator');
    pruefe(r.success === true && (await S.jevWirksam(Q, 'tool')).an === false, 'A jev_schalten Projekt Q tool aus', r);
    r = await A.fuehreJevAdminAus('jev_status', { project: Q }, 'p15-irgendwer');
    pruefe(r.success === true && r.wirksam?.tool?.an === false && r.wirksam?.empfehlung?.an === true && 'budget' in r && Array.isArray(r.schalter), 'A jev_status: wirksam je Funktion, Schalterzeilen, Budget', r);
    r = await A.fuehreJevAdminAus('jev_schalten', { ebene: 'projekt', project: Q, funktion: 'tool', aktiv: true }, 'user');
    pruefe(r.success === true && (await S.jevWirksam(Q, 'tool')).an === true, 'A agent_id user darf schalten', r);
    r = await A.fuehreJevAdminAus('jev_kosten', { project: P, nur_dieses_projekt: true }, 'x');
    pruefe(r.success === true && r.kosten?.gesamt && Array.isArray(r.kosten.je_tag), 'A jev_kosten', r);
    r = await A.fuehreJevAdminAus('jev_budget', { modus: 'setzen', grenze_usd: 5, reset_tag: 3 }, 'koordinator');
    pruefe(r.success === true && r.budget?.grenze_usd === 5 && r.budget?.reset_tag === 3, 'A jev_budget setzen', r);
    r = await A.fuehreJevAdminAus('jev_budget', { modus: 'setzen', grenze_usd: 5 }, 'p15-irgendwer');
    pruefe(r.success === false, 'A jev_budget setzen nur Koordinator/User', r);
    const kf = async (url, init) => { kf.url = url; kf.auth = init?.headers?.Authorization; return new Response(JSON.stringify({ data: { label: 'sk-or-v1-abc...', limit: 50, limit_remaining: 49.8, usage: 0.2, usage_daily: 0.01, usage_weekly: 0.05, usage_monthly: 0.2, limit_reset: null, is_free_tier: false } }), { status: 200 }); };
    r = await A.fuehreJevAdminAus('jev_budget', { modus: 'status', kontostand: true }, 'x', { fetch: kf });
    pruefe(r.success === true && r.kontostand?.limit === 50 && r.kontostand?.limit_remaining === 49.8 && !('label' in (r.kontostand ?? {}))
      && kf.url === 'https://openrouter.ai/api/v1/key' && kf.auth === `Bearer ${KEY}` && !JSON.stringify(r).includes(KEY), 'A Kontostand: /api/v1/key, nur Whitelist-Felder, kein Key', r);
    r = await A.fuehreJevAdminAus('jev_budget', { modus: 'entfernen' }, 'koordinator');
    pruefe(r.success === true && r.budget?.grenze_usd === null, 'A jev_budget entfernen', r);
  });

  // ── S stdio + Filter ──
  await versuche('S stdio', async () => {
    const liste = [{ name: 'admin' }, { name: 'jev' }, { name: 'code_intel' }];
    pruefe((await S.filtereJevTool(liste)).map((t) => t.name).join(',') === 'admin,jev,code_intel', 'S filtereJevTool bei an: jev bleibt');
    await setze({ ebene: 'global', funktion: 'tool', aktiv: false });
    pruefe((await S.filtereJevTool(liste)).map((t) => t.name).join(',') === 'admin,code_intel', 'S filtereJevTool bei global tool aus: jev weg, Rest bleibt');
    await setze({ ebene: 'global', funktion: 'tool', aktiv: true });
    await setze({ ebene: 'projekt', project: P, funktion: 'tool', aktiv: false });
    const { jevTool } = await lade(repo, 'packages', 'mcp-server', 'dist', 'tools', 'consolidated', 'jev.js');
    const r = await jevTool.handler({ action: 'protokoll', project: P });
    pruefe(r.success === false && r.error === 'jev_aus', 'S stdio jevTool.handler bei Projekt tool aus -> jev_aus', r);
    await setze({ ebene: 'projekt', project: P, funktion: 'tool', aktiv: true });
  });

  // ── O Jev-Optionen ──
  await versuche('O Optionen', async () => {
    let r = await A.fuehreJevAdminAus('jev_optionen', {}, 'x');
    pruefe(r.success && r.optionen?.erklaerung_sprachen?.de === true && r.optionen?.erklaerung_sprachen?.en === true
      && r.optionen?.jev_sprache === 'en' && r.optionen?.jev_sprache_wirksam === 'en' && !r.optionen?.hinweis, 'O Standard: de+en an, jev_sprache en', r);
    r = await A.fuehreJevAdminAus('jev_optionen', { modus: 'setzen', erklaerung_de: false, erklaerung_en: false }, 'koordinator');
    pruefe(r.success === false && r.error === 'keine_sprache', 'O beide Sprachen aus -> keine_sprache, nichts gespeichert', r);
    r = await A.fuehreJevAdminAus('jev_optionen', { modus: 'setzen', jev_sprache: 'fr' }, 'koordinator');
    pruefe(r.success === false && r.error === 'jev_sprache_ungueltig', 'O jev_sprache fr -> jev_sprache_ungueltig', r);
    r = await A.fuehreJevAdminAus('jev_optionen', { modus: 'setzen', jev_sprache: 'de' }, 'p15-irgendwer');
    pruefe(r.success === false && r.error === 'nur_koordinator', 'O setzen nur Koordinator/User', r);
    r = await A.fuehreJevAdminAus('jev_optionen', { modus: 'setzen', erklaerung_de: false, jev_sprache: 'de' }, 'koordinator');
    pruefe(r.success && r.optionen.jev_sprache === 'de' && r.optionen.jev_sprache_wirksam === 'en' && /Rueckfall/.test(r.optionen.hinweis ?? '')
      && JSON.stringify(r.optionen.gepflegte_sprachen) === '["en"]', 'O de aus + jev_sprache de -> Rueckfall en mit Hinweis, gepflegt [en]', r);
    r = await A.fuehreJevAdminAus('jev_optionen', { modus: 'setzen', jev_sprache: 'mix' }, 'user');
    pruefe(r.success && r.optionen.jev_sprache_wirksam === 'en' && /mix/.test(r.optionen.hinweis ?? ''), 'O mix bei nur en -> Rueckfall en', r);
    r = await A.fuehreJevAdminAus('jev_optionen', { modus: 'setzen', erklaerung_de: true }, 'koordinator');
    pruefe(r.success && r.optionen.jev_sprache === 'mix' && r.optionen.jev_sprache_wirksam === 'mix' && !r.optionen.hinweis, 'O de wieder an: mix wirksam, kein Hinweis (Wunsch blieb gespeichert)', r);
    r = await A.fuehreJevAdminAus('jev_status', { project: P }, 'x');
    pruefe(r.success && r.optionen?.jev_sprache === 'mix', 'O jev_status zeigt die Optionen', r.optionen);
  });

  // ── R REST ──
  await versuche('R REST', async () => {
    const { spawnSync } = await import('node:child_process');
    const lauf = () => {
      const k = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'rest'], { env: process.env, encoding: 'utf8', timeout: 120_000 });
      const zeile = (k.stdout ?? '').split('\n').find((l) => l.startsWith('ERGEBNIS '));
      return zeile ? JSON.parse(zeile.slice(9)) : { fehler: (k.stderr ?? '').slice(-800) };
    };
    let e = lauf();
    for (const url of ['/mcp/messages', '/']) {
      const n = e[url]?.namen ?? [];
      pruefe(n.includes('jev') && n.includes('admin'), `R ${url} an: jev in tools/list`, e[url] ?? e);
      pruefe(e[url]?.admin?.success === true && e[url]?.admin?.wirksam, `R ${url} admin jev_status ueber REST`, e[url]?.admin);
    }
    await setze({ ebene: 'global', funktion: 'alle', aktiv: false });
    e = lauf();
    for (const url of ['/mcp/messages', '/']) {
      const n = e[url]?.namen ?? [];
      pruefe(!n.includes('jev') && n.includes('admin') && n.includes('code_intel'), `R ${url} global aus: jev fehlt (ANKER admin, code_intel da)`, n);
      pruefe(e[url]?.jev?.success === false && e[url]?.jev?.error === 'jev_aus', `R ${url} global aus: tools/call jev -> jev_aus`, e[url]?.jev);
    }
    await setze({ ebene: 'global', funktion: 'alle', aktiv: true });
    e = lauf();
    pruefe((e['/mcp/messages']?.namen ?? []).includes('jev'), 'R wieder an: jev wieder in tools/list');
  });
} finally {
  await aufraeumen().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

console.log(fehler === 0 ? 'ALLE ZUSAGEN ERFUELLT' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
