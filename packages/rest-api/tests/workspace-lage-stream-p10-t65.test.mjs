/** t84: echter Docker-Modem-Demux beendet nicht den stdout-PassThrough. Kein Docker/SQL nötig. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {WorkspaceOrchestrator} from '../dist/services/workspace-orchestrator.js';
const frame=text=>{
 const data=Buffer.from(text),header=Buffer.alloc(8);
 header[0]=1;header.writeUInt32BE(data.length,4);return Buffer.concat([header,data]);
};
const probe=async text=>{
 const orch=new WorkspaceOrchestrator();
 const container={exec:async()=>({start:async()=>{
  const stream=new PassThrough();
  setImmediate(()=>stream.end(frame(text)));return stream;
 }})};
 // Originaler docker-modem-Demux der produktiven Dockerode-Instanz.
 return orch.lageProbeImContainer(container,{variablen:[]},'/workspace');
};
test('Workspace-Lageprobe endet am echten Docker-Rohstream',async()=>{
 const value={cwd:'/workspace',os:'linux',env:{},pfade:[]};
 assert.deepEqual(await probe(JSON.stringify(value)),value);
});
test('Workspace-Lageprobe verwirft ungültige Ausgabe',async()=>{
 await assert.rejects(()=>probe('kein JSON'),/workspace_lage_helfer_nicht_verfuegbar/);
});
test('Workspace-Lageprobe behält die Ausgabegrenze',async()=>{
 await assert.rejects(()=>probe('x'.repeat(262145)),/workspace_lage_grenze/);
});
