/** A10 extends internal complete reads; legacy code_intel response stays byte-identical to LIVE t85. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const roots=[pathToFileURL('/tmp/synapse-basis-844329d/'),new URL('../',import.meta.url)];
const bodies=['export const x=1;\n','x'.repeat(90000),'first\nsecond-long-line\nthird\n','SECRET=fixture\nNEXT=fixture\n'];
const names=['src/a.ts','src/long.ts','src/range.ts','.env'];
const opts=[undefined,undefined,{from:2,to:2,truncate_long_lines:8},undefined];
async function capture(root){
 const client=await import(new URL('packages/core/dist/db/client.js',root));
 const intel=await import(new URL('packages/core/dist/services/code-intel.js',root));
 let index=0;
 const pool={query:async()=>({rows:[{file_path:names[index],file_type:'ts',file_size:Buffer.byteLength(bodies[index]),content:bodies[index]}]})};
 try{
  const values=[];
  for(index=0;index<bodies.length;index++)values.push(await client.mitLesePool(pool,()=>intel.getFileContent('p13-a10-golden',names[index],opts[index])));
  return values;
 }finally{await client.closePool();}
}
const before=await capture(roots[0]),after=await capture(roots[1]);
assert.deepEqual(after,before);
console.log('GOLDEN PASS 4/4 against LIVE t85 844329d: small, >80k default reduction, line range, secret masking; SHA256='+createHash('sha256').update(JSON.stringify(before)).digest('hex'));
