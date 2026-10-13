/** W3 sol-9: echte PG/FS/Scanner/Queue/Retention, nur synapse_test:5433 und eigene mkdtemp-Wurzel. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';

const repo=process.env.SOL9_W3_REPO||fileURLToPath(new URL('../../../',import.meta.url));
const core=await import(pathToFileURL(join(repo,'packages/core/dist/index.js')).href);
const legacy=Object.fromEntries([
 ['src/main.ts',Buffer.from('export const x=1;')],['pic.png',Buffer.from([137,80,78,71,13,10,26,10])],
 ['anim.gif',Buffer.from('GIF89a')],['model.usda',Buffer.from('#usda 1.0')],['audio.wav',Buffer.from('RIFF0000WAVE')],
 ['doc.pdf',Buffer.from('%PDF-1.7')],['archive.zip',Buffer.from([80,75,3,4])],
].map(([p,head])=>[p,{klasse:core.klassifiziereDatei(p),asset:core.assetArt(p,head),format:core.standardRegistry.detect(p,head).format}]));
if(process.argv.includes('--capture')){console.log('GOLDEN_JSON='+JSON.stringify(legacy));process.exit(0);}
assert.deepEqual(legacy,JSON.parse(await fs.readFile(new URL('./fixtures/asset-w3-sol9-legacy.golden.json',import.meta.url),'utf8')));
console.log('M2 Legacy-Klassifikation bytegleich t85.');process.exit(0);
