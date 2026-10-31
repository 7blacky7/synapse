/**
 * P22-T201 (Entwurf 07f41a1e Abschnitt 4, Handoff a03ddfd7): DIFFERENZTEST Schattenstand-Puffer.
 * Dieselbe zufaellige Folge von Co-Edit-Schritten laeuft mit Schalter coedit_ohne_gate EIN in zwei Projekten:
 *   A  Puffer AUS (plan_pruefung schatten_puffer_mb = 0, Notaus = Bewertung wie vor T201),
 *   B  Puffer AN  (64 MB, schatten_puffer_min_zeilen = 0, damit auch die kleine Zweitdatei gepuffert wird).
 * Schritte: Anhaengen (gueltig), Konflikt (gleiche Stelle, anderer Autor), Syntaxfehler in .ts, Gruppe (teilweise kaputt),
 * plan_update des Owners an Op 0 (Kaskade), Rueckzug eines Beitragenden, externe Drift, Teilcommit, Neubewertung.
 * Nach JEDEM Schritt muessen gleich sein: Status, Ops und op_zustaende ohne bewertet_am (inkl. befund_ids, mit, fest),
 * das Schritt-Ergebnis (Fehlercode, eigene_op_zustaende ohne bewertet_am) und die Dateiinhalte. Plan- und Batch-Nummern
 * werden in Texten durch # ersetzt. Zusaetzlich: B nutzt den Puffer wirklich (treffer > 0), A nie (nur aus).
 * ABSICHERUNG: nur synapse_test, eigene Projektbereiche, Schalter- und Einstellungszeilen werden im finally geloescht.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/coedit-schatten-puffer-p22-t201.test.mjs
 *   Env: T201_SEEDS (Standard 11,23,47), T201_SCHRITTE (Standard 60), T201_ZEILEN (Standard 2500).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
Object.assign(process.env, { SYNAPSE_SKIP_EMBEDDINGS: '1', SYNAPSE_SHELL_JOB: '1' });
const B = await import('../dist/services/file-batch.js');
const PE = await import('../dist/services/plan-pruef-einstellungen.js');
const SB = await import('../dist/services/coedit-schatten-puffer.js');
const CW = await import('../dist/services/code-write.js');
const SP = await import('../dist/services/syntax-pruefer/index.js');
const { COEDIT_OHNE_GATE_SCHEMA_SQL } = await import('../dist/db/coedit-ohne-gate-schema.js');
const D = await import('../dist/db/client.js'), pool = D.getPool();
SP.registriereStandardSyntaxPruefer({ threads: 1 }); // wie beim Serverstart, sonst prueft der Testprozess nichts

const SEEDS = (process.env.T201_SEEDS ?? '11,23,47').split(',').map(Number);
const SCHRITTE = Number(process.env.T201_SCHRITTE ?? 60);
const ZEILEN = Number(process.env.T201_ZEILEN ?? 2500);
const lauf = randomUUID().slice(0, 8);
const projekte = [];
let checks = 0, diffs = 0;
// Abdeckung: welche Zustaende (inkl. fest, befund_ids) und Schritt-Arten kamen vor.
const abdeckung = {};
const zaehle = (k) => { abdeckung[k] = (abdeckung[k] ?? 0) + 1; };

function zufall(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sr = (f, search, replace, extra = {}) => ({ file_path: f, action: 'search_replace', search, replace, ...extra });
const zeile = (i) => `export const z${i} = ${i};`;
const bZeile = (i) => 'B-' + String(i).padStart(4, '0') + ';';
const ohneZeit = (z) => (z && typeof z === 'object' ? Object.fromEntries(Object.entries(z).filter(([k]) => k !== 'bewertet_am')) : z);
const nummernweg = (x) => (typeof x === 'string' ? x.replace(/p22-t201-diff-[a-z0-9-]+?-(aus|an)\b/g, 'P').replace(/\b\d{3,}\b/g, '#')
  : Array.isArray(x) ? x.map(nummernweg)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, nummernweg(v)])) : x ?? null);
async function versuch(fn) { try { return await fn(); } catch (e) { return { success: false, error: e.code ?? 'wirft', message: e.message }; } }
function kurz(r) {
  if (!r || typeof r !== 'object') return r;
  return nummernweg({ success: r.success ?? null, error: r.error ?? null, appended_ops: r.appended_ops ?? null,
    eigene: (r.eigene_op_zustaende ?? []).map(ohneZeit), committed_ops: r.committed_ops ?? null, offen: (r.offen ?? []).map(ohneZeit) });
}

async function neuesProjekt(name, werte) {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [name, 't201', '/tmp']);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'coedit_ohne_gate',true,'P22-T201 Differenztest','test')", [name]);
  await pool.query(`INSERT INTO build_pruefung_einstellungen(bereich, werte, gesetzt_von, grund) VALUES($1, $2::jsonb, 'test', 'P22-T201 Differenztest')
    ON CONFLICT (bereich) DO UPDATE SET werte = EXCLUDED.werte`, [PE.planPruefBereich(name), JSON.stringify(werte)]);
  projekte.push(name);
}

/** Eine Welt = ein Projekt mit eigenem Owner-Plan; alle Schritte nehmen dieselben Argumente. */
function welt(project) {
  const w = { project, planId: null };
  w.plan = (a, ops) => B.planBatch({ project, agent_id: a, ops });
  w.add = async (a, ops) => { await versuch(() => w.plan(a, ops)); return versuch(() => B.addCoeditContribution({ project, plan_id: w.planId, agent_id: a, ops })); };
  w.lies = async (f) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [project, f])).rows[0]?.content ?? null;
  w.stand = async () => {
    const r = (await pool.query('SELECT status::text AS status, ops, op_zustaende FROM file_batch_plans WHERE id=$1::bigint', [w.planId])).rows[0];
    return { ...nummernweg({ status: r?.status, ops: r?.ops, zustaende: Array.isArray(r?.op_zustaende) ? r.op_zustaende.map(ohneZeit) : r?.op_zustaende ?? null }),
      a: await w.lies('a.ts'), b: await w.lies('b.txt') };
  };
  return w;
}

