/** P16-T21: core contract tests, fake compiler only; DATABASE_URL must be synapse_test.
 * P16_CORE_DIST=/tmp/synapse-basis-f6b5a3a0/packages/core/dist gives the base red control:
 * a signature change produces no Dart/C# result at t101, but must produce an unchanged caller diagnostic.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env, {BUILD_PRUEFUNG: '1', BUILD_PRUEFUNG_CACHE_MS: '0', BUILD_PRUEFUNG_SPRACHEN: 'dart,csharp',
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9'});
const dist = process.env.P16_CORE_DIST ?? resolve('packages/core/dist');
const db = await import(pathToFileURL(join(dist, 'db/client.js')));
const bp = await import(pathToFileURL(join(dist, 'services/build-pruefung.js')));
const schema = await import(pathToFileURL(join(dist, 'db/build-pruefung-schema.js')));
const pool = db.getPool(), project = 'test-sol19-e3d-' + randomUUID().slice(0, 8);
const temp = mkdtempSync(join(tmpdir(), 'sol19-e3d-'));
const sha = s => createHash('sha256').update(s).digest('hex');
const fixture = {
  'dart/pubspec.yaml': 'name: probe\nenvironment:\n  sdk: ">=3.13.0 <4.0.0"\n',
  'dart/a.dart': "import 'b.dart';\nvoid main() { f(1); }\n",
  'dart/b.dart': 'void f(int x) {}\n',
  'cs/p.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  'cs/A.cs': 'class A { void Call() { B.F(1); } }',
  'cs/B.cs': 'class B { public static void F(int x) {} }',
};
let calls = [], incomplete = false, checks = 0;
const fake = {
  async pruefe(a) {
    calls.push(a);
    const dart = a.art === 'dartbuild', cs = a.art === 'csharpbuild';
    assert(dart || cs, 'only selected language reaches fake');
    assert(a.dateien.every(d => !d.pfad.startsWith('/')), 'PG snapshot relative paths');
    const source = dart ? 'dart/b.dart' : 'cs/B.cs', caller = dart ? 'dart/a.dart' : 'cs/A.cs';
    const text = a.dateien.find(d => d.pfad === source)?.inhalt ?? '';
    const projectName = dart ? 'dart' : 'cs';
    const diagnostics = [
      {datei: caller, zeile: 1, spalte: 1, code: 'OLD', meldung: 'existing baseline error', projekt: projectName, schwere: 'error'},
      ...(text.includes('string x') || text.includes('String x') ? [{datei: caller, zeile: 2, spalte: 10,
        code: dart ? 'argument_type_not_assignable' : 'CS1503', meldung: 'new call type mismatch',
        projekt: projectName, schwere: 'error'}] : []),
    ];
    return {status: incomplete ? 'teilweise' : 'fertig', dauer_ms: 1, werkzeug: dart ? 'dart 3.13.5' : 'Roslyn 10.0.402',
      projekte: a.projekte.map(projekt => ({projekt, schritt: a.art, status: incomplete ? 'abhaengigkeiten' : 'fertig',
        rc: 0, ms: 1, ...(incomplete ? {hinweis: 'dependency missing'} : {})})),
      diagnosen: incomplete ? diagnostics.map(d => ({...d, weich: true})) : diagnostics};
  },
  setzeBudget() { return false; },
  budget() { return {speicher_mb: 1536, tmpfs_mb: 384}; },
};
const pd = (file, result) => ({file_path: file, basis: fixture[file], ergebnis: result,
  ops: [{op_index: 0, agent_id: 'sol19-test', spannen: [[0, 3]]}]});
const setLanguages = async sprachen => {
  const r = await bp.fuehreBuildActionAus('build_einstellungen', {project, modus: 'setzen', sprachen, grund: 'P16-T21 fixture selection'}, 'koordinator');
  assert.equal(r.success, true, JSON.stringify(r));
};
try {
  await pool.query(schema.BUILD_PRUEFUNG_SCHEMA_SQL);
  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,false)', [project, 'test-only', temp]);
  for (const [file, text] of Object.entries(fixture)) await pool.query(
    'INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false)',
    [randomUUID(), project, file, file.split('/').at(-1), file.split('.').at(-1), Buffer.byteLength(text), text, sha(text)]);
  await pool.query('INSERT INTO build_pruefung_einstellungen(bereich,werte) VALUES($1,$2)', ['projekt:' + project, {aktiv: true, sprachen: ['dart', 'csharp']}]);
  bp.registriereBuildPruefer(fake);
  // Positive result assertion comes FIRST, so base control fails for absence of caller result rather than missing exports.
  for (const [language, file, type, caller] of [['dart', 'dart/b.dart', 'String', 'dart/a.dart'], ['csharp', 'cs/B.cs', 'string', 'cs/A.cs']]) {
    const r = await bp.pruefeBuildFuerPlan(project, [pd(file, fixture[file].replace('int x', type + ' x'))], {warten: true});
    assert(r && r.befunde.some(d => d.datei === caller), language + ': signature change must diagnose unchanged caller');
    assert.equal(r.stand.status, 'fertig');
    assert.equal(r.stand.sprache, language);
    assert.equal(r.stand.neue_fehler, 1, 'only new error; baseline error excluded');
    assert.equal(r.befunde.length, 1);
    assert.equal(r.befunde[0].op_index, null);
    checks++;
  }
  for (const language of ['dart', 'csharp']) assert(bp.BUILD_PARAMETER.sprachen.items.enum.includes(language));
  checks++;
  await setLanguages(['dart']);
  calls = [];
  assert.equal(await bp.pruefeBuildFuerPlan(project, [pd('cs/B.cs', fixture['cs/B.cs'].replace('int x', 'string x'))], {warten: true}), null);
  assert.equal(calls.length, 0, 'C# disabled');
  await setLanguages(['csharp']);
  calls = [];
  assert.equal(await bp.pruefeBuildFuerPlan(project, [pd('dart/b.dart', fixture['dart/b.dart'].replace('int x', 'String x'))], {warten: true}), null);
  assert.equal(calls.length, 0, 'Dart disabled'); checks++;
  await setLanguages(['dart', 'csharp']);
  incomplete = true;
  // New snapshot keys avoid complete cached runs from above.
  for (const [file, type] of [['dart/b.dart', 'String'], ['cs/B.cs', 'string']]) {
    const r = await bp.pruefeBuildFuerPlan(project, [pd(file, fixture[file].replace('int x', type + ' x') + '\n// missing context')], {warten: true});
    assert.equal(r.stand.status, 'teilweise', JSON.stringify(r));
    assert.equal(r.befunde.length, 0, 'partial context never blocks'); checks++;
  }
  const status = await bp.fuehreBuildActionAus('build_status', {project, pruefen: true, warten_sekunden: 10}, 'koordinator');
  assert.equal(status.success, true);
  assert(status.pruefung.sprachen.dart && status.pruefung.sprachen.csharp, JSON.stringify(status));
  checks++;
  const stored = (await pool.query('SELECT file_path,content FROM code_files WHERE project=$1', [project])).rows;
  assert.equal(stored.length, Object.keys(fixture).length);
  for (const row of stored) assert.equal(row.content, fixture[row.file_path], 'no artifact/write in project');
  checks++;
  await setLanguages([]);
  calls = [];
  assert.equal(await bp.pruefeBuildFuerPlan(project, [pd('dart/b.dart', 'void f(String x) {}')], {warten: true}), null);
  assert.equal(calls.length, 0); checks++;
  console.log('P16-T21 CORE PASS checks=' + checks);
} finally {
  bp.registriereBuildPruefer(null);
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [project]).catch(() => {});
  for (const table of ['code_files', 'agent_events']) await pool.query('DELETE FROM ' + table + ' WHERE project=$1', [project]).catch(() => {});
  await pool.query('DELETE FROM build_pruefung_einstellungen WHERE bereich=$1', ['projekt:' + project]).catch(() => {});
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  rmSync(temp, {recursive: true, force: true});
  await db.closePool();
}
