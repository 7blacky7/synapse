/**
 * P10-T36: E1-Kohorte erneut zählen, keinerlei historischen Befehl ausführen.
 * Historische Jobumgebungen sind nicht gespeichert: nur statische Zuweisungen auflösen.
 */
import assert from'node:assert/strict';
import {execFileSync}from'node:child_process';
import ts from'typescript';import{Pool}from'pg';import path from'node:path';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(url.pathname,'/synapse');assert.equal(url.port,'5432');
const oldSource=(file)=>execFileSync('git',['show','c37bc1d:packages/core/src/services/'+file],{encoding:'utf8'});
const dataUrl=(source)=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64');
const parser=dataUrl(oldSource('shell-sicherung-parser.ts'));
const seed=dataUrl(oldSource('shell-sicherung-seed.ts'));
const checker=await import(dataUrl(oldSource('shell-sicherung.ts').replace("'./shell-sicherung-parser.js'",()=>JSON.stringify(parser)).replace("'./shell-sicherung-seed.js'",()=>JSON.stringify(seed))));
const p=new Pool({connectionString:process.env.DATABASE_URL});const c=await p.connect();
const result={e1_kohorte:0,e1_ungeklaert:0,e2_geklärt:0,e2_weiter_ungeklaert:0,ohne_historische_umgebung:true,gruende:{}};
try{
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await c.query("DECLARE e2_cohort NO SCROLL CURSOR FOR WITH cohort AS (SELECT command,project,cwd_relative,created_at,id FROM shell_jobs ORDER BY created_at,id LIMIT 36080) SELECT c.*, (SELECT path FROM projects p WHERE p.name=c.project ORDER BY last_access DESC LIMIT 1) AS root FROM cohort c ORDER BY c.created_at,c.id");
 while(true){
  const {rows}=await c.query('FETCH FORWARD 200 FROM e2_cohort');if(!rows.length)break;
  for(const row of rows){
   result.e1_kohorte++;
   if(!checker.pruefeShellText(row.command).ungeklaert.length)continue;
   result.e1_ungeklaert++;
   const root=row.root??'/';const cwd=path.resolve(root,row.cwd_relative??'');
   const r=await ermittleShellLage(row.command,{shell:'bash',os:'linux',cwd,project_root:root,env:{},inspect:false});
   if(r.ungeklaert.length){result.e2_weiter_ungeklaert++;for(const reason of new Set(r.ungeklaert.map(x=>x.split(':')[0])))result.gruende[reason]=(result.gruende[reason]||0)+1;}
   else result.e2_geklärt++;
  }
 }
 await c.query('COMMIT');
 assert.equal(result.e1_kohorte,36080);
 assert.equal(result.e1_ungeklaert,6937,'Originalkohorte/ALT-Checker unverändert bestätigen');
 console.log(JSON.stringify(result));
}finally{c.release();await p.end();}
