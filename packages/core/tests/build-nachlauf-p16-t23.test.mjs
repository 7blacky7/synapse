/**
 * P16-T23: Build-Tor Nachlauf (core services/build-pruefung.ts, file-batch.ts, tool-antwort.ts) mit FAKE-Pruefserver
 * (kein Docker). Gegen synapse_test (DATABASE_URL des Shell-Jobs), eigenes Testprojekt, wird am Ende entfernt.
 *
 * Geprueft: Standard AUS = Altverhalten (Build-Stufe am Plan, Warteschlange), Rechte/Validierung, Produkt-Schalter
 * je Projekt, plan ohne Build-Stufe, commit schreibt SOFORT trotz laufender grosser Pruefung und startet NICHTS (nur
 * vorgemerkt, fertiger Aufruf build_pruefen), erst code_check(build_pruefen) stoesst an; laufender Lauf auf seinem Abbild
 * bleibt von spaeteren commits unberuehrt, die kommen in den Folgelauf; offener Plan -> erst committen,
 * Nachlauf mit Basis vor dem commit (neuer Folgefehler mit Plan-Zuordnung in build_status), Hinweis build_nachlauf
 * beim naechsten beliebigen Tool-Aufruf genau einmal, Ergebnis am Plan (sperrt nicht), zwei commits -> EIN Lauf,
 * intern-Override hat Vorrang (nur SYNAPSE_INTERN_TOOL=1), Ablauf -> Produkt-Schalter.
 *
 * Aufruf: node packages/core/tests/build-nachlauf-p16-t23.test.mjs   (vorher pnpm --filter @synapse/core build)
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─── Selbstschutz: nur synapse_test (5433), nie die Prod-DB ────────────────────────────────────────────────
const ziel = new URL(process.env.DATABASE_URL ?? 'http://ungueltig');
assert.equal(ziel.port, '5433', 'DATABASE_URL muss auf die Test-Instanz 5433 zeigen');
assert.equal(ziel.pathname, '/synapse_test', 'DATABASE_URL muss synapse_test sein');

delete process.env.BUILD_PRUEFUNG;
delete process.env.BUILD_PRUEFUNG_MAX_MB;
delete process.env.SYNAPSE_INTERN_TOOL;
Object.assign(process.env, {
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', SYNTAX_WORKER_THREADS: '0',
  FEHLERPRUEFUNG_TYPEN: '0', BUILD_PRUEFUNG_CACHE_MS: '0', SYNAPSE_COMMIT_WAIT_SYNC_MAX_SECONDS: '0', SYNAPSE_INTERN_CACHE_MS: '0',
});

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.P16_CORE_DIST ?? resolve(hier, '../dist');
const lade = (p) => import(pathToFileURL(join(dist, p)).href);
const db = await lade('db/client.js');
// file-batch zuerst (wie index.js): build-pruefung als Einstieg laeuft in den Zyklus agent-bezug -> intern-tool -> intern-waits -> file-batch.
const batch = await lade('services/file-batch.js');
const bp = await lade('services/build-pruefung.js');
const pb = await lade('services/plan-befunde.js');
const ta = await lade('services/tool-antwort.js');

const pool = db.getPool();
const project = 'test-tpd-p16t23-' + randomUUID().slice(0, 8);
const agent = 'tpd-test-' + randomUUID().slice(0, 8);
const tmpRoot = mkdtempSync(join(tmpdir(), 'tpd-p16t23-'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
let ok = 0;
const check = async (name, fn) => { await fn(); ok++; console.log('OK ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fixture: Monorepo mit a -> b, unabhaengigem c (wie P16-T16) ─────────────────────────────────────────────
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

// ─── Fake-Pruefserver (Vertrag BuildPrueferAnbindung, Diagnosen wie P16-T16) ───────────────────────────────────
const fake = {
  aufrufe: [], sperre: null,
  sperren() { let release; const promise = new Promise((r) => { release = r; }); this.sperre = { promise, release }; },
  freigeben() { const s = this.sperre; this.sperre = null; s?.release(); },
  async pruefe(auftrag) {
    this.aufrufe.push(auftrag);
    if (this.sperre) await this.sperre.promise;
    const dateien = new Map(auftrag.dateien.map((d) => [d.pfad, d]));
    const projekte = [];
    const diagnosen = [];
    for (const w of auftrag.projekte) {
      const cfg = JSON.parse(dateien.get(w).inhalt);
      const dir = posix.dirname(w);
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
    return { status: 'fertig', dauer_ms: 7, projekte, diagnosen, werkzeug: 'tsc 5.9.3 (node fake)' };
  },
  setzeBudget() { return false; },
  budget() { return { speicher_mb: 384, tmpfs_mb: 64 }; },
};

const aktion = (action, args, wer = 'koordinator') => bp.fuehreBuildActionAus(action, { project, ...args }, wer);
const status = async () => (await aktion('build_status', {})).projekte[0];
async function warteBis(fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); }
}
const ersetze = (file, search, replace) => batch.planBatch({ project, agent_id: agent, ops: [{ action: 'search_replace', file_path: file, search, replace }] });
const ruhig = async () => warteBis(async () => { const s = await status(); return !s.nachlauf?.laeuft && (s.nachlauf?.wartend.length ?? 0) === 0 && s.zustand !== 'laeuft'; });

let internZeileVorher = false;
try {
  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,false)', [project, 'tpd-tests', tmpRoot]);
  for (const [f, c] of Object.entries(FIXTURE)) await seed(f, c);
  internZeileVorher = (await pool.query("SELECT 1 FROM intern_schalter WHERE name='build_nachlauf'")).rowCount > 0;
  assert.equal(internZeileVorher, false, 'synapse_test: kein intern-Schalter build_nachlauf vorhanden (sonst Test ungueltig)');
  bp.registriereBuildPruefer(fake);
  const an = await aktion('build_einstellungen', { modus: 'setzen', aktiv: true, grund: 'Test P16-T23' });
  assert.equal(an.success, true, JSON.stringify(an));

  // ─── Standard AUS = Altverhalten ───────────────────────────────────────────────────────────────────────────────────────────
  await check('Standard AUS: Schalter standard, Build-Stufe am Plan, commit waehrend Pruefung eingereiht (Warteschlange)', async () => {
    const s = await bp.buildNachlaufAktiv(project);
    assert.equal(s.aktiv, false);
    assert.equal(s.quelle, 'standard');
    assert.equal(s.buendel_ms, 3000);
    assert.equal((await status()).nachlauf, undefined, 'build_status ohne nachlauf bei Schalter aus');
    fake.sperren();
    const p = await ersetze('packages/c/src/index.ts', C_GUT, 'export const c = 9;\n');
    assert.equal(p.pruefung?.build?.status, 'laeuft', JSON.stringify(p.pruefung));
    const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
    assert.equal(c.error, 'build_pruefung_eingereiht', JSON.stringify(c).slice(0, 500));
    assert.equal(c.build_pruefen, undefined);
    fake.freigeben();
    const fertig = await warteBis(async () => ((await status()).letzte_commits.find((l) => l.plan_id === p.plan_id)));
    assert.equal(fertig?.ergebnis, 'geschrieben');
    await seed('packages/c/src/index.ts', C_GUT);
    assert.ok(await ruhig());
  });

  await check('build_einstellungen: nachlauf nur Koordinator/User, Validierung, Projekt-Schalter mit Quelle', async () => {
    assert.equal((await aktion('build_einstellungen', { modus: 'setzen', nachlauf: true }, agent)).error, 'nicht_erlaubt');
    const v = await aktion('build_einstellungen', { modus: 'setzen', nachlauf_buendel_s: 500 });
    assert.equal(v.error, 'ungueltig');
    assert.ok(v.fehler.some((f) => f.startsWith('nachlauf_buendel_s')), JSON.stringify(v.fehler));
    const r = await aktion('build_einstellungen', { modus: 'setzen', nachlauf: true, grund: 'Test P16-T23' });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.ok(r.geaendert.includes(`projekt:${project}: nachlauf true`), JSON.stringify(r.geaendert));
    assert.equal(r.nachlauf.aktiv, true);
    assert.equal(r.nachlauf.quelle, 'projekt');
    const s = await status();
    assert.equal(s.nachlauf.schalter.quelle, 'projekt');
  });

  // ─── Nachlauf ───────────────────────────────────────────────────────────────────────────────────────────────────────
  let planC = null;
  let planB = null;
  await check('plan ohne Build-Stufe; commit schreibt SOFORT, auch waehrend die grosse Pruefung laeuft', async () => {
    fake.sperren();
    const p1 = await ersetze('packages/c/src/index.ts', C_GUT, 'export const c = 2;\n');
    assert.equal(p1.pruefung?.build, undefined, 'keine Build-Stufe beim plan: ' + JSON.stringify(p1.pruefung?.build));
    const c1 = await batch.commitBatch({ plan_id: p1.plan_id, agent_id: agent });
    assert.equal(c1.success, true, JSON.stringify(c1).slice(0, 800));
    assert.equal(c1.build_pruefen?.vorgemerkt, true, JSON.stringify(c1.build_pruefen));
    assert.equal(c1.build_pruefen.aufruf, `code_check(action:"build_pruefen", project:"${project}", plan_id:"${p1.plan_id}")`);
    assert.match(c1.build_pruefen.hinweis, /build_nachlauf/);
    assert.equal(await inhalt('packages/c/src/index.ts'), 'export const c = 2;\n');
    planC = p1.plan_id;
    // Nach dem commit startet NICHTS automatisch (laenger als die Sammelzeit warten).
    await sleep(3500);
    const s0 = await status();
    assert.ok(!s0.nachlauf.laeuft && s0.nachlauf.wartend.length === 0, 'keine Automatik: ' + JSON.stringify(s0.nachlauf));
    assert.deepEqual(s0.nachlauf.vorgemerkt.map((v) => v.plan_id), [planC]);
    const a1 = await aktion('build_pruefen', { plan_id: planC }, agent);
    assert.equal(a1.success, true, JSON.stringify(a1));
    assert.equal(a1.angestossen, true);
    // Lauf startet nach der Sammelzeit (3 s) und haengt im Fake.
    const laeuft = await warteBis(async () => (await status()).nachlauf?.laeuft, 15000);
    assert.ok(laeuft, 'Nachlauf laeuft');
    assert.deepEqual(laeuft.plaene.map((x) => x.plan_id), [planC]);
    assert.equal((await status()).zustand, 'laeuft');
    const p2 = await ersetze('packages/b/src/index.ts', B_GUT, B_ZWEI);
    assert.equal(p2.pruefung?.build, undefined);
    const vorC2 = fake.aufrufe.length;
    const t0 = Date.now();
    const c2 = await batch.commitBatch({ plan_id: p2.plan_id, agent_id: agent });
    assert.equal(c2.success, true, 'commit trotz laufender Pruefung: ' + JSON.stringify(c2).slice(0, 800));
    assert.ok(Date.now() - t0 < 10000, 'commit wartet nicht auf die Pruefung');
    assert.equal(c2.build_pruefen?.vorgemerkt, true, JSON.stringify(c2.build_pruefen));
    assert.equal(await inhalt('packages/b/src/index.ts'), B_ZWEI);
    planB = p2.plan_id;
    const a2 = await aktion('build_pruefen', { plan_id: planB }, agent);
    assert.ok(a2.laeuft_seit, 'Anstoss waehrend des Laufs: ' + JSON.stringify(a2));
    assert.deepEqual((await status()).nachlauf.wartend.map((w) => w.plan_id), [planB]);
    fake.freigeben();
    assert.ok(await ruhig(), 'beide Laeufe fertig');
    const letzte = (await status()).nachlauf.letzte;
    assert.deepEqual(letzte.map((l) => l.plaene.map((x) => x.plan_id)), [[planB], [planC]], 'genau ein Folgelauf');
    assert.equal(letzte[1].status, 'fertig', 'erster Lauf nicht abgebrochen');
    assert.equal(letzte[1].neue_fehler, 0);
    // Abbild: die Auftraege des ersten Laufs (vor dem zweiten commit gezogen) kennen B_ZWEI nicht.
    assert.ok(vorC2 > 0 && fake.aufrufe.slice(0, vorC2).every((a) => !a.dateien.some((d) => d.pfad === 'packages/b/src/index.ts' && d.inhalt.includes('b: number'))), 'erster Lauf auf altem Abbild');
    assert.equal(letzte[0].neue_fehler, 1, JSON.stringify(letzte[0]));
    const bf = letzte[0].befunde[0];
    assert.equal(bf.datei, 'packages/a/src/index.ts');
    assert.match(bf.code, /^TS2554/);
    assert.deepEqual(bf.plan_ids, [planB], 'Folgefehler mit Plan-Zuordnung');
  });

  await check('Hinweis build_nachlauf beim naechsten beliebigen Tool-Aufruf, genau einmal, nur fuer den Committer', async () => {
    const fremd = await ta.ergaenzeToolHinweise({ success: true }, 'memory', { project }, 'jemand-anders');
    assert.equal(fremd.build_nachlauf, undefined);
    const h1 = await ta.ergaenzeToolHinweise({ success: true, x: 1 }, 'memory', { project }, agent);
    assert.equal(h1.x, 1);
    assert.deepEqual(h1.build_nachlauf.map((h) => h.plan_id), [planC, planB], JSON.stringify(h1.build_nachlauf));
    assert.match(h1.build_nachlauf[0].hinweis, new RegExp(`Plan ${planC} ist durch: gruen`));
    assert.match(h1.build_nachlauf[1].hinweis, /1 neue\(r\) Fehler/);
    assert.match(h1.build_nachlauf[1].hinweis, /plan_status/);
    assert.equal(h1.build_nachlauf[1].neue_fehler, 1);
    assert.equal(h1.build_nachlauf[1].befunde[0].datei, 'packages/a/src/index.ts');
    const h2 = await ta.ergaenzeToolHinweise({ success: true }, 'code_intel', { project: 'anderes' }, agent);
    assert.equal(h2.build_nachlauf, undefined, 'genau einmal');
  });

  await check('Ergebnis am Plan (plan_status), sperrt nicht', async () => {
    const g = await pb.ladePlanBefunde(planB);
    assert.equal(g.build.nachlauf, true, JSON.stringify(g.build));
    assert.equal(g.build.neue_fehler, 1);
    assert.equal(g.build.nachlauf_befunde.length, 1);
    assert.equal(g.build.nachlauf_befunde[0].datei, 'packages/a/src/index.ts');
    assert.ok(!g.befunde.some((b) => b.quelle === 'build'), 'nicht in befunde');
    assert.equal(pb.befundUebersicht(g).sperre, false);
    const st = await batch.getBatchPlan(planB);
    assert.equal(st.status, 'committed');
  });

  await check('Zwei commits kurz nacheinander -> EIN gebuendelter Lauf, je Plan ein Hinweis', async () => {
    const vorher = bp.buildPruefungZustand().nachlauf.zaehler;
    const p1 = await ersetze('packages/c/src/index.ts', 'export const c = 2;\n', 'export const c = 3;\n');
    const p2 = await ersetze('packages/b/src/index.ts', B_ZWEI, B_GUT);
    assert.equal((await batch.commitBatch({ plan_id: p1.plan_id, agent_id: agent })).success, true);
    assert.equal((await batch.commitBatch({ plan_id: p2.plan_id, agent_id: agent })).success, true);
    assert.equal((await aktion('build_pruefen', { plan_id: p1.plan_id }, agent)).success, true);
    assert.equal((await aktion('build_pruefen', { plan_id: p2.plan_id }, agent)).success, true);
    assert.ok(await ruhig());
    const nachher = bp.buildPruefungZustand().nachlauf.zaehler;
    assert.equal(nachher.laeufe - vorher.laeufe, 1, JSON.stringify({ vorher, nachher }));
    assert.equal(nachher.gebuendelt - vorher.gebuendelt, 1);
    const letzte = (await status()).nachlauf.letzte[0];
    assert.deepEqual(letzte.plaene.map((x) => x.plan_id), [p1.plan_id, p2.plan_id]);
    assert.equal(letzte.neue_fehler, 0, 'Folgefehler behoben, kein neuer');
    const h = bp.holeBuildNachlaufHinweise(agent);
    assert.deepEqual(h.map((x) => x.plan_id), [p1.plan_id, p2.plan_id]);
    assert.ok(h.every((x) => x.neue_fehler === 0 && /gruen/.test(x.hinweis)));
    assert.deepEqual(bp.holeBuildNachlaufHinweise(agent), []);
  });

  await check('build_pruefen: offener Plan -> erst committen; ohne plan_id/unbekannt -> Fehler; zweiter Anstoss -> wiederholt', async () => {
    const p = await ersetze('packages/c/src/index.ts', 'export const c = 3;\n', 'export const c = 5;\n');
    const r = await aktion('build_pruefen', { plan_id: p.plan_id }, agent);
    assert.equal(r.error, 'plan_offen', JSON.stringify(r));
    assert.match(r.message, /erst committen/);
    await batch.cancelBatch(p.plan_id, agent, 'Testende');
    assert.equal((await aktion('build_pruefen', {}, agent)).error, 'ungueltig');
    assert.equal((await aktion('build_pruefen', { plan_id: '999999999' }, agent)).error, 'nicht_vorgemerkt');
    assert.equal((await aktion('build_pruefen', { plan_id: planB }, agent)).wiederholt, true);
  });

  // ─── intern-Override ──────────────────────────────────────────────────────────────────────────────────────────
  await check('intern-Override build_nachlauf: Vorrang nur mit SYNAPSE_INTERN_TOOL=1, Ablauf -> Produkt-Schalter', async () => {
    assert.equal((await aktion('build_einstellungen', { modus: 'setzen', nachlauf: false, grund: 'Test P16-T23' })).success, true);
    await pool.query(`INSERT INTO intern_schalter (name, aktiv, modus, bis, grund, gesetzt_von, gesetzt_am)
      VALUES ('build_nachlauf', true, 'freigegeben', NOW() + interval '5 minutes', 'Test P16-T23', 'test', NOW())`);
    assert.deepEqual(await bp.buildNachlaufAktiv(project).then((s) => [s.aktiv, s.quelle]), [false, 'projekt'], 'ohne intern-Tool wirkt der Override nicht');
    process.env.SYNAPSE_INTERN_TOOL = '1';
    const s = await bp.buildNachlaufAktiv(project);
    assert.equal(s.aktiv, true);
    assert.equal(s.quelle, 'intern');
    assert.ok(s.bis);
    const p = await ersetze('packages/c/src/index.ts', 'export const c = 3;\n', 'export const c = 4;\n');
    assert.equal(p.pruefung?.build, undefined, 'Override wirkt auf den plan');
    await batch.cancelBatch(p.plan_id, agent, 'Testende');
    await pool.query("UPDATE intern_schalter SET bis = NOW() - interval '1 second' WHERE name='build_nachlauf'");
    assert.deepEqual(await bp.buildNachlaufAktiv(project).then((x) => [x.aktiv, x.quelle]), [false, 'projekt'], 'Ablauf -> Produkt-Schalter');
    delete process.env.SYNAPSE_INTERN_TOOL;
  });

  console.log('TEST_GRUEN P16-T23 checks=' + ok);
} finally {
  delete process.env.SYNAPSE_INTERN_TOOL;
  bp.registriereBuildPruefer(null);
  fake.freigeben();
  if (!internZeileVorher) await pool.query("DELETE FROM intern_schalter WHERE name='build_nachlauf'").catch(() => {});
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [project]).catch(() => {});
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_references', 'code_call_edges', 'code_statements', 'code_symbols', 'code_chunks', 'code_files', 'agent_events']) {
    await pool.query('DELETE FROM ' + t + ' WHERE project=$1', [project]).catch(() => {});
  }
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  await pool.query('DELETE FROM build_pruefung_einstellungen WHERE bereich=$1', ['projekt:' + project]).catch(() => {});
  rmSync(tmpRoot, { recursive: true, force: true });
  await db.closePool();
}