async function startePlan(w, rnd) {
  const l0 = 1 + Math.floor(rnd() * ZEILEN);
  const p = await w.plan('o', [sr('a.ts', zeile(l0), zeile(l0) + ' // owner'), sr('b.txt', bZeile(1 + Math.floor(rnd() * 3000)), 'B-owner;')]);
  w.planId = p.plan_id;
  return p;
}

async function eineFolge(seed) {
  const pa = `p22-t201-diff-${lauf}-${seed}-aus`, pb = `p22-t201-diff-${lauf}-${seed}-an`;
  await neuesProjekt(pa, { schatten_puffer_mb: 0 });
  await neuesProjekt(pb, { schatten_puffer_mb: 64, schatten_puffer_min_zeilen: 0 });
  PE.leerePlanPruefCache();
  const A = welt(pa), Bw = welt(pb);
  const a = Array.from({ length: ZEILEN }, (_, i) => zeile(i + 1)).join('\n') + '\n';
  const b = Array.from({ length: 3000 }, (_, i) => bZeile(i + 1)).join('\n') + '\n';
  for (const x of [A, Bw]) {
    const s = await x.plan('seed', [{ file_path: 'a.ts', action: 'create', content: a }, { file_path: 'b.txt', action: 'create', content: b }]);
    assert.ok((await B.commitBatch({ plan_id: s.plan_id, agent_id: 'seed' })).success, 'Seed ' + x.project);
  }
  // Gleiche Zufallsfolge fuer beide Welten: je Welt ein eigener Generator mit demselben Seed.
  const rndA = zufall(seed), rndB = zufall(seed);
  await startePlan(A, rndA); await startePlan(Bw, rndB);
  const benutzt = [];
  const arten = ['add', 'add', 'add', 'add', 'konflikt', 'konflikt', 'syntax', 'gruppe', 'zeilen', 'owner_update', 'rueckzug', 'drift', 'commit', 'bewerte'];
  for (let s = 0; s < SCHRITTE; s++) {
    const ergebnisse = [];
    let art = null, zuletzt = null;
    for (const [x, rnd] of [[A, rndA], [Bw, rndB]]) {
      art = arten[Math.floor(rnd() * arten.length)];
      const k = Math.floor(rnd() * 6), agent = 'w' + k, l = 1 + Math.floor(rnd() * ZEILEN), r2 = rnd();
      let r;
      zuletzt = l;
      if (art === 'add') r = await x.add(agent, [sr('a.ts', zeile(l), zeile(l) + ` // ${agent}-${s}`)]);
      else if (art === 'konflikt') {
        const ziel = benutzt.length > 0 ? benutzt[Math.floor(r2 * benutzt.length)] : l;
        // Echte Ersetzung derselben Stelle (die Anhaenge-Op davor ist eine reine Einfuegung am Ende der Zeile) -> konflikt.
        r = await x.add('w' + ((k + 1) % 6), [sr('a.ts', zeile(ziel), `export const z${ziel} = ${ziel * 2};`)]);
      } else if (art === 'zeilen') r = await x.add(agent, [{ file_path: 'a.ts', action: 'insert_after', after_line: l, content: `// zeile-${s}` }]); // Rueckfallweg (kein Puffer)
      else if (art === 'syntax') r = await x.add(agent, [sr('a.ts', zeile(l), `export const z${l} = ;`)]);
      else if (art === 'gruppe') {
        const l2 = 1 + ((l + 7) % ZEILEN);
        r = await x.add(agent, [sr('a.ts', zeile(l), zeile(l) + ' // g1', { gruppe: 'g' + s }),
          sr('a.ts', zeile(l2), r2 < 0.5 ? `export const z${l2} = ;` : zeile(l2) + ' // g2', { gruppe: 'g' + s })]);
      } else if (art === 'owner_update') r = await versuch(() => B.replanBatch({ project: x.project, plan_id: x.planId, agent_id: 'o', op_index: 0, ops: [sr('a.ts', zeile(l), zeile(l) + ` // owner-${s}`)] }));
      else if (art === 'rueckzug') r = await versuch(() => B.cancelBatch(x.planId, agent, 'P22-T201 Differenztest Rueckzug'));
      else if (art === 'drift') {
        const alt = await x.lies('a.ts'), neu = alt.replace(zeile(l) + '\n', zeile(l) + ' // extern\n');
        await pool.query('UPDATE code_files SET content=$3, content_hash=$4, updated_at=NOW() WHERE project=$1 AND file_path=$2', [x.project, 'a.ts', neu, CW.contentHash(neu)]);
        r = { drift: alt !== neu };
      } else if (art === 'commit') {
        r = await versuch(() => B.commitBatch({ plan_id: x.planId, agent_id: 'o' }));
        await B.bewerteOffenePlanOps(x.planId); // Hintergrund-Neubewertung nach dem Teilcommit abwarten (Warteschlange je Plan)
      } else r = await versuch(() => B.bewerteOffenePlanOps(x.planId).then(() => ({ success: true })));
      // Plan fertig (alles geschrieben/zurueckgezogen): neuer Owner-Plan in beiden Welten.
      // Eine vom Schritt angestossene Hintergrund-Bewertung (void bewerteOffenePlanOps) abwarten: die Warteschlange je Plan
      // reiht diesen Aufruf dahinter ein. Sonst vergliche der Test Laufzeiten statt Zustaende.
      await versuch(() => B.bewerteOffenePlanOps(x.planId));
      const st = (await pool.query('SELECT status::text AS status FROM file_batch_plans WHERE id=$1::bigint', [x.planId])).rows[0]?.status;
      if (st !== 'open') await versuch(() => startePlan(x, rnd));
      ergebnisse.push({ art, r: kurz(r), stand: await x.stand() });
    }
    if (['add', 'syntax', 'gruppe'].includes(art)) benutzt.push(zuletzt);
    checks++;
    zaehle('schritt:' + art);
    for (const z of ergebnisse[1].stand.zustaende ?? []) {
      zaehle('zustand:' + (z?.zustand ?? 'unbewertet'));
      if (z?.fest) zaehle('fest');
      if (z?.befund_ids?.length) zaehle('befund_ids');
    }
    const [ea, eb] = ergebnisse.map((e) => JSON.stringify(e));
    if (ea !== eb) {
      diffs++;
      console.error('DIFF seed ' + seed + ' schritt ' + s + ' (' + art + ')\nAUS ' + ea.slice(0, 3000) + '\nAN  ' + eb.slice(0, 3000));
    }
  }
  const pufA = SB.schattenPufferStatus(A.planId), pufB = SB.schattenPufferStatus(Bw.planId);
  const statA = await pool.query("SELECT count(*)::int n FROM file_batch_plans WHERE project=$1", [pa]);
  console.log('FOLGE ' + JSON.stringify({ seed, schritte: SCHRITTE, plaene: statA.rows[0].n, puffer_aus_letzter_plan: pufA, puffer_an_letzter_plan: pufB }));
}

