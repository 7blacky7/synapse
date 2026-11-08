/**
 * P16-T26 (claude-buche, 08.11.2026): Pruef-Container ohne feste Speichergrenze, Heap der Plan-Typpruefung einstellbar.
 * WARUM: User-Entscheidung 08.11.2026 ~19:10 (Task P16-T26): der Container holt sich von Unraid so viel Speicher, wie
 * er braucht; der Einstellwert speicher_mb bleibt nur optionale Obergrenze (0 = unbegrenzt). Die Plan-Typpruefung lief
 * mit 256 MB Node-Heap in "JS heap out of memory" (Befund live t238, Bestand/Messung thought 6a61ea52).
 *
 * PRUEFT (Herkunft je Label):
 *   - packages/rest-api/src/services/pruef-container.ts: pruefContainerConfigAusEnv (Standard memMb 0), speicherGrenzeMb,
 *     containerOptionen (Memory 0, Sicherheit/PIDs bleiben), setzeBudget (0 erlaubt), zustand().limits.speicher_grenze,
 *     pruefeTypen (heap_mb aus typenHeap in der Nachricht, Diagnose typen.letzter_heap_mb / letzter_rss_mb).
 *   - docker/synapse-pruefcontainer/pruefer_typen.py (lokal mit python3 + node wie im Container): heap_mb der Nachricht
 *     wirkt (NODE_OPTIONS + Worker resourceLimits), Antwort heap_mb + speicher.rss_mb; ECHTE Typpruefung von
 *     packages/core (agent-profil-schalter-ziel.ts, Quellen von der Platte, Plan-Schatten mit kleiner Aenderung):
 *     mit 4096 MB fertig, mit 256 MB Heap-Ende mit Hinweis (der alte Fehler).
 *   - P16-T26 A-D (User-Freigabe 08.11.2026 nach Lebenszyklus-Analyse thought 93aa8821): A pruefserver.lauf beendet die
 *     Prozessgruppe (Reste weg, Zaehler aufgeraeumt), HostConfig.Init; B pruefer_projekt.gocache_leerlauf_pruefen
 *     (Leerlauf, nie bei belegter Semaphore), gocache_max_mb 0 = privat; C pruefserver.pflege uebernimmt
 *     jvm_leerlauf_s/gocache_* (pruefer_jvm.setze_leerlauf); D speicher_aufgeschluesselt (memory.stat anon/file/shmem,
 *     pids, cgroup-Attrappe PRUEF_CGROUP) + prozesse aus /proc; API PruefContainer.pflegen (Werte hin, Stand in zustand,
 *     altes Image -> unterstuetzt false). Standard-Heap seit Koordinator 08.11.: 2048 (Unraid ~5,7 GB frei).
 * Kein Docker, keine DB: typenHeap wird im Test gesetzt (Produktion: registriereContainerSyntaxPruefer ->
 * core wirksamesBuildBudget().heap_mb). Braucht gebautes dist von core und rest-api.
 * Aufruf: cd packages/rest-api && node --test tests/pruefcontainer-speicher-p16-t26.test.mjs
 *   P16_T26_ECHT=0 ueberspringt die echte core-Typpruefung (zusammen ~1-2 min).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PruefContainer, pruefContainerConfigAusEnv, speicherGrenzeMb } from '../dist/services/pruef-container.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(hier, '../../..');
const pruefDir = path.join(repo, 'docker/synapse-pruefcontainer');
const typescript = createRequire(path.join(repo, 'packages/core/package.json')).resolve('typescript');
const ECHT = process.env.P16_T26_ECHT !== '0';

/** Debugzeile bei Fehlschlag: Herkunft, erwartet, tatsaechlich (gekuerzt). */
const dbg = (herkunft, erwartet, ist) => `${herkunft}\n  erwartet: ${erwartet}\n  ist: ${JSON.stringify(ist).slice(0, 600)}`;

