/**
 * P22-T256: Freeze-Abbild editor-abbild.ts und editor-pruefplan.ts.
 * Herkunft: User 680ffa06, Auftrag 33447. Nur synapse_test:5433, eigenes Testprojekt.
 * Erwartung und tatsächliches Ergebnis stehen in jeder Assertion; kein Daemon/Browser.
 */
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port,'5433','P22-T256 Testziel Port 5433');assert.equal(url.pathname,'/synapse_test','P22-T256 Testziel synapse_test');
const db=await import('../dist/db/client.js'), A=await import('../dist/services/editor-abbild.js'), P=await import('../dist/services/editor-pruefplan.js'), F=await import('../dist/services/file-batch.js');
const pool=db.getPool(), project='test-p22-t256-'+randomUUID();
const identitaet=await import('../dist/services/agent-bezug.js');
const koord=randomUUID(), pruefer=randomUUID(), fremd=randomUUID();
const ctx=(id,rolle,fn)=>identitaet.mitAgentAufrufKontext({principal:{art:'identity',project,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null},bezug:{modus:'neu',standard:'alt',quelle:'standard',bis:null,letzter_fehler:null}},fn);
const hash=x=>createHash('sha256').update(x).digest('hex');
const insert=async(path,text)=>pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',[randomUUID(),project,path,'txt',Buffer.byteLength(text),text,hash(text)]);
try {
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'test-p22-t256','/tmp/p22-t256-'+randomUUID()]);
 await insert('src/a.txt','basis');await insert('.env','SECRET=geheim');
 const a=await A.erstelleEditorAbbild(project);
 await pool.query('UPDATE code_files SET content=$3,content_hash=$4 WHERE project=$1 AND file_path=$2',[project,'src/a.txt','agent',hash('agent')]);
 const f=await A.leseEditorAbbildDatei(project,a.id,'src/a.txt');
 assert.equal(f.inhalt,'basis','P22-T256 editor-abbild.ts: Freeze muss Basis behalten, tatsächlich '+f.inhalt);
 const env=await A.leseEditorAbbildDatei(project,a.id,'.env');
 assert.equal(env.maskiert,true,'P22-T256 editor-abbild.ts: .env maskiert');assert.ok(!env.inhalt.includes('geheim'),'P22-T256 editor-abbild.ts: kein Geheimwert im Abbild');
 assert.equal(await A.leseEditorAbbildDatei('anderes-projekt',a.id,'src/a.txt'),null,'P22-T256 editor-abbild.ts: Projektbindung');
 const p=await P.erstelleEditorPruefplan(project,a.id,'src/a.txt','user');
 const d=await P.leseEditorPruefplan(project,p.id);
 assert.equal(d.basis,'basis','P22-T256 editor-pruefplan.ts: Abbildbasis erhalten');
 assert.equal(d.aktuell,'agent','P22-T256 editor-pruefplan.ts: Agentenstand sichtbar');
 assert.equal(d.entwurf,'user','P22-T256 editor-pruefplan.ts: Userentwurf sichtbar');
 assert.equal(d.konflikt,true,'P22-T256 editor-pruefplan.ts: Abweichung erkannt, Plan '+p.id);
 await assert.rejects(()=>P.erstelleEditorPruefplan(project,a.id,'.env','SECRET=neu'),/maskierte_datei_nur_lesbar/,'P22-T256 editor-pruefplan.ts: sensible Datei darf nicht blind gespeichert werden');
 for(const [id,rolle] of [[koord,'koordinator'],[pruefer,'subagent'],[fremd,'subagent']]) await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,$1,$1,$3,'aktiv','test')",[id,project,rolle]);
 await assert.rejects(()=>ctx(fremd,'subagent',()=>P.weiseEditorPruefplanZu(project,p.id,pruefer)),/recht_fehlt/,'P22-T256 editor-pruefplan.ts: Fremdagent darf nicht zuteilen');
 await ctx(koord,'koordinator',()=>P.weiseEditorPruefplanZu(project,p.id,pruefer));
 await assert.rejects(()=>ctx(fremd,'subagent',()=>P.meldeEditorPruefung(project,p.id,'konflikt','Testkonflikt')),/nicht_zugeteilt/,'P22-T256 editor-pruefplan.ts: nur zugeteilter Prüfer meldet');
 await assert.rejects(()=>ctx(pruefer,'subagent',()=>P.bestaetigeEditorFreigabe(project,p.id,'999999999')),/commitbeleg_oder_aktueller_stand_abweichend/,'P22-T256 editor-pruefplan.ts: Freigabe ohne belegten files-Commit wird abgelehnt');
 const meldung=await ctx(pruefer,'subagent',()=>P.meldeEditorPruefung(project,p.id,'konflikt','Stand geändert'));
 assert.equal(meldung.status,'konflikt','P22-T256 editor-pruefplan.ts: Konflikt ohne Dateischreiben zurückgeben');
 const unberuehrt=await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2',[project,'src/a.txt']);
 assert.equal(unberuehrt.rows[0].content,'agent','P22-T256 editor-pruefplan.ts: Konflikt darf Agentenstand nicht ändern');
 // Erfolgsfall: neuer Freeze, keine Abweichung; derselbe zugeteilte Agent führt den regulären files-Weg aus.
 const b=await A.erstelleEditorAbbild(project), proposal=await P.erstelleEditorPruefplan(project,b.id,'src/a.txt','user-neu');
 await ctx(koord,'koordinator',()=>P.weiseEditorPruefplanZu(project,proposal.id,pruefer));
 const filesPlan=await ctx(pruefer,'subagent',()=>F.planBatch({project,agent_id:pruefer,open_for_coedit:false,ops:[{file_path:'src/a.txt',action:'search_replace',search:'agent',replace:'user-neu'}]}));
 const vorpruefung=await ctx(pruefer,'subagent',()=>P.pruefeEditorFilesPlan(project,proposal.id,String(filesPlan.plan_id)));
 assert.equal(vorpruefung.passend,true,'P22-T256 editor-pruefplan.ts: isolierter Plan muss Freeze und Entwurf entsprechen: '+JSON.stringify(vorpruefung));
 const commit=await ctx(pruefer,'subagent',()=>F.commitBatch({plan_id:filesPlan.plan_id,agent_id:pruefer}));
 assert.equal(commit.success,true,'P22-T256 file-batch.ts: regulärer Commit erwartet, tatsächlich '+JSON.stringify(commit));
 const freigabe=await ctx(pruefer,'subagent',()=>P.bestaetigeEditorFreigabe(project,proposal.id,String(filesPlan.plan_id)));
 assert.equal(freigabe.status,'freigegeben','P22-T256 editor-pruefplan.ts: gültiger Commitbeleg muss Freigabe erlauben');
} finally {
 await pool.query('DELETE FROM specialist_inbox WHERE project=$1',[project]);await pool.query('DELETE FROM editor_pruefplaene WHERE project=$1',[project]);await pool.query('DELETE FROM editor_abbilder WHERE project=$1',[project]);
 await pool.query('DELETE FROM file_versions WHERE project=$1',[project]);await pool.query('DELETE FROM file_batch_plans WHERE project=$1',[project]);
 await pool.query('DELETE FROM agent_identitaeten WHERE project=$1',[project]);
 await pool.query('DELETE FROM code_files WHERE project=$1',[project]);await pool.query('DELETE FROM projects WHERE name=$1',[project]);await pool.end();
}
