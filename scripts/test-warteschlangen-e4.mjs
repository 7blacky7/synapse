#!/usr/bin/env node
// test-warteschlangen-e4.mjs — P15-T12 E4: Umsortieren, gegen die TEST-DB (braucht das E4-Schema: core.ensureSchema()).
//   R1 Regression Schritt 1: CLAIM_SQL.normal liefert ohne prio/zurueckgestellt_bis exakt die Reihenfolge der alten Abfrage
//   R2 Regression Projektwahl: Stufe zuerst, innerhalb der Stufe zufaellig (beide Projekte kommen vor), wie die alte Abfrage
//   R3 claimEmbeddingChunks ohne Steuerung: file_path, chunk_index des gewaehlten Projekts
//   V1 Chunk vorne: vor allen anderen, auch aus einem Projekt mit schlechterer Stufe
//   V2 Chunk hinten: erst am Ende seines Projekts
//   V3 Datei zurueckstellen: nicht geclaimt, Liste/Uebersicht zeigen es, einreihen hebt es auf
//   V4 Projekt zurueckstellen: Projektwahl und Parser-Backlog ueberspringen es; einreihen entfernt den Eintrag
//   V5 Projekt vorne/hinten = Stufe 1/4
//   V6 einreihen eines eingebetteten Chunks -> neu einbetten (embedded_at NULL)
//   V7 Fehlercodes (dauer_fehlt, parameter_ungueltig, nicht_verschiebbar, unbekanntes_projekt, Kappung)
//   I1-I4 Daemon-Index (Speicher): FIFO ohne Steuerung, Projekt vorne, Projekt zurueckstellen mit Wecker, Ereignis vorne
// Aufruf: set -a; . <test-db.env>; set +a; node scripts/test-warteschlangen-e4.mjs   (core + daemon gebaut)
import assert from 'node:assert/strict';

if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('ABBRUCH: DATABASE_URL zeigt nicht auf die Test-DB (:5433/synapse_test).');
  process.exit(2);
}
process.env.SYNAPSE_INTERN_TOOL = '1';
process.env.INDEX_MAX_CONCURRENT = '1';

const core = await import('../packages/core/dist/index.js');
const { CLAIM_SQL, claimEmbeddingChunks } = await import('../packages/core/dist/services/embedding-claims.js');
const pool = core.getPool();
const A = 'p15-e4-a';
const B = 'p15-e4-b';
const NODE = 'p15-e4-knoten';
const intern = (args) => core.fuehreInternAus(args, 'test-e4');
let ok = 0;
const pruefe = (bed, name, info) => {
  if (!bed) {
    console.error('FEHLER ' + name, info === undefined ? '' : JSON.stringify(info, null, 2).slice(0, 2500));
    process.exitCode = 1;
    throw new Error(name);
  }
  ok++;
  console.log('OK  ' + name);
};

// Alte Abfragen (Stand vor E4) woertlich, als Referenz fuer die Regression.
const SPALTEN = `cc.id, cc.project, cc.file_path, cf.file_type, cc.chunk_index,
              cc.content, cc.line_start, cc.line_end,
              (SELECT COUNT(*) FROM code_chunks allc
                WHERE allc.project=cc.project AND allc.file_path=cc.file_path)::int AS total_chunks`;
const ALT_NORMAL = `SELECT ${SPALTEN}
         FROM code_chunks cc
         JOIN code_files cf ON cf.project=cc.project AND cf.file_path=cc.file_path
        WHERE cc.project = $2
          AND cc.embedded_at IS NULL
          AND (cc.lease_until IS NULL OR cc.lease_until < NOW())
        ORDER BY cc.file_path, cc.chunk_index
        LIMIT $1
        FOR UPDATE OF cc SKIP LOCKED`;
