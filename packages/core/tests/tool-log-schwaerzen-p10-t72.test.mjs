/**
 * P10-T72 B1: Geheimnisse landen nie in tool_calls (args_preview/result/error), fuer alle Tools und auch bei
 * abgelehnten/fehlgeschlagenen Aufrufen; shell(activity, detail:'full') zeigt sie nicht. Dazu die Lese-Maske:
 * Schluessel "passwort" bleibt stehen, sein Wert wird [WERT]; das Vorlagenwort "passwort" ist kein Literal.
 *
 * ABSICHERUNG: Teil B nur gegen synapse_test (:5433/synapse_test), eigenes Testprojekt t72-toollog-schwaerzen
 * (nur dessen tool_calls-Zeilen werden geschrieben/geloescht). Synthetische Passwoerter.
 * Voraussetzung: core, rest-api, mcp-server gebaut.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

const PW = 'Abc12345geheimXYZ';
const PW2 = 'Zzz98765nochGeheimQ';
const core = await import('../dist/services/tool-args-schwaerzen.js');
const maske = await import('../dist/services/shell-maske.js');

test('A schwaerzeToolDaten: verschachtelt, alle Schluesselvarianten, Zaehler/Verfahrenskennungen bleiben', () => {
  const args = {
    action: 'projekt_db', project: 'x',
    uebernehmen: { database: 't72_db', user: 't72_user', passwort: PW, host: '192.168.50.65', port: 5433 },
    nested: [{ password: PW }, { apiKey: PW }, { 'db-pass': PW }, { client_secret: { tief: PW } }, { token: 12345678 }],
    database_url: `postgresql://u:${PW}@h:5433/d`, frei: `verbinde postgresql://u:${PW2}@h:5433/d`,
    header: `Bearer ${PW2}`, wait_token: 'wt-123', max_tokens: 100, passende_tasks: 'ok', bypass: 'sichtbar',
  };
  const s = JSON.stringify(core.schwaerzeToolDaten(args));
  assert.ok(!s.includes(PW) && !s.includes(PW2), s);
  const o = JSON.parse(s);
  assert.equal(o.uebernehmen.passwort, '[WERT]');
  assert.equal(o.uebernehmen.database, 't72_db');
  assert.equal(o.uebernehmen.port, 5433);
  assert.equal(o.nested[4].token, 12345678, 'Zahlen werden nie geschwaerzt');
  assert.equal(o.wait_token, 'wt-123');
  assert.equal(o.max_tokens, 100);
  assert.equal(o.passende_tasks, 'ok');
  assert.equal(o.bypass, 'sichtbar');
  assert.match(o.frei, /postgresql:\/\/\[WERT\]@h:5433\/d/);
});

test('A abgeschnittene Vorschau, JSON-String im String, Freitext, toolArgsVorschau', () => {
  const lang = JSON.stringify({ a: 'x'.repeat(480), uebernehmen: { passwort: PW } });
  const abgeschnitten = lang.slice(0, lang.indexOf(PW) + 5);
  assert.ok(!core.schwaerzeToolText(abgeschnitten).includes(PW.slice(0, 5)), 'abgeschnittenes JSON');
  const eingebettet = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ passwort: PW, database_url: `postgresql://u:${PW2}@h/d` }) }] });
  const e = core.schwaerzeToolLogText(eingebettet);
  assert.ok(!e.includes(PW) && !e.includes(PW2), e);
  const frei = core.schwaerzeToolText(`Fehler: passwort=${PW} token: "${PW2}"`);
  assert.ok(!frei.includes(PW) && !frei.includes(PW2), frei);
  const v = core.toolArgsVorschau({ a: 'x'.repeat(600), uebernehmen: { passwort: PW } });
  assert.ok(v.length <= 500 && !v.includes(PW));
  const v2 = core.toolArgsVorschau({ uebernehmen: { passwort: PW }, a: 'x'.repeat(600) });
  assert.ok(v2.includes('"passwort":"[WERT]"') && !v2.includes(PW), v2.slice(0, 80));
});

test('A Runde 2: Varianten werden geschwaerzt (Schluessel, Text, URL ohne User, CLI, uebernehmen-Positivliste)', () => {
  const daten = { PGPASSWORD: PW, passWort: PW, passwort_neu: PW, pw: PW, db_pw: PW, DB_PASSWORT: PW, apiKey: PW, x_api_key: PW,
    pgpass: PW, Kennwort: PW, clientSecret: PW, refreshToken: PW };
  const d = core.schwaerzeToolDaten(daten);
  for (const [k, v] of Object.entries(d)) assert.equal(v, '[WERT]', k);
  const texte = [
    `PGPASSWORD=${PW} psql -h h`, `export PGPASSWORD='${PW}'`, `PGPASSWORD="${PW}" pg_dump`, `passWort=${PW}`, `passwort_neu=${PW}`,
    `pw=${PW}`, `postgresql://:${PW}@host:5433/db`, `postgresql://u:${PW}@host/db`, `mysql -uroot -p${PW} db`,
    `mariadb -h x -p'${PW}'`, `psql --password ${PW}`, `tool --password=${PW} --x`, `sshpass -p ${PW} ssh h`,
    `jdbc:postgresql://h/db?user=u&password=${PW}`, `Authorization: Bearer ${PW}`, `{"passwort":"${PW}`, `const token = '${PW}';`,
    // Matrix 7b4af9e2/ad49211a (weitere): libpq, DB_PASS, YAML-Block, ?token, Prosa, toml, dsn, sshpass -pX
    `host=h port=5433 password='${PW}' dbname=d`, `DB_PASS="${PW}"`, `password:\n  ${PW}`, `https://h/x?token=${PW}&a=1`,
    `Passwort: ${PW}`, `password = "${PW}"`, `host=h password=${PW} dbname=d`, `sshpass -p${PW} ssh h`,
    // Matrix 466e660c: YAML/compose/ini/.env/Prosa mit Leerraum, Markdown/Quotes/Pipe davor, SSHPASS
    `password: ${PW}`, `  password: ${PW}`, `db:\n  password: ${PW}\n  user: u`, `  POSTGRES_PASSWORD: ${PW}`, `GITHUB_TOKEN: ${PW}`,
    `Kennwort: ${PW}`, `Das Passwort: ${PW}`, `password: abc ${PW} def`, `PASSWORD = ${PW}`, `[db]\npassword = ${PW}`,
    `password= ${PW}`, `- **Passwort:** ${PW}`, '`PGPASSWORD=' + PW + '`', `"PGPASSWORD=${PW}"`, `|password=${PW}`, `SSHPASS=${PW}`,
    `export SSHPASS=${PW}`, `MYSQL_PASS: ${PW}`, `environment:\n  - POSTGRES_PASSWORD=${PW}`, `Fehler: passwort=${PW} token: x`,
  ];
  // Zeilenregel: Wert mit Leerzeichen bis Zeilenende
  assert.equal(core.schwaerzeToolText('password: abc def'), 'password: [WERT]');
  assert.equal(core.schwaerzeToolText('db:\n  password: geheim123\n  user: u'), 'db:\n  password: [WERT]\n  user: u');
  for (const t of texte) assert.ok(!core.schwaerzeToolText(t).includes(PW), t + ' -> ' + core.schwaerzeToolText(t));
  const u = core.schwaerzeToolDaten({ action: 'projekt_db', uebernehmen: { database: 't72_db', user: 't72_user', host: 'h', port: 5433,
    passwort: PW, pass_wort: PW, pwd: PW, geheim: PW, extra: 12345678, verschachtelt: { x: PW } } });
  assert.deepEqual(u.uebernehmen, { database: 't72_db', user: 't72_user', host: 'h', port: 5433, passwort: '[WERT]', pass_wort: '[WERT]',
    pwd: '[WERT]', geheim: '[WERT]', extra: '[WERT]', verschachtelt: { x: '[WERT]' } });
  for (const falsch of [[PW], PW, 12345678]) assert.equal(JSON.stringify(core.schwaerzeToolDaten({ uebernehmen: falsch })).includes(String(PW)) ||
    JSON.stringify(core.schwaerzeToolDaten({ uebernehmen: falsch })).includes('12345678'), false, JSON.stringify(falsch));
});

test('A Koordinator: starke Schluessel schwaerzen auch Zahlen/Booleans, schwache nicht', () => {
  // MUSS geschwaerzt
  const stark = { password: 123456, passwort: 4711, pin: 1234, userPin: 4711, pinCode: 9999, kennwort: true, db_pw: 1234, SSHPASS: 4711,
    secret: 42, PGPASSWORD: 271828, privateKey: 1 };
  for (const [k, v] of Object.entries(core.schwaerzeToolDaten(stark))) assert.equal(v, '[WERT]', k);
  for (const t of ['{"password": 123456}', '{"password": 123456', '{"kennwort":true,"x":1}', '[{"pin": 1234}]',
    'PASSWORT=4711', 'password: 123456', 'pin: 1234', '  POSTGRES_PASSWORD: 4711', 'kennwort=true', 'SSHPASS=4711', 'export PGPASSWORD=4711']) {
    const s = core.schwaerzeToolText(t);
    assert.ok(!/4711|123456|1234|true|271828/.test(s.replace(/"x":1/, '')), t + ' -> ' + s);
  }
  assert.equal(core.schwaerzeToolLogText(JSON.stringify({ password: 123456 })), '{"password":"[WERT]"}');
  assert.equal(core.schwaerzeToolText('PASSWORT=4711'), 'PASSWORT=[WERT]');
  // MUSS unveraendert
  const schwach = { tokens: 1234, pass: 7, token: 99, token_count: 3, max_tokens: 100, apiKeys: 2, secret: null, passwort: null, passwortGesetzt: true };
  assert.deepEqual(core.schwaerzeToolDaten(schwach), schwach);
  for (const t of ['"tokens": 1234', '"pass": 7', '{"tokens": 1234, "pass": 7}', 'tokens: 1234', 'pass=7', 'token=1234', 'secret: null', 'passwort: null']) {
    assert.equal(core.schwaerzeToolText(t), t, t);
  }
  const j = JSON.stringify({ tokens: 1234, pass: 7 });
  assert.equal(core.schwaerzeToolLogText(j), j);
});

test('A Runde 2: Quelltext, Prosa und Zaehler bleiben unveraendert', () => {
  const unveraendert = [
    "const passwort = typeof eingabe.passwort === 'string' ? eingabe.passwort : '';",
    'const token = naechstesToken();',
    'if (token === undefined) return;',
    'token=naechstesToken()',
    'const pw = holePasswort(x);',
    'const secret = config.secret;',
    'const apiKey = process.env.API_KEY;',
    'function f(password: string) {',
    'export function setze(token: string, passwort: string): void {',
    'const f = (token: string) => token.trim();',
    'items.map((token) => token.trim());',
    '  passwort: string;',
    '  password?: string;',
    'password: string',
    'interface Z { token: string; passwort: string }',
    '{ password, token }',
    '{ token: t, passwort: p }',
    '  passwort: eingabe.passwort,',
    'this.passwort = eingabe.passwort;',
    'passwort: typeof eingabe.passwort === \'string\' ? eingabe.passwort : \'\',',
    '| passwort | Beschreibung |',
    '|---|---|',
    'SELECT passwort FROM nutzer WHERE id = $1',
    'UPDATE nutzer SET passwort = $1 WHERE id = $2',
    '  passwort TEXT NOT NULL,',
    'CREATE TABLE projekt_datenbanken (project TEXT PRIMARY KEY, passwort TEXT NOT NULL);',
    'PGPASSWORD=$PGPASS psql',
    'password: ${{ secrets.DB_PASSWORD }}',
    '## Passwort',
    'Siehe Feld passwort in der Tabelle.',
    'token=true',
    'secret: null',
    'mysql -uroot -p',
    'mysql -uroot -p datenbank',
    'passende_tasks=3 bypass=ja compass=nord',
    '"pass": 7, "tokens": 1234, "max_tokens": 100',
    'wait_token=abc123def456 stream_id=0123456789abcdef',
  ];
  for (const t of unveraendert) assert.equal(core.schwaerzeToolText(t), t, t);
  const zaehler = { pass: 7, tokens: 1234, max_tokens: 100, passwortGesetzt: true, secret: null, token_count: 3, passwort_ort: 'project(projekt_db)',
    passende_tasks: 'liste', bypass: 'x' };
  assert.deepEqual(core.schwaerzeToolDaten(zaehler), zaehler);
  const json = JSON.stringify({ pass: 7, tokens: 1234, usage: { input_tokens: 10 } });
  assert.equal(core.schwaerzeToolLogText(json), json);
  const code = JSON.stringify({ file_path: 'a.ts', content: "const passwort = typeof eingabe.passwort === 'string' ? eingabe.passwort : '';\nconst token = naechstesToken();" });
  assert.equal(core.schwaerzeToolLogText(code), code);
  // files-Ergebnis mit TS-Inhalt, code_intel-Treffer, Markdown
  const ts = "export interface Z {\n  passwort: string;\n  token?: string;\n}\nexport function f(z: Z): string {\n  const pw = z.passwort;\n  if (pw === undefined) return '';\n  return holeToken(z.token);\n}\n";
  const filesErg = JSON.stringify({ success: true, file_path: 'src/z.ts', content: ts, total_lines: 9 });
  assert.equal(core.schwaerzeToolLogText(filesErg), filesErg);
  const ci = JSON.stringify({ success: true, results: [{ file_path: 'x.ts', headline: '<b>passwort</b> = typeof eingabe', matches: [
    { line: 3, text: 'const passwort = typeof eingabe.passwort' }, { line: 9, text: '  passwort: z.passwort,' }, { line: 12, text: 'if (token === undefined) return;' }] }] });
  assert.equal(core.schwaerzeToolLogText(ci), ci);
  const md = '# Zugang\n\n| Feld | Typ |\n|---|---|\n| passwort | string |\n\nDas Feld `passwort` ist Pflicht.\n';
  assert.equal(core.schwaerzeToolText(md), md);
});

test('A Lese-Maske: Schluessel bleibt, Wert wird [WERT]; Platzhalter-Literal "passwort" frisst keinen Schluessel', () => {
  const vorschau = JSON.stringify({ action: 'projekt_db', uebernehmen: { database: 'x', user: 'y', passwort: PW } });
  for (const werte of [[], ['passwort'], ['passwort', 'password']]) {
    const r = maske.maskiereShellDaten({ args_preview: vorschau }, werte).daten;
    assert.ok(!r.args_preview.includes(PW), JSON.stringify(werte) + ' ' + r.args_preview);
    assert.ok(r.args_preview.includes('"passwort"'), 'Schluessel bleibt ' + r.args_preview);
  }
  const t = maske.maskiereShellText(`passwort=${PW}`, ['passwort']).text;
  assert.equal(t, 'passwort=[WERT]');
  const k = maske.maskiereShellText(`kennwort=${PW}`).text;
  assert.equal(k, 'kennwort=[WERT]');
});

// ── TEIL B: echte REST-Strecke gegen synapse_test ──────────────────────────────
const roh = process.env.DATABASE_URL || '';
let db; try { db = new URL(roh); } catch { db = null; }
const testDb = db && db.port === '5433' && db.pathname === '/synapse_test';
const PROJEKT = 't72-toollog-schwaerzen';

test('B project(projekt_db, uebernehmen) und shell(activity, detail:full): Passwort nie gespeichert/angezeigt', { skip: !testDb && 'keine synapse_test-DATABASE_URL' }, async () => {
  process.env.SYNAPSE_DATABASE_URL = db.href;
  Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', SYNAPSE_INTERN_TOOL: '0' });
  delete process.env.SYNAPSE_AGENT_NAME;
  const kern = await import('../dist/index.js');
  const pool = kern.getPool();
  assert.equal((await pool.query('SELECT current_database() AS d')).rows[0].d, 'synapse_test');
  const aufraeumen = () => pool.query('DELETE FROM tool_calls WHERE project = $1', [PROJEKT]);
  await aufraeumen();
  after(async () => { await aufraeumen().catch(() => {}); await kern.closePool?.().catch(() => {}); });
  // Echte Strecke mit Activity-Log: POST / (tools/call -> fuehreToolsCallAus -> logToolCall).
  const { mcpRoutes } = await import('../../rest-api/dist/routes/mcp.js');
  const { createRequire } = await import('node:module');
  const Fastify = createRequire(new URL('../../rest-api/package.json', import.meta.url))('fastify');
  const app = Fastify({ logger: false });
  await app.register(mcpRoutes);
  await app.ready();
  after(async () => { await app.close().catch(() => {}); });
  let rpcId = 0;
  const handleToolCall = async (name, args) => {
    const r = await app.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } } });
    return r.json();
  };
  const basis = { action: 'projekt_db', project: PROJEKT };
  const faelle = [
    // Rolle fehlt -> abgelehnt
    [{ ...basis, agent_id: 'claude-t72', uebernehmen: { database: 't72_db', user: 't72_user', passwort: PW, host: '192.168.50.65', port: 5433 } }, 'claude-t72'],
    // gesperrte Rolle + System-Port -> abgelehnt
    [{ ...basis, agent_id: 'koordinator', uebernehmen: { database: 'synapse', user: 'synapse', passwort: PW, host: '192.168.50.65', port: 5432 } }, 'koordinator'],
    // gueltige Form, echte Anmeldung scheitert (synthetische Rolle) -> fehler
    [{ ...basis, agent_id: 'koordinator', uebernehmen: { database: 't72_db', user: 't72_nichtda_user', passwort: PW2, host: '192.168.50.65', port: 5433 } }, 'koordinator'],
    // kaputter Typ -> invalid_param
    [{ ...basis, agent_id: 'koordinator', uebernehmen: [PW] }, 'koordinator'],
  ];
  for (const [args, agent] of faelle) {
    const r = await handleToolCall('project', args, agent);
    assert.ok(!JSON.stringify(r).includes(PW) && !JSON.stringify(r).includes(PW2), 'Antwort ohne Passwort');
  }
  // logToolCall laeuft best-effort im Hintergrund -> auf alle Zeilen warten.
  let rows = [];
  for (let i = 0; i < 50 && rows.length < faelle.length; i++) {
    rows = (await pool.query("SELECT id::text, args_preview, result, error FROM tool_calls WHERE project = $1 AND tool_name = 'project'", [PROJEKT])).rows;
    if (rows.length < faelle.length) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(rows.length, faelle.length, 'alle Aufrufe protokolliert');
  for (const z of rows) {
    const s = JSON.stringify(z);
    assert.ok(!s.includes(PW) && !s.includes(PW2), 'tool_calls ohne Passwort: ' + s.slice(0, 300));
  }
  assert.ok(rows.some((z) => /"passwort":"\[WERT\]"/.test(z.args_preview ?? '')), 'Schluessel sichtbar, Wert geschwaerzt');
  const act = await handleToolCall('shell', { action: 'activity', project: PROJEKT, tools: ['project'], detail: 'full', agent_id: 'koordinator' }, 'koordinator');
  const a = JSON.stringify(act);
  assert.ok(a.includes('projekt_db'), 'activity liefert die Aufrufe');
  assert.ok(!a.includes(PW) && !a.includes(PW2), 'activity detail:full ohne Passwort');
});

test('B logToolCall direkt: jedes Tool, abgelehnt, Ergebnis mit Zugangsdaten', { skip: !testDb && 'keine synapse_test-DATABASE_URL' }, async () => {
  const kern = await import('../dist/index.js');
  const pool = kern.getPool();
  await kern.logToolCall({ project: PROJEKT, agentId: 'claude-t72', tool: 'memory', action: 'write',
    argsPreview: JSON.stringify({ content: 'x', secret: PW }).slice(0, 33), ok: false, error: `abgelehnt passwort=${PW}`,
    result: JSON.stringify({ success: true, passwort: PW2, database_url: `postgresql://u:${PW2}@h:5433/d` }) });
  const z = (await pool.query("SELECT args_preview, result, error FROM tool_calls WHERE project = $1 AND tool_name = 'memory'", [PROJEKT])).rows[0];
  const s = JSON.stringify(z);
  // argsPreview ist absichtlich mitten im Passwort abgeschnitten: auch der Anfang darf nicht stehen bleiben.
  assert.ok(z && !s.includes(PW.slice(0, 5)) && !s.includes(PW2), s);
});
