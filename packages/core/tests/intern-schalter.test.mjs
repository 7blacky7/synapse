/**
 * P14-T1 (11.10.2026): INTERN-SCHALTER UND SICHTBARKEIT DES TOOLS 'intern'.
 *
 * ZUSAGEN:
 *   S1 schalter_setzen ohne Dauer -> bis = jetzt + Hoechstdauer (12 h), hinweis
 *   S2 laengere Dauer wird auf die Hoechstdauer gekappt; SYNAPSE_INTERN_MAX_STUNDEN wirkt
 *   S3 ohne Ablauf nur mit dauerhaft:true; mehrere Dauerangaben -> dauer_mehrdeutig
 *   S4 falscher Modus / unbekannter Schalter / fehlende Pflichtangaben -> klare Fehlercodes
 *   S5 Ablauf: abgelaufener Schalter gilt als aus (abgelaufen:true), auch aus dem Cache
 *   S6 Cache: leseSchalter fragt PG erst nach SYNAPSE_INTERN_CACHE_MS erneut; setzeSchalter leert ihn
 *   S7 schalter_liste nennt alle vier Schalter (einschliesslich Tray-Token-Freigabe)
 *   R1 REST ohne SYNAPSE_INTERN_TOOL: 'intern' fehlt in BEIDEN tools/list-Stellen (/mcp/messages und POST /),
 *      Aufruf -> intern_tool_aus. ANKER: dieselbe Liste enthaelt 'artefakt' und 'code_intel' — sonst waere
 *      "fehlt" bei einer leeren Liste automatisch erfuellt (regel-nullzusagen-brauchen-anker).
 *   R2 REST mit SYNAPSE_INTERN_TOOL=1: 'intern' in beiden Listen mit outputSchema, Aufruf liefert die Schalter.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama hart auf 127.0.0.1:9;
 * zeigt die wirksame Konfiguration woanders hin (z. B. 192.168.50.65), Abbruch mit Exit 2.
 * Die Tabelle intern_schalter wird mit der DDL aus dem gebauten SCHEMA_SQL angelegt (dist/db/schema.js),
 * nicht mit einer Kopie — so prueft der Test die echte Anweisung.
 *
 * AUFRUF (NUR gegen die Test-DB):
 *   (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/intern-schalter.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB/Dienste.
 * Braucht gebautes packages/core/dist und packages/rest-api/dist.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('intern-schalter.test');
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_INTERN_CACHE_MS = '300';
delete process.env.SYNAPSE_INTERN_MAX_STUNDEN;

// Eigenes Schema wird an REST-Kindprozesse vererbt; keine fremden Test-Schalter anfassen.
const testSchema = process.env.T28_SCHALTER_SCHEMA ?? ('p9_t28_schalter_' + process.pid);
if (!/^p9_t28_schalter_[0-9]+$/.test(testSchema)) throw new Error('Test-Schema ungueltig');
process.env.T28_SCHALTER_SCHEMA = testSchema;
process.env.PGOPTIONS = '-c search_path=' + testSchema;

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);

// ── Kindprozess: REST-Strecke mit bzw. ohne SYNAPSE_INTERN_TOOL ──
if (process.argv[2] === 'rest-an' || process.argv[2] === 'rest-aus') {
  if (process.argv[2] === 'rest-an') process.env.SYNAPSE_INTERN_TOOL = '1';
  else delete process.env.SYNAPSE_INTERN_TOOL;
  const Fastify = createRequire(join(repo, 'packages', 'rest-api', 'package.json'))('fastify');
  const { mcpRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
  const f = Fastify();
  await f.register(mcpRoutes);
  const {internDaemonRoutes}=await lade(repo,'packages','rest-api','dist','routes','intern-daemon.js');
  await f.register(internDaemonRoutes);
  await f.ready();
  const ergebnis = {};
  for (const url of ['/mcp/messages', '/']) {
    const rpc = async (method, params) =>
      (await f.inject({ method: 'POST', url, payload: { jsonrpc: '2.0', id: 1, method, params } })).json();
    const tools = (await rpc('tools/list')).result?.tools ?? [];
    const aufruf = await rpc('tools/call', { name: 'intern', arguments: { action: 'schalter_liste', agent_id: 'intern-test' } });
    let antwort;
    try { antwort = JSON.parse(aufruf.result.content[0].text); } catch { antwort = aufruf; }
    ergebnis[url] = {
      namen: tools.map((t) => t.name),
      outputSchema: Boolean(tools.find((t) => t.name === 'intern')?.outputSchema),
      antwort,
    };
  }
  ergebnis.bruecke=(await f.inject({method:'GET',url:'/api/intern/daemon/befehle?host=p9-t28-fixture&warte=0'})).json();
  console.log('ERGEBNIS ' + JSON.stringify(ergebnis));
  process.exit(0);
}

const { getConfig } = await lade(dist, 'config.js');
const wirksam = getConfig();
if (wirksam.qdrant.url !== 'http://127.0.0.1:9' || /192\.168\.50\.65/.test(wirksam.qdrant.url)
  || /192\.168\.50\.65/.test(wirksam.embeddings.ollama.url)) {
  console.error(`ABBRUCH: Qdrant/Ollama zeigen nicht auf die Test-Attrappen (qdrant=${wirksam.qdrant.url}, ollama=${wirksam.embeddings.ollama.url}).`);
  process.exit(2);
}

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail) : '')); }
}
const ungefaehr = (iso, sollMs, tolMs = 5000) => iso !== null && Math.abs(Date.parse(iso) - (Date.now() + sollMs)) < tolMs;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const schemaJs = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
const ddl = schemaJs.match(/CREATE TABLE IF NOT EXISTS intern_schalter \([\s\S]*?\n\);/)?.[0];
if (!ddl) {
  console.error('FEHLER  DDL intern_schalter nicht im gebauten SCHEMA_SQL gefunden');
  process.exit(1);
}
await pool.query("SET lock_timeout = '5s'");
await pool.query('CREATE SCHEMA IF NOT EXISTS ' + testSchema);
await pool.query(ddl);
await pool.query('DELETE FROM intern_schalter');

process.env.SYNAPSE_INTERN_TOOL = '1';
const S = await lade(dist, 'services', 'intern-schalter.js');
const T = await lade(dist, 'services', 'intern-tool.js');
const H = 3_600_000;

try {
  pruefe(T.internToolAktiv() === true, 'internToolAktiv() bei SYNAPSE_INTERN_TOOL=1 beim Laden');
  pruefe(T.INTERN_DEFINITION.name === 'intern' && T.INTERN_DEFINITION.inputSchema.properties.action.enum.includes('schalter_setzen'),
    'Definition: name intern, action schalter_setzen');

  // S1
  let r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'embedding', aktiv: true, grund: 'test', agent_id: 'intern-test' });
  pruefe(r.success && r.schalter.aktiv && r.schalter.modus === 'hintergrund' && ungefaehr(r.schalter.bis, 12 * H) && /Hoechstdauer/.test(r.schalter.hinweis ?? ''),
    'S1 ohne Dauer: modus hintergrund, bis = jetzt + 12 h, hinweis', r);
  pruefe(r.schalter.gesetzt_von === 'intern-test' && r.schalter.grund === 'test', 'S1 gesetzt_von und grund gespeichert', r.schalter);

  // S2
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'parser', aktiv: true, dauer_min: 24 * 60 });
  pruefe(r.success && ungefaehr(r.schalter.bis, 12 * H) && /gekappt/.test(r.schalter.hinweis ?? ''), 'S2 24 h -> auf 12 h gekappt', r);
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'parser', aktiv: true, dauer_min: '30' });
  pruefe(r.success && ungefaehr(r.schalter.bis, 30 * 60_000) && r.schalter.hinweis === undefined, 'S2 dauer_min als Text "30" -> 30 min, kein hinweis', r);
  process.env.SYNAPSE_INTERN_MAX_STUNDEN = '2';
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'context7', aktiv: true });
  pruefe(r.success && ungefaehr(r.schalter.bis, 2 * H) && r.schalter.modus === 'pause', 'S2 SYNAPSE_INTERN_MAX_STUNDEN=2 -> bis = jetzt + 2 h', r);
  delete process.env.SYNAPSE_INTERN_MAX_STUNDEN;

  // S3
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'context7', aktiv: true, dauerhaft: true });
  pruefe(r.success && r.schalter.bis === null && r.schalter.dauerhaft === true && r.schalter.aktiv, 'S3 dauerhaft:true -> bis NULL', r);
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'context7', aktiv: true, dauerhaft: true, dauer_min: 5 });
  pruefe(!r.success && r.error === 'dauer_mehrdeutig', 'S3 dauerhaft + dauer_min -> dauer_mehrdeutig', r);

  // S4
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'parser', aktiv: true, modus: 'alle' });
  pruefe(!r.success && r.error === 'modus_ungueltig', 'S4 parser modus alle -> modus_ungueltig', r);
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'qdrant', aktiv: true });
  pruefe(!r.success && r.error === 'unbekannter_schalter', 'S4 unbekannter Schalter', r);
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'parser' });
  pruefe(!r.success && r.error === 'parameter_fehlt', 'S4 aktiv fehlt -> parameter_fehlt', r);
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'parser', aktiv: true, bis: '2001-01-01T00:00:00Z' });
  pruefe(!r.success && r.error === 'bis_vergangen', 'S4 bis in der Vergangenheit -> bis_vergangen', r);
  r = await T.fuehreInternAus({ action: 'gibtsnicht' });
  pruefe(!r.success && r.error === 'unbekannte_action', 'S4 unbekannte action', r);

  // S5 Ablauf (1,2 s), Stand kommt nach dem Setzen aus dem Cache
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'embedding', aktiv: true, modus: 'alle', dauer_min: 0.02 });
  pruefe(r.success && r.schalter.aktiv && r.schalter.modus === 'alle', 'S5 kurz gesetzt (modus alle)', r);
  let st = await S.leseSchalter('embedding');
  pruefe(st.aktiv === true, 'S5 sofort gelesen: aktiv', st);
  await warte(1500);
  process.env.SYNAPSE_INTERN_CACHE_MS = '60000'; // Ablauf muss auch aus dem Cache greifen
  st = await S.leseSchalter('embedding');
  pruefe(st.aktiv === false && st.abgelaufen === true && st.gesetzt === true, 'S5 nach Ablauf: aus, abgelaufen:true (aus dem Cache)', st);
  process.env.SYNAPSE_INTERN_CACHE_MS = '300';

  // S6 Cache
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'parser', aktiv: false });
  pruefe(r.success && r.schalter.aktiv === false && r.schalter.bis === null, 'S6 parser aus', r);
  st = await S.leseSchalter('parser');
  pruefe(st.aktiv === false, 'S6 gelesen: aus (Cache gefuellt)', st);
  await pool.query("UPDATE intern_schalter SET aktiv = true, modus = 'pause', bis = NOW() + interval '10 minutes' WHERE name = 'parser'");
  st = await S.leseSchalter('parser');
  pruefe(st.aktiv === false, 'S6 direkt nach PG-Aenderung: noch der Cache (aus)', st);
  await warte(400);
  st = await S.leseSchalter('parser');
  pruefe(st.aktiv === true, 'S6 nach Cache-Intervall: neuer Stand (an)', st);

  // P9-T28: Freigabe ist ein EIN/AUS-Override, keine Pause. Beide Richtungen befristet.
  r = await T.fuehreInternAus({action:'schalter_setzen',name:'tray_token_weiterleitung',aktiv:true});
  pruefe(r.success && r.schalter.modus==='freigegeben' && ungefaehr(r.schalter.bis,12*H) && /EIN/.test(r.message),
    'T28 EIN-Override: Default12h und klare Freigabesemantik',r);
  r = await T.fuehreInternAus({action:'schalter_setzen',name:'tray_token_weiterleitung',aktiv:false,dauer_min:24*60});
  pruefe(r.success && !r.schalter.aktiv && ungefaehr(r.schalter.bis,12*H) && /gekappt/.test(r.schalter.hinweis??''),
    'T28 AUS-Override ebenfalls befristet und auf12h begrenzt',r);
  r = await T.fuehreInternAus({action:'schalter_setzen',name:'tray_token_weiterleitung',aktiv:false,dauerhaft:true});
  pruefe(r.success && r.schalter.bis===null && r.schalter.dauerhaft===true,
    'T28 dauerhaft AUS nur mit explizitem dauerhaft:true',r);
  r = await T.fuehreInternAus({action:'schalter_setzen',name:'tray_token_weiterleitung',aktiv:false,dauerhaft:true,dauer_min:5});
  pruefe(!r.success && r.error==='dauer_mehrdeutig','T28 auch AUS: Dauer nicht mehrdeutig',r);
  r = await T.fuehreInternAus({action:'schalter_setzen',name:'tray_token_weiterleitung',aktiv:false,dauer_min:0.001});
  await warte(90);
  st = await S.leseSchalter('tray_token_weiterleitung');
  pruefe(!st.aktiv && st.abgelaufen===true,'T28 AUS-Override kann aus dem Cache ablaufen',st);

  // S7
  r = await T.fuehreInternAus({ action: 'schalter_liste' });
  const namen = (r.schalter ?? []).map((s) => s.name).sort();
  pruefe(r.success && JSON.stringify(namen) === JSON.stringify(['context7', 'embedding', 'parser', 'tray_token_weiterleitung']) && r.hoechstdauer_stunden === 12,
    'S7 schalter_liste: vier Schalter (einschliesslich Tray-Token-Freigabe), Hoechstdauer 12', r);

  // R1/R2 REST-Strecke in eigenen Prozessen (die Freischaltung wird beim Laden festgehalten)
  for (const modus of ['rest-aus', 'rest-an']) {
    const env = { ...process.env };
    delete env.SYNAPSE_INTERN_TOOL;
    const lauf = spawnSync(process.execPath, [fileURLToPath(import.meta.url), modus], { env, encoding: 'utf8', timeout: 60_000 });
    const zeile = (lauf.stdout ?? '').split('\n').find((z) => z.startsWith('ERGEBNIS '));
    if (!zeile) {
      pruefe(false, `${modus}: Kindprozess ohne Ergebnis (exit ${lauf.status})`, (lauf.stderr ?? '').slice(-1500));
      continue;
    }
    const erg = JSON.parse(zeile.slice('ERGEBNIS '.length));
    pruefe(modus==='rest-aus'
      ? erg.bruecke?.debug===false && erg.bruecke?.tray_token_weiterleitung===undefined
      : erg.bruecke?.debug===true && erg.bruecke?.tray_token_weiterleitung?.name==='tray_token_weiterleitung',
      'T28 Long-Poll-Freigabe nur bei API-Debug AN',erg.bruecke);
    for (const url of ['/mcp/messages', '/']) {
      const e = erg[url];
      const anker = e.namen.includes('artefakt') && e.namen.includes('code_intel');
      if (modus === 'rest-aus') {
        pruefe(anker && !e.namen.includes('intern'), `R1 ${url}: intern fehlt in tools/list (Anker artefakt/code_intel vorhanden)`, e.namen);
        pruefe(e.antwort?.success === false && e.antwort?.error === 'intern_tool_aus', `R1 ${url}: Aufruf -> intern_tool_aus`, e.antwort);
      } else {
        pruefe(anker && e.namen.includes('intern') && e.outputSchema, `R2 ${url}: intern in tools/list mit outputSchema`, e.namen);
        pruefe(e.antwort?.success === true && Array.isArray(e.antwort?.schalter) && e.antwort.schalter.length === 4, `R2 ${url}: schalter_liste ueber REST`, e.antwort);
      }
    }
  }
} finally {
  await pool.query('DELETE FROM intern_schalter').catch(() => {});
  await pool.query('DROP SCHEMA ' + testSchema + ' CASCADE').catch(() => {});
  await db.closePool();
}

console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} ZUSAGE(N) VERLETZT`);
process.exit(fehler === 0 ? 0 : 1);