/** pruefer_typen.pruefe wie im Container (pruefserver ruft genau diese Funktion). */
function pythonTypen(nachricht, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-B', '-c', 'import sys,json,pruefer_typen as t; print(json.dumps(t.pruefe(json.load(sys.stdin))))'], {
      cwd: pruefDir,
      env: { PATH: process.env.PATH, PYTHONPATH: pruefDir, PRUEF_NODE: process.execPath, PRUEF_TYPESCRIPT: typescript, PRUEF_LEER: tmpdir(), ...env },
    });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    p.on('error', reject);
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('pruefer_typen ohne JSON: ' + err.slice(0, 500))); } });
    p.stdin.end(JSON.stringify(nachricht));
  });
}

function container({ antwort } = {}) {
  const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
  const gesendet = [];
  pc.bereitMachen = async () => {};
  pc.schicke = async (nachricht) => {
    gesendet.push(nachricht);
    if (antwort) return antwort(nachricht);
    return { ok: true, typen: await pythonTypen(nachricht.typen) };
  };
  return { pc, gesendet };
}

const kleinerAuftrag = () => {
  const datei = 'pkg/src/a.ts';
  const gut = 'export const enabled: boolean = true;\n';
  return {
    project: 'p16-t26-test', root: '/__synapse_typen__/p16t26', budget_ms: 20000, basisvergleich: true, ziele: [datei],
    quellen: [{ file_path: 'pkg/tsconfig.json', content: JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, types: [] }, include: ['src'] }) }, { file_path: datei, content: gut }],
    dateien: [{ file_path: datei, basis: gut, ergebnis: "export const enabled: boolean = 'yes';\n", ops: [{ op_index: 0, agent_id: 'p16-t26-test', spannen: [[0, 1]] }] }],
  };
};

// ─── Konfiguration und Container-Optionen ───────────────────────────────────────────────────────────────────────

test('P16-T26 pruef-container.ts pruefContainerConfigAusEnv: Standard memMb 0 (unbegrenzt), Env > 0 = Obergrenze', () => {
  const alt = process.env.PRUEFCONTAINER_MEM_MB;
  try {
    delete process.env.PRUEFCONTAINER_MEM_MB;
    assert.equal(pruefContainerConfigAusEnv().memMb, 0, dbg('P16-T26 pruefContainerConfigAusEnv ohne Env', 0, pruefContainerConfigAusEnv().memMb));
    process.env.PRUEFCONTAINER_MEM_MB = '512';
    assert.equal(pruefContainerConfigAusEnv().memMb, 512);
    process.env.PRUEFCONTAINER_MEM_MB = '50';
    assert.equal(pruefContainerConfigAusEnv().memMb, 128, 'P16-T26 Obergrenze mindestens 128 MB');
  } finally {
    if (alt === undefined) delete process.env.PRUEFCONTAINER_MEM_MB; else process.env.PRUEFCONTAINER_MEM_MB = alt;
  }
  assert.deepEqual([speicherGrenzeMb(0), speicherGrenzeMb(-1), speicherGrenzeMb(NaN), speicherGrenzeMb(100), speicherGrenzeMb(2048.4)], [0, 0, 0, 128, 2048]);
});

