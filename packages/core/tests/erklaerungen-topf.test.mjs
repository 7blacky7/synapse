/**
 * P15-T33 E1 (11.10.2026): ERKLAERUNGS-TOPF (Konzept thought 0a089e5d v3, User-Entscheidungen a189da34, a5fd30ea).
 *
 * ZUSAGEN:
 *   S  DDL erklaerungen + erklaerung_faelle im gebauten SCHEMA_SQL (Sprachfelder de/en nullable, Status-CHECK).
 *   Q  Ausloeser Einzelweg: Syntax-Ablehnung -> Fall (asynchron), ohne Kandidaten KEIN fetch; Schatten V3
 *      (nummerierter Ausschnitt nachher/vorher + Diff), Bezug mit basis_hash/ergebnis_hash; Hinweis an den Agenten.
 *   F  code_check offene_faelle (ohne Schatten) und fall (mit Schatten) ueber den Dispatcher.
 *   P  tool_calls: Antwort von code_check(fall) landet NICHT in tool_calls.result (ANKER: offene_faelle schon).
 *   G  erklaerung_ablegen: Pflicht der gepflegten Sprachen; Generik-Pruefung (Pfad, Bezeichner, Zeilenangabe,
 *      Hash, Codeblock, Geheimnis, Projektname); nur betroffener Agent oder Koordinator.
 *   V  Verifikation: abgelegt != verifiziert; Fehlerstand (quittiert) und neuer Syntaxfehler -> nicht verifiziert;
 *      korrigierter Stand -> verifiziert, Fall geloescht (ANKER: Fall existierte vorher), Erklaerung verifiziert.
 *   K  Kandidaten + Jev: verifizierte Erklaerung der Familie -> genau ein Jev-Aufruf (funktion erklaerungstopf,
 *      State V3, choice mit 'keine'), Schreibweg wartet NICHT auf Jev (Fake verzoegert 700 ms), kein Fall,
 *      Auslieferung quelle 'erklaerung'; jev_sprache en/de/mix steuert die Kriterien.
 *   T  Tor: Confidence 0,5 und 'keine' -> Fall mit Jev-Versuch, keine Auslieferung einer Erklaerung.
 *   A  Schalter erklaerungstopf (Projekt) aus -> kein fetch, kein Fall; Budget-Pause -> Fall ohne fetch.
 *   L  fall_verwerfen: Koordinator jederzeit, andere Agenten ab 3 Monaten; grund >=10 Zeichen und zustimmung_user Pflicht;
 *      Tagespruefung markiert ab 6 Monaten, loescht ab 9 Monaten, laesst juengere stehen.
 *   R  Plan-Ausloeser: Syntaxbefund an einer Plan-Op -> Fall mit bezug.weg plan und op_index.
 *   B  erklaerungen (Liste) und erklaerung_bewerten (passt_nicht, stilllegen nur Koordinator mit grund).
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama 127.0.0.1:9. Jeder Jev-Aufruf ist
 * ein Fake-fetch (kein echter Aufruf). Tabellen mit der DDL aus dem gebauten SCHEMA_SQL.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/erklaerungen-topf.test.mjs   (core vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('erklaerungen-topf.test');
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama', QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9',
  JEV_SCHALTER_CACHE_MS: '0', JEV_MODUS_CACHE_S: '0', JEV_OPENROUTER_API_KEY: 'sk-or-test-GEHEIM-erklaerungen-0123',
  SYNTAX_WORKER_THREADS: '0', FEHLERPRUEFUNG_BUDGET_MS: '5000', FEHLERMUSTER_WARTE_MS: '0', PARSER_LOOP_DISABLED: '1',
});
for (const n of ['JEV_API_URL', 'JEV_PREIS_JE_MIO_EINGABE', 'JEV_BUDGET_RESERVE_USD', 'JEV_ERKLAERUNG_TOR', 'SYNAPSE_AGENT_NAME', 'SYNAPSE_DEFAULT_AGENT_ID', 'FEHLERPRUEFUNG_PLAN']) delete process.env[n];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...t) => import(pathToFileURL(join(...t)).href);
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1200) : '')); }
}
async function versuche(text, fn) {
  try { await fn(); } catch (err) { fehler++; console.error('FEHLER  ' + text + ': ' + (err instanceof Error ? err.stack ?? err.message : String(err))); }
}

const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const schemaJs = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
const TABELLEN = ['jev_schalter', 'jev_aufrufe', 'jev_budget_stand', 'jev_optionen', 'erklaerungen', 'erklaerung_faelle'];
const ddl = TABELLEN.map((t) => schemaJs.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\);`))?.[0]);
const fehlend = TABELLEN.filter((_, i) => !ddl[i]);
pruefe(fehlend.length === 0, 'S DDL jev_* + erklaerungen + erklaerung_faelle im gebauten SCHEMA_SQL', fehlend);
const modulDa = existsSync(join(dist, 'services', 'erklaerungen.js'));
pruefe(modulDa, 'S Modul dist/services/erklaerungen.js vorhanden');
if (fehlend.length > 0 || !modulDa) {
  console.error(`${fehler} FEHLER (Abbruch: ohne Tabellen/Modul keine weiteren Zusagen pruefbar)`);
  process.exit(1);
}
const e1 = ddl[4];
pruefe(/lage_de TEXT,/.test(e1) && /lage_en TEXT,/.test(e1) && /abhilfe_de TEXT,/.test(e1) && /'vorgeschlagen', 'verifiziert', 'stillgelegt'/.test(e1),
  'S erklaerungen: lage/wieso/abhilfe je Sprache nullable, Status vorgeschlagen|verifiziert|stillgelegt', e1);
await pool.query("SET lock_timeout = '5s'");
for (const d of ddl) await pool.query(d);
for (const m of schemaJs.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_erklaer[^;]*;/g)) await pool.query(m[0]);

const PRJ = 'zz-erklaerungen';
const A = 'ek-a';
const B2 = 'ek-b';
const KOORD = 'koordinator';
const aufraeumen = async () => {
  await pool.query('DELETE FROM erklaerung_faelle WHERE project = $1', [PRJ]);
  await pool.query(`DELETE FROM erklaerungen WHERE erstellt_von = ANY($1) OR lage_en LIKE 'ZZT %'`, [[A, B2, KOORD, 'ek-setup']]);
  await pool.query('DELETE FROM jev_schalter');
  await pool.query('DELETE FROM jev_budget_stand');
  await pool.query('DELETE FROM jev_optionen');
  await pool.query('DELETE FROM jev_aufrufe WHERE project = $1', [PRJ]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PRJ]).catch(() => {});
  }
};
await aufraeumen();
// P25-T17: Der Topf in synapse_test ist geteilt. Fremde Erklaerungen der Familie typescript (Startbestand aus dem API-Start
// oder Reste von erklaerungstopf-seed-v2) waeren Kandidaten fuer Q/K/T und machten die Fehlerzahl vom Vorlauf abhaengig
// (35/7/31). Fuer die Laufzeit unter eigener Familie parken; das finally gibt sie zurueck, auch Reste eines abgebrochenen Laufs.
const GEPARKT = 'zzt-geparkt|';
const zurueckgeben = () => pool.query('UPDATE erklaerungen SET familie = substr(familie, $2) WHERE left(familie, $3) = $1', [GEPARKT, GEPARKT.length + 1, GEPARKT.length]);
const geparkt = (await pool.query("UPDATE erklaerungen SET familie = $1 || familie WHERE familie = 'typescript'", [GEPARKT])).rowCount;
pruefe((await pool.query("SELECT count(*)::int AS n FROM erklaerungen WHERE familie = 'typescript'")).rows[0].n === 0,
  `P25-T17 ANKER: Topf typescript ohne fremde Kandidaten (${geparkt} geparkt)`);

const SP = await lade(dist, 'services', 'syntax-pruefer', 'index.js');
const FP = await lade(dist, 'services', 'fehlermuster-pruefung.js');
const CW = await lade(dist, 'services', 'code-write.js');
const AU = await lade(dist, 'services', 'fehlermuster-auslieferung.js');
const S = await lade(dist, 'services', 'jev-schalter.js');
const K = await lade(dist, 'services', 'jev-kosten.js');
const O = await lade(dist, 'services', 'jev-optionen.js');
const TL = await lade(dist, 'services', 'tool-call-log.js');
const CC = await lade(dist, 'services', 'code-check-tool.js');
const FB = await lade(dist, 'services', 'file-batch.js');
const E = await lade(dist, 'services', 'erklaerungen.js');

FP._syntaxPrueferLeeren();
SP.registriereStandardSyntaxPruefer({ threads: 0 });

/** Fake-fetch fuer Jev: antwort(n, body) -> {choice, confidence}; verzoegerung in ms. */
function fakeJev(antwort = () => ({ choice: 'a', confidence: 0.95 }), verzoegerung = 0) {
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    f.aufrufe.push({ url, body });
    if (verzoegerung) await new Promise((r) => setTimeout(r, verzoegerung));
    const a = antwort(f.aufrufe.length, body);
    return new Response(JSON.stringify({ answers: { erklaerung: a }, usage: { input_tokens: 2600, output_tokens: 70, cost: 0.0001092 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.aufrufe = [];
  return f;
}

const DATEI = 'src/rechnen.ts';
const GUT = [
  "import { formatiere } from './format.js';",
  '',
  'export function berechneSumme(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export const WERTE_LISTE = [1, 2, 3];',
  '',
  'export function zeige(x: number): string {',
  '  return formatiere(x);',
  '}',
  '',
].join('\n');
const KAPUTT = GUT.replace('  return a + b;', '  return (a + b;');
const faelle = async () => (await pool.query('SELECT * FROM erklaerung_faelle WHERE project = $1 ORDER BY id', [PRJ])).rows;
const schreibe = (inhalt, agent = A, quittieren) => CW.updateFileInPg(PRJ, DATEI, inhalt, agent, 'update', undefined, 'erklaerungen-test', undefined, { einzelweg: true, ...(quittieren ? { quittieren } : {}) });
async function schreibeKaputt(inhalt, agent = A) {
  const t0 = Date.now();
  try {
    await schreibe(inhalt, agent);
    return { abgelehnt: false, ms: Date.now() - t0 };
  } catch (err) {
    return { abgelehnt: err?.code === 'syntaxfehler', ms: Date.now() - t0, err };
  }
}
const TEXTE_OK = {
  lage_de: 'ZZT Eine schliessende runde Klammer fehlt in einem Ausdruck.',
  wieso_de: 'Eine Aenderung hat eine oeffnende Klammer eingefuegt, ohne sie zu schliessen; der Parser erwartet das Gegenstueck.',
  abhilfe_de: 'Die Klammerpaare der geaenderten Stelle zaehlen und die fehlende Klammer ergaenzen.',
  lage_en: 'ZZT A closing parenthesis is missing in an expression.',
  wieso_en: 'A change opened a parenthesis without closing it; the parser expects the matching one.',
  abhilfe_en: 'Count the bracket pairs at the changed place and add the missing closing parenthesis.',
};
const cc = (args, agent = A) => CC.fuehreCodeCheckAus(args, agent);

try {
  await CW.createFileInPg(PRJ, DATEI, GUT, 'ek-setup');

  // ── Q Einzelweg-Ausloeser ohne Kandidaten ──
  let fallId;
  await versuche('Q Einzelweg', async () => {
    const f0 = fakeJev();
    E._setzeErklaerungDeps({ fetch: f0 });
    const r = await schreibeKaputt(KAPUTT);
    pruefe(r.abgelehnt, 'Q Einzelweg lehnt den Syntaxfehler ab (SyntaxfehlerAbgelehnt)', r.err?.message);
    await E._erklaerungenLeerlauf();
    const fs = await faelle();
    const f = fs[0];
    fallId = f?.id;
    pruefe(fs.length === 1 && f.datei === DATEI && f.familie === 'typescript' && f.agent_id === A && /^syntax\|typescript\|TS\d+$/.test(f.schluessel),
      'Q genau ein Fall: datei, familie typescript, agent, schluessel syntax|typescript|TSnnnn', fs);
    pruefe(f0.aufrufe.length === 0 && f?.jev?.aufgerufen === false && f?.jev?.grund === 'keine_kandidaten',
      'Q ohne Kandidaten KEIN Jev-Aufruf (jev.grund keine_kandidaten)', { aufrufe: f0.aufrufe.length, jev: f?.jev });
    const s = f?.schatten ?? {};
    pruefe(/\n?\s+4 \|\s+return \(a \+ b;/.test(s.code_nachher ?? '') && /\s+4 \|\s+return a \+ b;/.test(s.code_vorher ?? '')
      && /- {2,}return a \+ b;/.test(s.aenderung ?? '') && /\+ {2,}return \(a \+ b;/.test(s.aenderung ?? ''),
      'Q Schatten V3: nummerierter Ausschnitt nachher/vorher (Zeile 4) und Diff mit - / +', s);
    pruefe(f?.bezug?.basis_hash === sha(GUT) && f?.bezug?.ergebnis_hash === sha(KAPUTT) && f?.bezug?.weg === 'einzelweg',
      'Q Bezug: basis_hash = Stand vorher, ergebnis_hash = abgelehnter Stand, weg einzelweg', f?.bezug);
    const h = await AU.holeFehlermusterHinweise(A);
    const t = h?.treffer?.find((x) => x.quelle === 'erklaerung');
    pruefe(t && String(t.wie).includes(`fall_id:"${fallId}"`) && String(t.wie).includes('erklaerung_ablegen'),
      'Q Hinweis an den Agenten: offener Fall mit fertigem erklaerung_ablegen-Aufruf', h);
  });

  // ── F offene_faelle / fall ──
  let fallAntwort;
  await versuche('F Dispatcher', async () => {
    const liste = await cc({ action: 'offene_faelle', project: PRJ });
    const z = liste.faelle?.find((x) => String(x.id) === String(fallId));
    pruefe(liste.success === true && z && z.stufe === 'neu' && z.schatten === undefined && z.datei === DATEI,
      'F offene_faelle: Fall gelistet, stufe neu, OHNE Schatten', liste);
    fallAntwort = await cc({ action: 'fall', id: String(fallId) });
    pruefe(fallAntwort.success === true && typeof fallAntwort.fall?.schatten?.code_nachher === 'string' && Array.isArray(fallAntwort.sprachen_pflicht),
      'F fall: Schatten + Pflichtsprachen', fallAntwort);
  });

  // ── P tool_calls ──
  await versuche('P tool_calls', async () => {
    const marke = 'MARKE-' + Date.now();
    await TL.logToolCall({ project: PRJ, agentId: 'ek-p', tool: 'code_check', action: 'fall', ok: true, result: JSON.stringify({ ...fallAntwort, marke }) });
    await TL.logToolCall({ project: PRJ, agentId: 'ek-p', tool: 'code_check', action: 'offene_faelle', ok: true, result: JSON.stringify({ marke }) });
    const rows = (await pool.query(`SELECT action, result FROM tool_calls WHERE agent_id = 'ek-p' AND ts > NOW() - INTERVAL '1 minute' ORDER BY ts DESC LIMIT 2`)).rows;
    const fall = rows.find((r) => r.action === 'fall');
    const liste = rows.find((r) => r.action === 'offene_faelle');
    pruefe(liste && String(liste.result).includes(marke), 'P ANKER: tool_calls speichert result fuer offene_faelle', rows);
    pruefe(fall && !String(fall.result ?? '').includes(marke) && !String(fall.result ?? '').includes('code_nachher'),
      'P code_check(fall): Antwort (Schatten) NICHT in tool_calls.result', fall);
    await pool.query(`DELETE FROM tool_calls WHERE agent_id = 'ek-p'`);
  });

  // ── G Pflichtsprachen, Generik, Rechte ──
  await versuche('G Ablegen', async () => {
    const nurEn = await cc({ action: 'erklaerung_ablegen', fall_id: String(fallId), lage_en: TEXTE_OK.lage_en, wieso_en: TEXTE_OK.wieso_en, abhilfe_en: TEXTE_OK.abhilfe_en });
    pruefe(nurEn.success === false && nurEn.error === 'sprache_fehlt' && JSON.stringify(nurEn).includes('de'), 'G beide Sprachen gepflegt: nur en -> sprache_fehlt (de)', nurEn);
    const faelleVerstoss = [
      ['pfad', { abhilfe_de: `In ${DATEI} die Klammer ergaenzen.` }],
      ['bezeichner', { lage_en: 'ZZT In berechneSumme a closing parenthesis is missing.' }],
      ['zeilenangabe', { wieso_de: 'In Zeile 4 fehlt die Klammer, der Parser erwartet sie dort.' }],
      ['hash', { wieso_en: 'Commit a3f9c2d81b0e removed the closing parenthesis by accident.' }],
      ['codeblock', { abhilfe_en: 'Write it like this: ```return (a + b);```' }],
      ['geheimnis', { abhilfe_de: 'Mit dem Schluessel sk-or-v1-abcdef0123456789abcdef pruefen und dann die Klammer ergaenzen.' }],
      ['projekt', { lage_de: `ZZT Im Projekt ${PRJ} fehlt eine schliessende Klammer.` }],
    ];
    for (const [art, ueber] of faelleVerstoss) {
      const r = await cc({ action: 'erklaerung_ablegen', fall_id: String(fallId), ...TEXTE_OK, ...ueber });
      pruefe(r.success === false && r.error === 'nicht_generisch' && (r.verstoesse ?? []).some((v) => v.art === art), `G Generik: ${art} -> nicht_generisch`, r);
    }
    const fremd = await cc({ action: 'erklaerung_ablegen', fall_id: String(fallId), ...TEXTE_OK }, B2);
    pruefe(fremd.success === false && fremd.error === 'nur_betroffener', 'G anderer Agent darf den Fall nicht schliessen (nur_betroffener)', fremd);
    pruefe((await pool.query('SELECT count(*)::int AS n FROM erklaerungen WHERE erstellt_von = ANY($1)', [[A, B2]])).rows[0].n === 0,
      'G abgelehnte Ablagen haben nichts gespeichert');
  });

  // ── V Verifikation ──
  let erklId;
  await versuche('V Verifikation', async () => {
    const r = await cc({ action: 'erklaerung_ablegen', fall_id: String(fallId), ...TEXTE_OK });
    erklId = r.erklaerung?.id;
    pruefe(r.success === true && r.erklaerung?.status === 'vorgeschlagen' && r.verifikation?.verifiziert === false && (r.verifikation?.gruende ?? []).includes('stand_wie_vorher'),
      'V abgelegt (vorgeschlagen), Stand = vorher -> nicht verifiziert (stand_wie_vorher)', r);
    pruefe((await faelle()).length === 1, 'V Fall bleibt offen');
    await schreibe(KAPUTT, A, 'absichtlich fehlerhaft fuer den Test');
    const r2 = await cc({ action: 'fall_pruefen', id: String(fallId) });
    pruefe(r2.verifiziert === false && (r2.gruende ?? []).includes('stand_unveraendert_fehlerstand'), 'V quittierter Fehlerstand zaehlt nicht (stand_unveraendert_fehlerstand)', r2);
    const TEIL = GUT.replace('export const WERTE_LISTE = [1, 2, 3];', 'export const WERTE_LISTE = [1, 2 3];');
    await schreibe(TEIL, A, 'absichtlich fehlerhaft fuer den Test');
    const r3 = await cc({ action: 'fall_pruefen', id: String(fallId) });
    pruefe(r3.verifiziert === false && (r3.gruende ?? []).some((g) => g.startsWith('syntax')), 'V Teilkorrektur mit neuem Syntaxfehler -> nicht verifiziert (syntax)', r3);
    pruefe((await faelle()).length === 1, 'V ANKER: Fall existiert vor der Korrektur');
    await schreibe(GUT + 'export const NEU = 1;\n');
    const r4 = await cc({ action: 'fall_pruefen', id: String(fallId) });
    const e = (await pool.query('SELECT status, verifiziert_n, verifiziert_am FROM erklaerungen WHERE id = $1', [erklId])).rows[0];
    pruefe(r4.verifiziert === true && r4.geloescht === true && (await faelle()).length === 0, 'V korrigierter Stand -> verifiziert, Fall + Schatten geloescht', r4);
    pruefe(e?.status === 'verifiziert' && e.verifiziert_n === 1 && e.verifiziert_am, 'V Erklaerung verifiziert (verifiziert_n 1, verifiziert_am)', e);
  });

  // ── K Kandidaten + Jev ──
  await versuche('K Jev', async () => {
    const f = fakeJev(() => ({ choice: 'a', confidence: 0.95 }), 700);
    E._setzeErklaerungDeps({ fetch: f });
    const kaputt2 = GUT.replace('  return a + b;', '  return (a + b;') + '// k1\n';
    const r = await schreibeKaputt(kaputt2);
    pruefe(r.abgelehnt && r.ms < 500, `K Schreibweg wartet nicht auf Jev (${r.ms} ms < 500, Fake braucht 700 ms)`, r.ms);
    await E._erklaerungenLeerlauf();
    pruefe(f.aufrufe.length === 1, 'K genau ein Jev-Aufruf', f.aufrufe.length);
    const body = f.aufrufe[0]?.body ?? {};
    const q = body.questions?.erklaerung ?? {};
    pruefe(q.type === 'choice' && typeof q.criteria?.a === 'string' && q.criteria.a.includes('Correct if:') && typeof q.criteria?.keine === 'string'
      && typeof body.state?.code_nachher === 'string' && typeof body.state?.code_vorher === 'string' && typeof body.state?.aenderung === 'string',
      'K Jev-Frage: choice, Kriterium englisch (jev_sprache en), keine, State V3', body);
    pruefe(!JSON.stringify(body).includes(DATEI), 'K Jev bekommt keinen Dateipfad', body.state);
    const auf = (await pool.query(`SELECT funktion, ok FROM jev_aufrufe WHERE project = $1`, [PRJ])).rows;
    pruefe(auf.length === 1 && auf[0].funktion === 'erklaerungstopf' && auf[0].ok === true, 'K jev_aufrufe: funktion erklaerungstopf', auf);
    pruefe((await faelle()).length === 0, 'K verifizierte Erklaerung gewaehlt -> kein Fall gespeichert');
    const g = (await pool.query('SELECT gewaehlt_n FROM erklaerungen WHERE id = $1', [erklId])).rows[0];
    pruefe(g?.gewaehlt_n === 1, 'K gewaehlt_n = 1', g);
    const h = await AU.holeFehlermusterHinweise(A);
    const t = h?.treffer?.find((x) => x.quelle === 'erklaerung');
    pruefe(t?.erklaerung?.id === erklId && t.erklaerung.status === 'verifiziert' && t.erklaerung.sprachen?.de && t.erklaerung.sprachen?.en && t.was,
      'K Auslieferung quelle erklaerung mit id, status, beiden gepflegten Sprachen', h);

    await O.setzeJevOptionen({ jev_sprache: 'de', agent: KOORD });
    await schreibeKaputt(kaputt2 + '// k2\n');
    await E._erklaerungenLeerlauf();
    pruefe(String(f.aufrufe[1]?.body?.questions?.erklaerung?.criteria?.a ?? '').includes('Richtig, wenn:') && !String(f.aufrufe[1]?.body?.questions?.erklaerung?.criteria?.a ?? '').includes('Correct if:'),
      'K jev_sprache de -> deutsches Kriterium', f.aufrufe[1]?.body?.questions);
    await O.setzeJevOptionen({ jev_sprache: 'mix', agent: KOORD });
    await schreibeKaputt(kaputt2 + '// k3\n');
    await E._erklaerungenLeerlauf();
    const mix = String(f.aufrufe[2]?.body?.questions?.erklaerung?.criteria?.a ?? '');
    pruefe(mix.includes('Richtig, wenn:') && mix.includes('Correct if:'), 'K jev_sprache mix -> beide Sprachen im Kriterium', mix);
    await O.setzeJevOptionen({ jev_sprache: 'en', agent: KOORD });
  });

  // ── T Tor ──
  await versuche('T Tor', async () => {
    const f = fakeJev((n) => (n === 1 ? { choice: 'a', confidence: 0.5 } : { choice: 'keine', confidence: 0.9 }));
    E._setzeErklaerungDeps({ fetch: f });
    await AU.holeFehlermusterHinweise(A);
    await schreibeKaputt(GUT.replace('  return a + b;', '  return (a + b;') + '// t1\n');
    await E._erklaerungenLeerlauf();
    let fs = await faelle();
    pruefe(f.aufrufe.length === 1 && fs.length === 1 && fs[0].jev?.confidence === 0.5 && !fs[0].erklaerung_id,
      'T Confidence 0,5 < Tor 0,7 -> Fall mit Jev-Versuch, ohne Erklaerung', fs.map((x) => x.jev));
    const h = await AU.holeFehlermusterHinweise(A);
    pruefe(!(h?.treffer ?? []).some((x) => x.erklaerung), 'T keine Erklaerung ausgeliefert', h);
    await schreibeKaputt(GUT.replace('  return a + b;', '  return (a + b;') + '// t2\n');
    await E._erklaerungenLeerlauf();
    fs = await faelle();
    pruefe(f.aufrufe.length === 2 && fs.length === 1 && fs[0].haeufigkeit === 2 && fs[0].jev?.wahl === 'keine',
      'T keine -> derselbe Fall (haeufigkeit 2), jev.wahl keine', fs.map((x) => ({ h: x.haeufigkeit, jev: x.jev })));
  });

  // ── A Deploy-Proben ──
  await versuche('A Deploy-Proben', async () => {
    await pool.query('DELETE FROM erklaerung_faelle WHERE project = $1', [PRJ]);
    const event = {
      project: PRJ, agent_id: A, basis: '', ergebnis: 'defekt',
      weg: 'einzelweg',
      befund: { quelle: 'syntax', pruefer: 'python', severity: 'error', datei: 'coedit-test/zz.py', code: 'SyntaxError', was: 'absichtlich kaputter Test', zeilen: [1] },
    };
    E.meldeFehlerfall(event);
    await E._erklaerungenLeerlauf();
    pruefe((await faelle()).length === 0, 'A Deploy-Probe in coedit-test/ erzeugt keinen Erklaerungs-Fall');
  });

  // ── A Schalter und Budget ──
  await versuche('A Schalter', async () => {
    await pool.query('DELETE FROM erklaerung_faelle WHERE project = $1', [PRJ]);
    const f = fakeJev();
    E._setzeErklaerungDeps({ fetch: f });
    await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'erklaerungstopf', aktiv: false, grund: 'test', agent: KOORD });
    await schreibeKaputt(GUT.replace('  return a + b;', '  return (a + b;') + '// a1\n');
    await E._erklaerungenLeerlauf();
    pruefe(f.aufrufe.length === 0 && (await faelle()).length === 0, 'A Schalter erklaerungstopf (Projekt) aus -> kein fetch, kein Fall');
    await S.setzeJevSchalter({ ebene: 'projekt', project: PRJ, funktion: 'erklaerungstopf', aktiv: true, grund: 'test', agent: KOORD });
    await K.setzeJevBudget({ grenze_usd: 0.000001, agent: KOORD });
    await pool.query('UPDATE jev_budget_stand SET verbraucht_usd = 1 WHERE id = 1');
    await schreibeKaputt(GUT.replace('  return a + b;', '  return (a + b;') + '// a2\n');
    await E._erklaerungenLeerlauf();
    const fs = await faelle();
    pruefe(f.aufrufe.length === 0 && fs.length === 1 && fs[0].jev?.grund === 'budget', 'A Budget-Pause -> Fall gespeichert, kein fetch (jev.grund budget)', fs.map((x) => x.jev));
    await K.setzeJevBudget({ grenze_usd: null, agent: KOORD });
  });

  // ── L Stufenmodell ──
  await versuche('L Stufen', async () => {
    const id = String((await faelle())[0]?.id);
    const jung = await cc({ action: 'fall_verwerfen', id, zustimmung_user: true, grund: 'Probe-Fall mit User-Freigabe' }, KOORD);
    pruefe(jung.success === true && jung.ergebnis === 'verworfen', 'L Koordinator verwirft jungen Fall mit Grund und Zustimmung', jung);
    const einTestFall = async (schluessel, monate) => String((await pool.query(
      `INSERT INTO erklaerung_faelle (project, agent_id, datei, familie, schluessel, befund, bezug, schatten, erstellt_am)
       VALUES ($1, $2, $3, 'typescript', $4, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NOW() - ($5 || ' months')::interval) RETURNING id`,
      [PRJ, A, DATEI, schluessel, String(monate)])).rows[0].id);
    const jungFremdId = await einTestFall('syntax|typescript|ZZ-young-other', 0);
    const fremdJung = await cc({ action: 'fall_verwerfen', id: jungFremdId, zustimmung_user: true, grund: 'Probe-Fall mit User-Freigabe' }, A);
    pruefe(fremdJung.success === false && fremdJung.error === 'zu_jung', 'L anderer Agent unter 3 Monaten: zu_jung', fremdJung);

    const grundId = await einTestFall('syntax|typescript|ZZ-grund', 4);
    const fehlenderGrund = await cc({ action: 'fall_verwerfen', id: grundId, zustimmung_user: true }, KOORD);
    pruefe(fehlenderGrund.success === false && fehlenderGrund.error === 'grund_fehlt', 'L Koordinator braucht eine Begruendung von mindestens 10 Zeichen', fehlenderGrund);
    const zustimmungId = await einTestFall('syntax|typescript|ZZ-zustimmung', 4);
    const fehlendeZustimmung = await cc({ action: 'fall_verwerfen', id: zustimmungId, grund: 'Probe-Fall mit User-Freigabe' }, KOORD);
    pruefe(fehlendeZustimmung.success === false && fehlendeZustimmung.error === 'zustimmung_fehlt', 'L Koordinator braucht zustimmung_user:true', fehlendeZustimmung);

    const stageId = await einTestFall('syntax|typescript|ZZ-stage', 4);
    const weg = await cc({ action: 'fall_verwerfen', id: stageId, zustimmung_user: true, grund: 'Probe-Fall mit User-Freigabe' }, A);
    pruefe(weg.success === true && weg.ergebnis === 'verworfen', 'L anderer Agent darf ab 3 Monaten mit Pflichtangaben verwerfen', weg);
    await pool.query('DELETE FROM erklaerung_faelle WHERE id = ANY($1::bigint[])', [[jungFremdId, grundId, zustimmungId]]);

    const ein = async (schl, monate) => (await pool.query(
      `INSERT INTO erklaerung_faelle (project, agent_id, datei, familie, schluessel, befund, bezug, schatten, erstellt_am)
       VALUES ($1, $2, $3, 'typescript', $4, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NOW() - ($5 || ' months')::interval) RETURNING id`,
      [PRJ, A, DATEI, schl, String(monate)])).rows[0].id;
    const i2 = await ein('syntax|typescript|ZZ2', 2);
    const i7 = await ein('syntax|typescript|ZZ7', 7);
    const i10 = await ein('syntax|typescript|ZZ10', 10);
    pruefe((await faelle()).length === 3, 'L ANKER: drei Faelle (2, 7, 10 Monate) vor der Tagespruefung');
    const tp = await E.erklaerungenTagespruefung();
    const rest = await faelle();
    const z7 = rest.find((x) => String(x.id) === String(i7));
    pruefe(rest.length === 2 && !rest.some((x) => String(x.id) === String(i10)) && z7?.markiert_am && !rest.find((x) => String(x.id) === String(i2))?.markiert_am,
      'L Tagespruefung: 10 Monate geloescht, 7 Monate markiert, 2 Monate unberuehrt', { tp, rest: rest.map((x) => ({ id: x.id, m: x.markiert_am })) });
    const liste = await cc({ action: 'offene_faelle', project: PRJ }, KOORD);
    pruefe(liste.faelle?.find((x) => String(x.id) === String(i7))?.stufe === 'markiert', 'L offene_faelle zeigt stufe markiert', liste);
    await pool.query('DELETE FROM erklaerung_faelle WHERE project = $1', [PRJ]);
  });

  // ── R Plan-Ausloeser ──
  await versuche('R Plan', async () => {
    E._setzeErklaerungDeps({ fetch: fakeJev(() => ({ choice: 'keine', confidence: 0.9 })) });
    const p = await FB.planBatch({ project: PRJ, agent_id: B2, ops: [{ file_path: DATEI, action: 'search_replace', search: '  return a + b;', replace: '  return (a + b;' }] });
    await E._erklaerungenLeerlauf();
    const fs = await faelle();
    pruefe(fs.length === 1 && fs[0].bezug?.weg === 'plan' && fs[0].bezug?.op_index === 0 && fs[0].agent_id === B2,
      'R Syntaxbefund an Plan-Op -> Fall (weg plan, op_index 0, Autor der Op)', { plan: p.pruefung, fs });
    if (p.plan_id) await FB.cancelBatch?.({ plan_id: p.plan_id, agent_id: B2 }).catch(() => {});
  });

  // ── B erklaerungen + bewerten ──
  await versuche('B Bewerten', async () => {
    const l = await cc({ action: 'erklaerungen', familie: 'typescript' });
    pruefe(l.success === true && l.erklaerungen?.some((x) => x.id === erklId && x.status === 'verifiziert'), 'B erklaerungen listet die verifizierte Erklaerung', l);
    const pn = await cc({ action: 'erklaerung_bewerten', id: erklId, bewertung: 'passt_nicht', grund: 'traf nicht' }, B2);
    const n = (await pool.query('SELECT passt_nicht_n FROM erklaerungen WHERE id = $1', [erklId])).rows[0];
    pruefe(pn.success === true && n.passt_nicht_n === 1, 'B passt_nicht zaehlt hoch', { pn, n });
    const s1 = await cc({ action: 'erklaerung_bewerten', id: erklId, bewertung: 'stilllegen', grund: 'Test stilllegen weil ueberholt' }, A);
    pruefe(s1.success === false && s1.error === 'nur_koordinator', 'B stilllegen nur Koordinator', s1);
    const s2 = await cc({ action: 'erklaerung_bewerten', id: erklId, bewertung: 'stilllegen', grund: 'kurz' }, KOORD);
    pruefe(s2.success === false && s2.error === 'grund_fehlt', 'B stilllegen braucht grund (mind. 10 Zeichen)', s2);
    const s3 = await cc({ action: 'erklaerung_bewerten', id: erklId, bewertung: 'stilllegen', grund: 'Test stilllegen weil ueberholt' }, KOORD);
    const st = (await pool.query('SELECT status FROM erklaerungen WHERE id = $1', [erklId])).rows[0];
    pruefe(s3.success === true && st.status === 'stillgelegt', 'B stilllegen durch Koordinator', { s3, st });
  });
} finally {
  E._setzeErklaerungDeps?.({});
  await aufraeumen().catch((err) => console.error('Aufraeumen:', err.message));
  await zurueckgeben().catch((err) => console.error('Zurueckgeben:', err.message));
  console.log(`\n${ok} OK, ${fehler} FEHLER`);
  await pool.end().catch(() => {});
  process.exit(fehler ? 1 : 0);
}
