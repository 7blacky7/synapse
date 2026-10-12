import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { docsTool } from '../../mcp-server/dist/tools/consolidated/docs.js';
import { handleToolCall } from '../../rest-api/dist/routes/mcp.js';

const GOLDEN = {
  single: '39049680a8bd66ad89b9d70b77b4e80388b958c81e401987f66b63d6e9916d3f',
  multi: 'cba5622d726e28a3e538aa4c2b0b09303dc46b0be40484a87daf226a34cfeff3',
};
const REST_GOLDEN = {
  single: '4a05d888e990356967987e8d15612bdfd405f5d1e80d44b3dd17059e9b99cc11',
  multi: '7043d85afc3110fe5b2cca0911d86c5570086ab944ffcedf03b54c5629d863c4',
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
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
for (const [name, args] of faelle) {
  const stdio = await docsTool.handler(args);
  const rest = await handleToolCall('docs', args, 'golden-docs');
  const stdioHash = hash(stdio);
  const restHash = hash(rest);
  console.log(`GOLDEN stdio-${name} ${stdioHash}`);
  console.log(`GOLDEN rest-${name} ${restHash}`);
  if (process.env.DOCS_GET_FOR_FILE_CAPTURE !== '1') {
    assert.equal(stdioHash, GOLDEN[name], `${name}: stdio-Standardausgabe bleibt bytegleich`);
    assert.equal(restHash, REST_GOLDEN[name], `${name}: REST-Standardausgabe bleibt bytegleich`);
  }
}

if (process.env.DOCS_GET_FOR_FILE_CAPTURE !== '1') {
  const erweitert = await docsTool.handler({ ...basis, file_path: 'src/example.ts', memories: true });
  assert.ok(Object.hasOwn(erweitert, 'memories'), 'memories:true liefert das optionale Feld');

  const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
  assert.equal(dbUrl.pathname, '/synapse_test', 'Tests laufen ausschliesslich gegen synapse_test');
  assert.equal(dbUrl.port, '5433', 'Tests laufen ausschliesslich gegen die Test-Instanz');
  const here = new URL('.', import.meta.url);
  const lade = (p) => import(new URL(p, here).href);
  const [{ getPool }, cw, versions] = await Promise.all([
    lade('../dist/db/client.js'),
    lade('../dist/services/code-write.js'),
    lade('../dist/services/file-versions.js'),
  ]);
  const pool = getPool();
  const project = `docs-steckbrief-${randomUUID()}`;
  const file = 'stale.txt';
  try {
    assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
    const alt = Array.from({ length: 50 }, (_, i) => `alte zeile ${i}`).join('\n') + '\n';
    const neu = Array.from({ length: 10 }, (_, i) => `neue zeile ${i}`).join('\n') + '\n';
    await cw.createFileInPg(project, file, alt, 'docs-steckbrief-test', 'Fixture anlegen');
    const baseline = await pool.query(
      'SELECT id::text AS id FROM file_versions WHERE project=$1 AND file_path=$2 ORDER BY id DESC LIMIT 1',
      [project, file],
    );
    assert.ok(baseline.rows[0]?.id, 'Positivkontrolle legt einen Baseline-Snapshot an');
    const meta = {
      datei_hash: createHash('sha256').update(alt).digest('hex'),
      file_version_id: baseline.rows[0].id,
      funktionen: [],
    };
    await pool.query(
      'INSERT INTO memories (id, project, name, category, content, tags, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())',
      [randomUUID(), project, 'steckbrief-stale-txt', 'documentation', `<!-- synapse-steckbrief:${JSON.stringify(meta)} -->\nGültiger Starttext`, ['steckbrief']],
    );
    await cw.updateFileInPg(project, file, neu, 'docs-steckbrief-test', 'update', undefined, 'Mehr als 20 Prozent geändert');
    await versions.listFileVersions(project, file, 500);

    const args = { project, agent_id: 'golden-docs', action: 'get_for_file', file_path: file, framework_warnungen: false, steckbrief: true };
    const stdio = await docsTool.handler(args);
    const rest = await handleToolCall('docs', args, 'golden-docs');
    assert.equal(stdio.steckbrief.möglicherweise_veraltet, true);
    assert.match(stdio.steckbrief.hinweis, />20|stark geändert|veraltet/);
    assert.ok(stdio.steckbrief.aenderungsanteil_zeilen > 0.2, 'Zeilenanteil muss die 20-%-Schwelle überschreiten');
    assert.deepEqual(rest.steckbrief, stdio.steckbrief, 'beide Wege nutzen denselben Core-Steckbrief');

    const fehlend = { ...args, file_path: 'missing.txt' };
    for (const [name, handler] of [
      ['stdio', (a) => docsTool.handler(a)],
      ['REST', (a) => handleToolCall('docs', a, 'golden-docs')],
    ]) {
      const result = await handler(fehlend);
      assert.equal(result.steckbrief.inhalt, null, `${name}: fehlender Steckbrief hat keinen Inhalt`);
      assert.match(result.steckbrief.hinweis, /Kein Steckbrief gespeichert/);
      assert.ok(Array.isArray(result.steckbrief.struktur.einstiegspunkte));
    }
    console.log('OK: fehlender Steckbrief und >20-%-Veraltet-Hinweis in stdio + REST');
  } finally {
    await pool.query('DELETE FROM memories WHERE project=$1', [project]);
    await pool.query('DELETE FROM file_versions WHERE project=$1', [project]);
    await pool.query('DELETE FROM code_files WHERE project=$1', [project]);
    await pool.end();
  }
}
process.exit(0);
