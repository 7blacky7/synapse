/**
 * P15-T17 (11.10.2026): Signaturpruefung im Einzelschreibweg und Syntax-Schnittstelle (User-Regel E-a/E-b).
 *
 * ZUSAGEN SIGNATUR (aktiv nur Musterpruefung):
 *   S1 create mit Signatur-Treffer: GESCHRIEBEN, befunde mit quelle muster, severity error, Zeile, wo aus verweise;
 *      die Tool-Auslieferung meldet es deutlich (ACHTUNG ... GESCHRIEBEN).
 *   S2 Altlast: Aenderung weit weg von einem bestehenden Treffer (fenster zeile) -> kein Befund.
 *   S3 update, das den Fehler einfuehrt -> Befund mit restore auf die echte Vorversion.
 *   S4 geltung.sprachen passt nicht -> kein Befund.  S5 stillgelegtes Muster -> kein Befund.
 *   S6 fenster datei: zaehlt nur mit Treffer nahe der Aenderung.
 *   S7 Musterliste aus dem Cache (TTL), neues Muster erst nach Cache-Leeren.
 * ZUSAGEN SYNTAX-SCHNITTSTELLE (Fake-Pruefer, echte kommen mit P16-T4):
 *   Y1 ohne Pruefer: einzelweg schreibt normal.
 *   Y2 sperrfaehiger Befund in geaenderter Zeile -> SyntaxfehlerAbgelehnt, NICHTS geschrieben, Meldung mit Quittier-Hinweis.
 *   Y3 quittieren mit Absichtsgrund -> geschrieben, Befund quittiert, Grund in file_versions.reason.
 *   Y4 Altlast (Fehler in unveraenderter Zeile) blockiert nicht.   Y5 update mit neuem Fehler -> abgelehnt, Inhalt unveraendert.
 *   Y6 ohne einzelweg (Plan-Commit, Restore) keine Ablehnung.   Y7 nicht sperrfaehiger Pruefer -> warning, geschrieben.
 *   Y8 Budget ueberschritten -> geschrieben, Befund nachgeliefert.   Y9 zu kurzer Grund -> weiter abgelehnt.
 *   Z1 REST PUT mit Syntaxfehler -> 422 {error:'syntaxfehler', geschrieben:false}.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node scripts/test-fehlermuster-signatur.mjs  (core + rest-api bauen)
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from './lib/test-db-schutz.mjs';
pruefeTestDbUrl('test-fehlermuster-signatur');
const MODELL = 'fake-fm-embed:latest';
const PRJ = 'zz-fehlermuster-sig';
const AGENT = 'zz-fm-sig';
const P_ERR = 'f0f0f0f0-1717-4e00-8a17-0000000000c1';
const P_DATEI = 'f0f0f0f0-1717-4e00-8a17-0000000000c2';
const P_STILL = 'f0f0f0f0-1717-4e00-8a17-0000000000c3';
const P_NEU = 'f0f0f0f0-1717-4e00-8a17-0000000000c4';

const fake = (antwort) => http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(antwort(req, body))); });
});
const ollama = fake((req, body) => {
  if (req.url === '/api/tags') return { models: [{ name: MODELL, model: MODELL, digest: 'ab'.repeat(32), size: 1000 }] };
  if (req.url === '/api/ps') return { models: [] };
  if (req.url === '/api/show') return { model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } };
  if (req.url === '/api/embed') { const a = JSON.parse(body); return { embeddings: (Array.isArray(a.input) ? a.input : [a.input]).map(() => [0, 1, 0, 0, 0, 0, 0, 0]) }; }
  return {};
});
const qdrant = fake((req) => (req.method === 'GET' && req.url === '/' ? { title: 'qdrant', version: '1.13.0' } : { status: 'ok', time: 0, result: /points\/search/.test(req.url) ? [] : {} }));
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`, OLLAMA_MODEL: MODELL,
  QDRANT_URL: `http://127.0.0.1:${qdrant.address().port}`, EMBED_MIN_GAP_MS: '0', SCORE_SCHWELLE_ERROR_PATTERNS: '0.5',
  EMBEDDING_QUERY_PREFIX: '', EMBEDDING_DOC_PREFIX: '', FEHLERMUSTER_WARTE_MS: '50',
});
for (const n of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE', 'SYNAPSE_AGENT_NAME',
  'SYNAPSE_DEFAULT_AGENT_ID', 'FEHLERMUSTER_CACHE_MS', 'FEHLERPRUEFUNG_BUDGET_MS']) delete process.env[n];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'packages', 'core', 'dist');
const lade = (...t) => import(pathToFileURL(join(...t)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) { console.error('ABBRUCH: Produktion.'); process.exit(2); }
const CW = await lade(dist, 'services', 'code-write.js');
const FP = await lade(dist, 'services', 'fehlermuster-pruefung.js');
const FA = await lade(dist, 'services', 'fehlermuster-auslieferung.js');
const db = await lade(dist, 'db', 'client.js');
const Fastify = createRequire(join(hier, '..', 'packages', 'rest-api', 'package.json'))('fastify');
const { filesRoutes } = await lade(hier, '..', 'packages', 'rest-api', 'dist', 'routes', 'files.js');
const pool = db.getPool();

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1500) : '')); }
}
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const inhalt = (p) => CW.getFileContentFromPg(PRJ, p);
const zeilen = (n, f = (i) => `export const z${i} = ${i};`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
const mitZeile = (text, nr, neu) => { const z = text.split('\n'); z[nr - 1] = neu; return z.join('\n'); };
async function aufraeumen() {
  await pool.query('DELETE FROM error_patterns WHERE id = ANY($1::uuid[])', [[P_ERR, P_DATEI, P_STILL, P_NEU]]);
  await pool.query('DELETE FROM error_pattern_seen WHERE session_id = $1', [AGENT]);
  await pool.query('DELETE FROM agent_sessions WHERE id = $1', [AGENT]).catch(() => {});
  await pool.query('DELETE FROM file_versions WHERE project = $1', [PRJ]).catch(() => {});
  await pool.query('DELETE FROM code_files WHERE project = $1', [PRJ]).catch(() => {});
}
const muster = (id, severity, status, erkennung, geltung, titel) => pool.query(
  `INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model, status, titel, warum, erkennung, geltung, verweise)
   VALUES ($1, $2, $3, $4, 'all', 'zz', 'opus', $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
  [id, 'ZZ-TEST ' + titel, 'ZZ-TEST fix ' + titel, severity, status, titel, 'ZZ-TEST warum ' + titel,
    JSON.stringify(erkennung), geltung ? JSON.stringify(geltung) : null, JSON.stringify([{ art: 'memory', name: 'zz-mem' }])]);

const app = Fastify({ logger: false });
await app.register(filesRoutes);
await app.ready();

try {
  await aufraeumen();
  FA._fehlermusterAuslieferungZuruecksetzen();
  FP._signaturMusterCacheLeeren();
  FP._syntaxPrueferLeeren();
  await muster(P_ERR, 'error', 'aktiv', { art: 'regex', signatur: ['zzVerbotenerAufruf_7Q3\\('], fenster: 'zeile', version: 1 }, { sprachen: ['ts'] }, 'ZZ verbotener Aufruf');
  await muster(P_DATEI, 'warning', 'aktiv', { art: 'regex', signatur: ['^"use zz"', 'zzExportFrom'], flags: 'm', fenster: 'datei', version: 1 }, null, 'ZZ datei-Muster');
  await muster(P_STILL, 'error', 'stillgelegt', { art: 'regex', signatur: ['zzStillgelegt_9K'], fenster: 'zeile', version: 1 }, null, 'ZZ stillgelegt');

  // ---- S1 ----
  const basis = zeilen(30);
  const s1Text = mitZeile(basis, 5, 'zzVerbotenerAufruf_7Q3(1);');
  const s1 = await CW.createFileInPg(PRJ, 's/a.ts', s1Text, AGENT, undefined, undefined, undefined, undefined, { einzelweg: true });
  const b1 = s1.befunde?.find((b) => b.pattern_id === P_ERR);
  pruefe(b1 && b1.quelle === 'muster' && b1.severity === 'error' && b1.zeilen[0] === 5 && b1.wo.includes('memory zz-mem')
    && b1.warum === 'ZZ-TEST warum ZZ verbotener Aufruf' && (await inhalt('s/a.ts')) === s1Text,
    'S1 create mit Treffer: geschrieben, Befund Z.5 mit was/warum/wie/wo', s1.befunde);
  const h1 = await FA.holeFehlermusterHinweise(AGENT);
  pruefe(h1?.treffer?.some((t) => t.quelle === 'muster' && t.pattern_id === P_ERR && t.zeilen?.[0] === 5) && /ACHTUNG/.test(h1.hinweis) && /GESCHRIEBEN/.test(h1.hinweis),
    'S1 Auslieferung: quelle muster, deutlicher Hinweis', h1);

  // ---- S2 Altlast ----
  const s2Text = mitZeile(s1Text, 25, 'export const z25 = 2500;');
  const s2 = await CW.updateFileInPg(PRJ, 's/a.ts', s2Text, AGENT, 'update', undefined, undefined, undefined, { einzelweg: true });
  pruefe(!s2.befunde?.some((b) => b.pattern_id === P_ERR), 'S2 Aenderung weit weg vom Bestandstreffer: kein Befund (Altlast)', s2.befunde);
  await FA.holeFehlermusterHinweise(AGENT);

  // ---- S3 restore ----
  const s3Text = mitZeile(s2Text, 20, '  zzVerbotenerAufruf_7Q3(2);');
  const s3 = await CW.updateFileInPg(PRJ, 's/a.ts', s3Text, AGENT, 'search_replace', undefined, undefined, undefined, { einzelweg: true });
  const b3 = s3.befunde?.find((b) => b.pattern_id === P_ERR);
  const vid = /version_id:'(\d+)'/.exec(b3?.restore ?? '')?.[1];
  const vorher = vid ? (await pool.query('SELECT content FROM file_versions WHERE id = $1', [vid])).rows[0]?.content : null;
  pruefe(b3?.zeilen[0] === 20 && vorher === s2Text, 'S3 Befund Z.20 mit restore auf die echte Vorversion', { b3, vid });

  // ---- S4/S5 ----
  const s4 = await CW.createFileInPg(PRJ, 's/b.py', 'zzVerbotenerAufruf_7Q3(1)\n', AGENT);
  pruefe(!s4.befunde?.length, 'S4 geltung sprachen ts: .py liefert keinen Befund', s4.befunde);
  const s5 = await CW.createFileInPg(PRJ, 's/c.ts', 'zzStillgelegt_9K()\n', AGENT);
  pruefe(!s5.befunde?.length, 'S5 stillgelegtes Muster liefert keinen Befund', s5.befunde);

  // ---- S6 fenster datei ----
  const d0 = '"use zz"\n' + zeilen(40);
  await CW.createFileInPg(PRJ, 's/d.ts', d0, AGENT);
  const d1 = mitZeile(d0, 30, 'zzExportFrom(1);');
  const s6a = await CW.updateFileInPg(PRJ, 's/d.ts', d1, AGENT);
  pruefe(s6a.befunde?.some((b) => b.pattern_id === P_DATEI && b.zeilen[0] === 1 && b.zeilen[1] === 30), 'S6a fenster datei: Treffer nahe der Aenderung zaehlt (Z.1-30)', s6a.befunde);
  const d2 = mitZeile(d1, 10, 'export const z9 = 99;');
  const s6b = await CW.updateFileInPg(PRJ, 's/d.ts', d2, AGENT);
  pruefe(!s6b.befunde?.some((b) => b.pattern_id === P_DATEI), 'S6b fenster datei: Aenderung weit weg -> kein Befund', s6b.befunde);

  // ---- S7 Cache ----
  await muster(P_NEU, 'warning', 'aktiv', { art: 'regex', signatur: ['zzNeuesMuster_5T'], fenster: 'zeile', version: 1 }, null, 'ZZ neu');
  const s7a = await CW.createFileInPg(PRJ, 's/e.ts', 'zzNeuesMuster_5T()\n', AGENT);
  FP._signaturMusterCacheLeeren();
  const s7b = await CW.updateFileInPg(PRJ, 's/e.ts', 'zzNeuesMuster_5T(2)\n', AGENT);
  pruefe(!s7a.befunde?.length && s7b.befunde?.some((b) => b.pattern_id === P_NEU), 'S7 Musterliste aus dem Cache, neues Muster nach Cache-Leeren', { a: s7a.befunde, b: s7b.befunde });

  // ---- S8-S12 (P15-T38): fenster zeile meldet nur GEAENDERTE Zeilen, nie eine unveraenderte Altzeile ----
  const t0 = mitZeile(zeilen(30), 15, 'zzVerbotenerAufruf_7Q3(15);');
  const t1 = mitZeile(mitZeile(t0, 3, 'export const z3 = 33;'), 28, 'export const z28 = 2828;');
  const s8 = await FP.pruefeSignaturen({ project: PRJ, filePath: 's/x.ts', alt: t0, neu: t1 });
  pruefe(!s8.some((b) => b.pattern_id === P_ERR), 'S8 Einzelweg, Aenderungen Z.3 + Z.28 um unveraenderte Trefferzeile Z.15: kein Befund', s8);
  const t2 = mitZeile(t0, 12, 'export const z12 = 1212;');
  const s9 = await FP.pruefeSignaturen({ project: PRJ, filePath: 's/x.ts', alt: t0, neu: t2, bereiche: [{ von: 10, bis: 20, gesamt: 31 }] });
  pruefe(!s9.some((b) => b.pattern_id === P_ERR), 'S9 Plan-Op-Spanne Z.10-20, geaendert nur Z.12: unveraenderte Trefferzeile Z.15 kein Befund', s9);
  const t3 = t0.split('\n');
  t3.splice(15, 2);
  const s10 = await FP.pruefeSignaturen({ project: PRJ, filePath: 's/x.ts', alt: t0, neu: t3.join('\n') });
  pruefe(!s10.some((b) => b.pattern_id === P_ERR), 'S10 reine Loeschung direkt nach der Trefferzeile Z.15: kein Befund', s10);
  const t4 = mitZeile(t2, 18, '  zzVerbotenerAufruf_7Q3(18);');
  const s11 = await FP.pruefeSignaturen({ project: PRJ, filePath: 's/x.ts', alt: t0, neu: t4, bereiche: [{ von: 10, bis: 20, gesamt: 31 }] });
  const b11 = s11.filter((b) => b.pattern_id === P_ERR);
  pruefe(b11.length === 1 && b11[0].zeilen[0] === 18 && b11[0].zeilen[1] === 18 && t4.split('\n')[17].includes('zzVerbotenerAufruf_7Q3(18)'),
    'S11 Kontrolle Plan: nur die geaenderte Trefferzeile Z.18 wird gemeldet (Anker im Text), nicht Z.15', s11);
  const t5 = mitZeile(t0, 15, 'zzVerbotenerAufruf_7Q3(150);');
  const s12 = await FP.pruefeSignaturen({ project: PRJ, filePath: 's/x.ts', alt: t0, neu: t5 });
  pruefe(s12.some((b) => b.pattern_id === P_ERR && b.zeilen[0] === 15) && t5.split('\n')[14].includes('(150)'), 'S12 Kontrolle Einzelweg: geaenderte Trefferzeile Z.15 wird gemeldet', s12);
  FA._fehlermusterAuslieferungZuruecksetzen();

  // ---- Y: Syntax-Schnittstelle ----
  pruefe(!FP.hatSyntaxPruefer('y/a.zzs'), 'Y1 ohne Pruefer: hatSyntaxPruefer false');
  const y1 = await CW.createFileInPg(PRJ, 'y/ok.zzs', 'KAPUTT\n', AGENT, undefined, undefined, undefined, undefined, { einzelweg: true });
  pruefe((await inhalt('y/ok.zzs')) === 'KAPUTT\n' && !y1.befunde?.length, 'Y1 ohne Pruefer schreibt einzelweg normal');

  const kaputtPruefer = (name, sperrfaehig, verzoegerung = 0) => ({
    name, version: '0.1', endungen: ['zzs'], sperrfaehig,
    async pruefe(text) {
      if (verzoegerung) await schlaf(verzoegerung);
      return text.split('\n').flatMap((z, i) => (z.includes('KAPUTT') ? [{ zeile: i + 1, spalte: 1, code: 'ZZ1', meldung: 'KAPUTT gefunden', wie: 'KAPUTT entfernen' }] : []));
    },
  });
  FP.registriereSyntaxPruefer(kaputtPruefer('zz-sperr', true));
  let y2err = null;
  try { await CW.createFileInPg(PRJ, 'y/neu.zzs', 'gut\nKAPUTT\n', AGENT, undefined, undefined, undefined, undefined, { einzelweg: true }); } catch (e) { y2err = e; }
  pruefe(y2err instanceof FP.SyntaxfehlerAbgelehnt && y2err.befunde[0].zeilen[0] === 2 && y2err.message.includes(FP.QUITTIER_HINWEIS)
    && (await inhalt('y/neu.zzs')) === null && y2err.antwort().geschrieben === false,
    'Y2 Syntaxfehler -> abgelehnt, nichts geschrieben, Quittier-Hinweis', y2err?.message);

  const y3 = await CW.createFileInPg(PRJ, 'y/fixture.zzs', 'gut\nKAPUTT\n', AGENT, 'Fixture', undefined, undefined, undefined,
    { einzelweg: true, quittieren: 'Test-Fixture absichtlich kaputt' });
  const y3reason = (await pool.query(`SELECT reason FROM file_versions WHERE project = $1 AND file_path = 'y/fixture.zzs' ORDER BY id DESC LIMIT 1`, [PRJ])).rows[0]?.reason;
  pruefe((await inhalt('y/fixture.zzs')) === 'gut\nKAPUTT\n' && y3.befunde?.some((b) => b.quelle === 'syntax' && b.quittiert_grund === 'Test-Fixture absichtlich kaputt')
    && /Syntaxbefund quittiert: Test-Fixture absichtlich kaputt/.test(y3reason ?? ''),
    'Y3 quittiert: geschrieben, Grund am Befund und in file_versions.reason', { befunde: y3.befunde, y3reason });

  // Y4: Altlast in Z.1, Aenderung in Z.20
  const alt4 = 'KAPUTT\n' + zeilen(25);
  await CW.createFileInPg(PRJ, 'y/alt.zzs', alt4, AGENT); // ohne einzelweg (wie ein Plan-Commit)
  const neu4 = mitZeile(alt4, 20, 'export const neu = 1;');
  let y4err = null;
  try { await CW.updateFileInPg(PRJ, 'y/alt.zzs', neu4, AGENT, 'update', undefined, undefined, undefined, { einzelweg: true }); } catch (e) { y4err = e; }
  pruefe(!y4err && (await inhalt('y/alt.zzs')) === neu4, 'Y4 Altlast (Fehler in unveraenderter Zeile) blockiert nicht', y4err?.message);

  const neu5 = mitZeile(neu4, 15, 'KAPUTT nochmal');
  let y5err = null;
  try { await CW.updateFileInPg(PRJ, 'y/alt.zzs', neu5, AGENT, 'replace_lines', undefined, undefined, undefined, { einzelweg: true }); } catch (e) { y5err = e; }
  pruefe(y5err?.code === 'syntaxfehler' && y5err.befunde[0].zeilen[0] === 15 && (await inhalt('y/alt.zzs')) === neu4,
    'Y5 update fuehrt Fehler ein -> abgelehnt, Inhalt unveraendert', y5err?.message);

  let y6err = null;
  try { await CW.updateFileInPg(PRJ, 'y/alt.zzs', neu5, AGENT, 'batch:1', 1); } catch (e) { y6err = e; }
  pruefe(!y6err && (await inhalt('y/alt.zzs')) === neu5, 'Y6 ohne einzelweg (Plan-Commit) keine Ablehnung', y6err?.message);

  let y9err = null;
  try { await CW.createFileInPg(PRJ, 'y/kurz.zzs', 'KAPUTT\n', AGENT, undefined, undefined, undefined, undefined, { einzelweg: true, quittieren: 'x' }); } catch (e) { y9err = e; }
  pruefe(y9err?.code === 'syntaxfehler', 'Y9 zu kurzer Grund -> weiter abgelehnt');

  // Z1 REST
  const z1 = await app.inject({ method: 'PUT', url: `/api/projects/${PRJ}/files`,
    payload: { file_path: 'y/alt.zzs', operation: 'replace_lines', line_start: 3, line_end: 3, content: 'KAPUTT rest', agent_id: AGENT } });
  const z1j = z1.json();
  pruefe(z1.statusCode === 422 && z1j.error === 'syntaxfehler' && z1j.geschrieben === false && z1j.befunde?.[0]?.zeilen?.[0] === 3 && (await inhalt('y/alt.zzs')) === neu5,
    'Z1 REST PUT mit Syntaxfehler -> 422, nichts geschrieben', { status: z1.statusCode, z1j });
  const z2 = await app.inject({ method: 'PUT', url: `/api/projects/${PRJ}/files`,
    payload: { file_path: 'y/alt.zzs', operation: 'replace_lines', line_start: 3, line_end: 3, content: 'KAPUTT rest', agent_id: AGENT, quittieren: 'Negativbeispiel fuer den Parser-Test' } });
  pruefe(z2.statusCode === 200 && z2.json().success, 'Z2 REST PUT mit quittieren -> geschrieben', z2.json());

  // Y7 nicht sperrfaehig
  FP._syntaxPrueferLeeren();
  FP.registriereSyntaxPruefer(kaputtPruefer('zz-weich', false));
  const y7 = await CW.createFileInPg(PRJ, 'y/weich.zzs', 'KAPUTT\n', AGENT, undefined, undefined, undefined, undefined, { einzelweg: true });
  pruefe((await inhalt('y/weich.zzs')) === 'KAPUTT\n' && y7.befunde?.some((b) => b.quelle === 'syntax' && b.severity === 'warning'),
    'Y7 nicht sperrfaehiger Pruefer: geschrieben, Befund warning', y7.befunde);

  // Y8 Budget
  FP._syntaxPrueferLeeren();
  FA._fehlermusterAuslieferungZuruecksetzen();
  FP.registriereSyntaxPruefer(kaputtPruefer('zz-langsam', true, 200));
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20';
  let y8err = null;
  const t8 = Date.now();
  try { await CW.createFileInPg(PRJ, 'y/langsam.zzs', 'KAPUTT\n', AGENT, undefined, undefined, undefined, undefined, { einzelweg: true }); } catch (e) { y8err = e; }
  const d8 = Date.now() - t8;
  await schlaf(300);
  const h8 = await FA.holeFehlermusterHinweise(AGENT);
  pruefe(!y8err && d8 < 180 && (await inhalt('y/langsam.zzs')) === 'KAPUTT\n' && h8?.treffer?.some((t) => t.quelle === 'syntax' && /nachgeliefert/.test(t.was)),
    'Y8 Budget ueberschritten: geschrieben, Befund nachgeliefert', { y8err: y8err?.message, d8, h8 });
  delete process.env.FEHLERPRUEFUNG_BUDGET_MS;
} catch (err) {
  fehler++;
  console.log('FEHLER  Ausnahme: ' + (err?.stack ?? err));
} finally {
  FP._syntaxPrueferLeeren();
  await schlaf(300);
  await aufraeumen().catch((e) => { fehler++; console.log('FEHLER  Aufraeumen: ' + e.message); });
  await app.close();
  ollama.close();
  qdrant.close();
}
console.log(`\nERGEBNIS: ${ok} OK, ${fehler} FEHLER`);
process.exit(fehler ? 1 : 0);
