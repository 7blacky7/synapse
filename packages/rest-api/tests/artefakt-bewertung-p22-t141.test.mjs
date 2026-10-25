/**
 * P22-T141: Artefakt-Bewertung (Design-Gedaechtnis global). NUR synapse_test:5433, privates Schema, gebaute Core/API-dists,
 * kein Docker/Browser (Abbild-Schritte von zeigen scheitern absichtlich laut, die PG-Zeile bleibt).
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/artefakt-bewertung-p22-t141.test.mjs
 * A Schalter AUS: POST 409 funktion_aus (nichts geschrieben), GET/Vorlieben aktiv false, Tool vorlieben leer, vorbild/versuch funktion_aus.
 * B Bewerten: artefakt hoch -> vorbild; inbox runter + Kommentar -> ueberarbeiten; verlauf runter ohne -> verbannt; Schnappschuss
 *   aus der Quelle (Client-HTML wirkungslos), Titel/Merkmale/Urheber.
 * C Abweisung: Inbox User->Agent, fremder Agent, fremde Verlaufszeile -> quelle_unbekannt; Text -> keine_html_quelle; Eingabefehler.
 * D Neubewertung ersetzt (anzahl 2), Historie; Stand je Block (GET quellen).
 * E Vorlieben kompakt in drei Gruppen ohne HTML, Kommentar nur bei ueberarbeiten, limit, debug; Anmeldezeile.
 * F Agenten-Weg (artefakt-Tool): vorbild (HTML), versuch -> versuch_gezeigt + aus der Liste, Fehlerfaelle; zeigen mit
 *   ueberarbeitet_aus (echter zeigen-Weg) verknuepft und traegt design_vorlieben; Neubewertung des Originals loest die Verknuepfung.
 * G Melden: artefakt_bewertung_melden EIN -> Inbox an den Urheber mit Zustand + Kommentar; AUS -> keine Nachricht.
 */
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const db = process.env.SYNAPSE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
let testDb;
try { testDb = new URL(db); } catch { /* unten geschlossen abbrechen */ }
if (testDb?.pathname !== '/synapse_test' || testDb.port !== '5433') {
  console.error('Abbruch: SYNAPSE_DATABASE_URL muss auf synapse_test:5433 zeigen'); process.exit(2);
}
process.env.DATABASE_URL = db;
process.env.SYNAPSE_AUTH_DISABLED = '1';
// zeigen ohne Container/Browser: beide Abbild-Schritte scheitern sofort und laut (hinweise), die PG-Zeile bleibt.
process.env.DOCKER_SOCKET = '/nicht/vorhanden/docker.sock';
process.env.SYNAPSE_KI_BROWSER_URL = 'http://127.0.0.1:9';

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const AT = await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t141_' + randomUUID().replaceAll('-', '');
const pool = {
  async connect() {
    const client = await basisPool.connect();
    try { await client.query('SET search_path TO ' + schema + ',public'); return client; }
    catch (error) { client.release(); throw error; }
  },
  async query(...args) {
    const client = await this.connect();
    try { return await client.query(...args); } finally { client.release(); }
  },
};

let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 600) : '')); } };
const P = 'p22-t141-' + randomUUID().slice(0, 8), Q = P + '-anderes';
const KOORD = randomUUID(), REA = randomUUID(), MAIN = randomUUID(), ANDERER = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const mit = (f) => mitLesePool(pool, f);
const inject = (request) => mit(() => app.inject(request));
const bewerte = (body) => inject({ method: 'POST', url: '/api/agent-runtimes/artefakt-bewertung', payload: body });
const stand = (quellen) => inject({ method: 'GET', url: '/api/agent-runtimes/artefakt-bewertung?quellen=' + encodeURIComponent(quellen) });
const vorlieben = (q = '') => inject({ method: 'GET', url: '/api/agent-runtimes/artefakt-bewertung/vorlieben' + q });
const tool = (args, agent = 'koordinator') => mit(() => AT.fuehreArtefaktAus(args, agent));
const schalter = async (funktion, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1", [funktion]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T141 Testfixture','user')", [funktion, aktiv]);
};
const zaehle = async (t) => (await pool.query('SELECT count(*)::int n FROM ' + t)).rows[0].n;

