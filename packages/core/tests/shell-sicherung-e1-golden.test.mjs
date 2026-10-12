/** ALT-Golden: nur normale Build/Test/git-status-Aufrufe, eigenes Testprojekt. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.pathname,'/synapse_test');assert.equal(url.port,'5433');
const here=dirname(fileURLToPath(import.meta.url));
const root=await mkdtemp(join(homedir(),'dev','synapse-shell-e1-runtime-'));
const project='test-shell-e1-golden-'+randomUUID();
const db=await import('../dist/db/client.js');
const {execShellInProject}=await import('../dist/services/shell-exec.js');
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
 const norm={...r,stream_id:'<STREAM>',tail:r.tail.map(l=>l.split(root).join('<TEST_ROOT>'))};
 results.push({command,result:norm});
}
const bytes=JSON.stringify(results);
if(process.argv.includes('--capture'))console.log('ALT_GOLDEN='+bytes);
else assert.equal(bytes,(await readFile(join(here,'fixtures/shell-sicherung-e1.golden.json'),'utf8')).trim());
console.log('Shell E1 ALT-Golden gruen: Build/Test/git status.');
await db.closePool();process.exit(0);
