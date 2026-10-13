/** W3/RV10: t85 (844329d) legacy tool contracts; exact additive W3 allowlist. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const current=await import('../packages/rest-api/dist/routes/mcp.js');
const baseline=await import('/tmp/synapse-basis-844329d/packages/rest-api/dist/routes/mcp.js');
const stdio=await import('../packages/mcp-server/dist/tools/consolidated/index.js');
const stdioBase=await import('/tmp/synapse-basis-844329d/packages/mcp-server/dist/tools/consolidated/index.js');
const core=await import('../packages/core/dist/index.js');
const coreBase=await import('/tmp/synapse-basis-844329d/packages/core/dist/index.js');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function projectLegacy(def,transport){
 const d=structuredClone(def);
 if(d.name==='project'){
  assert.deepEqual(d.inputSchema.properties.mode,{type:'string',enum:['create','restore_existing'],description:transport==='stdio'?'init: restore_existing liefert ein bereits im Tray an hostname gebundenes Projekt per API; kein Stub/DB/Workspace-Start.':'init: bestehende Tray-Hostbindung via API wiederherstellen; name+hostname, kein path.'});
  delete d.inputSchema.properties.mode;
 }
 if(d.name==='asset_intel'){
  assert.deepEqual(d.inputSchema.properties.action.enum.slice(-4),['konflikte','konflikt_loesen','geloescht','wiederherstellen']);
  d.inputSchema.properties.action.enum=d.inputSchema.properties.action.enum.slice(0,-4);
  const additions={
   asset_id:{type:'string',description:'Asset-ID (konflikt_loesen Pflicht, konflikte Filter)'},
   wahl:{type:'string',enum:['pc','share'],description:'konflikt_loesen: PC übernehmen oder Share behalten'},
   basis_revision:{type:'string',description:'Bekannte Revision (wiederherstellen Pflicht)'},
   event_id:{type:'string',description:'Idempotenz-ID (wiederherstellen Pflicht)'},
  };
  for(const [name,value] of Object.entries(additions)){assert.deepEqual(d.inputSchema.properties[name],value);delete d.inputSchema.properties[name];}
  const a='; geloescht=Löschliste; wiederherstellen(asset_id,basis_revision,event_id)=neue Share-Revision';
  const b=' konflikte=offene Share/PC-Konflikte; konflikt_loesen(asset_id,wahl pc|share) über API. Share gewinnt automatisch, PC-Revision bleibt gesichert.';
  assert(d.description.includes(a));assert(d.description.includes(b));d.description=d.description.replace(a,'').replace(b,'');
 }
 return d;
}
const defs=x=>Object.entries(x).filter(([n,v])=>n.endsWith('Tool')&&v?.definition).map(([,v])=>v.definition).sort((a,b)=>a.name.localeCompare(b.name));
const oldRest=baseline.MCP_TOOLS.filter(d=>d.name!=='reverse');
const oldStdio=defs(stdioBase).filter(d=>d.name!=='reverse');
assert.equal(hash(oldRest),'f673dbff0ff47d8f4008be3c2ccd76ef1ce866b7662c3f6e35f42dca788215f9','frozen live t85 REST capture');
assert.equal(hash(oldStdio),'f767109339140006272d731e1dc26f7fa17111e50a97e9c9b49b85ccf8d9646e','frozen live t85 stdio capture');
assert.deepEqual(current.MCP_TOOLS.filter(d=>d.name!=='reverse').map(d=>projectLegacy(d,'rest')),oldRest);
assert.deepEqual(defs(stdio).filter(d=>d.name!=='reverse').map(d=>projectLegacy(d,'stdio')),oldStdio);
const oldReverse=coreBase.REVERSE_DEFINITION.inputSchema.properties;
assert(!oldReverse.action.enum.includes('functions'),'negative feature control on t85');
assert.equal(typeof coreBase.ReversePipelineDienst,'undefined','RV8 missing in live baseline');
assert.deepEqual(core.REVERSE_DEFINITION.inputSchema.properties.action.enum.slice(0,oldReverse.action.enum.length),oldReverse.action.enum);
for(const [name,property] of Object.entries(oldReverse)){
 if(name==='action')continue;
 const now=structuredClone(core.REVERSE_DEFINITION.inputSchema.properties[name]);
 if(name==='file_path')now.description=property.description;
 if(name==='medien'){assert.deepEqual(now.items.properties.art,{type:'string',enum:['image','ordner','archiv']});delete now.items.properties.art;}
 assert.deepEqual(now,property,'legacy reverse parameter '+name);
}
assert.deepEqual(core.REVERSE_DEFINITION.outputSchema,coreBase.REVERSE_DEFINITION.outputSchema);
assert.deepEqual(stdio.reverseTool.definition,core.REVERSE_DEFINITION);
assert.deepEqual(current.MCP_TOOLS.find(d=>d.name==='reverse'),core.REVERSE_DEFINITION);
console.log('W3 LEGACY PASS: frozen t85 REST+stdio bytes after exact A10/A11/A13 additions; reverse legacy parameters/output unchanged; RV8/RV10 baseline negative controls');
await core.closePool();await coreBase.closePool();process.exit(0);
