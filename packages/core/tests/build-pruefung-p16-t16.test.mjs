/**
 * P16-T16 Etappe 1 (Testphase Welle 1): projektweite Build-Pruefung (core services/build-pruefung.ts) mit
 * FAKE-Pruefserver (kein Docker). Gegen synapse_test (DATABASE_URL des Shell-Jobs), eigenes Testprojekt, wird
 * am Ende vollstaendig entfernt.
 *
 * Geprueft: Schema 101 (idempotent, Spalten, Spiegel in schema.ts, Probelauf ensureSchema nurProbe), Schalter
 * Standard aus (Antwort ohne build-Stufe), Rechte/Validierung build_einstellungen, Vorrang Projekt > global > Env,
 * nicht_verfuegbar ohne Pruefer, Wrapper-tsconfig (paths -> Quellen, wurzel_ersetzen), betroffene Projekte
 * (transitiv, unabhaengiges Paket nicht), nur NEUE Fehler (Altfehler auch verschoben nicht), Befundform
 * (quelle build, Code-Hash, op-Zuordnung/beteiligt), Dedupe, Basis-Cache (auch nach commit), teilweise
 * (Zeitlimit, Schnappschuss zu gross) sperrt nicht, Warteschlange (eingereiht, FIFO-Ausfuehrung, Event),
 * Quittieren, Budget -> setzeBudget, build_status (laeuft/rot/pruefen:true).
 *
 * Aufruf: node packages/core/tests/build-pruefung-p16-t16.test.mjs   (vorher pnpm --filter @synapse/core build)
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Selbstschutz: nur synapse_test (5433), nie die Prod-DB ──────────────────────────────────────────────────
const ziel = new URL(process.env.DATABASE_URL ?? 'http://ungueltig');
assert.equal(ziel.port, '5433', 'DATABASE_URL muss auf die Test-Instanz 5433 zeigen');
assert.equal(ziel.pathname, '/synapse_test', 'DATABASE_URL muss synapse_test sein');

delete process.env.BUILD_PRUEFUNG;
delete process.env.BUILD_PRUEFUNG_MAX_MB;
Object.assign(process.env, {
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', SYNTAX_WORKER_THREADS: '0',
  FEHLERPRUEFUNG_TYPEN: '0', BUILD_PRUEFUNG_CACHE_MS: '0', SYNAPSE_COMMIT_WAIT_SYNC_MAX_SECONDS: '0',
});

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.P16_CORE_DIST ?? resolve(hier, '../dist');
const lade = (p) => import(pathToFileURL(join(dist, p)).href);
const db = await lade('db/client.js');
const bp = await lade('services/build-pruefung.js');
const pb = await lade('services/plan-befunde.js');
const batch = await lade('services/file-batch.js');
const schemaMod = await lade('db/build-pruefung-schema.js');

const pool = db.getPool();
const project = 'test-tpd-p16t16-' + randomUUID().slice(0, 8);
const agent = 'tpd-test-' + randomUUID().slice(0, 8);
const tmpRoot = mkdtempSync(join(tmpdir(), 'tpd-p16t16-'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
let ok = 0;
const check = async (name, fn) => { await fn(); ok++; console.log('OK ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fixture: Monorepo mit a -> b, unabhaengigem c ────────────────────────────────────────────────────────────
const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, rootDir: 'src', outDir: 'dist', module: 'NodeNext' }, include: ['src'] });
const B_GUT = 'export function f(a: number): number { return a; }\n';
const B_ZWEI = 'export function f(a: number, b: number): number { return a + b; }\n';
const A_GUT = "import { f } from '@bp/b';\nexport const x: number = f(1);\nconst y = alt; // ALTFEHLER\n";
const C_GUT = 'export const c = 1;\n';
const FIXTURE = {
  'package.json': '{"name":"bp-root","private":true}',
  'packages/b/package.json': '{"name":"@bp/b","type":"module","main":"dist/index.js","types":"dist/index.d.ts"}',
  'packages/b/tsconfig.json': TSCONFIG,
  'packages/b/src/index.ts': B_GUT,
  'packages/a/package.json': '{"name":"@bp/a","type":"module","dependencies":{"@bp/b":"workspace:*"}}',
  'packages/a/tsconfig.json': TSCONFIG,
  'packages/a/src/index.ts': A_GUT,
  'packages/c/package.json': '{"name":"@bp/c","type":"module"}',
  'packages/c/tsconfig.json': TSCONFIG,
  'packages/c/src/index.ts': C_GUT,
  'docs/readme.md': '# nicht relevant\n',
};

async function seed(file, content) {
  const type = file.split('.').at(-1);
  await pool.query(`INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored,parsed_at,parser_version,tsv,tsv_zerlegt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),1,to_tsvector('english',$7),to_tsvector('simple',$7))
    ON CONFLICT(project,file_path) DO UPDATE SET content=$7,content_hash=$8,file_size=$6,file_type=$5,parsed_at=NOW(),parser_version=1,
      tsv=to_tsvector('english',$7),tsv_zerlegt=to_tsvector('simple',$7),deleted_at=NULL`,
  [randomUUID(), project, file, file.split('/').at(-1), type, Buffer.byteLength(content), content, sha(content)]);
}
const inhalt = async (file) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2', [project, file])).rows[0]?.content;

// ─── Fake-Pruefserver (Vertrag BuildPrueferAnbindung) ────────────────────────────────────────────────────────
const fake = {
  aufrufe: [], modus: 'normal', sperre: null, budgetAufrufe: [], ist: { speicher_mb: 384, tmpfs_mb: 64 },
  sperren() { let release; const promise = new Promise((r) => { release = r; }); this.sperre = { promise, release }; },
  freigeben() { const s = this.sperre; this.sperre = null; s?.release(); },
  async pruefe(auftrag) {
    this.aufrufe.push(auftrag);
    if (this.sperre) await this.sperre.promise;
    if (this.modus === 'wirft') throw new Error('Container weg (Fake)');
    const dateien = new Map(auftrag.dateien.map((d) => [d.pfad, d]));
    const projekte = [];
    const diagnosen = [];
    for (const w of auftrag.projekte) {
      if (this.modus === 'zeitlimit') { projekte.push({ projekt: w, status: 'zeitlimit', ms: 5, rc: null, hinweis: 'nach 1 s abgebrochen' }); continue; }
      const wrapper = dateien.get(w);
      assert.ok(wrapper?.wurzel_ersetzen, 'Wrapper ' + w + ' mit wurzel_ersetzen');
      const cfg = JSON.parse(wrapper.inhalt);
      assert.equal(cfg.extends, './tsconfig.json');
      assert.equal(cfg.compilerOptions.noEmit, true);
      const dir = posix.dirname(w);
      // Mitgepruefte Fremdquellen ueber paths (wie tsc: Quellen eines Workspace-Pakets).
      const fremd = Object.entries(cfg.compilerOptions.paths ?? {})
        .filter(([k]) => !k.endsWith('/*')).map(([, v]) => v[0].replace('@@WURZEL@@/', ''));
      const fremdDirs = fremd.map((f) => posix.dirname(f));
      const zweiParam = fremd.some((f) => dateien.get(f)?.inhalt.includes('b: number)'));
      for (const [pfad, d] of dateien) {
        if (!/\.ts$/.test(pfad)) continue;
        const eigen = pfad.startsWith(dir + '/');
        if (!eigen && !fremdDirs.some((fd) => pfad.startsWith(fd + '/'))) continue;
        d.inhalt.split('\n').forEach((zeile, i) => {
          if (eigen && zeile.includes('ALTFEHLER')) diagnosen.push({ datei: pfad, zeile: i + 1, spalte: 11, code: 'TS2304', meldung: "Cannot find name 'alt'.", projekt: w });
          if (zeile.includes('NEUFEHLER')) diagnosen.push({ datei: pfad, zeile: i + 1, spalte: 1, code: 'TS2322', meldung: "Type 'string' is not assignable to type 'number'.", projekt: w });
          if (eigen && zweiParam && zeile.includes('f(1)')) diagnosen.push({ datei: pfad, zeile: i + 1, spalte: 26, code: 'TS2554', meldung: 'Expected 2 arguments, but got 1.', projekt: w });
        });
      }
      projekte.push({ projekt: w, status: 'fertig', ms: 3, rc: diagnosen.length ? 2 : 0 });
    }
    return { status: projekte.every((p) => p.status === 'fertig') ? 'fertig' : 'teilweise', dauer_ms: 7, projekte, diagnosen, werkzeug: 'tsc 5.9.3 (node fake)' };
  },
  setzeBudget(b) { this.budgetAufrufe.push(b); this.ist = { speicher_mb: b.speicher_mb ?? this.ist.speicher_mb, tmpfs_mb: b.tmpfs_mb ?? this.ist.tmpfs_mb }; return true; },
  budget() { return { ...this.ist }; },
};

const pd = (file, basis, ergebnis, op = 0) => ({ file_path: file, basis, ergebnis, ops: [{ op_index: op, agent_id: agent, spannen: [[0, ergebnis.split('\n').length]] }] });
const aktion = (action, args, wer = 'koordinator') => bp.fuehreBuildActionAus(action, { project, ...args }, wer);
const status = async () => (await aktion('build_status', {})).projekte[0];
async function warteBis(fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); }
}

let globalVorher = null;
let containerVorher = null;
try {
  // ─── Schema 101 ────────────────────────────────────────────────────────────────────────────────────────────
  await check('Schema 101: Datei == Spiegel in build-pruefung-schema.ts, idempotent, Spalten', async () => {
    const datei = readFileSync(resolve(hier, '../src/db/schema-sql/101_build_pruefung.sql'), 'utf8');
    assert.equal(schemaMod.BUILD_PRUEFUNG_SCHEMA_SQL.trim(), datei.trim());
    assert.ok(!/^\s*\/\//m.test(schemaMod.BUILD_PRUEFUNG_SCHEMA_SQL), 'keine //-Kommentare im SQL');
    const schemaTs = readFileSync(resolve(hier, '../src/db/schema.ts'), 'utf8');
    assert.match(schemaTs, /\$\{BUILD_PRUEFUNG_SCHEMA_SQL\}/, 'in SCHEMA_SQL eingehaengt');
    await pool.query(schemaMod.BUILD_PRUEFUNG_SCHEMA_SQL);
    await pool.query(schemaMod.BUILD_PRUEFUNG_SCHEMA_SQL);
    const sp = (await pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name='build_pruefung_einstellungen' ORDER BY ordinal_position`)).rows;
    assert.deepEqual(sp.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
      ['bereich', 'text', 'NO'], ['werte', 'jsonb', 'NO'], ['gesetzt_von', 'text', 'YES'], ['grund', 'text', 'YES'], ['gesetzt_am', 'timestamp with time zone', 'NO'],
    ]);
    const pk = (await pool.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid='build_pruefung_einstellungen'::regclass AND i.indisprimary`)).rows.map((r) => r.attname);
    assert.deepEqual(pk, ['bereich']);
  });
  if (process.argv.includes('--schema-probe')) {
    const schema = await lade('db/schema.js');
    await check('Schema: ensureSchema nurProbe gegen synapse_test (Rollback)', async () => {
      const e = await schema.ensureSchema({ nurProbe: true, versuche: 1 });
      console.log('PROBE ' + JSON.stringify(e).slice(0, 300));
    });
  }
  globalVorher = (await pool.query("SELECT werte FROM build_pruefung_einstellungen WHERE bereich='global'")).rows[0]?.werte ?? null;
  containerVorher = (await pool.query("SELECT werte FROM build_pruefung_einstellungen WHERE bereich='pruefcontainer'")).rows[0]?.werte ?? null;
  assert.equal(globalVorher, null, 'synapse_test: kein globaler Build-Schalter vorhanden (sonst Test ungueltig)');
  assert.equal(containerVorher, null, 'synapse_test: kein pruefcontainer-Budget vorhanden (sonst Test ungueltig)');

  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,false)', [project, 'tpd-tests', tmpRoot]);
  for (const [f, c] of Object.entries(FIXTURE)) await seed(f, c);

  // ─── Schalter Standard aus ─────────────────────────────────────────────────────────────────────────────────
  const tsAenderung = [pd('packages/b/src/index.ts', B_GUT, B_ZWEI)];
  const ohnePruefer = await pb.pruefePlanDateien(project, tsAenderung);
  bp.registriereBuildPruefer(fake);
  await check('Schalter Standard aus: buildAktiv env/false, keine Build-Stufe, kein Container-Aufruf', async () => {
    assert.deepEqual(await bp.buildAktiv(project), { aktiv: false, quelle: 'env' });
    assert.equal(await bp.pruefeBuildFuerPlan(project, tsAenderung), null);
    const mitPruefer = await pb.pruefePlanDateien(project, tsAenderung);
    assert.equal('build' in mitPruefer, false);
    const norm = (p) => JSON.stringify(p, (k, v) => (k === 'dauer_ms' || k === 'geprueft_am' ? 0 : v));
    assert.equal(norm(mitPruefer), norm(ohnePruefer), 'Antwort byte-gleich mit/ohne Pruefer bei Schalter aus');
    assert.equal(fake.aufrufe.length, 0);
    assert.equal(pb.befundUebersicht(mitPruefer).build, undefined);
  });
  await check('Nicht relevante Datei -> null (auch spaeter bei Schalter an)', async () => {
    assert.equal(bp.istBuildRelevant('docs/readme.md'), false);
    assert.equal(bp.istBuildRelevant('packages/a/tsconfig.base.json'), true);
    assert.equal(bp.istBuildRelevant('x/package.json'), true);
  });

  // ─── Rechte und Validierung ────────────────────────────────────────────────────────────────────────────────
  await check('build_einstellungen setzen: nur Koordinator/User, Validierung', async () => {
    const r = await aktion('build_einstellungen', { modus: 'setzen', aktiv: true }, agent);
    assert.equal(r.error, 'nicht_erlaubt');
    const u = await aktion('build_einstellungen', { modus: 'setzen', aktiv: true }, 'user');
    assert.equal(u.error, 'nicht_erlaubt', 'freier Name user ohne Herkunft');
    const v = await aktion('build_einstellungen', { modus: 'setzen', speicher_mb: 100, zeitlimit_s: 5 });
    assert.equal(v.error, 'ungueltig');
    assert.ok(v.fehler.some((f) => f.startsWith('speicher_mb')) && v.fehler.some((f) => f.startsWith('zeitlimit_s')), JSON.stringify(v.fehler));
    assert.equal((await pool.query("SELECT 1 FROM build_pruefung_einstellungen WHERE bereich='pruefcontainer'")).rowCount, 0, 'ungueltig schreibt nichts');
    const leer = await aktion('build_einstellungen', { modus: 'setzen' });
    assert.equal(leer.error, 'ungueltig');
    assert.equal((await aktion('build_einstellungen', { modus: 'quatsch' })).error, 'ungueltig');
    const s = await aktion('build_einstellungen', {});
    assert.equal(s.success, true);
    assert.deepEqual(s.schalter, { aktiv: false, quelle: 'env' });
    assert.equal(bp.istBuildAction('build_status'), true);
    assert.equal(bp.istBuildAction('check'), false);
  });
  await check('Vorrang Projekt > global > Env', async () => {
    let r = await bp.fuehreBuildActionAus('build_einstellungen', { modus: 'setzen', aktiv: true, grund: 'Test global' }, 'koordinator');
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(await bp.buildAktiv(project), { aktiv: true, quelle: 'global' });
    r = await aktion('build_einstellungen', { modus: 'setzen', aktiv: false, grund: 'Test projekt' });
    assert.deepEqual(await bp.buildAktiv(project), { aktiv: false, quelle: 'projekt' });
    r = await bp.fuehreBuildActionAus('build_einstellungen', { modus: 'setzen', zuruecksetzen: 'global' }, 'koordinator');
    assert.equal(r.success, true);
    assert.equal((await pool.query("SELECT 1 FROM build_pruefung_einstellungen WHERE bereich='global'")).rowCount, 0);
    process.env.BUILD_PRUEFUNG = '1';
    assert.deepEqual(await bp.buildAktiv(project), { aktiv: false, quelle: 'projekt' });
    await aktion('build_einstellungen', { modus: 'setzen', zuruecksetzen: 'projekt' });
    assert.deepEqual(await bp.buildAktiv(project), { aktiv: true, quelle: 'env' });
    delete process.env.BUILD_PRUEFUNG;
    r = await aktion('build_einstellungen', { modus: 'setzen', aktiv: true, grund: 'Testprojekt an' });
    assert.equal(r.success, true);
    assert.deepEqual(r.schalter, { aktiv: true, quelle: 'projekt' });
    const zeile = (await pool.query('SELECT werte, gesetzt_von, grund FROM build_pruefung_einstellungen WHERE bereich=$1', ['projekt:' + project])).rows[0];
    assert.deepEqual(zeile, { werte: { aktiv: true }, gesetzt_von: 'koordinator', grund: 'Testprojekt an' });
  });

  // ─── nicht_verfuegbar ──────────────────────────────────────────────────────────────────────────────────────
  await check('Schalter an, kein Pruefer im Prozess -> nicht_verfuegbar, keine Befunde', async () => {
    bp.registriereBuildPruefer(null);
    const r = await bp.pruefeBuildFuerPlan(project, tsAenderung);
    assert.equal(r.stand.status, 'nicht_verfuegbar');
    assert.equal(r.stand.tor, true);
    assert.equal(r.befunde.length, 0);
    const st = await aktion('build_status', {});
    assert.equal(st.pruefer_verfuegbar, false);
    assert.match(st.hinweis, /Kein Pruefcontainer/);
    const basis = await aktion('build_status', { pruefen: true });
    assert.equal(basis.pruefung.status, 'nicht_verfuegbar');
    bp.registriereBuildPruefer(fake);
  });
  await check('Pruefer wirft -> nicht_verfuegbar, sperrt nicht', async () => {
    fake.modus = 'wirft';
    const r = await bp.pruefeBuildFuerPlan(project, [pd('packages/b/src/index.ts', B_GUT, B_GUT + '// wirft\n')], { warten: true });
    assert.equal(r.stand.status, 'nicht_verfuegbar', JSON.stringify(r));
    assert.match(r.stand.hinweis, /Container weg/);
    assert.equal(r.befunde.length, 0);
    fake.modus = 'normal';
  });

  // ─── Laeuft, Ergebnis, nur neue Fehler ───────────────────────────────────────────────────────────────────────
  let befundCode;
  await check('Erster Aufruf: status laeuft (Hintergrund), zustand laeuft', async () => {
    fake.sperren();
    const vorher = fake.aufrufe.length;
    const r = await bp.pruefeBuildFuerPlan(project, tsAenderung);
    assert.equal(r.stand.status, 'laeuft');
    assert.deepEqual(r.stand.projekte, ['packages/a/tsconfig.json', 'packages/b/tsconfig.json'], 'c nicht betroffen');
    assert.equal(r.befunde.length, 0);
    assert.equal((await status()).zustand, 'laeuft');
    await warteBis(async () => fake.aufrufe.length > vorher);
    const auftrag = fake.aufrufe.at(-1);
    assert.deepEqual(auftrag.projekte, ['packages/a/tsconfig.synapse-build.json', 'packages/b/tsconfig.synapse-build.json']);
    const wrapperA = JSON.parse(auftrag.dateien.find((d) => d.pfad === 'packages/a/tsconfig.synapse-build.json').inhalt);
    assert.deepEqual(wrapperA.compilerOptions.paths['@bp/b'], ['@@WURZEL@@/packages/b/src/index.ts'], 'Workspace-Paket auf Quelle statt dist');
    assert.deepEqual(wrapperA.compilerOptions.paths['@bp/b/*'], ['@@WURZEL@@/packages/b/src/*']);
    assert.equal(wrapperA.compilerOptions.skipLibCheck, true);
    assert.equal(wrapperA.compilerOptions.composite, false);
    assert.equal(auftrag.dateien.some((d) => d.pfad === 'docs/readme.md'), false, 'nur TS/Konfig');
    assert.ok(auftrag.heap_mb >= 128 && auftrag.zeitlimit_ms === 300000, JSON.stringify({ h: auftrag.heap_mb, z: auftrag.zeitlimit_ms }));
    fake.freigeben();
  });
  await check('Ergebnis: neuer Folgefehler im unveraenderten Aufrufer, Altfehler nicht neu', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, tsAenderung, { warten: true });
    assert.equal(r.stand.status, 'fertig', JSON.stringify(r.stand));
    assert.equal(r.stand.neue_fehler, 1, JSON.stringify(r.befunde));
    assert.equal(r.stand.basis_fehler, 1);
    assert.equal(r.stand.werkzeug, 'tsc 5.9.3 (node fake)');
    const b = r.befunde[0];
    assert.equal(b.quelle, 'build');
    assert.equal(b.severity, 'error');
    assert.equal(b.datei, 'packages/a/src/index.ts');
    assert.deepEqual(b.zeilen, [2, 2]);
    assert.match(b.code, /^TS2554#[0-9a-f]{6}$/);
    assert.equal(b.op_index, null);
    assert.equal(b.agent_id, null);
    assert.deepEqual(b.beteiligt, [0]);
    assert.equal(b.pruefer, 'build:tsc@5.9.3');
    assert.match(r.stand.hinweis, /sperrt den commit/);
    befundCode = b.code;
  });
  await check('Neuer Fehler in geaenderter Datei: Op-Zuordnung + Dedupe ueber Projekte', async () => {
    const neu = B_GUT + "export const z: number = 'x'; // NEUFEHLER\n";
    const r = await bp.pruefeBuildFuerPlan(project, [pd('packages/b/src/index.ts', B_GUT, neu, 3)], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    // a prueft b-Quellen per paths mit: dieselbe Diagnose zweimal geliefert, einmal gemeldet.
    assert.equal(r.befunde.length, 1, JSON.stringify(r.befunde));
    assert.equal(r.befunde[0].op_index, 3);
    assert.equal(r.befunde[0].agent_id, agent);
    assert.equal(r.befunde[0].datei, 'packages/b/src/index.ts');
    assert.deepEqual(r.befunde[0].zeilen, [2, 2]);
  });
  await check('Verschobener Altfehler zaehlt nicht als neu', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('packages/a/src/index.ts', A_GUT, '// Kopf\n// noch einer\n' + A_GUT)], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.equal(r.stand.neue_fehler, 0, JSON.stringify(r.befunde));
    assert.deepEqual(r.stand.projekte, ['packages/a/tsconfig.json'], 'b haengt nicht von a ab');
  });
  await check('Basis-Cache: gleicher Stand ohne neuen Lauf', async () => {
    const n = fake.aufrufe.length;
    const r = await bp.pruefeBuildFuerPlan(project, tsAenderung, { warten: true });
    assert.equal(r.stand.neue_fehler, 1);
    assert.equal(fake.aufrufe.length, n);
  });
  await check('Basis-Cache nach commit: neuer PG-Stand == alter Schatten -> nur Schattenlauf', async () => {
    const neuA = A_GUT.replace('f(1)', 'f(1, 2)');
    const schatten = [pd('packages/a/src/index.ts', A_GUT, neuA), pd('packages/b/src/index.ts', B_GUT, B_ZWEI, 1)];
    await bp.pruefeBuildFuerPlan(project, schatten, { warten: true });
    await seed('packages/a/src/index.ts', neuA);
    await seed('packages/b/src/index.ts', B_ZWEI);
    const n = fake.aufrufe.length;
    const r = await bp.pruefeBuildFuerPlan(project, [pd('packages/c/src/index.ts', C_GUT, C_GUT + 'export const d = 2;\n')], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.deepEqual(r.stand.projekte, ['packages/c/tsconfig.json']);
    assert.equal(fake.aufrufe.length - n, 2, 'Basis (nur c) + Schatten');
    // Zurueck auf Ausgang; Schatten des vorigen Plans == jetzige Basis gegenueber dem Folgeplan:
    const m = fake.aufrufe.length;
    const r2 = await bp.pruefeBuildFuerPlan(project, schatten.map((d) => ({ ...d, basis: d.ergebnis })), { warten: true });
    assert.equal(r2.stand.neue_fehler, 0);
    assert.equal(fake.aufrufe.length, m, 'Basis und Schatten beide aus dem Cache (Schatten des Vorplans)');
    await seed('packages/a/src/index.ts', A_GUT);
    await seed('packages/b/src/index.ts', B_GUT);
  });

  // ─── teilweise ─────────────────────────────────────────────────────────────────────────────────────────────
  await check('Zeitlimit -> teilweise, keine Befunde, sperrt nicht (auch in pruefePlanDateien)', async () => {
    fake.modus = 'zeitlimit';
    const dateien = [pd('packages/b/src/index.ts', B_GUT, B_GUT + "export const q: number = 'x'; // NEUFEHLER zl\n")];
    const r = await bp.pruefeBuildFuerPlan(project, dateien, { warten: true });
    assert.equal(r.stand.status, 'teilweise');
    assert.equal(r.befunde.length, 0);
    assert.match(r.stand.hinweis, /sperrt nicht/);
    const p = await pb.pruefePlanDateien(project, dateien);
    assert.equal(p.build.status, 'teilweise');
    assert.equal(pb.blockierendeBefunde(p.befunde).filter((b) => b.quelle === 'build').length, 0);
    assert.equal(pb.befundUebersicht(p).build.status, 'teilweise');
    fake.modus = 'normal';
  });
  await check('Schnappschuss zu gross -> teilweise ohne Lauf', async () => {
    process.env.BUILD_PRUEFUNG_MAX_MB = '1';
    const n = fake.aufrufe.length;
    const gross = '// ' + 'x'.repeat(1_200_000) + '\n';
    const r = await bp.pruefeBuildFuerPlan(project, [pd('packages/c/src/gross.ts', '', gross)], { warten: true });
    assert.equal(r.stand.status, 'teilweise');
    assert.match(r.stand.hinweis, /MB/);
    assert.equal(fake.aufrufe.length, n);
    delete process.env.BUILD_PRUEFUNG_MAX_MB;
  });

  // ─── Warteschlange + Quittieren ueber files plan/commit ──────────────────────────────────────────────────────
  await check('commit waehrend Pruefung -> eingereiht, nichts geschrieben; Warteschlange fuehrt aus, Event', async () => {
    fake.sperren();
    const p = await batch.planBatch({ project, agent_id: agent, ops: [{ action: 'search_replace', file_path: 'packages/b/src/index.ts', search: B_GUT, replace: B_ZWEI.replace('a + b', 'a + b + 0') }] });
    assert.ok(p.plan_id, JSON.stringify(p).slice(0, 500));
    assert.equal(p.pruefung?.build?.status, 'laeuft', JSON.stringify(p.pruefung));
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c.error, 'build_pruefung_eingereiht', JSON.stringify(c).slice(0, 800));
    assert.equal(c.geschrieben, false);
    assert.equal(c.warteschlange.position, 1);
    assert.equal(await inhalt('packages/b/src/index.ts'), B_GUT);
    const st = await status();
    assert.equal(st.zustand, 'laeuft');
    assert.equal(st.warteschlange.length, 1);
    assert.equal(st.warteschlange[0].plan_id, p.plan_id);
    // Zweiter commit desselben Plans: bleibt EIN Eintrag.
    const c2 = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c2.error, 'build_pruefung_eingereiht');
    assert.equal((await status()).warteschlange.length, 1);
    fake.freigeben();
    const fertig = await warteBis(async () => ((await status()).letzte_commits.find((l) => l.plan_id === p.plan_id)));
    assert.ok(fertig, 'Warteschlange hat den commit ausgefuehrt');
    assert.equal(fertig.ergebnis, 'pruef_befunde', 'neuer Build-Fehler sperrt');
    assert.equal(await inhalt('packages/b/src/index.ts'), B_GUT);
    const ev = await warteBis(async () => (await pool.query("SELECT * FROM agent_events WHERE project=$1 AND event_type='ANNOUNCEMENT'", [project])).rows.find((e) => JSON.parse(e.payload ?? '{}').plan_id === p.plan_id));
    assert.ok(ev, 'Event an den Agenten');
    const evText = JSON.stringify(ev);
    assert.match(evText, new RegExp('agent:' + agent));
    assert.match(evText, /build-pruefung/);
    assert.match(evText, /pruef_befunde/);
    // Quittieren des Build-Befunds -> commit schreibt (Ergebnis im Cache, keine Warteschlange mehr).
    const gespeichert = await batch.pruefeGespeichertenPlan(p.plan_id);
    const befund = gespeichert.pruefung.befunde.find((b) => b.quelle === 'build');
    assert.ok(befund, JSON.stringify(gespeichert.pruefung).slice(0, 800));
    assert.equal(befund.code, befundCode, 'gleicher Code-Hash je Meldung');
    const zuKurz = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent, befunde_quittieren: [{ id: befund.id, grund: 'x' }] });
    assert.equal(zuKurz.error, 'pruef_befunde');
    const q = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent, befunde_quittieren: [{ id: befund.id, grund: 'Aufrufer folgt im naechsten Plan (Test)' }] });
    assert.equal(q.success, true, JSON.stringify(q).slice(0, 800));
    assert.match(await inhalt('packages/b/src/index.ts'), /a \+ b \+ 0/);
    await seed('packages/b/src/index.ts', B_GUT);
  });
  await check('Eingereihter sauberer commit wird geschrieben (Event normal)', async () => {
    fake.sperren();
    const p = await batch.planBatch({ project, agent_id: agent, ops: [{ action: 'search_replace', file_path: 'packages/c/src/index.ts', search: C_GUT, replace: 'export const c = 2;\n' }] });
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c.error, 'build_pruefung_eingereiht', JSON.stringify(c).slice(0, 500));
    fake.freigeben();
    const fertig = await warteBis(async () => ((await status()).letzte_commits.find((l) => l.plan_id === p.plan_id)));
    assert.equal(fertig?.ergebnis, 'geschrieben');
    assert.equal(await inhalt('packages/c/src/index.ts'), 'export const c = 2;\n');
    const ev = (await pool.query("SELECT * FROM agent_events WHERE project=$1 AND event_type='ANNOUNCEMENT'", [project])).rows.find((e) => JSON.parse(e.payload ?? '{}').plan_id === p.plan_id);
    assert.ok(ev);
    assert.equal(ev.priority, 'normal');
    await seed('packages/c/src/index.ts', C_GUT);
  });
  await check('teilweise sperrt den commit nicht (ueber Warteschlange)', async () => {
    fake.modus = 'zeitlimit';
    fake.sperren();
    const neu = C_GUT + "export const w: number = 'x'; // NEUFEHLER\n";
    const p = await batch.planBatch({ project, agent_id: agent, ops: [{ action: 'search_replace', file_path: 'packages/c/src/index.ts', search: C_GUT, replace: neu }] });
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c.error, 'build_pruefung_eingereiht');
    fake.freigeben();
    const fertig = await warteBis(async () => ((await status()).letzte_commits.find((l) => l.plan_id === p.plan_id)));
    assert.equal(fertig?.ergebnis, 'geschrieben');
    assert.equal(await inhalt('packages/c/src/index.ts'), neu);
    fake.modus = 'normal';
    await seed('packages/c/src/index.ts', C_GUT);
  });
  await check('Direkter commit ohne laufende Pruefung: neuer Fehler sperrt sofort (pruef_befunde)', async () => {
    const p = await batch.planBatch({ project, agent_id: agent, ops: [{ action: 'search_replace', file_path: 'packages/b/src/index.ts', search: B_GUT, replace: B_ZWEI }] });
    // Ergebnis liegt bereits im Cache (gleicher Stand wie oben) -> kein laeuft.
    assert.equal(p.pruefung.build.status, 'fertig', JSON.stringify(p.pruefung.build));
    assert.equal(p.pruefung.sperre, true);
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c.error, 'pruef_befunde');
    assert.ok(c.blockierende.some((b) => b.quelle === 'build'));
    await batch.cancelBatch(p.plan_id, agent, 'Testende');
  });

  // ─── build_status / Budget ───────────────────────────────────────────────────────────────────────────────────
  await check('build_status pruefen:true + warten -> Basis rot (Altfehler), erste_fehler', async () => {
    const r = await aktion('build_status', { pruefen: true, warten_sekunden: 10 });
    assert.equal(r.success, true);
    assert.equal(r.pruefung.fertig, true, JSON.stringify(r.pruefung));
    assert.equal(r.pruefung.fehler, 1);
    const st = r.projekte[0];
    assert.equal(st.zustand, 'rot');
    assert.equal(st.basis.vollstaendig, true);
    assert.deepEqual(st.basis.projekte, ['packages/a/tsconfig.json', 'packages/b/tsconfig.json', 'packages/c/tsconfig.json']);
    assert.equal(st.basis.erste_fehler[0].code, 'TS2304');
    assert.deepEqual(st.schalter, { aktiv: true, quelle: 'projekt' });
    const z = bp.buildPruefungZustand();
    assert.equal(z.pruefer_verfuegbar, true);
    assert.equal(z.projekte[project].zustand, 'rot');
  });
  await check('Budget setzen -> setzeBudget am Pruefer (Neustart), heap folgt Speicher, zuruecksetzen', async () => {
    const r = await aktion('build_einstellungen', { modus: 'setzen', speicher_mb: 1536, tmpfs_mb: 128, grund: 'Test Budget' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.ok(r.neustart);
    assert.deepEqual(fake.budgetAufrufe.at(-1), { speicher_mb: 1536, tmpfs_mb: 128 });
    assert.deepEqual(r.container_jetzt, { speicher_mb: 1536, tmpfs_mb: 128 });
    const b = await bp.wirksamesBuildBudget();
    assert.equal(b.heap_mb, 1536 - 192);
    assert.equal(b.max_mb, Math.min(48, Math.floor(128 * 0.8)));
    const nochmal = await aktion('build_einstellungen', { modus: 'setzen', heap_mb: 1000, zeitlimit_s: 60 });
    assert.equal(nochmal.neustart, undefined, 'heap/zeitlimit starten nicht neu');
    assert.equal((await bp.wirksamesBuildBudget()).heap_mb, 1000);
    assert.equal(await bp.synchronisiereBuildBudget(true), false);
    await aktion('build_einstellungen', { modus: 'setzen', zuruecksetzen: 'budget' });
    assert.equal((await pool.query("SELECT 1 FROM build_pruefung_einstellungen WHERE bereich='pruefcontainer'")).rowCount, 0);
  });
  await check('Schalter wieder aus -> keine Build-Stufe', async () => {
    await aktion('build_einstellungen', { modus: 'setzen', zuruecksetzen: 'projekt' });
    assert.equal(await bp.pruefeBuildFuerPlan(project, tsAenderung), null);
  });
  console.log('TEST_GRUEN P16-T16 E1 checks=' + ok);
} finally {
  bp.registriereBuildPruefer(null);
  fake.freigeben();
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [project]).catch(() => {});
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_references', 'code_call_edges', 'code_statements', 'code_symbols', 'code_chunks', 'code_files', 'agent_events']) {
    await pool.query('DELETE FROM ' + t + ' WHERE project=$1', [project]).catch(() => {});
  }
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  await pool.query('DELETE FROM build_pruefung_einstellungen WHERE bereich=$1', ['projekt:' + project]).catch(() => {});
  if (globalVorher === null) await pool.query("DELETE FROM build_pruefung_einstellungen WHERE bereich='global'").catch(() => {});
  if (containerVorher === null) await pool.query("DELETE FROM build_pruefung_einstellungen WHERE bereich='pruefcontainer'").catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
  await db.closePool();
}
