#!/usr/bin/env node
// test-warteschlangen-pg.mjs — P15-T12 E3/E4: intern(warteschlange_liste / warteschlange_verschieben) gegen die TEST-DB.
//   L1 Uebersicht ohne Namen: alle PG- und Speicher-Warteschlangen, code_chunks je Projekt richtig gezaehlt
//   L2 code_chunks: Eintraege, Status-Filter, Pagination (weitere), fremdes Projekt nicht enthalten
//   L3 shell_jobs: pending/running, running zuerst, Rang je Projekt, done fehlt
//   L4 wissen_nachzug: Filter Tabelle, falscher Typ -> parameter_ungueltig
//   L5 parser: faellige Dateien mit Grund (neu), nicht faellige fehlen; ohne project Projektliste
//   L6 Fehlercodes: unbekannte Warteschlange, limit 0, prozess daemon ohne Daemon
//   L7 Speicher-Register: eigene Warteschlange mit Filter/Rang; embedding_queue lesbar
//   L8 Daemon-Bruecke: warteschlange_liste prozess daemon (simulierter Daemon im selben Prozess)
// Aufruf: set -a; . <test-db.env>; set +a; node scripts/test-warteschlangen-pg.mjs
// Braucht gebautes packages/core/dist.
import assert from 'node:assert/strict';

if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('ABBRUCH: DATABASE_URL zeigt nicht auf die Test-DB (:5433/synapse_test).');
  process.exit(2);
}
process.env.SYNAPSE_INTERN_TOOL = '1';

const core = await import('../packages/core/dist/index.js');
const pool = core.getPool();
const A = 'p15-ws-a';
const B = 'p15-ws-b';
const intern = (args) => core.fuehreInternAus(args, 'test-warteschlangen');
let ok = 0;
const pruefe = (bed, name, info) => {
  if (!bed) {
    console.error('FEHLER ' + name, info === undefined ? '' : JSON.stringify(info, null, 2).slice(0, 2000));
    process.exitCode = 1;
    throw new Error(name);
  }
  ok++;
  console.log('OK  ' + name);
};

async function aufraeumen() {
  for (const p of [A, B]) {
    await pool.query('DELETE FROM code_chunks WHERE project = $1', [p]);
    await pool.query('DELETE FROM code_files WHERE project = $1', [p]);
    await pool.query('DELETE FROM projects WHERE name = $1', [p]);
    await pool.query('DELETE FROM embed_prioritaet WHERE project = $1', [p]);
    await pool.query('DELETE FROM shell_jobs WHERE project = $1', [p]);
    await pool.query('DELETE FROM memories WHERE project = $1', [p]);
  }
}