const HTML_A = '<div style="background:#111418;color:#f97316;font-family:\'IBM Plex Mono\',monospace;border:1px solid #f97316;border-radius:6px;display:grid"><h2>Status der Welle</h2><table><tr><td>T141</td></tr></table></div>';
const HTML_I = '<section style="background:#ffffff;color:#222;display:flex;box-shadow:0 1px 4px #0003"><h3>Inbox-Test</h3><ul><li>eins</li></ul></section>';
const HTML_V = '<div style="background:#000;color:#0f0"><p>Verlauf-HTML</p></div>';

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'agent_artifacts', 'hauptagent_verlauf', 'agent_runtime_sessions', 'agent_runtime_instances']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);
  check((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'artefakt_bewertungen%'", [schema])).rows[0].n === 2, 'Schema 151 idempotent (2x), zwei Tabellen');
  const { readFileSync } = await import('node:fs');
  check(readFileSync(join(repo, 'packages/core/src/db/schema-sql/151_artefakt_bewertung.sql'), 'utf8').trim() === C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL.trim(), 'Schema 151: SQL-Spiegel = TS-Konstante');
  await pool.query(
    `INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES
      ($1,$5,'koordinator','koordinator','koordinator','aktiv','p22-t141-test'),
      ($2,$5,'rea4','rea4','subagent','aktiv','p22-t141-test'),
      ($3,$5,'hauptagent-t141','hauptagent-t141','main','aktiv','p22-t141-test'),
      ($4,$6,'koordinator','koordinator','koordinator','aktiv','p22-t141-test')`,
    [KOORD, REA, MAIN, ANDERER, P, Q]);
  const A1 = randomUUID();
  await pool.query('INSERT INTO agent_artifacts(id, session_id, title, html, created_by, created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6)', [A1, randomUUID(), 'Wellenstatus', HTML_A, 'hauptagent-t141', MAIN]);
  const inbox = async (von, an, text, o = {}) => (await pool.query(
    'INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [von, an, text, o.project ?? P, o.von_id ?? null, o.an_id ?? null])).rows[0].id;
  const I1 = await inbox('koordinator', 'user', HTML_I, { von_id: KOORD });
  const I2 = await inbox('user', 'koordinator', HTML_I, { an_id: KOORD });
  const I3 = await inbox('rea4', 'user', HTML_I, { von_id: REA });
  const I4 = await inbox('koordinator', 'user', 'nur Text ohne Auszeichnung', { von_id: KOORD });
  const verlauf = async (identity, text) => (await pool.query("INSERT INTO hauptagent_verlauf(identity_id, rolle, richtung, weg, text) VALUES($1,'ausgabe','aus','lauf',$2) RETURNING id", [identity, text])).rows[0].id;
  const V1 = String(await verlauf(KOORD, HTML_V));
  const V2 = String(await verlauf(REA, HTML_V));

  // A Schalter AUS (Standard)
  let r = await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'hoch' });
  check(r.statusCode === 409 && r.json().error.code === 'funktion_aus', 'A AUS: POST 409 funktion_aus', r.json());
  check(await zaehle('artefakt_bewertungen') === 0, 'A AUS schreibt nichts');
  check((await stand('artefakt:' + A1)).json().aktiv === false, 'A AUS: GET aktiv false');
  let j = (await vorlieben()).json();
  check(j.aktiv === false && j.vorbilder.length === 0 && j.debug.schalter_quelle === 'standard', 'A AUS: Vorlieben leer, Quelle standard', j);
  j = await tool({ action: 'vorlieben' });
  check(j.success === true && j.aktiv === false, 'A AUS: Tool vorlieben leer', j);
  j = await tool({ action: 'vorbild', bewertung_id: 1 });
  check(j.success === false && j.error === 'funktion_aus', 'A AUS: Tool vorbild funktion_aus', j);
  check(await mit(() => C.designVorliebenZeile()) === null, 'A AUS: keine Anmeldezeile');

  await schalter('artefakt_bewertung', true);
  // B Bewerten
  r = await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'hoch', kommentar: 'klar und ruhig', html: '<p>vom Client</p>' });
  j = r.json();
  check(r.statusCode === 200 && j.success && j.bewertung.zustand === 'vorbild' && j.bewertung.kommentar === 'klar und ruhig' && j.gemeldet === null, 'B artefakt hoch -> vorbild (Melden aus)', j);
  const BA = j.bewertung.id;
  const zA = (await pool.query('SELECT * FROM artefakt_bewertungen WHERE id=$1', [BA])).rows[0];
  check(zA.html === HTML_A && zA.titel === 'Wellenstatus' && zA.urheber_agent === 'hauptagent-t141' && zA.urheber_identity_id === MAIN && zA.project === P,
    'B Schnappschuss/Titel/Urheber aus der Quelle, Client-HTML wirkungslos', { titel: zA.titel, urheber: zA.urheber_agent, project: zA.project });
  check(zA.merkmale.farben.includes('#f97316') && zA.merkmale.layout.includes('grid') && zA.merkmale.layout.includes('tabelle') && zA.merkmale.rundung && zA.merkmale.rahmen
    && zA.merkmale.grundton === 'dunkel' && zA.merkmale.schriften[0] === 'ibm plex mono', 'B Merkmale (Farben, Aufbau, Rundung, Rahmen, dunkel, Schrift)', zA.merkmale);
  r = await bewerte({ quelle_art: 'inbox', quelle_ref: I1, identity_id: KOORD, urteil: 'runter', kommentar: 'Schatten weg, mehr Luft' });
  j = r.json();
  check(r.statusCode === 200 && j.bewertung.zustand === 'ueberarbeiten' && j.bewertung.titel === 'Inbox-Test', 'B inbox runter + Kommentar -> ueberarbeiten, Titel aus h3', j);
  const BI = j.bewertung.id;
  r = await bewerte({ quelle_art: 'verlauf', quelle_ref: V1, identity_id: KOORD, urteil: 'runter' });
  j = r.json();
  check(r.statusCode === 200 && j.bewertung.zustand === 'verbannt' && j.bewertung.kommentar === null, 'B verlauf runter ohne Kommentar -> verbannt', j);
  const BV = j.bewertung.id;
  r = await bewerte({ quelle_art: 'verlauf', quelle_ref: V1, identity_id: KOORD, urteil: 'runter', kommentar: '   ' });
  check(r.json().bewertung.zustand === 'verbannt', 'B nur Leerraum zaehlt nicht als Kommentar');

  // C Abweisung
  const fehlerCode = async (body) => { const x = await bewerte(body); return x.statusCode + ':' + x.json().error?.code; };
  check(await fehlerCode({ quelle_art: 'inbox', quelle_ref: I2, identity_id: KOORD, urteil: 'hoch' }) === '404:quelle_unbekannt', 'C Inbox User->Agent abgewiesen');
  check(await fehlerCode({ quelle_art: 'inbox', quelle_ref: I3, identity_id: KOORD, urteil: 'hoch' }) === '404:quelle_unbekannt', 'C Inbox eines anderen Agenten abgewiesen');
  check(await fehlerCode({ quelle_art: 'inbox', quelle_ref: I1, identity_id: ANDERER, urteil: 'hoch' }) === '404:quelle_unbekannt', 'C gleicher Name in anderem Projekt abgewiesen');
  check(await fehlerCode({ quelle_art: 'verlauf', quelle_ref: V2, identity_id: KOORD, urteil: 'hoch' }) === '404:quelle_unbekannt', 'C fremde Verlaufszeile abgewiesen');
  check(await fehlerCode({ quelle_art: 'inbox', quelle_ref: I4, identity_id: KOORD, urteil: 'hoch' }) === '400:keine_html_quelle', 'C Text ohne HTML abgewiesen');
  check(await fehlerCode({ quelle_art: 'inbox', quelle_ref: I1, urteil: 'hoch' }) === '400:identity_id_fehlt', 'C inbox ohne identity_id');
  check(await fehlerCode({ quelle_art: 'bild', quelle_ref: '1', urteil: 'hoch' }) === '400:quelle_art_ungueltig', 'C quelle_art ungueltig');
  check(await fehlerCode({ quelle_art: 'inbox', quelle_ref: 'abc', identity_id: KOORD, urteil: 'hoch' }) === '400:quelle_ref_ungueltig', 'C quelle_ref ungueltig');
  check(await fehlerCode({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'mittel' }) === '400:urteil_ungueltig', 'C urteil ungueltig');
  check(await fehlerCode({ quelle_art: 'artefakt', quelle_ref: randomUUID(), urteil: 'hoch' }) === '404:quelle_unbekannt', 'C unbekanntes Artefakt');

  // D Neubewertung + Historie + Stand je Block
  r = await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'runter', kommentar: 'doch zu dunkel' });
  j = r.json();
  check(j.bewertung.id === BA && j.bewertung.zustand === 'ueberarbeiten' && j.bewertung.anzahl_bewertungen === 2, 'D Neubewertung ersetzt den Stand (gleiche ID, anzahl 2)', j);
  const hist = (await pool.query('SELECT urteil, zustand, kommentar FROM artefakt_bewertungen_historie WHERE bewertung_id=$1 ORDER BY id', [BA])).rows;
  check(hist.length === 2 && hist[0].zustand === 'vorbild' && hist[1].zustand === 'ueberarbeiten', 'D Historie behaelt beide Bewertungen', hist);
  r = await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'hoch' });
  check(r.json().bewertung.zustand === 'vorbild', 'D zurueck auf Vorbild');
  j = (await stand(['artefakt:' + A1, 'inbox:' + I1, 'verlauf:' + V1, 'inbox:999999', 'kaputt'].join(','))).json();
  const je = Object.fromEntries(j.bewertungen.map((b) => [b.quelle_art + ':' + b.quelle_ref, b.zustand]));
  check(j.aktiv === true && j.bewertungen.length === 3 && je['artefakt:' + A1] === 'vorbild' && je['inbox:' + I1] === 'ueberarbeiten' && je['verlauf:' + V1] === 'verbannt',
    'D Stand je Block (Unbekanntes faellt weg)', j);

  // E Vorlieben kompakt
  j = (await vorlieben()).json();
  check(j.aktiv === true && j.vorbilder.length === 1 && j.ueberarbeiten.length === 1 && j.verbannt.length === 1, 'E drei Gruppen', j);
  check(!JSON.stringify(j).includes('<div') && !JSON.stringify(j).includes('<section'), 'E ohne HTML');
  check(j.ueberarbeiten[0].kommentar === 'Schatten weg, mehr Luft' && j.vorbilder[0].kommentar === undefined, 'E Kommentar nur bei ueberarbeiten');
  check(/Farben/.test(j.vorbilder[0].merkmale) && /Aufbau grid/.test(j.vorbilder[0].merkmale) && j.vorbilder[0].titel === 'Wellenstatus', 'E Merkmale als kurze Zeile', j.vorbilder[0]);
  check(j.debug.anzahl.vorbild === 1 && j.debug.anzahl.verbannt === 1 && j.debug.schalter_quelle === 'produkt-schalter' && j.debug.gekappt === false, 'E debug anzahl/Quelle', j.debug);
  check((await vorlieben('?limit=0')).json().vorbilder.length === 1, 'E limit 0 -> Standard');
  const zeile = await mit(() => C.designVorliebenZeile());
  check(typeof zeile === 'string' && /1 Vorbild/.test(zeile) && /artefakt\(action:"vorlieben"\)/.test(zeile), 'E Anmeldezeile mit Zahlen und Abruf', zeile);

  // F Agenten-Weg
  j = await tool({ action: 'vorlieben', limit: 1 });
  check(j.success === true && j.vorbilder.length === 1 && typeof j.hinweis === 'string', 'F Tool vorlieben', j);
  j = await tool({ action: 'vorbild', bewertung_id: Number(BA) });
  check(j.success === true && j.html === HTML_A && j.zustand === 'vorbild' && j.quelle === 'artefakt:' + A1, 'F Tool vorbild liefert das HTML', j);
  j = await tool({ action: 'vorbild', bewertung_id: 'x' });
  check(j.success === false && j.error === 'bewertung_id_fehlt', 'F vorbild ohne gueltige ID', j);
  j = await tool({ action: 'versuch', bewertung_id: BV, quelle_art: 'inbox', quelle_ref: I4 });
  check(j.success === false && j.error === 'nicht_ueberarbeiten', 'F versuch nur fuer ueberarbeiten (verbannt bleibt)', j);
  j = await tool({ action: 'versuch', bewertung_id: BI, quelle_art: 'inbox', quelle_ref: 99999999 });
  check(j.success === false && j.error === 'nachfolger_unbekannt', 'F versuch mit unbekanntem Nachfolger', j);
  j = await tool({ action: 'versuch', bewertung_id: BI, quelle_art: 'inbox', quelle_ref: I1 });
  check(j.success === false && j.error === 'nachfolger_gleich_original', 'F Original ist kein Versuch', j);
  const I5 = await inbox('koordinator', 'user', '<div style="background:#fff"><h3>Inbox-Test v2</h3></div>', { von_id: KOORD });
  j = await tool({ action: 'versuch', bewertung_id: BI, quelle_art: 'inbox', quelle_ref: String(I5) });
  check(j.success === true && j.bewertung.zustand === 'versuch_gezeigt' && j.bewertung.nachfolger?.ref === String(I5), 'F versuch -> versuch_gezeigt mit Nachfolger', j);
  check((await vorlieben()).json().ueberarbeiten.length === 0, 'F Original verlaesst ueberarbeiten');
  j = await tool({ action: 'versuch', bewertung_id: BI, quelle_art: 'inbox', quelle_ref: String(I5) });
  check(j.success === false && j.error === 'versuch_schon_gezeigt', 'F zweiter Versuch abgewiesen', j);
  const hI = (await pool.query('SELECT zustand, von, nachfolger_ref FROM artefakt_bewertungen_historie WHERE bewertung_id=$1 ORDER BY id', [BI])).rows;
  check(hI.length === 2 && hI[1].zustand === 'versuch_gezeigt' && hI[1].von === 'agent:koordinator', 'F Historie mit Agent', hI);
  r = await bewerte({ quelle_art: 'inbox', quelle_ref: I5, identity_id: KOORD, urteil: 'hoch' });
  check(r.json().bewertung.zustand === 'vorbild', 'F neuer Versuch normal bewertbar');
  // zeigen mit ueberarbeitet_aus (echter zeigen-Weg ohne Container/Browser)
  r = await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'runter', kommentar: 'Tabelle ohne Rahmen' });
  check(r.json().bewertung.zustand === 'ueberarbeiten' && r.json().bewertung.nachfolger === null, 'F Original wieder ueberarbeiten');
  await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES('claude','claude','main','/mnt/z/x','img','synapse-runtime-t141',true) ON CONFLICT DO NOTHING");
  const S1 = randomUUID();
  await pool.query("INSERT INTO agent_runtime_sessions(id,agent_role,runtime,status,identity_id) VALUES($1,'main','claude','running',$2)", [S1, MAIN]);
  j = await tool({ action: 'zeigen', session_id: S1, html: '<div style="background:#111418"><h2>Wellenstatus v2</h2></div>', titel: 'Wellenstatus v2', ueberarbeitet_aus: Number(BA) }, 'hauptagent-t141');
  check(j.success === true && typeof j.artefakt_id === 'string' && j.versuch?.zustand === 'versuch_gezeigt' && j.versuch?.nachfolger?.ref === j.artefakt_id,
    'F zeigen mit ueberarbeitet_aus verknuepft den neuen Block', j);
  check(j.design_vorlieben && j.design_vorlieben.abruf === 'artefakt(action:"vorlieben")' && Array.isArray(j.hinweise), 'F zeigen traegt design_vorlieben (Abbild-Fehler laut in hinweise)', j);
  j = await tool({ action: 'zeigen', session_id: S1, html: '<p>noch einer</p>', ueberarbeitet_aus: Number(BA) }, 'hauptagent-t141');
  check(j.success === true && j.versuch_fehler?.code === 'versuch_schon_gezeigt', 'F zeigen bleibt erfolgreich, Verknuepfungsfehler in versuch_fehler', j);
  r = await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'runter', kommentar: 'nochmal anders' });
  check(r.json().bewertung.zustand === 'ueberarbeiten' && r.json().bewertung.nachfolger === null, 'F Neubewertung des Originals loest die Verknuepfung');

  // G Melden
  const vorher = await zaehle('specialist_inbox');
  await bewerte({ quelle_art: 'inbox', quelle_ref: I5, identity_id: KOORD, urteil: 'runter', kommentar: 'Ueberschrift zu klein' });
  check(await zaehle('specialist_inbox') === vorher, 'G Melden AUS: keine Nachricht');
  await schalter('artefakt_bewertung_melden', true);
  r = await bewerte({ quelle_art: 'inbox', quelle_ref: I5, identity_id: KOORD, urteil: 'runter', kommentar: 'Ueberschrift zu klein' });
  j = r.json();
  check(j.gemeldet?.gemeldet === true && Number.isFinite(Number(j.gemeldet.inbox_id)), 'G Melden EIN: gemeldet mit inbox_id', j);
  const msg = (await pool.query('SELECT from_agent, to_agent, content FROM specialist_inbox WHERE id=$1', [j.gemeldet?.inbox_id ?? 0])).rows[0];
  check(msg?.from_agent === 'user' && msg.to_agent === 'koordinator' && /\[Design-Bewertung\]/.test(msg.content) && /wird ueberarbeitet/.test(msg.content)
    && /Ueberschrift zu klein/.test(msg.content) && /ueberarbeitet_aus/.test(msg.content), 'G Nachricht an den Urheber: Zustand + Kommentar + Abruf', msg);
  r = await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'hoch' });
  check(r.json().gemeldet?.gemeldet === true, 'G auch hoch wird gemeldet (jede Bewertung)', r.json().gemeldet);
} finally {
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
