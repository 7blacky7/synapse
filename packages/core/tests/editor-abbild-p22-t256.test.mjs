/**
 * P22-T256: Freeze-Abbild editor-abbild.ts.
 * Herkunft: User 680ffa06, Auftrag 33447. Nur synapse_test:5433, eigenes Testprojekt.
 * Erwartung und tatsächliches Ergebnis stehen in jeder Assertion; kein Daemon/Browser.
 * P22-T264 (01.11.2026, claude-birke): der Prüfplan-Teil (editor-pruefplan.ts) ist mit der Verwaltung zurückgebaut (User 2a26e5e1);
 *   der Speicherweg ist der User-Plan, geprüft in editor-user-plan-p22-t264.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port,'5433','P22-T256 Testziel Port 5433');assert.equal(url.pathname,'/synapse_test','P22-T256 Testziel synapse_test');
const db=await import('../dist/db/client.js'), A=await import('../dist/services/editor-abbild.js');
const pool=db.getPool(), project='test-p22-t256-'+randomUUID();
const hash=x=>createHash('sha256').update(x).digest('hex');
const insert=async(path,text)=>pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',[randomUUID(),project,path,'txt',Buffer.byteLength(text),text,hash(text)]);
try {
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'test-p22-t256','/tmp/p22-t256-'+randomUUID()]);
 await insert('src/a.txt','basis');await insert('.env','SECRET=geheim');
 const a=await A.erstelleEditorAbbild(project);
 await pool.query('UPDATE code_files SET content=$3,content_hash=$4 WHERE project=$1 AND file_path=$2',[project,'src/a.txt','agent',hash('agent')]);
 const f=await A.leseEditorAbbildDatei(project,a.id,'src/a.txt');
 assert.equal(f.inhalt,'basis','P22-T256 editor-abbild.ts: Freeze muss Basis behalten, tatsächlich '+f.inhalt);
 assert.equal(f.basis_hash,hash('basis'),'P22-T256 editor-abbild.ts: basis_hash = sha256 des Freeze-Inhalts (P22-T264 nutzt ihn als expected_hash)');
 const env=await A.leseEditorAbbildDatei(project,a.id,'.env');
 assert.equal(env.maskiert,true,'P22-T256 editor-abbild.ts: .env maskiert');assert.ok(!env.inhalt.includes('geheim'),'P22-T256 editor-abbild.ts: kein Geheimwert im Abbild');
 assert.equal(await A.leseEditorAbbildDatei('anderes-projekt',a.id,'src/a.txt'),null,'P22-T256 editor-abbild.ts: Projektbindung');
 console.log('P22-T256 editor-abbild: alle Prüfungen grün');
} finally {
 await pool.query('DELETE FROM editor_abbilder WHERE project=$1',[project]);
 await pool.query('DELETE FROM code_files WHERE project=$1',[project]);await pool.query('DELETE FROM projects WHERE name=$1',[project]);await pool.end();
}
