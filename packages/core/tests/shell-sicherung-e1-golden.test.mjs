import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
/** ALT-Golden: nur normale Build/Test/git-status-Aufrufe, eigenes Testprojekt. */
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.pathname,'/synapse_test');assert.equal(url.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
const here=dirname(fileURLToPath(import.meta.url));
const root=await cleanup.createRoot('synapse-shell-e1-runtime-');
const project='test-shell-e1-golden-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
const db=await import('../dist/db/client.js');
const {execShellInProject:rawExecShellInProject}=await import('../dist/services/shell-exec.js');
const execShellInProject=trackShellStreams(cleanup,rawExecShellInProject);
// P10-T78: job_env.entfernt zaehlt die aus der AUFRUFER-Umgebung entfernten Variablen (Tokens, DB-URLs ...) und ist damit ein
// Laufzeitwert: das Golden (c37bc1da) entstand in einer Umgebung mit 7 solcher Variablen, ein Synapse-Shell-Job hat nur noch 1.
// Deshalb exakt gegen baueJobUmgebung derselben Umgebung pruefen und im Golden normalisieren (Regel: nur Laufzeitwerte).
const{baueJobUmgebung}=await import('../dist/services/shell-job-umgebung.js');
const erwartetEntfernt=(await baueJobUmgebung(project,{leseZugang:async()=>null})).info.entfernt;
const actualFetch=globalThis.fetch;
globalThis.fetch=(u,opts)=>String(u).includes('/projects/')&&String(u).includes('/status')
 ? Promise.resolve(new Response('{"enabled":true}',{status:200})):actualFetch(u,opts);
await db.getPool().query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'test',root]);
await writeFile(join(root,'package.json'),JSON.stringify({name:'shell-e1-fixture',version:'1.0.0',scripts:{build:'node -e "console.log(\'BUILD_OK\')"',test:'node -e "console.log(\'TEST_OK\')"'}}));
execFileSync('git',['init','--quiet',root]);
const results=[];
for(const command of ['pnpm build','pnpm test','git status --short']){
 const r=await execShellInProject({project,command,tail_lines:100});
 assert.equal(r.exit_code,0);
 assert.equal(r.job_env?.entfernt,erwartetEntfernt,'job_env.entfernt = entfernte Variablen der Aufrufer-Umgebung');
 const norm={...r,stream_id:'<STREAM>',job_env:{...r.job_env,entfernt:'<ENTFERNT>'},tail:r.tail.map(l=>l.split(root).join('<TEST_ROOT>'))};
 results.push({command,result:norm});
}
const bytes=JSON.stringify(results);
if(process.argv.includes('--capture'))console.log('ALT_GOLDEN='+bytes);
else assert.equal(bytes,(await readFile(join(here,'fixtures/shell-sicherung-e1.golden.json'),'utf8')).trim());
console.log('Shell E1 ALT-Golden gruen: Build/Test/git status.');


}finally{
 globalThis.fetch=oldFetch;
 try{
  try{
   if(fixtureApp)await fixtureApp.close();
   if(fixtureProjects.length){
    const pool=(await import('../dist/db/client.js')).getPool();
    const{rows}=await pool.query('SELECT stream_id FROM shell_jobs WHERE project=ANY($1::text[]) AND stream_id IS NOT NULL',[fixtureProjects]);
    for(const row of rows)cleanup.trackStreamId(row.stream_id);
    await pool.query('DELETE FROM projects WHERE name=ANY($1::text[])',[fixtureProjects]);
   }
  }finally{await(await import('../dist/db/client.js')).closePool();}
 }finally{await cleanup.cleanup();cleanup.dispose();}
}
