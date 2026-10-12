/** P10-T42: reine Auswahl/50er-Probe; keine Quellen- oder Marker-Schreibzugriffe.
 * node scripts/shell-altbestand-probe.mjs [--jev-50]
 * Standard: nur Inventar. --jev-50 nur für die ausdrücklich freigegebene kleine Probe.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getPool,closePool} from '../packages/core/dist/db/client.js';
import {ladeShellWerte} from '../packages/core/dist/services/shell-maske.js';
import {gruppiereShellAltbestand,bewerteShellAltbestand,shellAltIstDeterministisch} from '../packages/core/dist/services/shell-altbestand.js';
import {SHELL_ALT_REGELVERSION} from '../packages/core/dist/services/shell-altbestand-persistenz.js';
const real=process.argv.includes('--jev-50');
if(process.argv.slice(2).some(a=>a!=='--jev-50'))throw new Error('Nur Inventar oder --jev-50 erlaubt');
const pool=getPool(),werte=new Map(),gruppen=new Map(),geprueft={shell_jobs:0,tool_calls:0};
const felder={shell_jobs:['output','tail','message','error'],tool_calls:['result','args_preview','error']};
const seed='P10-T42-treffer-kontext-v2-50';
const randomKey=g=>createHash('sha256').update(seed+g.id).digest('hex');
const critical=g=>g.regel==='sshpass_passwort'||g.regel==='bearer'||g.name==='DATABASE_URL'||/DATABASE_URL\s*[=:]/.test(g.fenster);
const scanStart=Date.now();
try{
 const c=await pool.connect();
 try{
  await c.query('BEGIN READ ONLY');
  const start=(await c.query('SELECT clock_timestamp() AS t')).rows[0].t;
  await c.query('ROLLBACK');
  for(const table of ['shell_jobs','tool_calls']){
   let after=null;
   while(true){
    const params=[start],where=[(table==='shell_jobs'?'created_at':'ts')+' <= $1'];
    if(table==='tool_calls')where.push("tool_name='shell'");
    if(after!==null){params.push(after);where.push('id>$2');}
    await c.query('BEGIN READ ONLY');
    const rows=(await c.query('SELECT id::text AS id,project,'+felder[table].join(',')+' FROM '+table+' WHERE '+where.join(' AND ')+' ORDER BY id LIMIT 300',params)).rows;
    await c.query('ROLLBACK');
    if(!rows.length)break;
    after=rows.at(-1).id;geprueft[table]+=rows.length;
    const byProject=new Map();
    for(const r of rows){const p=r.project??'';if(!byProject.has(p))byProject.set(p,[]);byProject.get(p).push({tabelle:table,id:r.id,project:r.project,daten:Object.fromEntries(felder[table].map(f=>[f,r[f]]))});}
    for(const [p,part]of byProject){
     if(!werte.has(p))werte.set(p,await ladeShellWerte(p||undefined,{projektFs:p==='synapse'}));
     for(const g of gruppiereShellAltbestand(part,werte.get(p)))if(!gruppen.has(g.id))gruppen.set(g.id,g);
    }
   }
  }
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
 const all=[...gruppen.values()],kritisch=all.filter(critical),rest=all.filter(g=>!critical(g)).sort((a,b)=>randomKey(a).localeCompare(randomKey(b)));
 const categories={};for(const g of all)categories[g.regel]=(categories[g.regel]??0)+1;
 console.log(JSON.stringify({modus:real?'50er-Probe':'Inventar',regelversion:SHELL_ALT_REGELVERSION,geprueft,gruppen:all.length,kritische_gruppen:kritisch.length,kategorien:categories,scan_ms:Date.now()-scanStart,seed}));
 if(real){
  if(kritisch.length>30)throw new Error('50er-Grenze und alle kritischen Gruppen plus 20 Zufall unvereinbar; Koordinator-Entscheidung erforderlich');
  if(rest.length<50-kritisch.length)throw new Error('Zu wenige zusätzliche Gruppen für exakt 50');
  if(!process.env.JEV_OPENROUTER_API_KEY){
   const env=fs.readFileSync(path.join(os.homedir(),'dev/JEV-Test/.env'),'utf8');
   process.env.JEV_OPENROUTER_API_KEY=(env.match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1]??'').trim().replace(/^["']|["']$/g,'');
  }
  if(!process.env.JEV_OPENROUTER_API_KEY)throw new Error('Jev-Key fehlt');
  const selected=[...kritisch,...rest.slice(0,50-kritisch.length)];
  const result=await bewerteShellAltbestand(selected,{project:null,agent_id:'sol-1'});
  const decisions=new Map(result.bewertungen.map(b=>[b.gruppe,b])),verteilung={};
  for(const g of selected){const b=decisions.get(g.id),key=g.regel+' × '+(b?.bewertung??'nicht_bewertet');verteilung[key]=(verteilung[key]??0)+1;}
  const examples=selected.filter(g=>!shellAltIstDeterministisch(g)).slice(0,7);
  for(const regel of ['sshpass_passwort','url_passwort','bearer']){const g=selected.find(g=>g.regel===regel);if(g&&!examples.includes(g))examples.push(g);}
  for(const g of selected)if(examples.length<10&&!examples.includes(g))examples.push(g);
  console.log(JSON.stringify({status:result.status,auswahl:selected.length,kritisch:kritisch.length,zufall_mindestens:20,deterministisch:selected.filter(shellAltIstDeterministisch).length,jev_aufrufe:result.bewertungen.filter(b=>b.grund!=='deterministisch').length,usd:result.usd,verteilung,beispiele:examples.slice(0,10).map(g=>({regel:g.regel,name:g.name,zeile:g.zeile,fenster:g.fenster,bewertung:decisions.get(g.id)?.bewertung,confidence:decisions.get(g.id)?.confidence,grund:decisions.get(g.id)?.grund}))}));
  if(result.status!=='fertig')throw new Error('Probe wegen Jev-Budget pausiert');
  if(result.bewertungen.some(b=>b.grund.startsWith('jev_')))throw new Error('Jev-Aufruf fehlgeschlagen; Bericht prüfen');
 }
}finally{await closePool();}