test('P16-T26 pruef-container.ts containerOptionen: Memory 0 ohne Grenze, Sicherheit und PIDs bleiben', () => {
  const pc = new PruefContainer({}, { ...pruefContainerConfigAusEnv(), memMb: 0 });
  const o = pc.containerOptionen();
  assert.equal(o.HostConfig.Memory, 0, dbg('P16-T26 containerOptionen Memory', 0, o.HostConfig));
  assert.equal(o.HostConfig.MemorySwap, 0);
  assert.equal(o.HostConfig.ReadonlyRootfs, true);
  assert.equal(o.User, '65532:65532');
  assert.deepEqual(o.HostConfig.CapDrop, ['ALL']);
  assert.ok(o.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(o.HostConfig.NetworkMode, 'none');
  assert.equal(o.HostConfig.PidsLimit, pruefContainerConfigAusEnv().pids);
  const mit = new PruefContainer({}, { ...pruefContainerConfigAusEnv(), memMb: 2048 }).containerOptionen();
  assert.equal(mit.HostConfig.Memory, 2048 * 1048576, 'P16-T26 Obergrenze bleibt moeglich');
  assert.equal(mit.HostConfig.MemorySwap, 2048 * 1048576);
});

test('P16-T26 pruef-container.ts setzeBudget(speicher_mb 0) -> unbegrenzt, zustand().limits.speicher_grenze', async () => {
  const pc = new PruefContainer({}, { ...pruefContainerConfigAusEnv(), memMb: 2048 });
  assert.equal(pc.zustand().limits.speicher_grenze, '2048 MB');
  assert.equal(await pc.setzeBudget({ speicher_mb: 0 }), true, 'P16-T26 setzeBudget 2048 -> 0 ist eine Aenderung');
  assert.equal(pc.cfg.memMb, 0);
  const z = pc.zustand();
  assert.equal(z.limits.mem_mb, 0);
  assert.equal(z.limits.speicher_grenze, 'unbegrenzt', dbg('P16-T26 zustand().limits', 'unbegrenzt', z.limits));
  assert.equal(await pc.setzeBudget({ speicher_mb: 0 }), false, 'P16-T26 gleiches Budget -> kein Neustart');
});

// ─── Heap der Plan-Typpruefung ──────────────────────────────────────────────────────────────────────────────────

test('P16-T26 pruef-container.ts pruefeTypen: heap_mb aus typenHeap in der Nachricht, Messwerte in zustand().typen', async () => {
  const { pc, gesendet } = container({ antwort: async (n) => ({ ok: true, typen: { status: 'fertig', dauer_ms: 1, befunde: [], altlasten: 0, dateien: [], vollstaendig: true, fehlende_module: [], betroffene_aufrufer: [], heap_mb: n.typen.heap_mb, speicher: { rss_mb: 123 } } }) });
  pc.typenHeap = async () => 3072;
  const r = await pc.pruefeTypen(kleinerAuftrag());
  assert.equal(r.status, 'fertig', JSON.stringify(r));
  assert.equal(gesendet[0].typen.heap_mb, 3072, dbg('P16-T26 pruefeTypen Nachricht heap_mb', 3072, Object.keys(gesendet[0].typen)));
  const z = pc.zustand().typen;
  assert.equal(z.letzter_heap_mb, 3072);
  assert.equal(z.letzter_rss_mb, 123);
});

test('P16-T26 pruef-container.ts pruefeTypen: typenHeap fehlt/wirft -> kein heap_mb, Pruefung laeuft trotzdem', async () => {
  const { pc, gesendet } = container({ antwort: async () => ({ ok: true, typen: { status: 'fertig', dauer_ms: 1, befunde: [], altlasten: 0, dateien: [], vollstaendig: true, fehlende_module: [], betroffene_aufrufer: [] } }) });
  pc.typenHeap = async () => { throw new Error('P16-T26 Test: Einstellung nicht lesbar'); };
  const r = await pc.pruefeTypen(kleinerAuftrag());
  assert.equal(r.status, 'fertig');
  assert.equal('heap_mb' in gesendet[0].typen, false);
  assert.equal(pc.zustand().typen.letzter_heap_mb, null, 'P16-T26 altes Image ohne heap_mb -> null');
});

test('P16-T26 pruefer_typen.py: heap_mb der Nachricht wirkt, Standard 2048, Antwort mit speicher.rss_mb', async () => {
  const { pc } = container();
  pc.typenHeap = async () => 1024;
  const r = await pc.pruefeTypen(kleinerAuftrag());
  assert.equal(r.status, 'fertig', JSON.stringify(r));
  assert(r.befunde.some((b) => b.code === 'TS2322' && b.severity === 'error'), dbg('P16-T26 pruefer_typen kleiner Auftrag', 'TS2322', r.befunde));
  assert.equal(r.heap_mb, 1024, dbg('P16-T26 pruefer_typen.py heap_fuer', 1024, r));
  assert.ok(r.speicher?.rss_mb > 10, dbg('P16-T26 pruefer_typen.py BOOTSTRAP speicher.rss_mb', '> 10', r.speicher));
  const ohne = await pythonTypen({ ...(await (async () => { const { pc: p2, gesendet } = container({ antwort: async () => ({ ok: true }) }); await p2.pruefeTypen(kleinerAuftrag()); return gesendet[0].typen; })()) });
  assert.equal(ohne.heap_mb, 2048, dbg('P16-T26 pruefer_typen.py Standard PRUEF_TYPEN_HEAP_MB', 2048, ohne.heap_mb));
  const zuGross = await pythonTypen({ engine: '', diff: '', auftrag: {}, heap_mb: 999999 });
  assert.equal(zuGross.heap_mb, 16384, 'P16-T26 heap_fuer kappt auf PRUEF_TYPEN_MAX_HEAP_MB');
});

// ─── Echte Typpruefung von packages/core (Nachweis aus der Task) ───────────────────────────────────────────────

/** Quellen von packages/core wie im Code-Index (TS-Quellen + tsconfig-Kette + package.json), ohne __testdata__. */
function coreQuellen() {
  const quellen = [];
  for (const f of ['tsconfig.base.json', 'package.json', 'packages/core/tsconfig.json', 'packages/core/package.json']) {
    quellen.push({ file_path: f, content: readFileSync(path.join(repo, f), 'utf8') });
  }
  for (const rel of readdirSync(path.join(repo, 'packages/core/src'), { recursive: true })) {
    const p = String(rel).split(path.sep).join('/');
    if (!/\.(ts|tsx|mts|cts)$/.test(p) || p.startsWith('parser/__testdata__/')) continue;
    quellen.push({ file_path: 'packages/core/src/' + p, content: readFileSync(path.join(repo, 'packages/core/src', p), 'utf8') });
  }
  return quellen;
}

function coreAuftrag() {
  const datei = 'packages/core/src/services/agent-profil-schalter-ziel.ts';
  assert.ok(existsSync(path.join(repo, datei)), 'P16-T26 Zieldatei aus der Task fehlt: ' + datei);
  const basis = readFileSync(path.join(repo, datei), 'utf8');
  const ergebnis = basis + '\n// P16-T26 Probe\nexport const p16t26Probe: number = 1;\n';
  const zeilen = ergebnis.split('\n').length;
  return {
    project: 'p16-t26-core', root: '/__synapse_typen__/p16t26core', budget_ms: 240000, basisvergleich: true, ziele: [datei],
    quellen: coreQuellen().filter((q) => q.file_path !== datei).concat([{ file_path: datei, content: basis }]),
    dateien: [{ file_path: datei, basis, ergebnis, ops: [{ op_index: 0, agent_id: 'p16-t26-test', spannen: [[zeilen - 3, zeilen]] }] }],
  };
}

test('P16-T26 Nachweis: echte Typpruefung packages/core (agent-profil-schalter-ziel.ts) mit Standard 2048 MB ohne Speichermangel', { skip: !ECHT && 'P16_T26_ECHT=0' }, async () => {
  const { pc } = container();
  // Pruefer claude-birke 08.11.2026: der neue Standard (BUILD_HEAP_STANDARD_MB 2048, User c78a9965) muss fuer core reichen.
  pc.typenHeap = async () => 2048;
  const a = coreAuftrag();
  const t0 = Date.now();
  const r = await pc.pruefeTypen(a);
  const z = pc.zustand().typen;
  console.log(`  P16-T26 MESSUNG core: status=${r.status} quellen=${a.quellen.length} heap_mb=${r.heap_mb} rss_mb=${r.speicher?.rss_mb} werkzeug_ms=${r.werkzeug_ms} gesamt_ms=${Date.now() - t0} befunde=${r.befunde.length} fehlende_module=${r.fehlende_module.length}`);
  assert.equal(r.status, 'fertig', dbg('P16-T26 pruefer_typen.py core 2048 MB', 'fertig', { status: r.status, hinweis: r.hinweis }));
  assert.equal(r.heap_mb, 2048);
  assert.equal(z.letzter_rss_mb, r.speicher.rss_mb);
  assert.equal(r.befunde.filter((b) => b.severity === 'error').length, 0, dbg('P16-T26 Probe-Aenderung typrichtig', '0 error', r.befunde.slice(0, 5)));
});

test('P16-T26 Gegenprobe: dieselbe core-Typpruefung mit 256 MB (alter Standard) -> Heap-Ende mit Hinweis, keine Sperre', { skip: !ECHT && 'P16_T26_ECHT=0' }, async () => {
  const { pc } = container();
  pc.typenHeap = async () => 256;
  const r = await pc.pruefeTypen(coreAuftrag());
  console.log(`  P16-T26 GEGENPROBE 256 MB: status=${r.status} rss_mb=${r.speicher?.rss_mb} hinweis=${String(r.hinweis).slice(0, 200)}`);
  assert.equal(r.status, 'nicht_verfuegbar', dbg('P16-T26 core 256 MB', 'nicht_verfuegbar', { status: r.status, hinweis: r.hinweis }));
  assert.match(String(r.hinweis), /Heap 256 MB reicht/, dbg('P16-T26 pruefer_typen.py _heap_text', 'Heap 256 MB reicht', r.hinweis));
  assert.equal(r.befunde.length, 0);
});

// ─── P16-T26 A-D: Aufraeumen, Init, Leerlauf-Ende, Pflege (User-Freigabe 08.11.2026, thought 93aa8821) ────────────

/** Python im Modulverzeichnis des Containers; Ergebnis = JSON der letzten Ausgabezeile. */
function python(code, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-B', '-c', code], { cwd: pruefDir, env: { PATH: process.env.PATH, PYTHONPATH: pruefDir, PRUEF_LEER: tmpdir(), ...env } });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    p.on('error', reject);
    p.on('close', (rc) => { try { resolve(JSON.parse(out.trim().split('\n').at(-1))); } catch { reject(new Error(`python rc ${rc} ohne JSON: ${err.slice(-800)}`)); } });
  });
}

