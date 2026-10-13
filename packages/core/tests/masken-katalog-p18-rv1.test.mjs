/** P18-T11/RV1: Altstand-Golden und additiver Masken-Katalog; ausschließlich synthetische Werte. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const db = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(db.port, '5433');
assert.equal(db.pathname, '/synapse_test');
const project = 'p18_rv1';
const mode = process.argv[2] || 'verify';
const databaseUrl = process.env.DATABASE_URL;
// Keine echten lokalen Secret-Quellen im Test lesen.
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  SYNAPSE_SECRETS_ENV: path.join(process.cwd(), 'coedit-test', 'p18_rv1-nicht-vorhanden.env'),
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
});
const env = await import('../dist/services/env-maske.js');
const shell = await import('../dist/services/shell-maske.js');
const mcp = await import('../dist/services/mcp-json-maske.js');
const explanation = await import('../dist/services/erklaerungen.js');
const provenance = await import('../dist/services/shell-masken-katalog.js');
const {getPool, closePool} = await import('../dist/db/client.js');

const fake = 'nur_test_wert_1234567890';
const cases = [
  ['plain', 'hallo Welt\nPUBLIC_FLAG=1\nkey=normal\n'],
  ['pem', 'vor\n-----BEGIN PRIVATE KEY-----\nsynthetischerInhalt\n-----END PRIVATE KEY-----\nnach'],
  ['pem_offen', '-----BEGIN RSA PRIVATE KEY-----\nnurTest'],
  ['sk', 'sk-' + 'x'.repeat(20)],
  ['github', 'ghp_' + 'x'.repeat(24)],
  ['github_varianten', ['o','u','s','r'].map(c=>'gh'+c+'_'+'y'.repeat(24)).join(' ')],
  ['github_pat', 'github_pat_' + 'x'.repeat(24)],
  ['aws', 'AKIA' + 'A'.repeat(16)],
  ['slack', 'xoxb-' + 'a'.repeat(16)],
  ['google', 'AIza' + 'a'.repeat(32)],
  ['jwt', 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(8)],
  ['bearer', 'Authorization: Bearer ' + fake],
  ['bearer_kurz', 'Bearer abc'],
  ['url', 'postgresql://tester:' + fake + '@example.invalid/db'],
  ['url_kodiert', 'https://tester:nur%20test%20passwort@example.invalid/a'],
  ['assignment', 'api_key="' + fake + '" token: \'' + fake + '\' pwd="' + fake + '"'],
  ['shell_names', ['KEY','API_KEY','AUTH','CREDENTIAL','PWD','PASSWORD','PASS','TOKEN','SECRET'].map(n=>n+'='+fake).join('\r\n')],
  ['exceptions', ['wait_token','batch_token','stream_id','token_count','password_length','input_tokens','KEY_PATH'].map(n=>n+'='+fake).join('\n')],
  ['sshpass', 'sshpass -p ' + fake + ' cmd\nsshpass -p\'' + fake + '\' cmd\nsshpass -p"' + fake + '" cmd'],
  ['quotes', 'export TOKEN = "' + fake + '"\r\n# Kommentar\r\nEMPTY=""\r\nTOKEN=\r\n'],
  ['json', JSON.stringify({key:'normal',accessToken:fake,outer:{password:fake},Config:{Env:['TOKEN='+fake,'LANG=C.UTF8']}})],
  ['json_pretty', JSON.stringify({password:fake,wait_token:fake,headers:{Authorization:'Bearer '+fake}},null,2)+'\n'],
  ['json_fragment', 'prefix {"accessToken": "' + fake + '", "key": "normal"} suffix'],
  ['maskiert', 'TOKEN=[WERT]\nBearer [WERT]\n[GEHEIM]\nsshpass -p "[WERT]"'],
  ['boundary', 'sk-kurz ghp_kurz AKIA123 Bearer [WERT]'],
  ['literal', 'Wert: '+fake+' und '+fake],
  ['long', 'not JSON {"note":"' + 'token key '.repeat(6000) + '"}'],
];
// Erfasst am unveränderten Altstand, Job b4c69b46-89da-4363-8bcd-2167ca59309b.
const golden = {
  "text/plain": "3591d2fb3c67ff8e8c7cc60a426a540843b9faeabc7270f316cb8d1cd9c59736",
  "text/pem": "e682766b2119ad9f2012096fbad80670b026ab81347b5044601192ebb6d63b2f",
  "text/pem_offen": "67b473e37168fc35ac1937365b23de2f2cd9e4ca2c7929ca8d4a9227f91b99e3",
  "text/sk": "b18fee40ebb4a39c2c2f7a75aa107b8fcd6c6758863b715b25d6f773234f6d91",
  "text/github": "e8a7f988ca4c537f565ecff1e06b216b50ff03d5029cc53d80f84842f58c044b",
  "text/github_varianten": "197d7999c58f5d8761f93b14c7c311430346c0e84c3fc206815a3d1551b209f6",
  "text/github_pat": "b6197c33256b419e67b7b60ed11fb14b1c10a834e73e5c4ca921fd48e980cc80",
  "text/aws": "22fc4622c0635ced8e5a957c481ba184cf23ae46e8435d7427229eb0d553c139",
  "text/slack": "e5053dcc265337709a3594f7edcce02c960beadcc28dd43fd247dd43f68c95ac",
  "text/google": "62d537c4fda84d2e19a58d8cb590d6047de3cf2d07cfcd031babad80fc7183d2",
  "text/jwt": "7fbc58dacbcb25ef25a7900dfad9d495c8e830258872a39a2646789f737daf91",
  "text/bearer": "a1a7651a6b3645d1f4fa98376a689f308d1cc5cac8ad8d0ab879f57521a594a2",
  "text/bearer_kurz": "bf04ebef86e27c0bc7c5aea2d01836e078892ff5e6c484742bf0da1cc860d84f",
  "text/url": "2b7e0a8a7699a3fa7fb0389235985bbe8f59330b11f9a3b5d60e6bb27364c44e",
  "text/url_kodiert": "f3629d44abd6caedb5a9e396b265ac949f70ad992fd89163a64c510dfafce32b",
  "text/assignment": "ed6167a2efca10ba6e8e884c913af40aab9e702f695f2dca662f55a6a6ab23f8",
  "text/shell_names": "a143d6345be127c3a7df8d459ad147255cebebd36ddbfc55011c2edea85b538a",
  "text/exceptions": "49d2cdf537cc3f4face2e6a7ea301b605c3b0a09cbd70651b470fb886cc74822",
  "text/sshpass": "3c415b6d699acd6d01c32ea5b631d4f93102959fb1f54b22c712660adf5a1cbb",
  "text/quotes": "e4313d32b7e7bf2fe61337c73d7d39dcfba9a824ce6762af17817237e09562d9",
  "text/json": "39e1d86021dc168d1bf3ae3e394489c1f693d2849e47b610e561397bbc9d695f",
  "text/json_pretty": "663b3ee8aa040d444a05089daa593447a1c41fc04601f2498776dcafe9b299f0",
  "text/json_fragment": "866247671960808dddc35b344e0a0e6b1163c3f82f06764ce5015030ce095b17",
  "text/maskiert": "752921e1019f7f06245e8f18f97652caf4859d79022806944ce01d7704aabb06",
  "text/boundary": "1c573123896ff2b3a97147799d8edb043da2133505fe0b99651b3af7fcc2219d",
  "text/literal": "ccce7e2712e28f3c384539cee2333ecd0cdb26064d864588fe868c0b3b62b508",
  "text/long": "40a0ed8e44f489dbf19ff181532dae1e3a0e7f1dfdb6c9b46836e0387c95612d",
  "names": "cb6ac9e97de570fcc7a5a932fb261b78baeac1bdd7b82daca2fc9b46a94b94c9",
  "env": "79092703c7f86ebd8989ef2456b77b8d8951374dceb1f3e261a02a08ebe8d2ed",
  "mcp": "32a0f91e1360ee6a1cbaea96baccf2c1ed5f236b3c9e8040264d183eee4055b2",
  "literal_large": "b901049d00135822cdbe97a789f8fe4cc7d76f95e130756a9d554828211cfc12",
  "structured": "b154c0dff1486c72e4d7974497e1bee8c06e983be0cdbc6e0ba8871b265e1be6",
  "response": "2701aa0711922d84ba6361a3af37a9cfbc4ad82781a6a8ab15233d7ce3f5ce2b",
  "persistence": "e101f329f18fdff70ed96122e9925b3c2f1d57bf9c3286aadc1087ab87854e15"
}; // GOLDEN_ALTSTAND
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const values = [fake, 'test_ueberlappender_Wert', 'ueberlappender'];
const actual = {};
function capture(name, value) { actual[name] = digest(value); }
for (const [name, text] of cases) {
  capture('text/'+name, {
    shell: env.maskiereShellText(text),
    literal: env.maskiereShellText(text, values),
    explanation: explanation.schwaerzeGeheimnisse(text),
    provenance: env.maskiereShellTextMitTreffern(text, values),
  });
}
capture('names', ['KEY','keys','apiKey','accessToken','TOKEN_COUNT','wait_token','batch_token','stream_id','passwordLength','input_tokens','KEY_FILE','credential','auth','ordinary'].map(n=>[n,mcp.istShellGeheimnisName(n),mcp.istShellJsonGeheimnisName(n)]));
capture('env', [env.maskiereEnv('TOKEN="'+fake+'"\r\nEMPTY=\r\n# hi\r\nMULTI="a\nb"\n'),env.shellGeheimWerte('TOKEN='+fake+'\nPUBLIC_FLAG=1\nDATABASE_URL=postgresql://u:'+fake+'@example.invalid/db')]);
capture('mcp', [mcp.maskiereMcpJson('{"env":{"PUBLIC_FLAG":"yes"},"headers":{"X-Test":"'+fake+'"},"url":"https://u:'+fake+'@example.invalid/a"}'),mcp.maskiereMcpJsonFragment('prefix {"token": "'+fake+'"} suffix',true)]);
capture('literal_large', env.maskiereShellText('first '+fake+' last [WERT]',[fake,...Array.from({length:1500},(_,i)=>'synthetischer_langer_Wert_'+i)]));
capture('structured', shell.maskiereShellDaten({id:fake,status:'done',tail:[fake,'TOKEN='+fake],nested:{key:'public',password:fake},command:'TOKEN='+fake},values,true));

const pool = getPool();
let inserted = false;
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects WHERE name=$1',[project])).rows[0].n,0,'Testprojekt muss frei sein');
  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,os.hostname(),path.join(process.cwd(),'coedit-test','p18_rv1-nicht-vorhanden')]);
  inserted = true;
  await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size) VALUES($1,$2,'cfg/.env','.env','env',$3,'rv1-fixture',40)",[randomUUID(),project,'TOKEN='+fake]);
  const payload = {project,id:'11111111-1111-4111-8111-111111111111',status:'done',command:'echo TOKEN='+fake,output:cases.map(x=>x[1]).join('\n'),tail:[fake,'Bearer '+fake],nested:{password:fake,key:'public'}};
  capture('response',await shell.maskiereShellAntwort(project,payload));
  capture('persistence',await shell.maskiereShellVorSpeichern(project,payload));
  if (mode === 'capture') {
    console.log('GOLDEN_ALTSTAND='+JSON.stringify(actual));
  } else {
    assert.deepEqual(actual,golden,'Bytegleiche Altstand-Ausgaben einschließlich Zähler und Provenienz');
    console.log('OK Golden '+Object.keys(actual).length+' Fälle');
  }
  if (mode !== 'capture') {
    const catalog = await import('../dist/services/masken-katalog.js');
    assert(Array.isArray(catalog.MASKEN_KATALOG));
    assert.equal(new Set(catalog.MASKEN_KATALOG.map(e=>e.kennung)).size,catalog.MASKEN_KATALOG.length);
    for(const e of catalog.MASKEN_KATALOG) {
      assert.equal(typeof e.kennung,'string'); assert(e.muster instanceof RegExp);
      assert.equal(typeof e.ersatz,'function'); assert(e.anwendungsbereich.length>0);
    }
    for(const [name,text] of cases.filter(([name])=>!['plain','boundary','long','maskiert','exceptions'].includes(name))) {
      const result=catalog.maskiereMitKatalog(text,'erklaerung');
      assert.deepEqual(result,explanation.schwaerzeGeheimnisse(text),name);
      assert.equal(catalog.zaehleMaskenTreffer(text,'erklaerung'),result.treffer);
      assert.equal(typeof catalog.zaehleMaskenTreffer(text,'erklaerung'),'number');
    }
    for(const [name,text] of cases) {
      const result=catalog.maskiereMitKatalog(text,'shell',values);
      assert.deepEqual(result,{text:env.maskiereShellText(text,values).text,treffer:env.maskiereShellText(text,values).maskiert},name);
      assert.equal(catalog.zaehleMaskenTreffer(text,'shell',values),result.treffer);
    }
    const reverse=catalog.maskiereMitKatalog(cases.map(x=>x[1]).join('\n'),'reverse',values);
    for(const secret of [fake,'sk-'+'x'.repeat(20),'ghp_'+'x'.repeat(24),'AKIA'+'A'.repeat(16)])
      assert(!reverse.text.includes(secret),'Reverse maskiert bekannte und formatierte Geheimnisse');
    assert(reverse.treffer>0);
    assert.equal(catalog.zaehleMaskenTreffer(cases.map(x=>x[1]).join('\n'),'reverse',values),reverse.treffer);
    assert.deepEqual(Object.keys(reverse).sort(),['text','treffer']);
    for(const [name,text] of cases) assert.deepEqual(catalog.maskiereMitKatalog(text,'erklaerung'),catalog.maskiereMitKatalog(text,'erklaerung'),'kein RegExp-lastIndex-Leck '+name);
    assert.equal(provenance.SHELL_BEARER,catalog.SHELL_BEARER,'alter Export bleibt Alias');
    console.log('OK Katalog, Profile, Trefferzahlen ohne Werte, Reverse und alte Exporte');
  }
} finally {
  if(inserted) {
    await pool.query('DELETE FROM code_files WHERE project=$1',[project]);
    await pool.query('DELETE FROM projects WHERE name=$1',[project]);
  }
  await closePool();
}