let daemonLaeuft = false;
try {
  await aufraeumen();
  for (const p of [A, B]) {
    await pool.query(`INSERT INTO projects (name, hostname, path, enabled) VALUES ($1, 'test', '/tmp/' || $1, true)`, [p]);
  }
  await pool.query(`INSERT INTO embed_prioritaet (project, stufe, gesetzt_von) VALUES ($1, 1, 'test')`, [A]);
  await pool.query(`INSERT INTO code_files (id, project, file_path, file_name, file_type, content, parsed_at)
                    VALUES ($1, $2, 'src/a.ts', 'a.ts', 'typescript', 'export const a = 1;', NULL)`, [`${A}-fa`, A]);
  await pool.query(`INSERT INTO code_files (id, project, file_path, file_name, file_type, content, parsed_at, parser_version)
                    VALUES ($1, $2, 'src/b.ts', 'b.ts', 'typescript', 'export const b = 1;', NOW(), 999)`, [`${A}-fb`, A]);
  await pool.query(`INSERT INTO code_files (id, project, file_path, file_name, file_type, content, parsed_at, parser_version)
                    VALUES ($1, $2, 'src/c.ts', 'c.ts', 'typescript', 'x', NOW(), 999)`, [`${B}-fc`, B]);
  const chunk = (id, p, f, i, extra = '', werte = []) => pool.query(
    `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end${extra ? ', claimed_by, lease_until' : ''})
     VALUES ($1, $2, $3, $4, 'inhalt ' || $1, 1, 1${extra})`, [id, p, f, i, ...werte]);
  await chunk(`${A}-c1`, A, 'src/a.ts', 0);
  await chunk(`${A}-c2`, A, 'src/a.ts', 1, `, $5, NOW() + INTERVAL '5 minutes'`, ['tk']);
  await chunk(`${A}-c3`, A, 'src/a.ts', 2, `, $5, NOW() - INTERVAL '5 minutes'`, ['tk-alt']);
  await chunk(`${B}-c1`, B, 'src/c.ts', 0);
  await chunk(`${B}-c2`, B, 'src/c.ts', 1);
  for (const [status, alter] of [['pending', 30], ['pending', 20], ['running', 10], ['done', 5]]) {
    await pool.query(`INSERT INTO shell_jobs (project, command, status, agent_id, created_at) VALUES ($1, 'echo ' || $2, $2::shell_job_status, 'tester', NOW() - ($3::int * INTERVAL '1 second'))`, [A, status, alter]);
  }
  for (const n of [1, 2]) {
    await pool.query(`INSERT INTO memories (id, project, name, content, embedded_at) VALUES ($1, $2, $1, 'x', NULL)`, [`${A}-m${n}`, A]);
  }

  // L1
  let r = await intern({ action: 'warteschlange_liste' });
  pruefe(r.success === true, 'L1 Uebersicht success', r);
  for (const n of ['code_chunks', 'parser', 'wissen_nachzug', 'shell_jobs', 'specialist_jobs', 'project_init_jobs', 'embedding_queue']) {
    pruefe(r.warteschlangen[n] && r.warteschlangen[n].fehler === undefined, `L1 Uebersicht enthaelt ${n} ohne Fehler`, r.warteschlangen[n]);
  }
  r = await intern({ action: 'warteschlange_liste', project: A });
  const pa = r.warteschlangen.code_chunks.projekte;
  pruefe(pa.length === 1 && pa[0].projekt === A && pa[0].offen === 3 && pa[0].geclaimt === 1 && pa[0].lease_abgelaufen === 1 && pa[0].stufe === 1,
    'L1 code_chunks je Projekt: offen 3, geclaimt 1, lease_abgelaufen 1, stufe 1', pa);
  pruefe(r.warteschlangen.code_chunks.claims_je_knoten.tk === 1, 'L1 Claims je Knoten (tk=1)', r.warteschlangen.code_chunks.claims_je_knoten);
  pruefe(r.warteschlangen.shell_jobs.anzahl === 3, 'L1 shell_jobs Anzahl 3 (done zaehlt nicht)', r.warteschlangen.shell_jobs);
  pruefe(r.warteschlangen.wissen_nachzug.je_tabelle.memories === 2, 'L1 wissen_nachzug memories 2', r.warteschlangen.wissen_nachzug);

  // L2
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'code_chunks', project: A });
  pruefe(r.success && r.gesamt === 3 && r.eintraege.length === 3, 'L2 code_chunks Projekt A: 3 Eintraege', r);
  pruefe(new Set(r.eintraege.map((e) => e.status)).size === 3, 'L2 drei Status (offen/geclaimt/lease_abgelaufen)', r.eintraege);
  pruefe(r.eintraege.every((e) => e.projekt === A), 'L2 Positivkontrolle: kein Eintrag aus B', r.eintraege);
  pruefe(r.eintraege[0].details.chunk_index === 0 && r.eintraege[0].prioritaet === 1 && r.eintraege[0].typ === 'typescript', 'L2 Reihenfolge chunk_index, Stufe, Typ', r.eintraege[0]);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'code_chunks', project: A, eintrag_status: 'geclaimt' });
  pruefe(r.gesamt === 1 && r.eintraege[0].details.claimed_by === 'tk', 'L2 Filter geclaimt -> 1 (tk)', r);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'code_chunks', project: A, limit: 2 });
  pruefe(r.eintraege.length === 2 && r.weitere === 1, 'L2 Pagination limit 2 -> weitere 1', r);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'code_chunks', project: A, limit: 2, offset: 2 });
  pruefe(r.eintraege.length === 1 && r.weitere === 0 && r.eintraege[0].details.chunk_index === 2, 'L2 Pagination offset 2 -> letzter Eintrag', r);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'code_chunks', project: B });
  pruefe(r.gesamt === 2 && r.eintraege.every((e) => e.prioritaet === 3), 'L2 Projekt B: 2 Eintraege, Stufe 3 (ohne Eintrag)', r);

  // L3
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'shell_jobs', project: A });
  pruefe(r.gesamt === 3 && r.eintraege[0].status === 'running', 'L3 shell_jobs: 3, running zuerst', r);
  pruefe(r.eintraege[1].rang === 1 && r.eintraege[2].rang === 2 && r.eintraege[1].alter_s > r.eintraege[2].alter_s, 'L3 pending in Claim-Reihenfolge (aeltester Rang 1)', r.eintraege);
  pruefe(r.eintraege.every((e) => e.typ === 'tester'), 'L3 typ = Agent', r.eintraege);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'shell_jobs', project: A, eintrag_status: 'pending' });
  pruefe(r.gesamt === 2, 'L3 Filter pending -> 2', r);

  // L4
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'wissen_nachzug', project: A, eintrag_typ: 'memories' });
  pruefe(r.gesamt === 2 && r.eintraege.every((e) => e.typ === 'memories' && e.id.startsWith('memories:')), 'L4 wissen_nachzug memories: 2', r);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'wissen_nachzug', eintrag_typ: 'gibtsnicht' });
  pruefe(r.success === false && r.error === 'parameter_ungueltig', 'L4 falscher Typ -> parameter_ungueltig', r);

  // L5
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'parser', project: A });
  pruefe(r.success && r.eintraege.some((e) => e.id === 'src/a.ts' && e.typ === 'neu'), 'L5 parser: src/a.ts faellig (neu)', r);
  pruefe(!r.eintraege.some((e) => e.id === 'src/b.ts'), 'L5 Positivkontrolle: src/b.ts (aktuell geparst) fehlt', r.eintraege);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'parser', limit: 200 });
  pruefe(r.success && r.eintraege.some((e) => e.projekt === A && e.typ === 'projekt'), 'L5 parser ohne project: Projektliste enthaelt A', r.eintraege?.slice(0, 5));

  // L6
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'gibtsnicht' });
  pruefe(r.success === false && r.error === 'unbekannte_warteschlange', 'L6 unbekannte Warteschlange', r);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'code_chunks', limit: 0 });
  pruefe(r.success === false && r.error === 'parameter_ungueltig', 'L6 limit 0 -> parameter_ungueltig', r);
  r = await intern({ action: 'warteschlange_liste', prozess: 'daemon', warteschlange: 'index' });
  pruefe(r.success === false && r.error === 'daemon_nicht_verbunden', 'L6 prozess daemon ohne Daemon -> daemon_nicht_verbunden', r);

  // L7
  core.registriereWarteschlange({
    name: 'test_q', beschreibung: 'Test', reihenfolge: 'FIFO', verschiebbar: 'nein',
    uebersicht: () => ({ anzahl: 3 }),
    liste: (f) => core.seiteAusListe([
      { id: '1', projekt: 'x', typ: 't', status: 'wartend', prioritaet: null, alter_s: 3 },
      { id: '2', projekt: 'y', typ: 't', status: 'wartend', prioritaet: null, alter_s: 2 },
      { id: '3', projekt: 'x', typ: 't', status: 'pausiert', prioritaet: null, alter_s: 1 },
    ], f),
  });
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'test_q', project: 'x' });
  pruefe(r.gesamt === 2 && r.eintraege[0].rang === 1 && r.eintraege[1].rang === 3, 'L7 Register: Filter Projekt, Rang aus Gesamtreihenfolge', r);
  r = await intern({ action: 'warteschlange_liste', warteschlange: 'embedding_queue' });
  pruefe(r.success === true && Array.isArray(r.eintraege), 'L7 embedding_queue lesbar', r);

  // L8 simulierter Daemon: holt Befehle wie intern-bruecke.ts und fuehrt sie gegen dieselbe Registry aus
  daemonLaeuft = true;
  const daemon = (async () => {
    while (daemonLaeuft) {
      const befehle = await core.holeDaemonBefehle('testhost', 200);
      for (const b of befehle) {
        const ergebnis = await core.fuehreWarteschlangeLokal(b.befehl, b.args, 'daemon:testhost');
        core.meldeDaemonAntwort('testhost', b.id, ergebnis);
      }
    }
  })();
  await new Promise((res) => setTimeout(res, 50));
  r = await intern({ action: 'warteschlange_liste', prozess: 'daemon', warteschlange: 'test_q', eintrag_status: 'pausiert' });
  pruefe(r.success === true && r.prozess === 'daemon:testhost' && r.gesamt === 1 && r.eintraege[0].id === '3', 'L8 Bruecke: Daemon-Warteschlange mit Filter', r);
  r = await intern({ action: 'warteschlange_liste', prozess: 'daemon', warteschlange: 'code_chunks' });
  pruefe(r.success === false && r.error === 'unbekannte_warteschlange', 'L8 PG-Warteschlangen gibt es im Daemon nicht', r);
  r = await intern({ action: 'warteschlange_liste' });
  pruefe(r.daemons && r.daemons['daemon:testhost'] && r.daemons['daemon:testhost'].test_q, 'L8 Uebersicht haengt verbundene Daemons an', r.daemons);
  daemonLaeuft = false;
  core.vergissDaemons();
  await daemon;

  console.log(`ALLE PRUEFUNGEN GRUEN (${ok})`);
} finally {
  daemonLaeuft = false;
  await aufraeumen().catch(() => {});
  await core.closePool?.();
}