test('P16-T26 A pruef-container.ts containerOptionen: HostConfig.Init Standard an, PRUEFCONTAINER_INIT=0 aus', () => {
  const alt = process.env.PRUEFCONTAINER_INIT;
  try {
    delete process.env.PRUEFCONTAINER_INIT;
    const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
    assert.equal(pc.containerOptionen().HostConfig.Init, true, dbg('P16-T26 A HostConfig.Init', true, pc.containerOptionen().HostConfig));
    assert.equal(pc.zustand().limits.init, true);
    process.env.PRUEFCONTAINER_INIT = '0';
    assert.equal(new PruefContainer({}, pruefContainerConfigAusEnv()).containerOptionen().HostConfig.Init, false);
  } finally {
    if (alt === undefined) delete process.env.PRUEFCONTAINER_INIT; else process.env.PRUEFCONTAINER_INIT = alt;
  }
});

test('P16-T26 A pruefserver.lauf: abgespaltener Rest der Prozessgruppe wird nach dem Lauf beendet', async () => {
  const r = await python([
    'import json, time, pruefserver as s, pruefer_tsbuild as tb',
    "rc, out, err = s.lauf(['sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], b'')",
    'pid = int(out.decode().strip()); time.sleep(0.3)',
    'try:',
    "    st = open(f'/proc/{pid}/stat').read().split(')')[-1].split()[0]",
    'except OSError:',
    "    st = 'weg'",
    "print(json.dumps({'rc': rc, 'zustand': st, 'aufgeraeumt': tb.AUFGERAEUMT}))",
  ].join('\n'));
  assert.equal(r.rc, 0);
  assert.ok(['weg', 'Z', 'X'].includes(r.zustand), dbg('P16-T26 A pruefserver.lauf -> pruefer_tsbuild.gruppe_beenden', 'sleep beendet (weg/Z)', r));
  assert.ok(r.aufgeraeumt.mit_resten >= 1, dbg('P16-T26 A Zaehler aufgeraeumt.mit_resten', '>= 1', r.aufgeraeumt));
});

