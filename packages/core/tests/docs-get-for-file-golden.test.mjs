import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { docsTool } from '../../mcp-server/dist/tools/consolidated/docs.js';

const GOLDEN = {
  single: '39049680a8bd66ad89b9d70b77b4e80388b958c81e401987f66b63d6e9916d3f',
  multi: 'cba5622d726e28a3e538aa4c2b0b09303dc46b0be40484a87daf226a34cfeff3',
};

const basis = {
  project: 'docs-get-for-file-golden',
  agent_id: 'golden-docs',
  action: 'get_for_file',
};
const faelle = [
  ['single', { ...basis, file_path: 'src/example.ts' }],
  ['multi', { ...basis, file_path: ['src/example.ts', 'src/other.ts'] }],
];
const hashes = {};

for (const [name, args] of faelle) {
  const result = await docsTool.handler(args);
  const json = JSON.stringify(result);
  hashes[name] = createHash('sha256').update(json).digest('hex');
  console.log(`GOLDEN ${name} ${hashes[name]}`);
  if (process.env.DOCS_GET_FOR_FILE_CAPTURE !== '1') {
    assert.equal(hashes[name], GOLDEN[name], `${name}: Standardausgabe muss unveraendert bleiben`);
  }
}

if (process.env.DOCS_GET_FOR_FILE_CAPTURE !== '1') {
  const erweitert = await docsTool.handler({ ...basis, file_path: 'src/example.ts', memories: true });
  assert.ok(Object.hasOwn(erweitert, 'memories'), 'memories:true liefert das neue optionale Feld');
}
