/**
 * P10-T76 (14.10.2026): Schwaerzungsregeln geschaerft (Stichprobe 4fef23d2, C1-C9), Regel-Kennungen je Treffer,
 * Filter regeln:[...] fuer intern(tool_calls_nachschwaerzen).
 *   R1 Falsch-Positive aus Quelltext/Doku/env-Ausgaben bleiben unveraendert (C1-C8).
 *   R2 Echte Geheimnisse werden weiter vollstaendig geschwaerzt (keine Lockerung).
 *   R3 schwaerzeToolLogTextMitRegeln: ohne regeln identisch zum Schreibweg, Treffer je Regel/Schluessel, nie Werte.
 *   R4 regeln-Filter wendet nur die genannten Regeln an.
 *   R5 intern: Parameter regeln im Schema, unbekannte Kennung -> parameter_ungueltig, Zeile meldet regeln.
 * Rein funktional (keine DB). Synthetische Werte. Voraussetzung: core gebaut. Die Faelle aus
 * tool-log-schwaerzen-p10-t72.test.mjs muessen unveraendert gruen bleiben.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.SYNAPSE_INTERN_TOOL = '1';
const c = await import('../dist/services/tool-args-schwaerzen.js');
const PW = 'Abc12345geheimXYZ';

test('R1 Falsch-Positive bleiben (C1-C8)', () => {
  const bleibt = [
    // C1 token nur als Name-Ende
    'tokenizer: nemotron', 'tokens_in: 1200', 'token_type: bearer', 'token_count: 3', 'kontext_tokens: 1.2M', 'tokens: 12k',
    'Token: 3 von 5', 'next_page_token: abcdef', "const TOKEN_HEADER = 'x-synapse-token';",
    // C2 PWD-Pfad
    'PWD=/home/x/dev', 'OLDPWD=~/alt', 'PWD=C:\\Users\\x',
    // C3 pin: zurueckgenommen (Koordinator-Entscheid zu 91fd264e) -> Faelle stehen in R6 als geschwaerzt
    // C4 Prosa (Koordinator 14.10.2026: unter starkem Schluessel nur mit eindeutigem Quellverweis; die frueheren Faelle
    // 'password: is stored in the vault' und 'Kennwort: siehe project(projekt_db) …' stehen jetzt in R6 als geschwaerzt)
    'Passwort: kommt aus der .env', 'Kennwort: siehe config/secrets.yaml', 'password: see DB_PASSWORD',
    // C5 auth/credentials/cookie: zurueckgenommen (Koordinator-Entscheid zu 91fd264e) -> Faelle stehen in R6 als geschwaerzt
    // C6 Feldnamen-Literale
    'PASSWORD_FIELD = "password"', 'tokenKey: "authToken"', "const SECRET_NAME = 'client_secret';",
    // C7 Typangaben anderer Sprachen
    'password: str', 'def f(token: str):', '    password: Optional[str] = None', 'token: Option<String>,', 'password: &str,',
    // C8 Platzhalter
    'password: <dein-passwort>', 'password: ***', 'DB_PASSWORD=xxx', 'password: {{ vault.db }}', 'token: %API_TOKEN%',
  ];
  for (const t of bleibt) assert.equal(c.schwaerzeToolText(t), t, t);
  // Nachbesserung 2 (61ca8b09): tokens_out ist wieder geheim (wie an der Basis) -> hier token_usage als Meta-Angabe.
  // C3/C5 zurueckgenommen: pin/auth/credentials nicht mehr im Sichtbar-Objekt (R6 prueft sie als geschwaerzt).
  const daten = { PWD: '/home/x', token_type: 'bearer', tokenizer: 'nemotron', token_usage: 'viele', password: '<dein-passwort>' };
  assert.deepEqual(c.schwaerzeToolDaten(daten), daten);
  // Nachbesserung 2: tokens_in und TOKEN_HEADER sind wieder geheim (R7); 'tokens_in: 1200' bleibt als Mengenangabe sichtbar.
  for (const n of ['tokenizer', 'token_type', 'kontext_tokens', 'token_budget', 'page_token', 'token_count', 'token_ttl']) {
    assert.equal(c.istToolLogGeheimSchluessel(n), false, n);
  }
});

test('R2 echte Geheimnisse bleiben geschwaerzt', () => {
  const weg = [
    `API_TOKEN=${PW}`, `DB_PWD=${PW}`, `PWD=${PW}`, `access_token: ${PW}`, `GITHUB_TOKEN: ${PW}`, `csrftoken=${PW}`, `x-api-token: ${PW}`,
    `password: abc ${PW} def`, `Passwort: ${PW}`, `const API_TOKEN = '${PW}';`, `{"accessToken":"${PW}"}`, `{"token":"${PW}"}`,
    `{"tokenizer":"x","refreshToken":"${PW}"}`, `const token = '${PW}';`, `auth: ${PW}`, `credentials: ${PW}`, `cookie: sid=${PW}`,
    `token_value: ${PW}`, `password: ${PW}  # siehe der Tresor`, `postgresql://u:${PW}@h/d`, `Bearer ${PW}`, `sshpass -p ${PW} ssh h`,
    `PASSWORD_FIELD = "${PW}"`,
  ];
  for (const t of weg) assert.ok(!c.schwaerzeToolText(t).includes(PW), t + ' -> ' + c.schwaerzeToolText(t));
  // Passphrase ohne Fuellwort, ENV-Form mit Prosa, pin mit 4-8 Ziffern, starke Schluessel mit Zahl
  assert.equal(c.schwaerzeToolText('password: correct horse battery staple'), 'password: [WERT]');
  assert.equal(c.schwaerzeToolText('PASSWORD=kommt aus der env'), 'PASSWORD=[WERT]');
  assert.equal(c.schwaerzeToolText('pin: 4711'), 'pin: [WERT]');
  assert.equal(c.schwaerzeToolText('PWD=geheim'), 'PWD=[WERT]');
  const d = c.schwaerzeToolDaten({ pin: 123456, refresh_tokens: PW, apiToken: PW, password: 'changeme', DB_PWD: '/sieht/aus/wie/pfad' });
  assert.deepEqual(d, { pin: '[WERT]', refresh_tokens: '[WERT]', apiToken: '[WERT]', password: '[WERT]', DB_PWD: '[WERT]' });
});

test('R3 Bericht je Regel und Schluessel, ohne regeln identisch zum Schreibweg', () => {
  const texte = [
    JSON.stringify({ r: `x postgresql://u:${PW}@h/d Bearer ${PW}`, passwort: PW, uebernehmen: { database: 'd', passwort: PW } }),
    `PGPASSWORD=${PW} psql\npassword: ${PW}\nsshpass -p ${PW} ssh h`, 'nichts geheimes hier', `{"password": 4711, "token": "${PW}`,
  ];
  for (const t of texte) {
    const b = c.schwaerzeToolLogTextMitRegeln(t);
    assert.equal(b.text, c.schwaerzeToolLogText(t), t);
    assert.ok(!JSON.stringify(b.treffer).includes(PW) && !JSON.stringify(b.schluessel).includes(PW));
    for (const r of Object.keys(b.treffer)) assert.ok(c.SCHWAERZ_REGELN.includes(r), r);
  }
  const b0 = c.schwaerzeToolLogTextMitRegeln(texte[0]);
  assert.deepEqual(Object.keys(b0.treffer).sort(), ['bearer', 'struktur', 'url', 'zugang_container']);
  assert.equal(b0.schluessel.passwort, 1);
  assert.equal(b0.schluessel.uebernehmen, 1);
  const b1 = c.schwaerzeToolLogTextMitRegeln(texte[1]);
  assert.deepEqual(b1.treffer, { env: 1, zeile: 1, sshpass: 1 });
  assert.deepEqual(c.schwaerzeToolLogTextMitRegeln(texte[2]).treffer, {});
  assert.deepEqual(c.schwaerzeToolLogTextMitRegeln(texte[3]).treffer, { json_feld: 1, json_skalar: 1 });
  // ausserhalb eines Bericht-Laufs bleibt kein Zustand haengen
  assert.equal(c.schwaerzeToolLogText(texte[1]), c.schwaerzeToolLogTextMitRegeln(texte[1]).text);
});

test('R4 regeln-Filter wendet nur die genannten Regeln an', () => {
  const t = `PGPASSWORD=${PW}x psql postgresql://u:${PW}y@h/d`;
  const nurUrl = c.schwaerzeToolLogTextMitRegeln(t, { regeln: ['url'] });
  assert.ok(nurUrl.text.includes(`PGPASSWORD=${PW}x`) && !nurUrl.text.includes(`${PW}y`), nurUrl.text);
  assert.deepEqual(nurUrl.treffer, { url: 1 });
  const nurEnv = c.schwaerzeToolLogTextMitRegeln(t, { regeln: ['env'] });
  assert.ok(!nurEnv.text.includes(PW), nurEnv.text);
  assert.deepEqual(Object.keys(nurEnv.treffer), ['env']);
  const j = JSON.stringify({ passwort: PW, frei: `Bearer ${PW}z` });
  const nurBearer = c.schwaerzeToolLogTextMitRegeln(j, { regeln: ['bearer'] });
  assert.ok(nurBearer.text.includes(`"passwort":"${PW}"`) && !nurBearer.text.includes(`${PW}z`), nurBearer.text);
  const leer = c.schwaerzeToolLogTextMitRegeln(j, { regeln: [] });
  assert.equal(leer.text, c.schwaerzeToolLogText(j), 'leere Liste = alle Regeln');
});

test('R5 intern tool_calls_nachschwaerzen: Parameter regeln, Validierung, Regeln je Zeile', async () => {
  const T = await import('../dist/services/intern-tool.js');
  const S = await import('../dist/services/intern-tool-calls-schwaerzen.js');
  const def = T.INTERN_DEFINITION.inputSchema;
  assert.ok(def.properties.regeln, 'Parameter regeln');
  assert.deepEqual([...def.properties.regeln.items.enum].sort(), [...c.SCHWAERZ_REGELN].sort());
  const f = await S.fuehreToolCallsSchwaerzenAus('tool_calls_nachschwaerzen', { regeln: ['url', 'gibtsnicht'] }, 'koordinator');
  assert.equal(f.success, false);
  assert.equal(f.error, 'parameter_ungueltig');
  assert.ok(f.message.includes('gibtsnicht') && !f.message.includes(PW));
  const z = S.schwaerzeToolCallZeile({ args_preview: JSON.stringify({ passwort: PW }), result: `x postgresql://u:${PW}@h/d`, error: null });
  assert.deepEqual(z.felder, ['args_preview', 'result']);
  assert.deepEqual(z.regeln, { struktur: 1, url: 1 });
  assert.deepEqual(z.schluessel, { passwort: 1 });
  const zUrl = S.schwaerzeToolCallZeile({ args_preview: JSON.stringify({ passwort: PW }), result: `x postgresql://u:${PW}@h/d` }, ['url']);
  assert.deepEqual(zUrl.felder, ['result']);
  assert.deepEqual(zUrl.regeln, { url: 1 });
});


// R6 (Nachbesserung nach Abnahme d996c097, Probe 9e017bc6): an Basis 9f5b103a geschwaerzt, vor dem Fix sichtbar.
test('R6 keine Lockerung: Token-Namen mit Umgebungs-Suffix, Prosa unter starkem Schluessel, Schluessel-Komposita, def-Zeilen', () => {
  const S = 'ZZgeheimZZ';
  const faelle = [
    [`SLACK_TOKEN_PROD=${S}abc`, S], [`GITHUB_TOKEN_CI=${S}abc`, S], [`token_live: "${S}abc"`, S],
    [`{"API_TOKEN_STAGING":"${S}abc"}`, S], [`{"bot_tokens":["${S}abc"]}`, S],
    ['password: open the gate now', 'open the gate'], ['Passwort: ich liebe die berge', 'liebe die berge'],
    ["const apiKey = 'live_secret_abcdef';", 'live_secret'], ['SECRET_KEY: my-token-value', 'my-token-value'],
    [`def login(): password = ${S}abc`, S], [`fn main() { let password = "${S}abc"; }`, S],
  ];
  for (const [t, geheim] of faelle) {
    const raus = c.schwaerzeToolLogText(t);
    assert.ok(!raus.includes(geheim), t + ' -> ' + raus);
    assert.ok(raus.includes('[WERT]'), t + ' -> ' + raus);
  }
  for (const n of ['SLACK_TOKEN_PROD', 'GITHUB_TOKEN_CI', 'token_live', 'API_TOKEN_STAGING', 'bot_tokens']) {
    assert.equal(c.istToolLogGeheimSchluessel(n), true, n);
  }
  const d = c.schwaerzeToolDaten({ SLACK_TOKEN_PROD: S, token_live: S, bot_tokens: [S], apiKey: 'live_secret_abcdef', SECRET_KEY: 'my-token-value' });
  assert.ok(!JSON.stringify(d).includes(S) && !JSON.stringify(d).includes('live_secret') && !JSON.stringify(d).includes('my-token'), JSON.stringify(d));

  // Koordinator-Entscheid 14.10.2026 zu den Grenzfaellen aus 2fcbbcba:
  // (1) pin mit 9 und mehr Ziffern wird ebenfalls geschwaerzt (4..12 und laenger). Koordinator-Entscheid zu 91fd264e
  // (Grundsatz: was an der Basis geschwaerzt war, bleibt geschwaerzt): C3 und C5 zurueckgenommen -> auch 1..3 Ziffern,
  // Booleans und auth-Verfahrensnamen werden geschwaerzt (frueher hier als sichtbar geprueft).
  for (const z of ['1234', '12345678', '123456789', '123456789012', '1234567890123456']) {
    assert.equal(c.schwaerzeToolText('pin: ' + z), 'pin: [WERT]', 'pin ' + z);
    assert.equal(c.schwaerzeToolText(`{"pin": ${z}}`), '{"pin": "[WERT]"}', 'json pin ' + z);
    assert.deepEqual(c.schwaerzeToolDaten({ pin: Number(z), userPin: z }), { pin: '[WERT]', userPin: '[WERT]' }, 'daten pin ' + z);
  }
  for (const t of ['pin: 123', 'pin: 7', 'pin: 1', 'pin: true', '"pin": false', '{"pin": 12}', '{"pin": true, "x": 1}',
    'auth: none', "credentials: 'include'", 'cookie: httponly', 'authorization: basic', 'auth: oauth2', 'auth: basic']) {
    const raus = c.schwaerzeToolText(t);
    assert.ok(raus !== t && raus.includes('[WERT]'), t + ' -> ' + raus);
  }
  assert.deepEqual(c.schwaerzeToolDaten({ pin: true, pin_code: 12, auth: 'basic', credentials: 'include', cookie: 'httponly' }),
    { pin: '[WERT]', pin_code: '[WERT]', auth: '[WERT]', credentials: '[WERT]', cookie: '[WERT]' });
  // (2) Prosa unter starkem Schluessel: freie Saetze werden geschwaerzt, auch mit Fuell-/Verweis-Wort.
  const frei = [
    ['password: comes from the moon', 'moon'], ['password: is stored in the vault', 'vault'],
    ['Kennwort: siehe project(projekt_db) und die Doku', 'Doku'], ['Passwort: kommt aus dem Tresor', 'Tresor'],
    ['secret: see the docs please', 'docs'], ['password: siehe oben', 'oben'], ['Passwort: steht im Wiki', 'Wiki'],
    ['pwd: lives in my head', 'head'],
  ];
  for (const [t, geheim] of frei) {
    const raus = c.schwaerzeToolLogText(t);
    assert.ok(!raus.includes(geheim) && raus.includes('[WERT]'), t + ' -> ' + raus);
  }
  // ... sichtbar nur bei EINDEUTIGEM Quellverweis (.env, siehe/see + Datei/Variable, ${VAR}, process.env.X)
  const quelle = [
    'Passwort: kommt aus der .env', 'password: comes from .env.local', 'password: siehe .env', 'Kennwort: siehe config/secrets.yaml',
    'password: see ~/.pgpass', 'password: see DB_PASSWORD', 'secret: siehe Variable APP_SECRET', 'password: kommt aus ${DB_PASSWORD}',
    'password: is read from process.env.DB_PASSWORD', 'Passwort: siehe /etc/synapse/db.conf', 'password: see the file deploy/.env',
  ];
  for (const t of quelle) assert.equal(c.schwaerzeToolText(t), t, t);
  // ENV-Form bleibt immer geschwaerzt, auch mit Quellverweis-Text
  assert.equal(c.schwaerzeToolText('PASSWORD=kommt aus der .env'), 'PASSWORD=[WERT]');
});

// R7 (Nachbesserung 2, Nachpruefung 61ca8b09, Proben probe-t76b/c): an Basis 9f5b103a geschwaerzt, vor diesem Fix sichtbar.
// User-Grundsatz: KEINE Lockerung bei Schluesseln/Passwoertern/Tokens.
test('R7 keine Lockerung: Quellverweis nur verankert, Token-Meta eng, Geheimnis-Muster immer', () => {
  const S = 'ZZgeheimZZ';
  const faelle = [
    // N1 Quellverweis irgendwo im Wert macht einen starken Wert NICHT sichtbar
    ['password: hunter2 siehe .env', 'hunter2'], ['password: Xk9#mQ2v $HOME', 'Xk9#mQ2v'],
    ['password: hunter2 see config.yaml', 'hunter2'], ['Passwort: Tr0ub4dor siehe ~/.pgpass', 'Tr0ub4dor'],
    ['secret: correcthorse process.env.X', 'correcthorse'], ['Kennwort: hunter2 kommt aus der .env', 'hunter2'],
    ['api_key: sk-abc123def456 siehe .env', 'sk-abc123def456'],
    // N2 TOKEN_META_SUFFIX nur type/count/len/length/size/limit/budget/usage/estimate/ttl/expiry/expires
    [`DEPLOY_TOKEN_ID=${S}x`, S], [`TOKEN_NAME=${S}x`, S], [`GH_TOKEN_HEADER=${S}x`, S], [`session_token_in=${S}x`, S],
    ['{"GITHUB_TOKEN_URL":"ghp_abc123def"}', 'ghp_abc123def'], ['{"SLACK_TOKEN_NAME":"xoxb-1-abc"}', 'xoxb-1-abc'],
    ['{"api_token_header":"Bearer abc123def456"}', 'Bearer'], [`api_token_header: ${S}x`, S], [`GITHUB_TOKEN2=${S}x`, S],
    [`tokens_out: ${S}x`, S], [`TOKEN_PATH=${S}x`, S],
    // N3 Geheimnis-Muster/hohe Entropie unter Meta-Namen und Ausnahmen
    ['{"page_token":"Zk3mQ9xLp2Vt7RwB4nYc8HsD"}', 'Zk3mQ9xLp2Vt7RwB4nYc8HsD'], ['token_type: sk_live_abcdefghij012345', 'sk_live_'],
  ];
  for (const [t, geheim] of faelle) {
    const raus = c.schwaerzeToolLogText(t);
    assert.ok(!raus.includes(geheim), t + ' -> ' + raus);
    assert.ok(raus.includes('[WERT]'), t + ' -> ' + raus);
  }
  for (const n of ['DEPLOY_TOKEN_ID', 'TOKEN_NAME', 'GH_TOKEN_HEADER', 'session_token_in', 'GITHUB_TOKEN_URL', 'SLACK_TOKEN_NAME',
    'api_token_header', 'tokens_in', 'TOKEN_HEADER', 'GITHUB_TOKEN2', 'tokens_out']) {
    assert.equal(c.istToolLogGeheimSchluessel(n), true, n);
  }
  const d = JSON.stringify(c.schwaerzeToolDaten({ GITHUB_TOKEN_URL: 'ghp_abc123def', SLACK_TOKEN_NAME: 'xoxb-1-abc',
    api_token_header: 'Bearer abc123def456', DEPLOY_TOKEN_ID: S }));
  for (const g of ['ghp_', 'xoxb', 'abc123def456', S]) assert.ok(!d.includes(g), g + ' -> ' + d);
});

// R9: verankerte reine Verweise und die engen Token-Meta-Angaben bleiben sichtbar (C1/C4 nach Nachbesserung 2).
// An der Basis ueberschwaerzt (token_type), daher nicht Teil von R7 (R7 muss an der Basis gruen sein).
test('R9 verankerte Verweise und Token-Meta bleiben sichtbar', () => {
  for (const t of ['password: siehe .env', 'password: ${DB_PASSWORD}', 'password: process.env.DB_PASSWORD', 'token_count: 1234',
    'token_type: bearer', '{"page_token":"abc123"}', 'tokenizer: cl100k_base', 'risk-assessment-document-final-version']) {
    assert.equal(c.schwaerzeToolText(t), t, t);
  }
});

// R8 (Nachbesserung 2): Altlecks, die schon an der Basis 9f5b103a sichtbar waren (Proben probe-t76b/R7-Probe) und jetzt
// geschwaerzt werden. An der Basis ROT (bewusst: Verschaerfung), jetzt gruen.
test('R8 Altlecks der Basis: Geheimnis-Muster im freien Text, PEM, passphrase, Wert mit Leerraum vor Punkt, ${VAR} am Ende', () => {
  const S = 'ZZgeheimZZ';
  const faelle = [
    [`xoxb-123456789012-${S}abcdefgh`, S], [`ghp_${S}abcdefghijklmnopqrstuvwxyz0123`, S],
    ['siehe github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_11'], ['key AKIAIOSFODNN7EXAMPLE dort', 'AKIAIOSFODNN7EXAMPLE'],
    ['OPENAI sk-proj-abcdefghijklmnopqrstuv0123', 'sk-proj-abc'], ['{"token_count":"ghp_abcdefghij0123456789"}', 'ghp_abc'],
    [`-----BEGIN RSA PRIVATE KEY-----\nMIIE${S}x\n-----END RSA PRIVATE KEY-----`, S],
    [`private_key: "-----BEGIN PRIVATE KEY-----\\nMIIE${S}x\\n-----END PRIVATE KEY-----"`, S],
    ['passphrase: correct horse battery staple', 'horse battery'], ['password: siehe .env hunter2', 'hunter2'],
    ['password: abc .def', 'abc'], ['password: geheim123 ${DB_PASSWORD}', 'geheim123'],
    // Koordinator-Entscheid zu 91fd264e: Zuweisungen in Code-Zeilen mit String-Literal an geheime Namen
    [`func x() { apiKey := "${S}x" }`, S], [`apiKey := "${S}x"`, S], [`\tsecret := '${S}x'`, S], [`password := \`${S}x\``, S],
    [`token := "${S}x"`, S], [`var apiKey = "${S}x"`, S], [`const apiKey = "${S}x";`, S], [`let password = '${S}x';`, S],
    [`password = "${S}x"`, S], [`    api_token = '${S}x'`, S], [`self.secret = "${S}x"`, S],
  ];
  for (const [t, geheim] of faelle) {
    const raus = c.schwaerzeToolLogText(t);
    assert.ok(!raus.includes(geheim), t + ' -> ' + raus);
    assert.ok(raus.includes('[WERT]'), t + ' -> ' + raus);
  }
  const d = JSON.stringify(c.schwaerzeToolDaten({ token_count: 'ghp_abcdefghij0123456789', frei: `x ghp_${S}abcdefghijklmnop` }));
  assert.ok(!d.includes('ghp_') && !d.includes(S), d);
  assert.deepEqual(c.schwaerzeToolLogTextMitRegeln(`x ghp_${S}abcdefghijklmnop y`).treffer, { muster: 1 });
  assert.equal(c.schwaerzeToolText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'),
    '-----BEGIN PRIVATE KEY-----[WERT]-----END PRIVATE KEY-----');
});