test('P16-T26 C/D pruefserver.pflege: Einstellwerte uebernommen, memory.stat aufgeschluesselt, Prozessliste', async () => {
  const cg = mkdtempSync(path.join(tmpdir(), 'p16t26-cgroup-'));
  const tmp = mkdtempSync(path.join(tmpdir(), 'p16t26-tmp-'));
  try {
    // Attrappe der cgroup v2 (Live-Befund Koordinator 08.11.: 335 MB current im Leerlauf, nur pruefserver.py).
    writeFileSync(path.join(cg, 'memory.current'), String(335 * 1048576));
    writeFileSync(path.join(cg, 'memory.peak'), String(400 * 1048576));
    writeFileSync(path.join(cg, 'memory.max'), 'max\n');
    writeFileSync(path.join(cg, 'memory.stat'), `anon ${50 * 1048576}\nfile ${200 * 1048576}\nshmem ${100 * 1048576}\nkernel ${10 * 1048576}\n`);
    writeFileSync(path.join(cg, 'pids.current'), '3\n');
    const r = await python([
      'import json, os, pruefserver as s',
      "a = s.pflege({'jvm_leerlauf_s': 120, 'gocache_leerlauf_s': 60, 'gocache_max_mb': 128, 'unbekannt': 5})",
      "b = s.pflege({'jvm_leerlauf_s': True, 'gocache_max_mb': 'x'})",
      // Auf dem Host listet /proc alle Prozesse (im Container nur die eigenen): den eigenen ohne 40er-Kappung suchen.
      "ich = [p for p in s.prozesse(10 ** 6) if p['pid'] == os.getpid()]",
      "print(json.dumps({'a': a, 'b_geaendert': b['geaendert'], 'ich': ich, 'info_leerlauf': s.leerlauf_einstellungen()}))",
    ].join('\n'), { PRUEF_CGROUP: cg, PRUEF_BUILD_TMP: tmp });
    const a = r.a;
    assert.deepEqual(a.einstellungen, { jvm_leerlauf_s: 120, gocache_leerlauf_s: 60, gocache_max_mb: 128 }, dbg('P16-T26 C pruefserver.pflege einstellungen', '120/60/128', a.einstellungen));
    assert.deepEqual(Object.keys(a.geaendert).sort(), ['gocache_leerlauf_s', 'gocache_max_mb', 'jvm_leerlauf_s']);
    assert.deepEqual(r.b_geaendert, {}, 'P16-T26 C ungueltige Werte (bool, Text) werden ignoriert');
    assert.equal(a.jvm.idle_s, 120, 'P16-T26 C pruefer_jvm.setze_leerlauf wirkt in zustand()');
    assert.equal(a.speicher.aktuell_mb, 335);
    assert.equal(a.speicher.limit, 'unbegrenzt');
    assert.deepEqual(a.speicher.stat_mb, { anon: 50, file: 200, shmem: 100, kernel: 10 }, dbg('P16-T26 D speicher_aufgeschluesselt stat_mb', 'anon 50/file 200/shmem 100/kernel 10', a.speicher));
    assert.equal(a.speicher.pids, 3);
    assert.equal(typeof a.speicher.tmp_belegt_mb, 'number');
    assert.ok(Array.isArray(a.prozesse) && a.prozesse.length > 0 && a.prozesse.length <= 40, 'P16-T26 D pflege.prozesse gekappt auf 40');
    const ich = r.ich[0];
    assert.ok(ich && /python/.test(ich.name) && ich.rss_mb > 1 && ich.alter_s >= 0 && ich.zustand, dbg('P16-T26 D pruefserver.prozesse aus /proc', 'eigener python-Prozess mit rss/alter/zustand', r.ich));
    assert.equal(a.gocache.max_mb, 128);
    assert.deepEqual(r.info_leerlauf, a.einstellungen, 'P16-T26 D info().leerlauf');
  } finally {
    rmSync(cg, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('P16-T26 B pruefer_projekt.gocache_leerlauf_pruefen: frisch bleibt, belegte Semaphore wartet, Leerlauf leert; max 0 = privat', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'p16t26-go-'));
  try {
    const r = await python([
      'import json, os, time, pruefer_projekt as pp, pruefer_tsbuild as ts',
      "os.makedirs(pp.GOCACHE_GETEILT + '/aa', exist_ok=True)",
      "open(pp.GOCACHE_GETEILT + '/aa/x', 'w').write('x' * 2000)",
      'pp.setze_gocache(leerlauf_s=60)',
      "pp._go['zuletzt'] = time.monotonic()",
      'frisch = pp.gocache_leerlauf_pruefen()',
      "pp._go['zuletzt'] = time.monotonic() - 120",
      'ts._sperre.acquire(); belegt = pp.gocache_leerlauf_pruefen(); ts._sperre.release()',
      'alt = pp.gocache_leerlauf_pruefen()',
      'z = pp.gocache_zustand()',
      'pp.setze_gocache(max_mb=0)',
      "privat = pp._gocache('/tmp/p16t26-privat')",
      // Pruefer claude-birke 08.11.2026: max 0 leert einen schon vorhandenen geteilten Cache sofort, auch bei Leerlauf 0.
      'weg_vorher = not os.path.isdir(pp.GOCACHE_GETEILT)',
      "os.makedirs(pp.GOCACHE_GETEILT + '/bb', exist_ok=True)",
      'pp.setze_gocache(leerlauf_s=0)',
      "pp._go['zuletzt'] = time.monotonic()",
      'aus0 = pp.gocache_leerlauf_pruefen()',
      'weg0 = not os.path.isdir(pp.GOCACHE_GETEILT)',
      'pp.setze_gocache(max_mb=256)',
      "os.makedirs(pp.GOCACHE_GETEILT + '/cc', exist_ok=True)",
      'nie = pp.gocache_leerlauf_pruefen(time.monotonic() + 10 ** 6)',
      "print(json.dumps({'frisch': frisch, 'belegt': belegt, 'alt': alt, 'weg': weg_vorher, 'z': z, 'privat': privat, 'aus0': aus0, 'weg0': weg0, 'nie': nie}))",
    ].join('\n'), { PRUEF_BUILD_TMP: tmp });
    assert.equal(r.frisch, false, 'P16-T26 B frisch benutzt -> bleibt');
    assert.equal(r.belegt, false, 'P16-T26 B Projektpruefer laeuft (Semaphore belegt) -> nicht leeren');
    assert.equal(r.alt, true, dbg('P16-T26 B Leerlauf ueberschritten -> geleert', true, r));
    assert.equal(r.weg, true);
    assert.equal(r.z.leerlauf_geleert, 1);
    assert.equal(r.privat, '/tmp/p16t26-privat/gocache', 'P16-T26 C gocache_max_mb 0 -> kein geteilter Cache');
    assert.equal(r.aus0, true, dbg('P16-T26 B gocache_max_mb 0 leert vorhandenen geteilten Cache auch bei Leerlauf 0', true, r));
    assert.equal(r.weg0, true);
    assert.equal(r.nie, false, 'P16-T26 B gocache_leerlauf_s 0 (max > 0) -> nie leeren');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('P16-T26 C/D pruef-container.ts pflegen: Leerlaufwerte hin, Stand in zustand().pflege, altes Image -> unterstuetzt false', async () => {
  const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
  const gesendet = [];
  pc.zustandName = 'bereit';
  pc.stream = {};
  pc.leerlaufWerte = async () => ({ jvm_leerlauf_s: 120, gocache_leerlauf_s: 900, gocache_max_mb: 256 });
  pc.schicke = async (n) => { gesendet.push(n); return { ok: true, pflege: { einstellungen: { jvm_leerlauf_s: 120, gocache_leerlauf_s: 900, gocache_max_mb: 256 }, speicher: { aktuell_mb: 335, stat_mb: { anon: 50, file: 200, shmem: 85 } }, prozesse: [{ pid: 7, name: 'python3' }] } }; };
  const stand = await pc.pflegen();
  assert.deepEqual(gesendet[0].pflege, { jvm_leerlauf_s: 120, gocache_leerlauf_s: 900, gocache_max_mb: 256 }, dbg('P16-T26 C pflegen Nachricht', 'Leerlaufwerte', gesendet[0]));
  assert.equal(stand.speicher.stat_mb.file, 200);
  assert.equal(pc.cfg.jvmIdleS, 120, 'P16-T26 C API-Seite folgt dem wirksamen JVM-Leerlauf');
  const z = pc.zustand().pflege;
  assert.equal(z.abfragen, 1);
  assert.equal(z.stand.prozesse[0].name, 'python3');
  // Altes Image: pruefserver kennt 'pflege' nicht und antwortet wie bei einer unbekannten Sprache.
  pc.schicke = async () => { throw new Error('Pruef-Container: keine Pruefung fuer Sprache None'); };
  assert.equal(await pc.pflegen(), null);
  assert.equal(pc.zustand().pflege.unterstuetzt, false);
  let nochmal = 0;
  pc.schicke = async () => { nochmal++; return { ok: true }; };
  assert.equal(await pc.pflegen(), null);
  assert.equal(nochmal, 0, 'P16-T26 altes Image: bis zum naechsten Start keine weiteren Pflege-Nachrichten');
  // Nicht bereit -> startet nichts, schickt nichts.
  const kalt = new PruefContainer({}, pruefContainerConfigAusEnv());
  kalt.schicke = async () => { throw new Error('darf nicht senden'); };
  assert.equal(await kalt.pflegen(), null);
});

// P16-T26 B1 (Gesamtbericht t242, thought 268f113f): Docker-T8 "3 Timeouts in Folge -> Container gestoppt" war rot, weil die
// ok-Antwort der Pflege nach dem Start timeoutsInFolge auf 0 setzte. Ohne Docker: Attrappen-Stream, Antworten von Hand.
test('P16-T26 B1 Pflege-Antwort setzt den Timeout-Zaehler nicht zurueck; dritter Timeout stoppt; echte Pruefantwort setzt zurueck', async () => {
  const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
  const geschrieben = [];
  const gestoppt = [];
  pc.zustandName = 'bereit';
  pc.stream = { write: (z) => { geschrieben.push(JSON.parse(z)); return true; } };
  pc.stoppen = async (grund) => { gestoppt.push(grund); };
  const pruefung = () => pc.schicke({ sprache: 'rust', inhalt: '', pfad: 'a.rs' }, 20, { sprache: 'rust', pfad: 'a.rs' }).then(() => 'ok', (e) => e.name || 'fehler');
  await pruefung();
  await pruefung();
  assert.equal(pc.timeoutsInFolge, 2, dbg('P16-T26 B1 zwei Pruef-Timeouts gezaehlt', 2, pc.timeoutsInFolge));
  const pflege = pc.pflegen();
  await new Promise((r) => setImmediate(r));
  const nachricht = geschrieben.find((n) => n.pflege !== undefined);
  assert.ok(nachricht, dbg('P16-T26 B1 Pflege-Nachricht geschrieben', 'pflege', geschrieben));
  pc.antwort(JSON.stringify({ id: nachricht.id, ok: true, pflege: { einstellungen: {} } }));
  assert.ok(await pflege, 'P16-T26 B1 Pflege beantwortet');
  assert.equal(pc.timeoutsInFolge, 2, dbg('P16-T26 B1 Pflege-Antwort laesst die Timeout-Folge stehen', 2, pc.timeoutsInFolge));
  await pruefung();
  assert.deepEqual(gestoppt, ['3 Timeouts in Folge'], dbg('P16-T26 B1 dritter Timeout in Folge stoppt den Container (T8)', ['3 Timeouts in Folge'], gestoppt));
  assert.equal(pc.timeoutsInFolge, 0);
  // Gegenprobe: eine echte Pruefantwort beendet die Folge wie bisher.
  await pruefung();
  assert.equal(pc.timeoutsInFolge, 1);
  const echt = pc.schicke({ sprache: 'rust', inhalt: 'fn main(){}', pfad: 'b.rs' }, 1000, { sprache: 'rust', pfad: 'b.rs' });
  pc.antwort(JSON.stringify({ id: geschrieben[geschrieben.length - 1].id, ok: true, meldungen: [], ms: 1 }));
  await echt;
  assert.equal(pc.timeoutsInFolge, 0, 'P16-T26 B1 echte Pruefantwort setzt die Timeout-Folge zurueck');
});
