/**
 * P10-T35: nur SELECT, Befehle nie ausführen oder ausgeben.
 * Live ausdrücklich nur --live-readonly; Seeds/Schemata werden hier nie geschrieben.
 */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {pruefeShellText,zaehleShellSicherungsBestand} from '../dist/services/shell-sicherung.js';
const u=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.argv.includes('--live-readonly')) {
  assert.equal(u.pathname,'/synapse');assert.equal(u.port,'5432');
} else { assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433'); }
const p=new Pool({connectionString:process.env.DATABASE_URL});
const client=await p.connect();
try {
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 // Alle Zeilen; LIMIT/OFFSET beeinflusst nur den Speicherbedarf, nicht die Stichprobe.
 const {rows:[size]}=await client.query('SELECT count(*)::text AS n FROM shell_jobs');
 const result={gesamt:0,harmlos:0,regel_treffer_befehle:0,jev_kandidaten:0,ungeklart:0,build_test:0,build_test_regel_treffer:0,je_regel:{}};
 await client.query('DECLARE e1_commands NO SCROLL CURSOR FOR SELECT command FROM shell_jobs ORDER BY created_at,id');
 while(true){
  const {rows}=await client.query('FETCH FORWARD 1000 FROM e1_commands');if(!rows.length)break;
  const part=zaehleShellSicherungsBestand(rows.map(x=>x.command));
  for(const k of ['gesamt','harmlos','regel_treffer_befehle','jev_kandidaten','ungeklart','build_test','build_test_regel_treffer'])result[k]+=part[k];
  for(const [k,v]of Object.entries(part.je_regel))result.je_regel[k]=(result.je_regel[k]||0)+v;
 }
 assert.equal(result.gesamt,Number(size.n));
 await client.query('COMMIT');
 console.log(JSON.stringify(result));
 assert.equal(result.build_test_regel_treffer,0,'Build/Test-Treffer sind Regelfehler');
} finally {client.release();await p.end();}
