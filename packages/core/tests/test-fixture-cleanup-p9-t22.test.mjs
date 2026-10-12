import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const base = await mkdtemp(join(tmpdir(), 'p9-t22-cleanup-test-'));
const rootDirectory = join(base, 'roots');
const streamDirectory = join(base, 'streams');
await mkdir(streamDirectory);
const ownId = randomUUID();
const otherId = randomUUID();
await writeFile(join(streamDirectory, ownId + '.log'), 'own');
await writeFile(join(streamDirectory, otherId + '.log'), 'other');
await writeFile(join(streamDirectory, ownId + '.meta.json'), JSON.stringify({project:'own'}));
await writeFile(join(streamDirectory, otherId + '.meta.json'), JSON.stringify({project:'other'}));

try {
  const helper = fileURLToPath(new URL('./_helfer/test-fixture-cleanup.mjs', import.meta.url));
  const code = `import {createTestFixtureCleanup} from ${JSON.stringify(helper)};
const cleanup = createTestFixtureCleanup({rootDirectory:${JSON.stringify(rootDirectory)}, streamDirectory:${JSON.stringify(streamDirectory)}});
const hold = setInterval(() => {}, 1000);
process.once('SIGTERM', () => clearInterval(hold));
const root = await cleanup.createRoot('signal-fixture-');
await import('node:fs/promises').then(fs => fs.writeFile(root + '/fixture', 'owned'));
console.log(root);
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', childError = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { childError += chunk; });
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('child fixture did not start: ' + childError)), 5000);
    child.stdout.on('data', () => {
      if (output.includes('\n')) {
        clearTimeout(timer);
        resolveReady(output.split('\n')[0]);
      }
    });
    child.once('error', reject);
    child.once('exit', (codeValue, signal) => {
      if (!output.trim()) reject(new Error('child exited before creating fixture: ' + (signal ?? codeValue) + ' ' + childError));
    });
  });
  const exited = once(child, 'exit');
  const childRoot = await ready;
  const [codeValue, signal] = await exited;
  assert.equal(signal, null);
  assert.equal(codeValue, 143);
  await assert.rejects(stat(childRoot), {code: 'ENOENT'}, 'SIGTERM removes the child fixture');

  const {createTestFixtureCleanup} = await import('./_helfer/test-fixture-cleanup.mjs');
  const cleanup = createTestFixtureCleanup({rootDirectory, streamDirectory});
  const root = await cleanup.createRoot('normal-fixture-');
  cleanup.trackStreamId(ownId);
  await cleanup.cleanup();
  await assert.rejects(stat(root), {code: 'ENOENT'});
  await assert.rejects(readFile(join(streamDirectory, ownId + '.log')), {code: 'ENOENT'});
  await assert.rejects(readFile(join(streamDirectory, ownId + '.meta.json')), {code:'ENOENT'}, 'own stream metadata removed');
  assert.equal(await readFile(join(streamDirectory, otherId + '.meta.json'), 'utf8'), JSON.stringify({project:'other'}), 'unrelated stream metadata is preserved');
  assert.equal(await readFile(join(streamDirectory, otherId + '.log'), 'utf8'), 'other', 'unrelated stream log is preserved');
  cleanup.dispose();
  console.log('PASS P9-T22: SIGTERM/normal cleanup removes owned fixtures and only owned stream logs');
} finally {
  await rm(base, {recursive: true, force: true});
}
