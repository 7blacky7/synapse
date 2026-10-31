/**
 * P22-T243 (+P22-T208): volle Shell-Ausgabe in Teilen, gedeckelte Abrufe mit Hinweis 'gezielt abrufen'.
 * Quellen: core shell-ausgabe.ts, shell-queue.ts (completeShellJob, getShellJobById, getShellJobLogLines, searchShellJobLog),
 *   shell-ausgabe-schema.ts + schema-sql/171_shell_ausgabe.sql, Daemon shell-ausgabe-uebertragung.ts.
 * A: reine Funktionen (schneideAusgabeTeile) - ohne DB.
 * B: NUR synapse_test:5433, privates temporaeres PG-Schema (search_path), kein Browser/Docker; ohne synapse_test SKIP.
 * Aufruf (nach Build von core und file-watcher-daemon-ts):
 *   mise exec node@25 -- node packages/core/tests/shell-ausgabe-voll-p22-t243.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const T='P22-T243';
const check=(label,expected,actual)=>{try{assert.deepEqual(actual,expected);console.log('OK '+T+' '+label);}
 catch(e){console.error('DEBUG '+T+' '+label+' erwartet='+JSON.stringify(expected)+' tatsaechlich='+String(JSON.stringify(actual)).slice(0,500));throw e;}};
const A=await import('../dist/services/shell-ausgabe.js');

// ── A: Schneiden (gemeinsam fuer Daemon und Core) ───────────────────────────
{
 const text=Array.from({length:5000},(_,i)=>'zeile '+i+' '+'x'.repeat(i%97)).join('\n')+'\nletzte ohne umbruch';
 const {teile,rest}=A.schneideAusgabeTeile(text,4096);
 check('A schneide: Teile ergeben den Text',text,teile.join('')+rest);
 check('A schneide: final kein Rest','',rest);
 check('A schneide: jeder Teil <= Grenze (JSON-Bytes)',true,teile.every(t=>A.ausgabeJsonBytes(t)<=4096));
 check('A schneide: Schnitt an Zeilenenden',true,teile.slice(0,-1).every(t=>t.endsWith('\n')));
 check('A schneide offenLassen: unvollstaendige Zeile bleibt Rest',{teile:['a\nb\n'],rest:'halb'},A.schneideAusgabeTeile('a\nb\nhalb',4096,{offenLassen:true}));
 const lang='y'.repeat(10000),l=A.schneideAusgabeTeile(lang,1000);
 check('A schneide: ueberlange Zeile wird zerteilt',lang,l.teile.join(''));
 check('A schneide: ueberlange Zeile Teile <= Grenze',true,l.teile.every(t=>A.ausgabeJsonBytes(t)<=1000));
 const e=A.schneideAusgabeTeile('\u{1F600}'.repeat(3000),999);
 check('A schneide: Surrogatpaare bleiben ganz',true,e.teile.every(t=>!/[\ud800-\udbff]$/.test(t)&&!/^[\udc00-\udfff]/.test(t)));
 check('A schneide: Steuerzeichen zaehlen als JSON-Escape',true,A.schneideAusgabeTeile('\u001b'.repeat(3000),1200).teile.every(t=>A.ausgabeJsonBytes(t)<=1200));
 check('A filter fehler/warnungen',[true,true,false,true],[A.SHELL_LOG_FILTER.fehler.test('npm ERR! kaputt'),A.SHELL_LOG_FILTER.fehler.test('error TS2304: x'),
  A.SHELL_LOG_FILTER.fehler.test('ok 1'),A.SHELL_LOG_FILTER.warnungen.test('warning: alt')]);
}

// ── B: gegen synapse_test ───────────────────────────────────────────────────
const db=process.env.DATABASE_URL??process.env.SYNAPSE_DATABASE_URL??'';
let u;try{u=new URL(db);}catch{}
if(u?.port!=='5433'||u.pathname!=='/synapse_test'){console.log('SKIP '+T+' B: ausschliesslich synapse_test:5433 (DATABASE_URL)');process.exit(0);}
process.env.DATABASE_URL=db;
process.env.SYNAPSE_W1B_GATE_TTL_MS='0';
process.env.SYNAPSE_SECRETS_ENV='/nicht-vorhanden/p22-t243-secrets';
const C=await import('../dist/db/client.js');
const Q=await import('../dist/services/shell-queue.js');
const W=await import('../../file-watcher-daemon-ts/dist/shell-ausgabe-uebertragung.js');
const {mitLesePool}=C;
const real=C.getPool(),schema='p22_t243_'+randomUUID().replaceAll('-',''),project='p22-t243-'+randomUUID();
const pool={
 async connect(){const c=await real.connect();try{await c.query('SET search_path TO '+schema+',public');return c;}catch(e){c.release();throw e;}},
 async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}
};
const mit=f=>mitLesePool(pool,f);
const sql=await readFile(new URL('../src/db/schema-sql/171_shell_ausgabe.sql',import.meta.url),'utf8');
const root=await mkdtemp(join(tmpdir(),'p22-t243-'));
const Z=n=>'zeile '+n+' '+'z'.repeat(30);
const gross=Array.from({length:60000},(_,i)=>Z(i+1)).join('\n')+'\n'; // ~2,5 MB, 60000 Zeilen
try{
 await real.query('CREATE SCHEMA '+schema);
 for(const t of ['shell_jobs','shell_stream_chunks','agent_profil_schalter','agent_identitaeten','projects','code_files','shell_demaskierungen','tool_calls'])
  await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(sql);await pool.query(sql);
 check('B 171_shell_ausgabe.sql zweimal ausfuehrbar (6 Spalten ausgabe_*)',6,Number((await pool.query(
  "SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='shell_jobs' AND column_name LIKE 'ausgabe\\_%'",[schema])).rows[0].count));
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture',$2,true)",[project,root]);
 const neuerJob=async()=>{const id=randomUUID();
  await pool.query("INSERT INTO shell_jobs(id,project,command,status,claimed_by) VALUES($1,$2,'fixture','running','daemon-fixture-1')",[id,project]);return id;};

 // B1 Schalter AUS = Altverhalten (1 MB, keine Teile, Altform der Antworten)
 const j0=await neuerJob();
 await mit(()=>Q.completeShellJob(j0,{status:'done',exit_code:0,output:gross}));
 const r0=(await pool.query('SELECT output_truncated,ausgabe_teile FROM shell_jobs WHERE id=$1',[j0])).rows[0];
 check('B1 Schalter AUS: 1 MB gekappt, keine Teile',{t:true,teile:null},{t:r0.output_truncated,teile:r0.ausgabe_teile});
 check('B1 Schalter AUS: log-Bereich in Altform (kein total_bytes)',undefined,(await mit(()=>Q.getShellJobLogLines(j0,1,10))).total_bytes);
 check('B1 Schalter AUS: Teil wird abgelehnt','shell_ausgabe_funktion_aus',await mit(()=>A.haengeShellAusgabeTeilAn(j0,{folge:0,inhalt:'x\n'})).then(()=>'',x=>x.code));
 check('B1 Schalter AUS: filter ohne query klarer Fehler','query_fehlt',(await mit(()=>Q.searchShellJobLog(j0,'',{filter:'fehler'}))).error);

 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'shell_ausgabe_voll',true,'P22 T243 Test','user')",[project]);

 // B2 Daemon-Weg: Teile in Reihenfolge, idempotent, Luecke abgelehnt, Abschluss mit Meta
 const j1=await neuerJob();
 const {teile}=A.schneideAusgabeTeile(gross,262144);
 for(let i=0;i<teile.length;i++)await mit(()=>A.haengeShellAusgabeTeilAn(j1,{folge:i,inhalt:teile[i]}));
 const dup=await mit(()=>A.haengeShellAusgabeTeilAn(j1,{folge:0,inhalt:teile[0]}));
 check('B2 Teil idempotent je folge',{g:false,d:true},{g:dup.gespeichert,d:dup.doppelt});
 check('B2 Teil-Luecke abgelehnt','ausgabe_teil_luecke',await mit(()=>A.haengeShellAusgabeTeilAn(j1,{folge:teile.length+3,inhalt:'x'})).then(()=>'',x=>x.code));
 await mit(()=>Q.completeShellJob(j1,{status:'done',exit_code:0,ausgabe:{teile:teile.length,bytes_gesamt:Buffer.byteLength(gross)}}));
 const r1=(await pool.query('SELECT status::text AS status,output_truncated,ausgabe_stand,ausgabe_teile,ausgabe_zeilen::int AS z,length(output) AS n FROM shell_jobs WHERE id=$1',[j1])).rows[0];
 check('B2 Abschluss mit Meta: vollstaendig, Kopf <= 1 MB',{status:'done',stand:'vollstaendig',teile:teile.length,z:60000,kopf:true,t:false},
  {status:r1.status,stand:r1.ausgabe_stand,teile:r1.ausgabe_teile,z:r1.z,kopf:r1.n<=1000000,t:r1.output_truncated});
 check('B2 history: output_line_count aus den Teilen',60000,(await mit(()=>Q.getShellJobs({project,limit:50}))).find(j=>j.id===j1)?.output_line_count);

 // B3 log-Bereich ueber den vollen Bestand, gedeckelt
 const b=await mit(()=>Q.getShellJobLogLines(j1,59990,100000));
 check('B3 log-Bereich hinter 1 MB',{total:60000,erste:Z(59990),letzte:Z(60000),n:11},{total:b.total_lines,erste:b.lines[0],letzte:b.lines.at(-1),n:b.lines.length});
 const b2=await mit(()=>Q.getShellJobLogLines(j1,1,100000));
 check('B3 log-Bereich: hoechstens 500 Zeilen + naechster_bereich + hinweis',{n:500,gekappt:'zeilen',naechster:501,hinweis:true},
  {n:b2.lines.length,gekappt:b2.gekappt,naechster:b2.naechster_bereich?.from_line,hinweis:/gezielt/i.test(b2.hinweis??'')});

 // B4 Suche: voller Bestand, Kontext, Deckel mit 'N von M', Bereich, Regex-Fehler, filter
 const s=await mit(()=>Q.searchShellJobLog(j1,'zeile 45678 ',{kontext_zeilen:2}));
 check('B4 Suche im vollen Bestand mit Kontext',{n:1,nr:45678,vorher:[Z(45676),Z(45677)],nachher:[Z(45679),Z(45680)]},
  {n:s.total_matches,nr:s.matches[0]?.line_number,vorher:s.matches[0]?.vorher,nachher:s.matches[0]?.nachher});
 const viele=await mit(()=>Q.searchShellJobLog(j1,'zeile',{max_matches:5000}));
 check('B4 Suche gedeckelt: N von M + weiter_ab_zeile + hinweis',{total:60000,shown:200,weiter:201,hinweis:true,truncated:true},
  {total:viele.total_matches,shown:viele.matches.length,weiter:viele.weiter_ab_zeile,hinweis:/200 von 60000/.test(viele.hinweis??''),truncated:viele.truncated});
 const bereich=await mit(()=>Q.searchShellJobLog(j1,'zeile',{from_line:100,to_line:109}));
 check('B4 Suche im Bereich',{total:10,erste:100,voll:true},{total:bereich.total_matches,erste:bereich.matches[0]?.line_number,voll:bereich.durchsucht?.vollstaendig});
 check('B4 Suche: ungueltige Regex klarer Fehler','regex_ungueltig',(await mit(()=>Q.searchShellJobLog(j1,'(',{regex:true}))).error);
 const j2=await neuerJob();
 await mit(()=>A.haengeShellAusgabeTeilAn(j2,{folge:0,inhalt:'ok 1\nnpm ERR! kaputt\nwarning: alt\nerror TS2304: x\nok 2\n'}));
 check('B4 filter fehler',[2,4],(await mit(()=>Q.searchShellJobLog(j2,'',{filter:'fehler'}))).matches.map(m=>m.line_number));
 check('B4 filter warnungen',[3],(await mit(()=>Q.searchShellJobLog(j2,'',{filter:'warnungen'}))).matches.map(m=>m.line_number));
 check('B4 filter + query',[4],(await mit(()=>Q.searchShellJobLog(j2,'TS2304',{filter:'fehler'}))).matches.map(m=>m.line_number));

 // B5 get: nie die ganze Ausgabe
 const g=await mit(()=>Q.getShellJobById(j1,{anzeige:'kompakt'}));
 check('B5 get: Kopf + Ende statt output',{output:null,kopf:20,ende:true,total:60000,letzte:Z(60000),hinweis:true},
  {output:g.output,kopf:g.ausgabe?.kopf?.length,ende:(g.ausgabe?.ende?.length??0)>0&&g.ausgabe.ende.length<=40,total:g.ausgabe?.total_lines,
   letzte:g.ausgabe?.ende?.at(-1),hinweis:/shell\(log/.test(g.ausgabe?.hinweis??'')});

 // B6 Core-Weg (stdio/alter Daemon) mit Grenze: Kopf + Marker + Ende, nie still
 await pool.query("INSERT INTO shell_ausgabe_einstellungen(ebene,project,name,wert,grund,gesetzt_von) VALUES('projekt',$1,'max_bytes_je_job',1200000,'P22 T243 Test','user'),('projekt',$1,'ende_reserve_bytes',100000,'P22 T243 Test','user')",[project]);
 const j3=await neuerJob();
 await mit(()=>Q.completeShellJob(j3,{status:'done',exit_code:0,output:gross}));
 const r3=(await pool.query('SELECT ausgabe_stand,output_truncated,message FROM shell_jobs WHERE id=$1',[j3])).rows[0];
 check('B6 Grenze: Stand luecke, truncated, Meldung',{stand:'luecke',t:true,m:true},{stand:r3.ausgabe_stand,t:r3.output_truncated,m:/gekappt/i.test(r3.message??'')});
 check('B6 Grenze: sichtbarer Marker',1,(await mit(()=>Q.searchShellJobLog(j3,'SHELL-AUSGABE GEKAPPT'))).total_matches);
 check('B6 Grenze: Ende bleibt erhalten',[Z(60000)],(await mit(()=>A.leseShellAusgabeNeu(j3,{tail_lines:1}))).neue_zeilen);
 await pool.query('DELETE FROM shell_ausgabe_einstellungen WHERE project=$1',[project]);

 // B7 get_stream (P22-T208): laufend nur vollstaendige Zeilen, Cursor, Zeile ueber Teilgrenze
 const j4=await neuerJob();
 await mit(()=>A.haengeShellAusgabeTeilAn(j4,{folge:0,inhalt:'a\nb\nha'}));
 const s1=await mit(()=>A.leseShellAusgabeNeu(j4,{seit_zeile:1}));
 check('B7 get_stream laufend: nur vollstaendige Zeilen',{z:['a','b'],next:3,laufend:true},{z:s1.neue_zeilen,next:s1.naechste_seit_zeile,laufend:s1.laufend});
 await mit(()=>A.haengeShellAusgabeTeilAn(j4,{folge:1,inhalt:'lb\nc\n'}));
 check('B7 get_stream Cursor: Zeile ueber Teilgrenze zusammengesetzt',['halb','c'],(await mit(()=>A.leseShellAusgabeNeu(j4,{seit_zeile:s1.naechste_seit_zeile}))).neue_zeilen);

 // B8 Daemon-Uebertragung (live + final) gegen den Core: Datei == PG-Bestand
 const j5=await neuerJob();
 const datei=join(root,'stream.log');
 await writeFile(datei,'eins\nzw');
 const uebertragung=new W.ShellAusgabeUebertragung(datei,(teil)=>mit(()=>A.haengeShellAusgabeTeilAn(j5,teil)),()=>{});
 uebertragung.starteLive();
 await new Promise(r=>setTimeout(r,300));
 await appendFile(datei,'ei\n'+gross+'ohne ende');
 await uebertragung.beende();
 check('B8 Uebertragung fertig',{status:'fertig',fehler:null},{status:uebertragung.status,fehler:uebertragung.fehler});
 await mit(()=>Q.completeShellJob(j5,{status:'done',exit_code:0,ausgabe:uebertragung.meta()}));
 const alle=[];
 for(let von=1;;){const r=await mit(()=>Q.getShellJobLogLines(j5,von,von+499));alle.push(...r.lines);if(!r.naechster_bereich)break;von=r.naechster_bereich.from_line;}
 check('B8 Uebertragung: Datei == PG-Bestand',('eins\nzwei\n'+gross+'ohne ende').split('\n'),alle);

 // B9 exec-tail gedeckelt, B10 Einstellwerte/Recht
 const t=await mit(()=>A.begrenzeShellTail(project,Array.from({length:1000},(_,i)=>'t'+i)));
 check('B9 exec-tail gedeckelt',{n:200,letzte:'t999',hinweis:true},{n:t.tail.length,letzte:t.tail.at(-1),hinweis:!!t.tail_gekappt});
 const adm=await mit(()=>A.fuehreShellAusgabeAdminAus({project},null));
 check('B10 admin ohne Akteur: recht_fehlt',{success:false,error:'recht_fehlt'},{success:adm.success,error:adm.error});
 const st=await mit(()=>A.leseShellAusgabeEinstellungen(project));
 check('B10 Einstellwerte mit Quelle',{wert:500,quelle:'standard',schalter:true},{wert:st.einstellungen.log_max_zeilen.wert,quelle:st.einstellungen.log_max_zeilen.quelle,schalter:st.schalter.aktiv});
 console.log('OK '+T+' alle Pruefungen');
}finally{
 await real.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
 await rm(root,{recursive:true,force:true});
 await real.end().catch(()=>{});
}