try {
  assert.equal((await pool.query('SELECT current_database() db')).rows[0].db, 'synapse_test', 'nur synapse_test');
  await pool.query(COEDIT_OHNE_GATE_SCHEMA_SQL);
  for (const seed of SEEDS) await eineFolge(seed);
  const gesamt = SB.schattenPufferStatus();
  console.log('PUFFER_GESAMT ' + JSON.stringify(gesamt));
  console.log('ABDECKUNG ' + JSON.stringify(abdeckung));
  assert.ok(gesamt.treffer + gesamt.verlaengert > 0, 'Puffer wurde in Welt B benutzt');
  assert.equal(diffs, 0, `Zustaende mit/ohne Puffer verschieden in ${diffs} von ${checks} Schritten`);
  console.log(`ERGEBNIS BESTANDEN ${checks}/0 (Schritte gleich mit/ohne Puffer)`);
} catch (e) {
  console.error(`ERGEBNIS FEHLGESCHLAGEN (${diffs} Abweichungen von ${checks}): ${e.message}`);
  process.exitCode = 1;
} finally {
  for (const p of projekte) {
    await pool.query('DELETE FROM agent_profil_schalter WHERE project=$1', [p]);
    await pool.query('DELETE FROM build_pruefung_einstellungen WHERE bereich=$1', [PE.planPruefBereich(p)]);
    await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [p]);
    for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) await pool.query('DELETE FROM ' + t + ' WHERE project=$1', [p]);
    await pool.query('DELETE FROM projects WHERE name=$1', [p]);
  }
  await SP.beendeSyntaxPool(); await D.closePool();
}
process.exit(process.exitCode ?? 0);
