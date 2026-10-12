/** P6-T41: echter PG-Poller, verspäteter Commit und periodischer Vollabgleich. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port,'5433'); assert.equal(db.pathname,'/synapse_test');
const schema = 'sol3_pgfs_' + randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path='+schema+',public');
process.env.DATABASE_URL=db.toString();
process.env.SYNAPSE_PGFS_OVERLAP_MS='10000';
process.env.SYNAPSE_PGFS_FULL_RECONCILE_MS='12000';
process.env.SYNAPSE_PGFS_FULL_BATCH_FILES='2';
process.env.QDRANT_URL='http://127.0.0.1:9';
process.env.OLLAMA_URL='http://127.0.0.1:9';
const {getPool}=await import('../dist/db/client.js');
const {startFileWatcher}=await import('../dist/watcher/index.js');
const pool=getPool(),query=pool.query.bind(pool);
const project='sol-3-pgfs-'+randomUUID();
const root=resolve('coedit-test',project);
fs.mkdirSync(root,{recursive:true});
const sha=s=>createHash('sha256').update(s).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const exists=p=>fs.existsSync(join(root,p));
async function until(test,ms=8000) {
  const end=Date.now()+ms;
  while(!test()&&Date.now()<end) await pause(50);
  return test();
}
async function row(file,content,old=false) {
  await query(`INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size,updated_at)
    VALUES(gen_random_uuid()::text,$1,$2,$2,'txt',$3,$4,$5,CASE WHEN $6 THEN NOW()-interval '1 day' ELSE NOW() END)`,
    [project,file,content,sha(content),Buffer.byteLength(content),old]);
}
const logs=[],original=console.error;
console.error=(...args)=>{logs.push(args.map(String).join(' '));original(...args);};
let watcher,slow;
const failures=[];
function check(label,ok) {if(!ok) failures.push(label);}
try {
  await query('CREATE SCHEMA '+schema);
  await query('CREATE TABLE code_files (LIKE public.code_files INCLUDING ALL)');
  await query('CREATE TABLE file_versions (LIKE public.file_versions INCLUDING ALL)');
  await row('start.txt','START',true);
  watcher=startFileWatcher({projectPath:root,projectName:project,onFileChange:()=>{}});
  assert(await until(()=>exists('start.txt')),'Positivkontrolle: Startabgleich schreibt vorhandenen PG-Stand');
  const baseline=logs.length;
  // A hält nur eigene Fixturezeilen. BEGIN, Sleep und COMMIT sind EIN Serveraufruf:
  // keine offene Transaktion wartet auf den Testclient; Timeouts begrenzen alle Sperren.
  const client=await pool.connect();
  slow=client.query(`BEGIN;
    SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='10s';
    INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size,updated_at)
      VALUES(gen_random_uuid()::text,'${project}','a.txt','a.txt','txt','A','${sha('A')}',1,NOW());
    SELECT pg_sleep(5);
    COMMIT;`).finally(()=>client.release());
  await pause(700);
  await row('b.txt','B');
  assert(await until(()=>exists('b.txt'),3500),'Positivkontrolle: B sichtbar und gepollt, während A offen ist');
  assert(!exists('a.txt'),'A ist vor COMMIT unsichtbar');
  await slow; slow=null;
  check('A trotz älterem updated_at nach B synchronisiert',await until(()=>exists('a.txt'),3500));
  check('Überlappung als Nachholen protokolliert',logs.slice(baseline).some(l=>l.includes('Nachgeholt')&&l.includes('a.txt')&&l.includes('Überlappung')));
  // Beliebig alter Merkpunkt außerhalb jeder Überlappung: nur Vollabgleich kann ihn finden.
  await row('vergessen.txt','ALT',true);
  fs.writeFileSync(join(root,'fremd.txt'),'USER');
  await row('fremd.txt','PG',true);
  check('periodischer Vollabgleich holt alten Stand nach',await until(()=>exists('vergessen.txt'),22000));
  check('Vollabgleich protokolliert Nachholen',logs.some(l=>l.includes('Nachgeholt')&&l.includes('vergessen.txt')&&l.includes('Vollabgleich')));
  assert.equal(fs.readFileSync(join(root,'fremd.txt'),'utf8'),'USER','unbekannte lokale Änderung bleibt geschützt');
  assert.equal(fs.readFileSync(join(root,'start.txt'),'utf8'),'START');
  assert.equal(fs.readFileSync(join(root,'b.txt'),'utf8'),'B');
  if(exists('a.txt')) assert.equal(fs.readFileSync(join(root,'a.txt'),'utf8'),'A');
  check('Vollabgleich-Statistik mit Projekt, Dateien, Dauer und Nachholzahl',await until(()=>logs.some(l=>l.includes('PG→FS Vollabgleich:')&&l.includes(project)&&l.includes('Dateien=5')&&/Dauer_ms=\d+ nachgeholt=1/.test(l)),8000));
  assert.deepEqual(failures,[],failures.join('\n'));
  console.log('PASS P6-T41: A nach B, Start-/Vollabgleich, Hashschutz und Nachholprotokoll');
} finally {
  await slow?.catch(()=>{});
  await watcher?.stop();
  console.error=original;
  await query('DROP SCHEMA '+schema+' CASCADE');
  await pool.end();
  fs.rmSync(root,{recursive:true,force:true});
}
