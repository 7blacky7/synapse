/**
 * P16-T16 Etappe 2 (Testphase Welle 2, TP-E): projektweite Go-/Python-Pruefung in core services/build-pruefung.ts mit
 * FAKE-Pruefserver (kein Docker, kein Go/Pyright noetig). Gegen synapse_test (DATABASE_URL des Shell-Jobs), eigenes
 * Testprojekt, wird am Ende vollstaendig entfernt.
 *
 * Geprueft (Liste aus Bericht 09b4f850 Punkt 4): Schalter aus -> keine Go/Python-Stufe; Go-Modul mit 2 Paketen,
 * Signaturaenderung -> Befund im UNVERAENDERTEN Aufrufer (op_index null, beteiligt), Altfehler nicht neu, Dedupe
 * build/vet; lokales replace -> abhaengiges Modul mitgeprueft, replace ausserhalb des Projekts faellt weg; Go-Datei
 * ohne go.mod -> nicht geprueft; vet-Befund = warning ohne Sperre; externe Abhaengigkeit -> teilweise; cgo ->
 * teilweise; Python (src-Layout) Signaturaenderung -> reportCallIssue im Aufrufer, python_version aus .python-version;
 * fehlender Import -> fertig + Abdeckungshinweis, kein Befund; Pyright-Warnung kein Befund; Python ohne Wurzel ->
 * Projektwurzel '.'; Plan mit TS+Go+Python -> teile + kombinierter Stand; sprachen 'keine'/['go'] und Env
 * BUILD_PRUEFUNG_SPRACHEN; altes Image -> nicht_verfuegbar (sperrt nicht); Schnappschuss zu gross -> teilweise ohne
 * Lauf; commit ueber files plan/commit: Go-Fehler sperrt (pruef_befunde), vet-Warnung schreibt; build_status
 * pruefen:true mit sprachen + basis_sprachen; Ohne Go/Python-Datei exakt E1-Form (keine teile/sprache).
 *
 * Aufruf: node packages/core/tests/build-pruefung-e2-p16-t16.test.mjs   (vorher pnpm --filter @synapse/core build)
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Selbstschutz: nur synapse_test (5433), nie die Prod-DB ──────────────────────────────────────────────────
const ziel = new URL(process.env.DATABASE_URL ?? 'http://ungueltig');
assert.equal(ziel.port, '5433', 'DATABASE_URL muss auf die Test-Instanz 5433 zeigen');
assert.equal(ziel.pathname, '/synapse_test', 'DATABASE_URL muss synapse_test sein');

delete process.env.BUILD_PRUEFUNG;
delete process.env.BUILD_PRUEFUNG_MAX_MB;
delete process.env.BUILD_PRUEFUNG_SPRACHEN;
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
const project = 'test-tpe2-p16e2-' + randomUUID().slice(0, 8);
const agent = 'tpe2-test-' + randomUUID().slice(0, 8);
const tmpRoot = mkdtempSync(join(tmpdir(), 'tpe2-p16e2-'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
let ok = 0;
const check = async (name, fn) => { await fn(); ok++; console.log('OK ' + name); };

// ─── Fixture: TS-Paket, Go-Module m (2 Pakete), n (replace ../m), x (replace ausserhalb), lose Go-Datei, Python ─────
const B_GO = 'package sub\n\nfunc F(a int) int { return a }\n';
const B_GO_ZWEI = 'package sub\n\nfunc F(a int, b int) int { return a + b }\n';
const M_MAIN = 'package main\n\nimport "example.invalid/m/sub"\n\nfunc main() { _ = sub.F(1) }\n';
const PY_B = 'def f(x: int) -> int:\n    return x\n';
const PY_B_ZWEI = 'def f(x: int, y: int) -> int:\n    return x + y\n';
const PY_A = 'from p.b import f\n\nx: int = f(1)\nwert = alt  # ALTFEHLER\n';
const TS_GUT = 'export const t = 1;\n';
const FIXTURE = {
  'package.json': '{"name":"e2-root","private":true}',
  'ts/package.json': '{"name":"@e2/ts","type":"module"}',
  'ts/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, rootDir: 'src', outDir: 'dist' }, include: ['src'] }),
  'ts/src/index.ts': TS_GUT,
  'm/go.mod': 'module example.invalid/m\n\ngo 1.26\n',
  'm/main.go': M_MAIN,
  'm/sub/b.go': B_GO,
  'm/alt.go': 'package main\n\nvar _ = alt // ALTFEHLER\n',
  'n/go.mod': 'module example.invalid/n\n\ngo 1.26\n\nrequire example.invalid/m v0.0.0\n\nreplace example.invalid/m => ../m\n',
  'n/main.go': 'package main\n\nimport "example.invalid/m/sub"\n\nfunc main() { _ = sub.F(1) }\n',
  'x/go.mod': 'module example.invalid/x\n\ngo 1.26\n\nreplace example.invalid/m => ../../ausserhalb\n',
  'x/main.go': 'package main\n\nfunc main() {}\n',
  'lose/einzel.go': 'package lose\n',
  'p/pyproject.toml': '[project]\nname = "p"\n',
  'p/.python-version': '3.12\n',
  'p/src/p/__init__.py': '',
  'p/src/p/a.py': PY_A,
  'p/src/p/b.py': PY_B,
  'skripte/tool.py': 'print(1)\n',
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

// ─── Fake-Pruefserver (Vertrag BuildPrueferAnbindung, Nachrichten build | gobuild | pyright) ────────────────────
const GO_W = 'go 1.27.2 (linux/amd64)';
const PY_W = 'pyright 1.1.414';
const fake = {
  aufrufe: [], modus: 'normal',
  async pruefe(a) {
    this.aufrufe.push(a);
    if (!a.art) {
      return { status: 'fertig', dauer_ms: 3, projekte: a.projekte.map((p) => ({ projekt: p, status: 'fertig', ms: 1, rc: 0 })), diagnosen: [], werkzeug: 'tsc 5.9.3 (node fake)' };
    }
    if (this.modus === 'altesImage') {
      // So meldet pruef-container.ts ein Image ohne pruefer_projekt.py (Antwort ohne gobuild/pyright).
      throw new Error(`Pruef-Container nicht verfuegbar: Antwort ohne ${a.art} (Image ohne Go-/Python-Projektpruefung P16-T16 E2? neu bauen: docker/synapse-pruefcontainer)`);
    }
    assert.ok(Array.isArray(a.projekte) && a.projekte.length > 0, 'projekte im Auftrag');
    assert.ok(a.heap_mb >= 128 && a.zeitlimit_ms === 300000, JSON.stringify({ h: a.heap_mb, z: a.zeitlimit_ms }));
    for (const d of a.dateien) assert.ok(!d.pfad.startsWith('/') && !d.pfad.split('/').includes('..'), 'relativer Pfad ' + d.pfad);
    const dateien = new Map(a.dateien.map((d) => [d.pfad, d.inhalt]));
    const unter = (p, w) => w === '.' || p.startsWith(w + '/');
    const projekte = [];
    const diagnosen = [];
    for (const w of a.projekte) {
      const eigene = [...dateien].filter(([p]) => unter(p, w));
      if (a.art === 'gobuild') {
        assert.ok(dateien.has(w === '.' ? 'go.mod' : w + '/go.mod'), 'go.mod von ' + w + ' im Auftrag');
        if (eigene.some(([, t]) => t.includes('"github.com/'))) {
          projekte.push({ projekt: w, schritt: 'build', status: 'abhaengigkeiten', ms: 1, rc: 1, hinweis: 'Abhaengigkeiten fehlen offline (kein Modulbestand im Container, kein Netz); nicht geprueft.' });
          continue;
        }
        const zwei = [...dateien.values()].some((t) => t.includes('func F(a int, b int)'));
        const cgo = eigene.some(([p, t]) => p.endsWith('.go') && /^import "C"$/m.test(t));
        for (const [p, t] of eigene) {
          if (!p.endsWith('.go')) continue;
          t.split('\n').forEach((z, i) => {
            if (z.includes('ALTFEHLER')) diagnosen.push({ datei: p, zeile: i + 1, spalte: 9, code: 'go', meldung: 'undefined: alt', projekt: w, schwere: 'error' });
            if (zwei && z.includes('sub.F(1)')) {
              const d = { datei: p, zeile: i + 1, spalte: 22, code: 'go', meldung: 'not enough arguments in call to sub.F / have (number) / want (int, int)', projekt: w, schwere: 'error' };
              diagnosen.push(d, { ...d }); // vet wiederholt den Typfehler (Dedupe in core)
            }
            if (z.includes('VETFEHLER')) diagnosen.push({ datei: p, zeile: i + 1, spalte: 2, code: 'vet', meldung: 'fmt.Printf format %d has arg "x" of wrong type string', projekt: w, schwere: 'warning' });
          });
        }
        projekte.push({ projekt: w, schritt: 'build', status: cgo ? 'cgo' : 'fertig', ms: 2, rc: 0, ...(cgo ? { hinweis: 'cgo-Dateien (import "C") werden ohne C-Compiler nicht mitgeprueft; Ergebnis unvollstaendig.' } : {}) },
          { projekt: w, schritt: 'vet', status: 'fertig', ms: 1, rc: 0 });
      } else {
        assert.equal(a.art, 'pyright');
        const zwei = [...dateien.values()].some((t) => t.includes('def f(x: int, y: int)'));
        let fehlend = 0;
        for (const [p, t] of eigene) {
          if (!/\.pyi?$/.test(p)) continue;
          t.split('\n').forEach((z, i) => {
            if (z.includes('ALTFEHLER')) diagnosen.push({ datei: p, zeile: i + 1, spalte: 8, code: 'reportUndefinedVariable', meldung: '"alt" is not defined', projekt: w, schwere: 'error' });
            if (zwei && /\bf\(1\)/.test(z)) diagnosen.push({ datei: p, zeile: i + 1, spalte: 10, code: 'reportCallIssue', meldung: 'Argument missing for parameter "y"', projekt: w, schwere: 'error' });
            if (z.includes('import fehlt_modul')) {
              fehlend++;
              diagnosen.push({ datei: p, zeile: i + 1, spalte: 8, code: 'reportMissingImports', meldung: 'Import "fehlt_modul" could not be resolved', projekt: w, schwere: 'warning', weich: true });
            }
            if (z.includes('PYWARN')) diagnosen.push({ datei: p, zeile: i + 1, spalte: 1, code: 'reportUnusedExpression', meldung: 'Expression value is unused', projekt: w, schwere: 'warning' });
          });
        }
        projekte.push({ projekt: w, schritt: 'pyright', status: 'fertig', ms: 2, rc: 0, dateien: eigene.length,
          ...(fehlend ? { abdeckung: 'unvollstaendig', fehlende_importe: fehlend, hinweis: `${fehlend} Import(e) nicht aufgeloest` } : {}) });
      }
    }
    return { status: projekte.every((p) => p.status === 'fertig') ? 'fertig' : 'teilweise', dauer_ms: 5, projekte, diagnosen, werkzeug: a.art === 'gobuild' ? GO_W : PY_W };
  },
  setzeBudget() { return false; },
  budget() { return { speicher_mb: 384, tmpfs_mb: 64 }; },
};

const pd = (file, basis, ergebnis, op = 0) => ({ file_path: file, basis, ergebnis, ops: [{ op_index: op, agent_id: agent, spannen: [[0, ergebnis.split('\n').length]] }] });
const aktion = (action, args, wer = 'koordinator') => bp.fuehreBuildActionAus(action, { project, ...args }, wer);
const goAuftraege = () => fake.aufrufe.filter((a) => a.art === 'gobuild');
const pyAuftraege = () => fake.aufrufe.filter((a) => a.art === 'pyright');

let globalVorher = null;
try {
  await pool.query(schemaMod.BUILD_PRUEFUNG_SCHEMA_SQL);
  globalVorher = (await pool.query("SELECT werte FROM build_pruefung_einstellungen WHERE bereich='global'")).rows[0]?.werte ?? null;
  assert.equal(globalVorher, null, 'synapse_test: kein globaler Build-Schalter vorhanden (sonst Test ungueltig)');
  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,false)', [project, 'tpe2-tests', tmpRoot]);
  for (const [f, c] of Object.entries(FIXTURE)) await seed(f, c);
  bp.registriereBuildPruefer(fake);

  const goAenderung = [pd('m/sub/b.go', B_GO, B_GO_ZWEI)];
  const pyAenderung = [pd('p/src/p/b.py', PY_B, PY_B_ZWEI)];

  await check('Relevanz: .go/go.mod/go.sum/.py/.pyi/pyproject/setup.cfg/.python-version; nicht md/TS', async () => {
    for (const p of ['a/b.go', 'go.mod', 'x/go.sum', 'a.py', 'a.pyi', 'p/pyproject.toml', 'setup.cfg', 'p/.python-version']) assert.equal(bp.istSprachRelevant(p), true, p);
    for (const p of ['docs/readme.md', 'ts/src/index.ts', 'go.work', 'x.pyc']) assert.equal(bp.istSprachRelevant(p), false, p);
  });
  await check('Schalter aus: Go-/Python-Aenderung -> null, kein Container-Aufruf', async () => {
    assert.equal(await bp.pruefeBuildFuerPlan(project, goAenderung), null);
    assert.equal(await bp.pruefeBuildFuerPlan(project, pyAenderung), null);
    assert.equal(fake.aufrufe.length, 0);
    const s = await aktion('build_einstellungen', {});
    assert.deepEqual(s.sprachen_wirksam, ['go', 'python'], 'Standard go+python');
  });
  const r0 = await aktion('build_einstellungen', { modus: 'setzen', aktiv: true, grund: 'Testprojekt E2 an' });
  assert.equal(r0.success, true, JSON.stringify(r0));

  // ─── Go ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('Go: erster Aufruf laeuft (Hintergrund), sprache go, betroffen m + n (replace), x nicht', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, goAenderung);
    assert.equal(r.stand.status, 'laeuft', JSON.stringify(r.stand));
    assert.equal(r.stand.sprache, 'go');
    assert.deepEqual(r.stand.projekte, ['m', 'n']);
    assert.equal(r.befunde.length, 0);
  });
  await check('Go: Signaturaenderung -> Befund in unveraenderten Aufrufern (m, n), Altfehler nicht neu, Dedupe build/vet', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, goAenderung, { warten: true });
    assert.equal(r.stand.status, 'fertig', JSON.stringify(r.stand));
    assert.equal(r.stand.sprache, 'go');
    assert.equal(r.stand.neue_fehler, 2, JSON.stringify(r.befunde));
    assert.equal(r.stand.basis_fehler, 1, 'ALTFEHLER in m/alt.go');
    assert.equal(r.stand.werkzeug, GO_W);
    assert.match(r.stand.hinweis, /2 neue\(r\) Go-Fehler .* sperrt den commit/);
    assert.deepEqual(r.befunde.map((b) => b.datei).sort(), ['m/main.go', 'n/main.go']);
    for (const b of r.befunde) {
      assert.equal(b.quelle, 'build');
      assert.equal(b.severity, 'error');
      assert.deepEqual(b.zeilen, [5, 5]);
      assert.equal(b.spalte, 22);
      assert.match(b.code, /^go#[0-9a-f]{6}$/);
      assert.equal(b.pruefer, 'build:go@1.27.2');
      assert.equal(b.op_index, null);
      assert.equal(b.agent_id, null);
      assert.deepEqual(b.beteiligt, [0]);
      assert.match(b.titel, /^go \(Go [mn]\)$/);
      assert.match(b.warum, /go build -o \/dev\/null/);
    }
    const auftrag = goAuftraege().at(-1);
    assert.equal(auftrag.art, 'gobuild');
    assert.deepEqual(auftrag.projekte, ['m', 'n']);
    assert.deepEqual(auftrag.dateien.map((d) => d.pfad), ['m/alt.go', 'm/go.mod', 'm/main.go', 'm/sub/b.go', 'n/go.mod', 'n/main.go'],
      'nur Go-Dateien der Module (kein TS/Python/x/lose)');
    assert.equal(auftrag.dateien.find((d) => d.pfad === 'm/sub/b.go').inhalt, B_GO_ZWEI, 'Schatten = Plan-Ergebnis');
    assert.equal('python_version' in auftrag, false);
    assert.equal(auftrag.dateien.some((d) => 'wurzel_ersetzen' in d), false, 'nichts erzeugt/umgeschrieben');
  });
  await check('Go: Ergebnis-Cache (gleicher Stand ohne neuen Lauf)', async () => {
    const n = fake.aufrufe.length;
    const r = await bp.pruefeBuildFuerPlan(project, goAenderung, { warten: true });
    assert.equal(r.stand.neue_fehler, 2);
    assert.equal(fake.aufrufe.length, n);
  });
  await check('Go: Fehler in geaenderter Datei -> Op-Zuordnung', async () => {
    const neu = M_MAIN.replace('func main() { _ = sub.F(1) }', 'func main() { _ = sub.F(1) }\n\nvar _ = alt // ALTFEHLER');
    const r = await bp.pruefeBuildFuerPlan(project, [pd('m/main.go', M_MAIN, neu, 4)], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.deepEqual(r.stand.projekte, ['m', 'n'], 'n bindet m per replace ein -> mitgeprueft');
    // Gleiche Meldung wie der Altfehler, aber in einer anderen Datei -> neu (Schluessel Datei|Code|Meldung).
    assert.equal(r.befunde.length, 1, JSON.stringify(r.befunde));
    assert.equal(r.befunde[0].datei, 'm/main.go');
    assert.deepEqual(r.befunde[0].zeilen, [7, 7]);
    assert.equal(r.befunde[0].op_index, 4);
    assert.equal(r.befunde[0].agent_id, agent);
    assert.equal('beteiligt' in r.befunde[0], false);
  });
  await check('Go: lokales replace ausserhalb des Projekts faellt weg (x nicht betroffen von m), x allein pruefbar', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('x/main.go', 'package main\n\nfunc main() {}\n', 'package main\n\nfunc main() { println(1) }\n')], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.deepEqual(r.stand.projekte, ['x']);
    const auftrag = goAuftraege().at(-1);
    assert.deepEqual(auftrag.dateien.map((d) => d.pfad), ['x/go.mod', 'x/main.go']);
  });
  await check('Go-Datei ohne go.mod -> fertig, nicht geprueft, kein Lauf', async () => {
    const n = fake.aufrufe.length;
    const r = await bp.pruefeBuildFuerPlan(project, [pd('lose/einzel.go', 'package lose\n', 'package lose\n\nvar Y = 1\n')], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.match(r.stand.hinweis, /nicht geprueft/);
    assert.equal(fake.aufrufe.length, n);
  });
  await check('go vet-Befund = warning, neue_warnungen, sperrt nicht (pruefePlanDateien)', async () => {
    const neu = M_MAIN.replace('func main() { _ = sub.F(1) }', 'func main() {\n\t_ = sub.F(1) // VETFEHLER\n}');
    const dateien = [pd('m/main.go', M_MAIN, neu, 2)];
    const r = await bp.pruefeBuildFuerPlan(project, dateien, { warten: true });
    assert.equal(r.stand.neue_fehler, 0, JSON.stringify(r.befunde));
    assert.equal(r.stand.neue_warnungen, 1);
    assert.equal(r.befunde.length, 1);
    assert.equal(r.befunde[0].severity, 'warning');
    assert.match(r.befunde[0].code, /^vet#/);
    assert.equal(r.befunde[0].op_index, 2);
    assert.match(r.befunde[0].wie, /sperrt nicht/);
    assert.match(r.stand.hinweis, /go-vet-Warnung/);
    const p = await pb.pruefePlanDateien(project, dateien);
    assert.equal(pb.blockierendeBefunde(p.befunde).filter((b) => b.quelle === 'build').length, 0);
    assert.equal(p.befunde.filter((b) => b.quelle === 'build' && b.severity === 'warning').length, 1);
  });
  await check('Go: externe Abhaengigkeit -> teilweise, keine Befunde, sperrt nicht', async () => {
    const neu = 'package main\n\nimport "github.com/x/y"\n\nfunc main() { y.F() }\n';
    const dateien = [pd('m/main.go', M_MAIN, neu)];
    const r = await bp.pruefeBuildFuerPlan(project, dateien, { warten: true });
    assert.equal(r.stand.status, 'teilweise', JSON.stringify(r.stand));
    assert.equal(r.befunde.length, 0);
    assert.match(r.stand.hinweis, /Teilweise geprueft \(sperrt nicht\): m: abhaengigkeiten/);
    const p = await pb.pruefePlanDateien(project, dateien);
    assert.equal(p.build.status, 'teilweise');
    assert.equal(pb.blockierendeBefunde(p.befunde).length, 0);
  });
  await check('Go: cgo -> teilweise (Diagnosen des Moduls nicht gewertet)', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('m/c.go', '', 'package main\n\nimport "C"\n'), ...goAenderung], { warten: true });
    assert.equal(r.stand.status, 'teilweise', JSON.stringify(r.stand));
    assert.match(r.stand.hinweis, /m: cgo/);
    assert.deepEqual(r.befunde.map((b) => b.datei), ['n/main.go'], 'n ohne cgo weiter gewertet');
  });
  await check('Go: geloeschte Datei faellt aus dem Schatten', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [{ ...pd('m/alt.go', 'package main\n\nvar _ = alt // ALTFEHLER\n', ''), geloescht: true }], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.equal(goAuftraege().at(-1).dateien.some((d) => d.pfad === 'm/alt.go'), false);
    assert.equal(r.stand.neue_fehler, 0);
  });

  // ─── Python ──────────────────────────────────────────────────────────────────────────────────────────────────────
  await check('Python: Signaturaenderung -> reportCallIssue im Aufrufer, python_version, src-Layout-Projekt p', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, pyAenderung, { warten: true });
    assert.equal(r.stand.status, 'fertig', JSON.stringify(r.stand));
    assert.equal(r.stand.sprache, 'python');
    assert.deepEqual(r.stand.projekte, ['p']);
    assert.equal(r.stand.neue_fehler, 1, JSON.stringify(r.befunde));
    assert.equal(r.stand.basis_fehler, 1);
    const b = r.befunde[0];
    assert.equal(b.datei, 'p/src/p/a.py');
    assert.deepEqual(b.zeilen, [3, 3]);
    assert.match(b.code, /^reportCallIssue#[0-9a-f]{6}$/);
    assert.equal(b.pruefer, 'build:pyright@1.1.414');
    assert.equal(b.severity, 'error');
    assert.equal(b.op_index, null);
    assert.match(b.warum, /Pyright, Projekt p/);
    const auftrag = pyAuftraege().at(-1);
    assert.equal(auftrag.python_version, '3.12');
    assert.deepEqual(auftrag.projekte, ['p']);
    assert.deepEqual(auftrag.dateien.map((d) => d.pfad), ['p/.python-version', 'p/pyproject.toml', 'p/src/p/__init__.py', 'p/src/p/a.py', 'p/src/p/b.py'],
      'nur Python-Dateien unter p (kein skripte/, kein Go/TS)');
  });
  await check('Python: fehlender Import -> fertig + Abdeckungshinweis, kein Befund', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('p/src/p/b.py', PY_B, 'import fehlt_modul\n' + PY_B)], { warten: true });
    assert.equal(r.stand.status, 'fertig', JSON.stringify(r.stand));
    assert.equal(r.befunde.length, 0);
    assert.equal(r.stand.neue_fehler, 0);
    assert.match(r.stand.hinweis, /Abdeckung unvollstaendig .*p: 1 Import\(e\) nicht aufgeloest/);
  });
  await check('Python: Pyright-Warnung ist kein Befund', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('p/src/p/b.py', PY_B, PY_B + 'f  # PYWARN\n')], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.equal(r.befunde.length, 0);
    assert.equal(r.stand.neue_warnungen, undefined);
  });
  await check('Python ohne Projektdatei -> Projektwurzel "." mit allen Python-Dateien', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('skripte/tool.py', 'print(1)\n', 'print(2)\n')], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.deepEqual(r.stand.projekte, ['.']);
    const auftrag = pyAuftraege().at(-1);
    assert.deepEqual(auftrag.projekte, ['.']);
    assert.ok(auftrag.dateien.some((d) => d.pfad === 'skripte/tool.py') && auftrag.dateien.some((d) => d.pfad === 'p/src/p/a.py'));
    assert.equal('python_version' in auftrag, false, 'keine .python-version in der Wurzel');
  });

  // ─── Kombination, Sprachen-Schalter ──────────────────────────────────────────────────────────────────────────────
  await check('Ohne Go/Python-Datei: exakt E1-Form (keine teile/sprache)', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('ts/src/index.ts', TS_GUT, TS_GUT + 'export const u = 2;\n')], { warten: true });
    assert.equal(r.stand.status, 'fertig');
    assert.equal('teile' in r.stand, false);
    assert.equal('sprache' in r.stand, false);
    assert.deepEqual(r.stand.projekte, ['ts/tsconfig.json']);
  });
  await check('Plan mit TS + Go + Python -> teile + kombinierter Stand', async () => {
    const r = await bp.pruefeBuildFuerPlan(project, [pd('ts/src/index.ts', TS_GUT, TS_GUT + 'export const v = 3;\n'), ...goAenderung, ...pyAenderung], { warten: true });
    assert.equal(r.stand.status, 'fertig', JSON.stringify(r.stand));
    assert.equal(r.stand.teile.length, 3);
    assert.deepEqual(r.stand.teile.map((t) => t.sprache ?? 'ts'), ['ts', 'go', 'python']);
    assert.equal(r.stand.neue_fehler, 3);
    assert.equal(r.stand.basis_fehler, 2, 'TS-Basis ohne Fehler (Fake) + Go 1 + Python 1');
    assert.deepEqual(r.stand.projekte, ['ts/tsconfig.json', 'go:m', 'go:n', 'python:p']);
    assert.match(r.stand.werkzeug, /tsc 5\.9\.3.*\+ go 1\.27\.2.*\+ pyright 1\.1\.414/);
    assert.match(r.stand.hinweis, /Go: .*\| Python: /);
    assert.equal(r.befunde.length, 3);
  });
  await check('Kombination: laeuft gewinnt (Warteschlange greift)', async () => {
    const neu = PY_B_ZWEI + '# frisch\n';
    const r = await bp.pruefeBuildFuerPlan(project, [pd('ts/src/index.ts', TS_GUT, TS_GUT + 'export const v = 3;\n'), pd('p/src/p/b.py', PY_B, neu)]);
    assert.equal(r.stand.status, 'laeuft', JSON.stringify(r.stand));
    assert.ok(r.stand.laufend >= 0);
    await bp.pruefeBuildFuerPlan(project, [pd('p/src/p/b.py', PY_B, neu)], { warten: true });
  });
  await check('sprachen keine -> nur TypeScript; [go] -> Python aus; Validierung; Env BUILD_PRUEFUNG_SPRACHEN', async () => {
    const falsch = await aktion('build_einstellungen', { modus: 'setzen', sprachen: ['go', 'fortran'] });
    assert.equal(falsch.error, 'ungueltig');
    assert.match(falsch.message, /unbekannt: fortran/);
    assert.equal((await aktion('build_einstellungen', { modus: 'setzen', sprachen: ['go'] }, agent)).error, 'nicht_erlaubt');
    let r = await aktion('build_einstellungen', { modus: 'setzen', sprachen: 'keine', grund: 'nur TS' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.deepEqual(r.sprachen_wirksam, []);
    assert.equal(await bp.pruefeBuildFuerPlan(project, goAenderung, { warten: true }), null, 'nur Go-Datei, nur TS aktiv');
    const nurTs = await bp.pruefeBuildFuerPlan(project, [pd('ts/src/index.ts', TS_GUT, TS_GUT + 'export const v = 3;\n'), ...goAenderung], { warten: true });
    assert.equal('teile' in nurTs.stand, false);
    assert.deepEqual(nurTs.stand.projekte, ['ts/tsconfig.json']);
    r = await aktion('build_einstellungen', { modus: 'setzen', sprachen: ['go'], grund: 'nur Go' });
    assert.deepEqual(r.sprachen_wirksam, ['go']);
    assert.equal(await bp.pruefeBuildFuerPlan(project, pyAenderung, { warten: true }), null);
    assert.equal((await bp.pruefeBuildFuerPlan(project, goAenderung, { warten: true })).stand.sprache, 'go');
    // Projekt-Eintrag entfernen (auch aktiv weg) -> Env-Ebene der Sprachen; Schalter wieder an.
    await aktion('build_einstellungen', { modus: 'setzen', zuruecksetzen: 'projekt' });
    process.env.BUILD_PRUEFUNG_SPRACHEN = 'python, quatsch';
    assert.deepEqual(await bp.sprachenAktiv(project), ['python']);
    delete process.env.BUILD_PRUEFUNG_SPRACHEN;
    assert.deepEqual(await bp.sprachenAktiv(project), ['go', 'python']);
    r = await aktion('build_einstellungen', { modus: 'setzen', aktiv: true, grund: 'wieder an' });
    assert.equal(r.success, true);
  });
  await check('Altes Image (Antwort ohne gobuild/pyright) -> nicht_verfuegbar, sperrt nicht; TS-Teil bleibt -> teilweise', async () => {
    fake.modus = 'altesImage';
    const neu = B_GO_ZWEI + '// altes Image\n';
    const r = await bp.pruefeBuildFuerPlan(project, [pd('m/sub/b.go', B_GO, neu)], { warten: true });
    assert.equal(r.stand.status, 'nicht_verfuegbar', JSON.stringify(r.stand));
    assert.match(r.stand.hinweis, /Image ohne Go-\/Python-Projektpruefung/);
    assert.equal(r.befunde.length, 0);
    const mit = await bp.pruefeBuildFuerPlan(project, [pd('ts/src/index.ts', TS_GUT, TS_GUT + 'export const w = 4;\n'), pd('m/sub/b.go', B_GO, neu)], { warten: true });
    assert.equal(mit.stand.status, 'teilweise');
    assert.deepEqual(mit.stand.teile.map((t) => t.status), ['fertig', 'nicht_verfuegbar']);
    const p = await pb.pruefePlanDateien(project, [pd('m/sub/b.go', B_GO, neu)]);
    assert.equal(pb.blockierendeBefunde(p.befunde).length, 0);
    fake.modus = 'normal';
  });
  await check('Kein Pruefer im Prozess -> nicht_verfuegbar (Go)', async () => {
    bp.registriereBuildPruefer(null);
    const r = await bp.pruefeBuildFuerPlan(project, goAenderung);
    assert.equal(r.stand.status, 'nicht_verfuegbar');
    assert.equal(r.stand.sprache, 'go');
    assert.match(r.stand.hinweis, /Kein Pruefcontainer/);
    bp.registriereBuildPruefer(fake);
  });
  await check('Schnappschuss zu gross -> teilweise ohne Lauf', async () => {
    process.env.BUILD_PRUEFUNG_MAX_MB = '1';
    const n = fake.aufrufe.length;
    const gross = 'package main\n\n// ' + 'x'.repeat(1_200_000) + '\n';
    const r = await bp.pruefeBuildFuerPlan(project, [pd('m/gross.go', '', gross)], { warten: true });
    assert.equal(r.stand.status, 'teilweise');
    assert.match(r.stand.hinweis, /MB/);
    assert.equal(fake.aufrufe.length, n);
    delete process.env.BUILD_PRUEFUNG_MAX_MB;
  });

  // ─── commit ueber files plan/commit ──────────────────────────────────────────────────────────────────────────────
  await check('commit: neuer Go-Fehler sperrt (pruef_befunde), Datei unveraendert', async () => {
    await bp.pruefeBuildFuerPlan(project, goAenderung, { warten: true }); // Ergebnis im Cache -> kein 'laeuft'
    const p = await batch.planBatch({ project, agent_id: agent, ops: [{ action: 'search_replace', file_path: 'm/sub/b.go', search: B_GO, replace: B_GO_ZWEI }] });
    assert.ok(p.plan_id, JSON.stringify(p).slice(0, 500));
    assert.equal(p.pruefung.build.status, 'fertig', JSON.stringify(p.pruefung.build));
    assert.equal(p.pruefung.build.sprache, 'go');
    assert.equal(p.pruefung.sperre, true);
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c.error, 'pruef_befunde', JSON.stringify(c).slice(0, 800));
    assert.ok(c.blockierende.some((b) => b.quelle === 'build'), JSON.stringify(c.blockierende).slice(0, 1500));
    assert.equal(await inhalt('m/sub/b.go'), B_GO);
    await batch.cancelBatch(p.plan_id, agent, 'Testende');
  });
  await check('commit: nur vet-Warnung -> geschrieben', async () => {
    const neu = M_MAIN.replace('func main() { _ = sub.F(1) }', 'func main() {\n\t_ = sub.F(1) // VETFEHLER\n}');
    await bp.pruefeBuildFuerPlan(project, [pd('m/main.go', M_MAIN, neu)], { warten: true });
    const p = await batch.planBatch({ project, agent_id: agent, ops: [{ action: 'search_replace', file_path: 'm/main.go', search: M_MAIN, replace: neu }] });
    assert.equal(p.pruefung.build.status, 'fertig', JSON.stringify(p.pruefung.build));
    assert.equal(p.pruefung.sperre, false, JSON.stringify(p.pruefung).slice(0, 800));
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c.success, true, JSON.stringify(c).slice(0, 800));
    assert.equal(await inhalt('m/main.go'), neu);
    await seed('m/main.go', M_MAIN);
  });

  // ─── build_status ────────────────────────────────────────────────────────────────────────────────────────────────
  await check('build_status pruefen:true -> sprachen go/python (Basis rot), basis_sprachen, zustand rot', async () => {
    const r = await aktion('build_status', { pruefen: true, warten_sekunden: 10 });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 500));
    assert.equal(r.pruefung.fertig, true, JSON.stringify(r.pruefung));
    assert.equal(r.pruefung.sprachen.go.fertig, true, JSON.stringify(r.pruefung.sprachen));
    assert.equal(r.pruefung.sprachen.go.fehler, 1, 'ALTFEHLER m/alt.go');
    assert.deepEqual(r.pruefung.sprachen.go.projekte, ['m', 'n', 'x']);
    // Befund (Bericht): die Python-Projektwurzel '.' schliesst das verschachtelte Projekt p mit ein (Go schliesst
    // verschachtelte Module aus) -> ALTFEHLER in p/src/p/a.py zaehlt in der Basis zweimal.
    assert.equal(r.pruefung.sprachen.python.fehler, 2);
    assert.deepEqual(r.pruefung.sprachen.python.projekte, ['.', 'p'], 'Wurzel fuer skripte/ + p');
    const st = r.projekte[0];
    assert.equal(st.zustand, 'rot');
    assert.equal(st.basis_sprachen.go.vollstaendig, true);
    assert.equal(st.basis_sprachen.go.fehler, 1);
    assert.equal(st.basis_sprachen.go.erste_fehler[0].datei, 'm/alt.go');
    assert.equal(st.basis_sprachen.python.fehler, 2);
    const z = bp.buildPruefungZustand();
    assert.equal(z.projekte[project].zustand, 'rot');
  });
  await check('build_status pruefen:true mit sprachen keine -> kein Feld sprachen', async () => {
    await aktion('build_einstellungen', { modus: 'setzen', sprachen: [], grund: 'nur TS' });
    const r = await aktion('build_status', { pruefen: true, warten_sekunden: 5 });
    assert.equal(r.success, true);
    assert.equal('sprachen' in r.pruefung, false);
  });
  console.log('TEST_GRUEN P16-T16 E2 checks=' + ok);
} finally {
  bp.registriereBuildPruefer(null);
  delete process.env.BUILD_PRUEFUNG_SPRACHEN;
  delete process.env.BUILD_PRUEFUNG_MAX_MB;
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [project]).catch(() => {});
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_references', 'code_call_edges', 'code_statements', 'code_symbols', 'code_chunks', 'code_files', 'agent_events']) {
    await pool.query('DELETE FROM ' + t + ' WHERE project=$1', [project]).catch(() => {});
  }
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  await pool.query('DELETE FROM build_pruefung_einstellungen WHERE bereich=$1', ['projekt:' + project]).catch(() => {});
  if (globalVorher === null) await pool.query("DELETE FROM build_pruefung_einstellungen WHERE bereich='global'").catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
  await db.closePool();
}