const ALT_PROJEKTWAHL = `SELECT p.name
         FROM (SELECT DISTINCT name, enabled FROM projects) p
        WHERE p.enabled
          AND EXISTS (SELECT 1 FROM code_chunks cc
                       WHERE cc.project = p.name AND cc.embedded_at IS NULL)
        ORDER BY COALESCE((SELECT e.stufe FROM embed_prioritaet e WHERE e.project = p.name), 3), random()
        LIMIT 1`;

async function inTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); return await fn(c); } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}
const freigeben = () => pool.query('UPDATE code_chunks SET claimed_by = NULL, claim_token = NULL, lease_until = NULL WHERE claimed_by = $1', [NODE]);
const claim = async (limit) => {
  const c = await claimEmbeddingChunks(NODE, { limit, maxConcurrent: 100, leaseSeconds: 60 });
  await freigeben();
  return c.map((x) => `${x.project}:${x.filePath}#${x.chunkIndex}`);
};
const stufe = async (p, s) => {
  await pool.query('DELETE FROM embed_prioritaet WHERE project = $1', [p]);
  if (s) await pool.query(`INSERT INTO embed_prioritaet (project, stufe, gesetzt_von) VALUES ($1, $2, 'test')`, [p, s]);
};
const cid = (p, f, i) => `${p}|${f}|${i}`;

async function aufraeumen() {
  await freigeben().catch(() => {});
  for (const p of [A, B]) {
    await pool.query('DELETE FROM code_chunks WHERE project = $1', [p]);
    await pool.query('DELETE FROM code_files WHERE project = $1', [p]);
    await pool.query('DELETE FROM projects WHERE name = $1', [p]);
    await pool.query('DELETE FROM embed_prioritaet WHERE project = $1', [p]);
  }
}

