/**
 * P22-T116: reine Funktionen der Runtime-Agenten-Uebersicht (ohne DB, ohne Netz).
 *   pnpm --filter @synapse/core build && node packages/core/tests/runtime-agenten-uebersicht-p22-t116.test.mjs
 */
import assert from 'node:assert/strict';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const m=await import(pathToFileURL(join(repo,'packages/core/dist/services/runtime-agenten-uebersicht.js')).href);
const jetzt=Date.parse('2026-10-24T11:30:00Z');
const basis={project:'synapse',wrapperPid:1,innerPid:2,model:'opus',modelFullId:null,provider:'anthropic',busy:false,currentTask:null,
 contextCeiling:200000,tokensInput:10,tokensOutput:1,tokensPercent:5,channels:[],connectedMcp:false,heartbeatEnabled:true,heartbeatIntervalMs:null};
const t107={...basis,identityId:'d6dc4703',agentName:'koordinator-test-t107',status:'crashed',heartbeatEnabled:false,
 socketPath:'/root/.synapse/agent-runs/d6dc4703/koordinator-test-t107.sock',lastActivity:new Date('2026-10-24T10:23:12Z'),currentTask:'warte'};
const still={...basis,agentName:'still',status:'idle',heartbeatEnabled:false,socketPath:'/home/x/.synapse/sockets/still.sock',lastActivity:new Date(jetzt-1000)};
const alt={...basis,agentName:'alt',status:'running',busy:true,socketPath:'',lastActivity:new Date(jetzt-3600_000)};

assert.deepEqual(m.ortFuer(t107),{ort:'container',runtime:'claude'});
assert.deepEqual(m.ortFuer({...t107,provider:'openai'}),{ort:'container',runtime:'codex'});
assert.deepEqual(m.ortFuer(still),{ort:'pc',runtime:null});
assert.deepEqual(m.ortFuer(alt),{ort:'unbekannt',runtime:null});
assert.deepEqual(m.ortFuer(still,{start_ort:'container',start_ziel:'codex'}),{ort:'container',runtime:'codex'});

assert.deepEqual(m.warnungenFuer(t107,jetzt,600_000),['crashed']);
assert.deepEqual(m.warnungenFuer(still,jetzt,600_000),['laeuft_ohne_heartbeat_und_auftrag']);
assert.deepEqual(m.warnungenFuer(alt,jetzt,600_000),['busy_veraltet']);
assert.deepEqual(m.warnungenFuer({...still,heartbeatEnabled:true},jetzt,600_000),[]);

const u=m.baueRuntimeUebersicht([t107,still,alt],{jetzt,veraltetMs:600_000});
assert.equal(u.anzahl,3);
assert.equal(u.warnungen_gesamt,3);
assert.deepEqual(Object.keys(u.orte).sort(),['container:claude','pc','unbekannt']);
const e=u.orte['container:claude'][0];
assert.equal(e.name,'koordinator-test-t107');
assert.equal(e.identity_id,'d6dc4703');
assert.equal(e.quelle,'identitaet');
assert.equal(e.heartbeat.an,false);
assert.equal(e.inaktiv_sekunden,4008);
assert.equal(u.orte.pc[0].quelle,'legacy');

const gross=m.baueRuntimeUebersicht([{...still,currentTask:'x'.repeat(500)}],{jetzt});
assert.equal(gross.orte.pc[0].auftrag.length,200);
assert.equal(m.RUNTIME_UEBERSICHT_FUNKTION,'runtime_agenten_uebersicht');
console.log('OK runtime-agenten-uebersicht-p22-t116');
