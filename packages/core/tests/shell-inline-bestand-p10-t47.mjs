/** P10-T47: ausschließlich read-only Shell-Bestandszählung, keine Inhalte ausgeben. */
import assert from'node:assert/strict';import path from'node:path';
import{getPool,closePool}from'../dist/db/client.js';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';
import{holeShellStartKatalog}from'../dist/services/shell-sicherungs-lauf.js';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse');assert.equal(u.port,'5432');
const katalog=await holeShellStartKatalog(),counts={gesamt:0,anleitung:0,inline_anleitung:0,nach_grund:{},gespeicherte_lage:0};
const bis=process.argv.find(x=>x.startsWith('--bis='))?.slice(6)??new Date().toISOString();assert.ok(Number.isFinite(Date.parse(bis)));let cursor='0';
for(;;){
 const{rows}=await getPool().query("SELECT j.id::text,j.project,j.command,j.cwd_relative,j.sicherung,p.path AS root FROM shell_jobs j LEFT JOIN projects p ON p.name=j.project WHERE j.created_at>=$2::timestamptz-INTERVAL '7 days' AND j.created_at<=$2::timestamptz AND j.id::text>$1 ORDER BY j.id::text LIMIT 500",[cursor,bis]);
 if(!rows.length)break;
 for(const row of rows){
  cursor=row.id;const known=row.sicherung?.lage,root=known?.project_root??row.root??'/unknown';
  const ctx={shell:known?.shell??'sh',os:known?.os??'linux',cwd:known?.cwd??path.resolve(root,row.cwd_relative??''),project_root:root,env:{},env_vollstaendig:false,inspect:false};
  const lage=process.argv.includes('--alt')?(known??await ermittleShellLage(row.command,ctx)):await ermittleShellLage(row.command,ctx);if(known)counts.gespeicherte_lage++;
  const result=pruefeShellStart({project:row.project,command:row.command,lage,agent_id:'sol-2'},katalog);counts.gesamt++;
  if(result.antwort?.stufe!=='anleitung'||result.darf_starten)continue;
  counts.anleitung++;
  const reasons=lage.ungeklaert??[];
  for(const reason of new Set(reasons)){const group=reason.split(':')[0];counts.nach_grund[group]=(counts.nach_grund[group]??0)+1;}
  if(reasons.includes('inline_oder_script_lage_unbekannt')||reasons.includes('interpreter_datei'))counts.inline_anleitung++;
 }
}
console.log('P10_T47_7TAGE_'+(process.argv.includes('--alt')?'ALT':'NEU')+'='+JSON.stringify(counts));
await closePool();process.exit(0);