try {
  await aufraeumen();
  if ((await core.leseSchalter('embedding')).aktiv) throw new Error('PG-Schalter embedding in der Test-DB aktiv - Claims waeren leer');
  const andere = await pool.query(`SELECT count(*)::int AS n FROM (SELECT DISTINCT name FROM projects WHERE enabled) p
    WHERE EXISTS (SELECT 1 FROM code_chunks c WHERE c.project = p.name AND c.embedded_at IS NULL)`);
  if (andere.rows[0].n > 0) throw new Error(`Test-DB hat ${andere.rows[0].n} andere Projekte mit offenen Chunks - Projektwahl waere nicht eindeutig`);
  for (const p of [A, B]) await pool.query(`INSERT INTO projects (name, hostname, path, enabled) VALUES ($1, 'test', '/tmp/' || $1, true)`, [p]);
  const datei = (p, f) => pool.query(`INSERT INTO code_files (id, project, file_path, file_name, file_type, content, parsed_at, parser_version)
     VALUES ($1, $2, $3, $3, 'typescript', 'x', NOW(), 999)`, [`${p}|${f}`, p, f]);
  const chunk = (p, f, i) => pool.query(`INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end)
     VALUES ($1, $2, $3, $4, 'inhalt ' || $1, 1, 1)`, [cid(p, f, i), p, f, i]);
  await datei(A, 'src/a.ts'); await datei(A, 'src/b.ts'); await datei(B, 'src/c.ts');
  for (const i of [0, 1, 2, 3]) await chunk(A, 'src/a.ts', i);
  for (const i of [0, 1]) await chunk(A, 'src/b.ts', i);
  for (const i of [0, 1, 2]) await chunk(B, 'src/c.ts', i);

  // R1
  for (const p of [A, B]) {
    const [alt, neu] = await Promise.all([
      inTx((c) => c.query(ALT_NORMAL, [10, p])),
      inTx((c) => c.query(CLAIM_SQL.normal, [10, p])),
    ]);
    pruefe(JSON.stringify(alt.rows.map((r) => r.id)) === JSON.stringify(neu.rows.map((r) => r.id)) && neu.rows.length > 0,
      `R1 Schritt 1 [${p}] identisch zur alten Abfrage (${neu.rows.length} Zeilen)`, { alt: alt.rows.map((r) => r.id), neu: neu.rows.map((r) => r.id) });
  }
  // R2
  await stufe(A, 2);
  const wahl = async (sql, n) => { const s = []; for (let i = 0; i < n; i++) s.push((await pool.query(sql)).rows[0]?.name); return s; };
  let neuW = await wahl(CLAIM_SQL.projektWahl, 20);
  let altW = await wahl(ALT_PROJEKTWAHL, 20);
  pruefe(neuW.every((x) => x === A) && altW.every((x) => x === A), 'R2 Stufe 2 vor Stufe 3 (alt und neu)', { neuW, altW });
  await stufe(A, null);
  neuW = await wahl(CLAIM_SQL.projektWahl, 40);
  altW = await wahl(ALT_PROJEKTWAHL, 40);
  pruefe(new Set(neuW).size === 2 && new Set(altW).size === 2, 'R2 gleiche Stufe: zufaellig, beide Projekte kommen vor (alt und neu)', { neu: neuW.join(','), alt: altW.join(',') });
  // R3
  await stufe(A, 1);
  let c = await claim(3);
  pruefe(JSON.stringify(c) === JSON.stringify([`${A}:src/a.ts#0`, `${A}:src/a.ts#1`, `${A}:src/a.ts#2`]), 'R3 Claims ohne Steuerung: a.ts 0,1,2', c);

  // V1
  let r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'vorne', eintrag_id: cid(B, 'src/c.ts', 2) });
  pruefe(r.success && r.geaendert === 1, 'V1 verschieben vorne: 1 Chunk', r);
  c = await claim(2);
  pruefe(c[0] === `${B}:src/c.ts#2` && c[1] === `${A}:src/a.ts#0`, 'V1 vorgezogener Chunk aus B (Stufe 3) vor A (Stufe 1)', c);
  // V2
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'hinten', eintrag_id: [cid(A, 'src/a.ts', 0)] });
  pruefe(r.success && r.geaendert === 1, 'V2 verschieben hinten: 1 Chunk', r);
  c = await claim(10);
  const nurA = c.filter((x) => x.startsWith(A));
  pruefe(c[0] === `${B}:src/c.ts#2` && nurA.at(-1) === `${A}:src/a.ts#0` && nurA.length === 6, 'V2 a.ts#0 ans Projektende, vorgezogener B-Chunk weiter zuerst', c);
  // V3
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'zurueckstellen', project: A, file_path: 'src/b.ts', dauer_min: 10 });
  pruefe(r.success && r.geaendert === 2 && r.ebene === 'dateien' && r.zurueckgestellt_bis, 'V3 Datei b.ts zurueckgestellt (2 Chunks)', r);
  c = await claim(10);
  pruefe(!c.some((x) => x.includes('src/b.ts')), 'V3 zurueckgestellte Datei wird nicht geclaimt', c);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'code_chunks', project: A, eintrag_status: 'zurueckgestellt' });
  pruefe(r.gesamt === 2 && r.eintraege.every((e) => e.details.zurueckgestellt_bis), 'V3 Liste: Status zurueckgestellt mit Zeitpunkt', r);
  r = await intern({ action: 'warteschlange_liste', project: A });
  const ua = r.warteschlangen.code_chunks.projekte[0];
  pruefe(ua.chunks_zurueckgestellt === 2 && ua.ans_ende === 1, 'V3 Uebersicht: chunks_zurueckgestellt 2, ans_ende 1', ua);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'einreihen', project: A, file_path: ['src/b.ts'] });
  pruefe(r.success && r.geaendert === 2 && r.neu_einbetten === 0, 'V3 einreihen hebt die Zurueckstellung auf', r);
  c = await claim(10);
  pruefe(c.some((x) => x.includes('src/b.ts')), 'V3 nach einreihen wieder geclaimt', c);
  // V4
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'zurueckstellen', project: A, dauer_min: 5 });
  pruefe(r.success && r.ebene === 'projekt' && r.stufe === 1 && r.zurueckgestellt_bis, 'V4 Projekt A zurueckgestellt (Stufe bleibt 1)', r);
  neuW = await wahl(CLAIM_SQL.projektWahl, 10);
  pruefe(neuW.every((x) => x === B), 'V4 Projektwahl ueberspringt A', neuW);
  const backlog = await core.projekteMitBacklog(200);
  pruefe(!backlog.some((p) => p.project === A) && backlog.some((p) => p.project === B), 'V4 Parser-Backlog ueberspringt A, B bleibt', backlog);
  const { listeEmbedPrioritaet } = await import('../packages/core/dist/services/embed-prioritaet.js');
  const liste = await listeEmbedPrioritaet();
  pruefe(liste.find((x) => x.project === A)?.zurueckgestellt_bis, 'V4 embed_prioritaet-Liste zeigt zurueckgestellt_bis', liste.find((x) => x.project === A));
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'parser', nach: 'einreihen', project: A });
  pruefe(r.success && r.ebene === 'projekt' && (await pool.query('SELECT 1 FROM embed_prioritaet WHERE project = $1', [A])).rowCount === 0, 'V4 einreihen (ueber parser) entfernt den Eintrag', r);
  // V5
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'hinten', project: A });
  pruefe(r.stufe === 4, 'V5 Projekt hinten = Stufe 4', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'vorne', project: B });
  pruefe(r.stufe === 1, 'V5 Projekt vorne = Stufe 1', r);
  await pool.query('UPDATE code_chunks SET prio = NULL WHERE project = ANY($1::text[])', [[A, B]]);
  neuW = await wahl(CLAIM_SQL.projektWahl, 10);
  pruefe(neuW.every((x) => x === B), 'V5 Projektwahl folgt der Stufe', neuW);
  // V6
  await pool.query('UPDATE code_chunks SET embedded_at = NOW() WHERE id = $1', [cid(A, 'src/a.ts', 3)]);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'einreihen', eintrag_id: cid(A, 'src/a.ts', 3) });
  const e6 = (await pool.query('SELECT embedded_at FROM code_chunks WHERE id = $1', [cid(A, 'src/a.ts', 3)])).rows[0];
  pruefe(r.neu_einbetten === 1 && e6.embedded_at === null, 'V6 eingebetteter Chunk wird neu eingereiht', r);
  // V7
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'zurueckstellen', project: A });
  pruefe(r.error === 'dauer_fehlt', 'V7 zurueckstellen ohne Dauer -> dauer_fehlt', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'seitwaerts', project: A });
  pruefe(r.error === 'parameter_ungueltig', 'V7 falsches nach -> parameter_ungueltig', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'shell_jobs', nach: 'vorne', project: A });
  pruefe(r.error === 'nicht_verschiebbar', 'V7 shell_jobs -> nicht_verschiebbar', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'parser', nach: 'vorne', eintrag_id: 'src/a.ts' });
  pruefe(r.error === 'nicht_verschiebbar', 'V7 parser-Datei -> nicht_verschiebbar (Verweis auf parse_neu)', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'vorne', project: 'gibts-nicht-p15' });
  pruefe(r.error === 'unbekanntes_projekt', 'V7 unbekanntes Projekt', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'wissen_nachzug', nach: 'hinten', project: A });
  pruefe(r.error === 'nicht_verschiebbar', 'V7 wissen_nachzug hinten -> nicht_verschiebbar', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'zurueckstellen', project: A, dauer_min: 100000 });
  pruefe(r.success && /gekappt/.test(r.hinweis ?? ''), 'V7 Dauer ueber der Obergrenze wird gekappt', r);
  r = await intern({ action: 'warteschlange_verschieben', warteschlange: 'code_chunks', nach: 'vorne' });
  pruefe(r.error === 'parameter_fehlt', 'V7 ohne project/eintrag_id -> parameter_fehlt', r);

  // I1-I4 Daemon-Index (gleicher Prozess, gleiche Registry)
  const { indexSlotsFuerTests: S } = await import('../packages/file-watcher-daemon-ts/dist/manager.js');
  const reihe = [];
  const warte = (p, f) => S.acquire(p, f).then(() => reihe.push(`${p}/${f}`));
  const ablauf = async (n) => { for (let i = 0; i < n; i++) { S.release(); await new Promise((res) => setImmediate(res)); } };
  await S.acquire('a', 'a1');
  const v1 = [warte('a', 'a2'), warte('b', 'b1'), warte('b', 'b2'), warte('a', 'a3')];
  await ablauf(4); await Promise.all(v1); S.release();
  pruefe(reihe.join(',') === 'a/a2,b/b1,b/b2,a/a3' && S.belegt() === 0, 'I1 ohne Steuerung FIFO wie bisher', reihe);
  reihe.length = 0;
  const lok = (args) => core.fuehreWarteschlangeLokal('warteschlange_verschieben', { warteschlange: 'index', ...args }, 'daemon:test');
  r = await lok({ nach: 'vorne', project: 'b' });
  pruefe(r.success && r.ebene === 'projekt', 'I2 Projekt b vorne', r);
  await S.acquire('a', 'a1');
  const v2 = [warte('a', 'a2'), warte('b', 'b1'), warte('a', 'a3'), warte('b', 'b2')];
  await ablauf(4); await Promise.all(v2); S.release();
  pruefe(reihe.join(',') === 'b/b1,b/b2,a/a2,a/a3', 'I2 b vor a, darin FIFO', reihe);
  reihe.length = 0;
  await lok({ nach: 'einreihen', project: 'b' });
  r = await lok({ nach: 'zurueckstellen', project: 'a', dauer_min: 0.01 });
  pruefe(r.success && r.zurueckgestellt_bis, 'I3 Projekt a zurueckgestellt (600 ms)', r);
  await S.acquire('c', 'c1');
  const v3 = [warte('a', 'a2'), warte('b', 'b1')];
  S.release();
  await new Promise((res) => setTimeout(res, 100));
  pruefe(reihe.join(',') === 'b/b1', 'I3 zurueckgestelltes a wartet, b laeuft', reihe);
  S.release();
  await new Promise((res) => setTimeout(res, 900));
  pruefe(reihe.join(',') === 'b/b1,a/a2', 'I3 nach Ablauf vergibt der Wecker den Slot an a', reihe);
  await Promise.all(v3); S.release();
  await lok({ nach: 'einreihen', project: 'a' });
  reihe.length = 0;
  await S.acquire('a', 'x0');
  const v4 = [warte('a', 'x1'), warte('a', 'x2'), warte('a', 'x3')];
  const l = await core.fuehreWarteschlangeLokal('warteschlange_liste', { warteschlange: 'index' }, 'daemon:test');
  const x3 = l.eintraege.find((e) => e.details.pfad === 'x3');
  r = await lok({ nach: 'vorne', eintrag_id: x3.id });
  pruefe(r.success && r.geaendert === 1, 'I4 Ereignis x3 vorne', r);
  const l2 = await core.fuehreWarteschlangeLokal('warteschlange_liste', { warteschlange: 'index' }, 'daemon:test');
  pruefe(l2.eintraege[0].details.pfad === 'x3' && l2.eintraege[0].prioritaet === 'vorne', 'I4 Liste zeigt x3 auf Rang 1', l2.eintraege);
  await ablauf(3); await Promise.all(v4); S.release();
  pruefe(reihe.join(',') === 'a/x3,a/x1,a/x2' && S.belegt() === 0, 'I4 Vergabe x3, x1, x2', reihe);

  console.log(`ALLE PRUEFUNGEN GRUEN (${ok})`);
} finally {
  await aufraeumen().catch(() => {});
  await core.closePool?.();
}
