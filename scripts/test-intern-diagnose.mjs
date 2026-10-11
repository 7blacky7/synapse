/**
 * P15-T15 (11.10.2026): intern Debug-Werkzeuge Welle 1 gegen die Test-DB und eine Fake-Qdrant.
 *
 * Jede Zusage hat eine POSITIVKONTROLLE: der Testaufbau loest den gesuchten Fall wirklich aus.
 *   B1 bestand_abgleich: Code 2 eingebettet vs 5 Punkte -> differenz +3 mit Befund.
 *   B2 Memories: Zahl gleich (3 = 3), aber IDs verschieden -> nur ids_vergleichen zeigt fehlend 1 / verwaist 1
 *      (genau der Fall, den eine reine Zaehlung verdeckt).
 *   D1 durchsatz: Chunk mit claimed_by diag-knoten im Fenster -> erscheint je Knoten; claim_attempt 4 -> haengend.
 *   D2 (P15-T20) durchsatz: Rampe (erst ab -120 s aktiv) -> je_min_aktiv ~13 statt 2.4 ueber das Fenster;
 *      Luecke ~354 s zwischen Abschluessen erkannt; Verlauf je Minute mit leeren Minuten; Einzelabschluss -> null.
 *   W1..W5 warum_nicht: claim_attempt-Chunk, eingebetteter Chunk, Chunk im deaktivierten Projekt, unbekannte
 *      Datei, Shell-Job ohne Daemon.
 *   P1 parse_ausfaelle zeigt den vermerkten Ausfall; P2 parse_neu ohne ausfuehren aendert nichts (Ausfall bleibt,
 *      0 Symbole); P3 mit ausfuehren -> Symbole > 0, Ausfall aufgeloest.
 *   PP parser_pool: erzwungener Timeout (PARSER_TIMEOUT_MS=1) -> timeouts_gesamt/beendet_gesamt >= 1, exit kommt.
 *   Z1 wartezustand: Wait ohne Ziel (10 min alt) und Wait mit committetem Ziel + unverbrauchter Op -> Befunde;
 *      Kontroll-Wait (ready, Op verbraucht) ohne Befund.
 *   T1 wrapper_takt: liegende Inbox-Post (10 min) bei nicht busy -> VERDACHT TAUB; Kontroll-Wrapper ohne Post nicht.
 *   S1 sync_inspektor: PG neuer als letzte file_version -> Befund NEUER; offener Plan auf der Datei wird gezaehlt.
 *   K1 schema_probe Vorschau: Kennung des Builds; F1 Parameterfehler. R1 (DIAG_REGISTRIERT=1): ueber fuehreInternAus.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test), Qdrant = eigene Fake-Instanz, Ollama 127.0.0.1:9.
 * AUFRUF: set -a; . <test-db.env>; set +a; node scripts/test-intern-diagnose.mjs
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}

// ── Fake-Qdrant ──
const qd = {};
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', time: 0, result: o })); };
    if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ title: 'qdrant', version: '1.13.0' })); return; }
    if (req.method === 'GET' && u.pathname === '/collections') return send({ collections: Object.keys(qd).map((name) => ({ name })) });
    let m = /^\/collections\/([^/]+)\/points\/count$/.exec(u.pathname);
    if (m) return send({ count: (qd[decodeURIComponent(m[1])] ?? []).length });
    m = /^\/collections\/([^/]+)\/points\/scroll$/.exec(u.pathname);
    if (m) {
      const b = JSON.parse(body || '{}');
      const alle = qd[decodeURIComponent(m[1])] ?? [];
      const off = b.offset ? Number(b.offset) : 0;
      const lim = b.limit ?? 10;
      return send({ points: alle.slice(off, off + lim).map((id) => ({ id })), next_page_offset: off + lim < alle.length ? off + lim : null });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: { error: 'nicht im Fake: ' + req.method + ' ' + u.pathname } }));
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.QDRANT_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.SYNAPSE_INTERN_TOOL = '1';
process.env.OLLAMA_MODEL = 'fake-embed';
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'packages', 'core', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().qdrant.url + getConfig().embeddings.ollama.url)) {
  console.error('ABBRUCH: Qdrant/Ollama zeigen auf Produktion.');
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 2500) : '')); }
}

createRequire(join(hier, '..', 'packages', 'core', 'package.json'))('pg');
const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
await pool.query("SET lock_timeout = '5s'");
const D = await lade(dist, 'services', 'intern-diagnose.js');
const T = await lade(dist, 'services', 'intern-tool.js');
const PF = await lade(dist, 'db', 'parse-failures.js');
const WP = await lade(dist, 'parser', 'worker-pool.js');
const { COLLECTIONS } = await lade(dist, 'types', 'index.js');

const PRJ = 'diag-test-p15';
const PRJ2 = 'diag-test-p15-aus';
const PROJEKTE = [PRJ, PRJ2];
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const INHALT = 'export function hallo(x: number): number {\n  return x + 1;\n}\nexport const welt = 2;\n';

async function aufraeumen() {
  for (const t of ['code_call_edges', 'code_statements', 'code_references', 'code_symbols', 'parse_coverage', 'code_chunks', 'parse_failures',
    'code_files', 'memories', 'file_batch_waits', 'file_batch_plans', 'wrapper_status', 'shell_jobs', 'file_versions', 'projects', 'embed_prioritaet']) {
    const spalte = t === 'projects' ? 'name' : 'project';
    await pool.query(`DELETE FROM ${t} WHERE ${spalte} = ANY($1)`, [PROJEKTE]).catch(() => {});
  }
  await pool.query(`DELETE FROM specialist_inbox WHERE to_agent IN ('diag-taub', 'diag-ok')`).catch(() => {});
}

const ausf = (args) => D.fuehreDiagnoseAus(args.action, args, 'diag-test');

try {
  await aufraeumen();
  // ── Aufbau ──
  await pool.query(`INSERT INTO projects (name, hostname, path, enabled) VALUES ($1, 'diag-host', '/tmp/diag', true), ($2, 'diag-host', '/tmp/diag2', false)`, [PRJ, PRJ2]);
  for (const [p, f] of [[PRJ, 'a.ts'], [PRJ2, 'z.ts']]) {
    await pool.query(
      `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at, indexed_at)
       VALUES ($1, $2, $3, $3, 'ts', $4, $5, $6, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')`,
      [`${p}:${f}`, p, f, INHALT, sha(INHALT), INHALT.length],
    );
  }
  await pool.query(
    `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end, embedded_at, claimed_by, claim_attempt) VALUES
      ('diag-c1', $1, 'a.ts', 0, 'x', 1, 1, NOW() - INTERVAL '2 hours', NULL, 1),
      ('diag-c2', $1, 'a.ts', 1, 'y', 2, 2, NULL, 'diag-knoten', 4),
      ('diag-c3', $1, 'a.ts', 2, 'z', 3, 3, NOW() - INTERVAL '1 minute', 'diag-knoten', 1),
      ('diag-c4', $2, 'z.ts', 0, 'w', 1, 1, NULL, NULL, 0)`, [PRJ, PRJ2],
  );
  await pool.query(
    `INSERT INTO memories (id, project, name, content, embedded_at) VALUES
      ('diag-m1', $1, 'm1', 'eins', NOW()), ('diag-m2', $1, 'm2', 'zwei', NOW()),
      ('diag-m3', $1, 'm3', 'drei', NOW()), ('diag-m4', $1, 'm4', 'vier', NULL)`, [PRJ],
  );
  qd[COLLECTIONS.projectMemories(PRJ)] = ['diag-m1', 'diag-m2', 'diag-verwaist'];
  qd[COLLECTIONS.projectCode(PRJ)] = ['p1', 'p2', 'p3', 'p4', 'p5'];

  // B1 + B2
  let r = await ausf({ action: 'bestand_abgleich', project: PRJ });
  const code = (r.alle ?? []).find((z) => z.collection === COLLECTIONS.projectCode(PRJ));
  const mem = (r.alle ?? []).find((z) => z.collection === COLLECTIONS.projectMemories(PRJ));
  pruefe(r.success && code?.pg_eingebettet === 2 && code?.qdrant === 5 && code?.differenz === 3 && /mehr als/.test(code?.befund ?? ''),
    'B1 Code: 2 eingebettet vs 5 Punkte -> differenz +3 mit Befund', r);
  pruefe(mem?.pg_gesamt === 4 && mem?.pg_eingebettet === 3 && mem?.qdrant === 3 && mem?.differenz === 0 && !mem?.befund,
    'B2a Memories: Zahl gleich (3 = 3), ohne ID-Abgleich keine Abweichung', mem);
  r = await ausf({ action: 'bestand_abgleich', project: PRJ, arten: ['memories', 'code'], ids_vergleichen: true });
  const idm = (r.id_abgleich ?? []).find((z) => z.collection === COLLECTIONS.projectMemories(PRJ));
  const idc = (r.id_abgleich ?? []).find((z) => z.collection === COLLECTIONS.projectCode(PRJ));
  pruefe(idm?.fehlend_in_qdrant === 1 && idm.fehlend_beispiele[0] === 'diag-m3' && idm?.verwaist_in_qdrant === 1 && idm.verwaist_beispiele[0] === 'diag-verwaist',
    'B2b ids_vergleichen: fehlend diag-m3, verwaist diag-verwaist', r.id_abgleich);
  pruefe(/Inhalts-Hashes/.test(idc?.uebersprungen ?? ''), 'B2c Code wird beim ID-Abgleich begruendet uebersprungen', idc);

  // D1
  r = await ausf({ action: 'durchsatz', minuten: 10 });
  const kn = (r.fertig_je_knoten ?? []).find((k) => k.knoten === 'diag-knoten');
  pruefe(r.success && kn && kn.n >= 1 && typeof kn.je_min === 'number', 'D1 durchsatz: diag-knoten mit fertigem Chunk im Fenster', r.fertig_je_knoten);
  pruefe(r.haengend?.anzahl >= 1 && Array.isArray(r.befund) && r.befund.length > 0 && typeof r.offen?.claimbar === 'number',
    'D1 haengend (claim_attempt >= 3) gezaehlt, Befund vorhanden', { haengend: r.haengend, befund: r.befund });

  // D2 (P15-T20): Rampe nach Start und Luecke mitten im Fenster. Abschluesse in Zweier-Stapeln (gleicher embedded_at).
  //   diag-rampe: erst ab -120 s, alle 10 s ein Stapel bis -10 s -> 12 Stapel = 24 Chunks in ~110 s.
  //   diag-luecke: -540..-510 s und -180..-150 s im 10-s-Takt -> Luecke 330 s zwischen, seit letztem 150 s.
  await pool.query(
    `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end, embedded_at, claimed_by, claim_attempt)
     SELECT 'diag-r' || g || '-' || k, $1, 'a.ts', 100 + g * 2 + k, 'r', 1, 1, NOW() - make_interval(secs => 120 - g * 10), 'diag-rampe', 1
       FROM generate_series(0, 11) g, generate_series(0, 1) k`, [PRJ]);
  await pool.query(
    `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end, embedded_at, claimed_by, claim_attempt)
     SELECT 'diag-l' || i, $1, 'a.ts', 200 + i, 'l', 1, 1, NOW() - make_interval(secs => s), 'diag-luecke', 1
       FROM unnest(ARRAY[540, 530, 520, 510, 180, 170, 160, 150]) WITH ORDINALITY AS u(s, i)`, [PRJ]);
  r = await ausf({ action: 'durchsatz', minuten: 10 });
  const ra = (r.fertig_je_knoten ?? []).find((k) => k.knoten === 'diag-rampe');
  const lu = (r.fertig_je_knoten ?? []).find((k) => k.knoten === 'diag-luecke');
  const dk = (r.fertig_je_knoten ?? []).find((k) => k.knoten === 'diag-knoten');
  pruefe(ra?.n === 24 && ra.je_min_fenster === 2.4 && ra.aktiv_s >= 108 && ra.aktiv_s <= 112 && ra.je_min_aktiv >= 12.5 && ra.je_min_aktiv <= 13.5,
    'D2a Rampe: je_min_fenster 2.4, je_min_aktiv ~13 ueber erster..letzter', ra);
  pruefe(ra?.luecken?.some((l) => l.art === 'vor_erstem' && l.s >= 470 && l.s <= 490) && !ra.luecken.some((l) => l.art === 'zwischen')
    && r.befund.some((b) => /diag-rampe: erst ab .* aktiv/.test(b)),
    'D2b Rampe: Luecke vor_erstem ~480 s, keine zwischen (10-s-Takt < 30 s), Befund Start statt Einbruch', { luecken: ra?.luecken, befund: r.befund });
  const mitte = lu?.luecken?.find((l) => l.art === 'zwischen');
  pruefe(mitte && mitte.s >= 328 && mitte.s <= 332 && lu.luecken.some((l) => l.art === 'seit_letztem' && l.s >= 145)
    && lu.je_min_ohne_luecken > lu.je_min_aktiv && r.befund.some((b) => /diag-luecke: 1 Luecke/.test(b)),
    'D2c Luecke ~330 s zwischen Abschluessen + seit_letztem erkannt, je_min_ohne_luecken > je_min_aktiv', { lu, befund: r.befund });
  pruefe(dk && dk.je_min_aktiv === null, 'D2d Kontrolle: ein einzelner Abschluss -> je_min_aktiv null (nicht belastbar)', dk);
  const vSumme = (r.verlauf ?? []).reduce((s, v) => s + v.gesamt, 0);
  const vRampe = (r.verlauf ?? []).map((v) => v.je_knoten['diag-rampe'] ?? 0);
  pruefe(r.verlauf_schritt_min === 1 && r.verlauf.length >= 10 && r.verlauf.length <= 11 && vSumme === r.fertig_gesamt
    && vRampe.slice(0, -3).every((n) => n === 0) && vRampe.reduce((s, n) => s + n, 0) === 24,
    'D2e Verlauf je Minute: leere Minuten enthalten, Summe = fertig_gesamt, Rampe nur in den letzten Minuten', { verlauf: r.verlauf, fertig: r.fertig_gesamt });
  const r60 = await ausf({ action: 'durchsatz', minuten: 180, luecke_s: 600 });
  const lu60 = (r60.fertig_je_knoten ?? []).find((k) => k.knoten === 'diag-luecke');
  pruefe(r60.verlauf_schritt_min === 3 && r60.verlauf.length <= 61 && r60.luecke_s === 600 && !lu60?.luecken?.some((l) => l.art === 'zwischen'),
    'D2f 180 min: Schritt 3 min (<= 61 Eintraege), luecke_s 600 blendet die 330-s-Luecke aus', { schritt: r60.verlauf_schritt_min, n: r60.verlauf?.length, lu60 });

  // W1..W5
  r = await ausf({ action: 'warum_nicht', chunk_id: 'diag-c2' });
  pruefe(r.success && r.befund.some((b) => /claim_attempt 4/.test(b)), 'W1 Chunk mit claim_attempt 4 -> Befund', r.befund);
  r = await ausf({ action: 'warum_nicht', chunk_id: 'diag-c1' });
  pruefe(r.befund?.[0]?.startsWith('Nichts offen'), 'W2 eingebetteter Chunk -> Nichts offen', r.befund);
  r = await ausf({ action: 'warum_nicht', chunk_id: 'diag-c4' });
  pruefe(r.befund?.some((b) => /deaktiviert/.test(b)), 'W3 Chunk im deaktivierten Projekt -> deaktiviert', r.befund);
  r = await ausf({ action: 'warum_nicht', project: PRJ, file_path: 'gibts-nicht.ts' });
  pruefe(r.gefunden === false && /nicht in code_files/.test(r.befund[0]), 'W4 unbekannte Datei', r);
  const job = (await pool.query(`INSERT INTO shell_jobs (project, command, status) VALUES ($1, 'echo diag', 'pending') RETURNING id::text`, [PRJ])).rows[0].id;
  r = await ausf({ action: 'warum_nicht', shell_job_id: job });
  pruefe(r.befund?.some((b) => /nie ein Daemon/.test(b)), 'W5 Shell-Job ohne Daemon-Heartbeat', r.befund);

  // P1..P3
  await PF.vermerkeAusfall(pool, { project: PRJ, filePath: 'a.ts', grund: 'timeout', details: 'diag-test', dauerMs: 5, dateiBytes: INHALT.length });
  r = await ausf({ action: 'parse_ausfaelle', project: PRJ });
  pruefe(r.success && r.anzahl === 1 && r.eintraege[0]?.file_path === 'a.ts' && r.eintraege[0]?.grund === 'timeout', 'P1 parse_ausfaelle zeigt den Ausfall', r);
  r = await ausf({ action: 'warum_nicht', project: PRJ, file_path: 'a.ts' });
  pruefe(r.befund?.some((b) => /Parse-Ausfall vermerkt: timeout/.test(b)), 'P1b warum_nicht Datei nennt den Ausfall', r.befund);
  r = await ausf({ action: 'parse_neu', project: PRJ, file_path: 'a.ts' });
  const nachVorschau = (await pool.query('SELECT count(*)::int AS n FROM parse_failures WHERE project = $1', [PRJ])).rows[0].n;
  pruefe(r.success && r.modus === 'vorschau' && r.dateien[0]?.symbole === 0 && nachVorschau === 1, 'P2 parse_neu ohne ausfuehren: Vorschau, nichts geaendert', { r, nachVorschau });
  r = await ausf({ action: 'parse_neu', project: PRJ, alle_ausfaelle: true, ausfuehren: true });
  const e0 = r.ergebnis?.[0];
  pruefe(r.success && r.modus === 'ausgefuehrt' && e0?.file_path === 'a.ts' && e0?.fehler === null && e0?.symbole_nachher > 0 && e0?.ausfall_vorher === 'timeout' && e0?.ausfall_nachher === null,
    'P3 parse_neu ausfuehren: Symbole > 0, Ausfall aufgeloest', r);

  // PP
  r = await ausf({ action: 'parser_pool' });
  pruefe(r.success && Array.isArray(r.pool?.slots) && r.pool.slots.length === r.pool.groesse, 'PP1 parser_pool: Pool nach dem Parse mit allen Slots', r.pool);
  process.env.PARSER_TIMEOUT_MS = '1';
  let timeoutFehler = null;
  try {
    await WP.getParserPool().parse({ filePath: 'gross.ts', fileType: 'ts', content: 'export const x = 1;\n'.repeat(200000) });
  } catch (err) { timeoutFehler = err; }
  delete process.env.PARSER_TIMEOUT_MS;
  await new Promise((res) => setTimeout(res, 800));
  r = await ausf({ action: 'parser_pool' });
  pruefe(timeoutFehler?.name === 'ParseTimeoutError' && r.pool?.timeouts_gesamt >= 1 && r.pool?.beendet_gesamt >= 1 && r.pool?.beendet_exit_ausstehend === 0,
    'PP2 erzwungener Timeout: gezaehlt, Worker beendet, exit angekommen', { timeoutFehler: timeoutFehler?.name, pool: r.pool, threads: r.threads_prozess });

  // Z1
  const plan = async (owner, ops, status) => (await pool.query(
    `INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews, status) VALUES ($1, $2, $3::jsonb, '{}'::jsonb, '[]'::jsonb, $4::file_batch_status) RETURNING id::text`,
    [PRJ, owner, JSON.stringify(ops), status])).rows[0].id;
  const traeger = await plan('diag-a', [], 'open');
  const ziel = await plan('diag-b', [{ file_path: 'a.ts' }], 'committed');
  const offenPlan = await plan('diag-c', [{ file_path: 'a.ts', action: 'update' }], 'open');
  const traegerZu = await plan('diag-a', [], 'committed');
  const wait = async (primary, status, verbraucht, alterMin, src = traeger) => (await pool.query(
    `INSERT INTO file_batch_waits (source_plan_id, project, waiting_agent, primary_agent, shared_files, deferred_ops, deferred_op_indexes,
                                   primary_plan_id, status, consumed_deferred_op_indexes, expires_at, created_at)
     VALUES ($1, $2, 'diag-a', 'diag-b', '{a.ts}', '[{"x":1}]'::jsonb, '{0}', $3, $4, $5::int[], NOW() + INTERVAL '1 hour', NOW() - make_interval(mins => $6::int))
     RETURNING wait_token::text`, [src, PRJ, primary, status, verbraucht, alterMin])).rows[0].wait_token;
  const wOhne = await wait(null, 'waiting', [], 10);
  const wZiel = await wait(ziel, 'linked', [], 3);
  // Kontrolle: Traeger schon zu (ein offener leerer Traeger bei ready waere zu Recht ein Befund)
  const wOk = await wait(ziel, 'ready', [0], 3, traegerZu);
  const wTraeger = await wait(ziel, 'ready', [0], 3);
  r = await ausf({ action: 'wartezustand', project: PRJ });
  const bw = (t) => (r.waits ?? []).find((w) => w.wait_token === t)?.befund ?? null;
  pruefe(r.success && bw(wOhne)?.some((b) => /ohne Ziel/.test(b)), 'Z1a Wait ohne Ziel (10 min) erkannt', bw(wOhne));
  pruefe(bw(wZiel)?.some((b) => /committed, Wait noch linked/.test(b)) && bw(wZiel)?.some((b) => /nicht verbraucht/.test(b)), 'Z1b Ziel committet + unverbrauchte Op erkannt', bw(wZiel));
  pruefe(Array.isArray(bw(wOk)) && bw(wOk).length === 0, 'Z1c Kontroll-Wait (ready, Op verbraucht, Traeger zu) ohne Befund', bw(wOk));
  pruefe(bw(wTraeger)?.some((b) => /offen ohne Ops/.test(b)), 'Z1d ready mit offenem leerem Traeger erkannt', bw(wTraeger));

  // T1
  await pool.query(`INSERT INTO wrapper_status (agent_name, project, status, busy) VALUES ('diag-taub', $1, 'idle', false), ('diag-ok', $1, 'idle', false)`, [PRJ]);
  await pool.query(`INSERT INTO specialist_inbox (from_agent, to_agent, content, processed, created_at) VALUES ('diag', 'diag-taub', 'hallo', false, NOW() - INTERVAL '10 minutes')`);
  r = await ausf({ action: 'wrapper_takt', project: PRJ });
  pruefe(r.success && r.verdacht.includes(`${PRJ}/diag-taub`) && !r.verdacht.includes(`${PRJ}/diag-ok`), 'T1 liegende Post -> VERDACHT TAUB, Kontrolle nicht', { verdacht: r.verdacht, wrapper: r.wrapper });

  // S1
  await pool.query(`INSERT INTO file_versions (project, file_path, content, content_hash, agent_id, created_at) VALUES ($1, 'a.ts', 'alt', $2, 'diag', NOW() - INTERVAL '20 minutes')`, [PRJ, sha('alt')]);
  r = await ausf({ action: 'sync_inspektor', project: PRJ, file_path: 'a.ts' });
  pruefe(r.success && r.befund.some((b) => /NEUER/.test(b)) && r.pg?.hash_aus_inhalt === sha(INHALT) && r.offene_plaene.some((p) => p.id === offenPlan),
    'S1 PG neuer als letzte file_version; offener Plan auf der Datei gezaehlt', r);

  // K1 + F1
  r = await ausf({ action: 'schema_probe' });
  pruefe(r.success && r.modus === 'vorschau' && typeof r.build_kennung === 'string' && r.build_kennung.length > 10, 'K1 schema_probe Vorschau mit Build-Kennung', r);
  const f1 = await ausf({ action: 'parse_neu' });
  const f2 = await ausf({ action: 'bestand_abgleich', arten: ['quatsch'] });
  const f3 = await ausf({ action: 'warum_nicht' });
  pruefe(f1.error === 'parameter_fehlt' && f2.error === 'parameter_ungueltig' && f3.error === 'parameter_fehlt', 'F1 Parameterfehler', { f1, f2, f3 });

  // R1
  if (process.env.DIAG_REGISTRIERT === '1') {
    const r1 = await T.fuehreInternAus({ action: 'warum_nicht', chunk_id: 'diag-c2' }, 'diag-test');
    const schema = T.INTERN_DEFINITION.inputSchema.properties;
    pruefe(r1.success && r1.action === 'warum_nicht' && T.INTERN_ACTIONS.includes('bestand_abgleich') && schema.chunk_id && schema.action.enum.includes('schema_probe'),
      'R1 ueber fuehreInternAus registriert (Actions + Schema)', r1);
  } else {
    console.log('SKIP    R1 (DIAG_REGISTRIERT=1 nach der Registrierung in intern-tool.ts)');
  }
} finally {
  await aufraeumen();
  await WP.resetParserPool().catch(() => {});
  await db.closePool();
  fake.close();
}

console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} ZUSAGE(N) VERLETZT`);
process.exit(fehler === 0 ? 0 : 1);
