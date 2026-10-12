/** P6-T41: rein lesender PG/Platten-Hashbenchmark der drei größten lokalen Projekte. */
import fs from 'node:fs';
import {hostname} from 'node:os';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {getPool} from '../packages/core/dist/db/client.js';
const pool=getPool(),client=await pool.connect();
try {
  await client.query('SET default_transaction_read_only = on');
  await client.query("SET statement_timeout = '30s'");
  const projects=await client.query(`SELECT p.name,p.path,COUNT(*)::int AS files,COALESCE(SUM(cf.file_size),0)::text AS bytes
    FROM projects p JOIN code_files cf ON cf.project=p.name
    WHERE p.hostname=$1 AND cf.content IS NOT NULL AND cf.deleted_at IS NULL
    GROUP BY p.name,p.path ORDER BY SUM(cf.file_size) DESC NULLS LAST LIMIT 3`,[hostname()]);
  for(const project of projects.rows) {
    const start=performance.now();
    const files=await client.query('SELECT file_path,content_hash FROM code_files WHERE project=$1 AND content IS NOT NULL AND deleted_at IS NULL ORDER BY file_path',[project.name]);
    const queryMs=performance.now()-start;
    let hashed=0,bytes=0,missing=0,errors=0,outside=0,different=0;
    let batchStart=performance.now(),batchFiles=0,maxBatchMs=0;
    const differences=[];
    const root=resolve(project.path);
    for(const file of files.rows) {
      const target=resolve(root,file.file_path),rel=relative(root,target);
      if(isAbsolute(file.file_path)||rel==='..'||rel.startsWith('../')||isAbsolute(rel)){outside++;continue;}
      try {
        const content=fs.readFileSync(target,'utf8');
        bytes+=Buffer.byteLength(content); hashed++;
        const hash=createHash('sha256').update(content).digest('hex');
        if(hash!==file.content_hash){
          different++;
          const known=await client.query('SELECT 1 FROM file_versions WHERE project=$1 AND file_path=$2 AND content_hash=$3 LIMIT 1',[project.name,file.file_path,hash]);
          differences.push({path:file.file_path,known_version:known.rows.length>0});
        }
      } catch(error) {if(error.code==='ENOENT')missing++;else errors++;}
      if(++batchFiles===500){maxBatchMs=Math.max(maxBatchMs,performance.now()-batchStart);batchStart=performance.now();batchFiles=0;}
    }
    if(batchFiles)maxBatchMs=Math.max(maxBatchMs,performance.now()-batchStart);
    console.log(JSON.stringify({project:project.name,pg_files:project.files,pg_bytes:Number(project.bytes),hashed,bytes,missing,errors,outside,different,differences,batch_files:500,max_batch_ms:Math.round(maxBatchMs),query_ms:Math.round(queryMs),total_ms:Math.round(performance.now()-start)}));
  }
} finally {client.release();await pool.end();}
