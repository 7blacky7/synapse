/**
 * P22-T161: Top-Artefakte je Projekt aus den Bewertungen. NUR synapse_test:5433, privates Schema, gebaute Core/API-dists, kein Docker/Browser.
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/top-artefakte-p22-t161.test.mjs
 * A rein: topWeg, kommentarVorschau, vergleicheTop. B Schema 156 idempotent + SQL-Spiegel. C GET top?project=P: alle Wege mit Projektdaten
 * (Ausweis-Artefakt, Vorlage ueber standard_project, Inbox, Verlauf), nicht: Main-Artefakt ohne Projektbezug, fremdes Projekt, verbannt,
 * ueberarbeiten; Rangfolge Saldo, Gleichstand juengste zuerst; Revision geaendert; Modus/Weg. D alle=1: Zustaende, verbannt ganz unten.
 * E Schnappschuss. F Live: NOTIFY -> gebuendeltes 'geaendert' an Betrachter. G Schalter AUS: leer, Schnappschuss funktion_aus, Strom 'aus'.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
process.env.DOCKER_SOCKET = '/nicht/vorhanden/docker.sock';
process.env.SYNAPSE_KI_BROWSER_URL = 'http://127.0.0.1:9';

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const L = await load('packages/rest-api/dist/services/artefakt-bewertung-live.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t161_' + randomUUID().replaceAll('-', '');
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
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 900) : '')); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const P = 'p22-t161-' + randomUUID().slice(0, 8);
const Q = P + '-fremd';
const HA = P + '-hauptagent';
const KOORD = randomUUID(), MAIN = randomUUID(), FREMD = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const mit = (f) => mitLesePool(pool, f);
const bewerte = async (body) => (await mit(() => app.inject({ method: 'POST', url: '/api/agent-runtimes/artefakt-bewertung', payload: body }))).json();
const top = async (q) => mit(() => app.inject({ method: 'GET', url: '/api/main-agent/artefakte/top?' + q }));
const schalter = async (aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion='artefakt_bewertung'");
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'artefakt_bewertung',$1,'T161 Testfixture','user')", [aktiv]);
};

// A rein
check(C.topWeg({ quelle_art: 'inbox' }) === 'inbox' && C.topWeg({ quelle_art: 'verlauf' }) === 'verlauf'
  && C.topWeg({ quelle_art: 'artefakt', hat_vorlage: true, session_id: 's' }) === 'vorlage' && C.topWeg({ quelle_art: 'artefakt', session_id: 's' }) === 'main'
  && C.topWeg({ quelle_art: 'artefakt', session_id: null }) === 'ausweis', 'A topWeg je Quelle');
const kv = C.kommentarVorschau('a'.repeat(400));
check(kv.gekuerzt && kv.text.length === 160 && C.kommentarVorschau('  x \n y ').text === 'x y' && C.kommentarVorschau('').text === null, 'A kommentarVorschau kappt und glaettet', kv);
const t0 = '2026-10-25T10:00:00.000Z', t1 = '2026-10-25T11:00:00.000Z';
const liste = [
  { bewertung_id: '1', zustand: 'verbannt', saldo: 0, bewertet_am: t1 }, { bewertung_id: '2', zustand: 'vorbild', saldo: 1, bewertet_am: t0 },
  { bewertung_id: '3', zustand: 'vorbild', saldo: 1, bewertet_am: t1 }, { bewertung_id: '4', zustand: 'vorbild', saldo: 3, bewertet_am: t0 },
  { bewertung_id: '5', zustand: 'ueberarbeiten', saldo: 5, bewertet_am: t1 },
].sort(C.vergleicheTop).map((e) => e.bewertung_id).join(',');
check(liste === '4,3,2,5,1', 'A vergleicheTop: vorbild vor anderen, Saldo, Gleichstand juengste, verbannt unten', liste);

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'agent_artifacts', 'hauptagent_verlauf']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  // B Schema 151 + 156 (zweimal: idempotent), SQL-Spiegel
  for (let i = 0; i < 2; i++) { await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL); await pool.query(C.ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL); }
  const trig = (await pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname='trg_notify_artefakt_bewertung' AND tgrelid=($1 || '.artefakt_bewertungen')::regclass", [schema])).rows[0].n;
  check(trig === 1, 'B Schema 156 idempotent (2x), genau ein Trigger', trig);
  check(readFileSync(join(repo, 'packages/core/src/db/schema-sql/156_artefakt_bewertung_notify.sql'), 'utf8').trim() === C.ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL.trim(), 'B Schema 156: SQL-Spiegel = TS-Konstante');
  check(readFileSync(join(repo, 'packages/core/src/db/schema-sql/151_artefakt_bewertung.sql'), 'utf8').trim() === C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL.trim(), 'B Schema 151 unveraendert (Spiegel)');

  await pool.query(`INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES
      ($1,$4,'koordinator','koordinator','koordinator','aktiv','p22-t161-test'),
      ($2,$5,'hauptagent','hauptagent','main','aktiv','p22-t161-test'),
      ($3,$6,'koordinator','koordinator','koordinator','aktiv','p22-t161-test')`, [KOORD, MAIN, FREMD, P, HA, Q]);
  const artefakt = async (o) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO agent_artifacts(id, session_id, title, html, created_by, created_by_identity_id, vorlage, quellen, modus, standard_project)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [id, o.session ?? null, o.titel, '<div style="background:#101820;color:#f2a900"><h2>' + o.titel + '</h2></div>',
      o.von, o.identity, o.vorlage ?? null, o.vorlage ? JSON.stringify([{ name: 'plaene', quelle: 'plan.list' }]) : null, o.modus ?? 'fest', o.standard ?? null]);
    return id;
  };
  const A_AUS = await artefakt({ titel: 'Ausweis-Artefakt', von: 'koordinator', identity: KOORD });
  const A_VORL = await artefakt({ titel: 'Live-Vorlage', von: 'hauptagent', identity: MAIN, session: randomUUID(), vorlage: '<h1>{{_meta.project}}</h1>', modus: 'live', standard: P });
  const A_MAIN = await artefakt({ titel: 'Main ohne Projekt', von: 'hauptagent', identity: MAIN, session: randomUUID() });
  const A_FREMD = await artefakt({ titel: 'Fremdes Projekt', von: 'koordinator', identity: FREMD });
  const A_VERB = await artefakt({ titel: 'Verbannt', von: 'koordinator', identity: KOORD });
  const A_UEB = await artefakt({ titel: 'Ueberarbeiten', von: 'koordinator', identity: KOORD });
  const INB = (await pool.query("INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id) VALUES('koordinator','user',$1,$2,$3) RETURNING id",
    ['<section style="color:#0a7"><h3>Inbox-HTML</h3></section>', P, KOORD])).rows[0].id;
  const VERL = (await pool.query("INSERT INTO hauptagent_verlauf(identity_id, rolle, richtung, weg, text) VALUES($1,'ausgabe','aus','lauf',$2) RETURNING id",
    [KOORD, '<div class="v"><h2>Verlauf-HTML</h2></div>'])).rows[0].id;
  await schalter(true);

  // Bewertungen (Reihenfolge = Zeit): Saldo A_AUS 2 (zweimal hoch), Inbox 0 (runter+Kommentar, dann hoch), Rest 1
  const ok = (j, n) => { check(j.success === true, 'Fixture: Bewertung ' + n, j); return j.bewertung?.id; };
  const B_AUS = ok(await bewerte({ quelle_art: 'artefakt', quelle_ref: A_AUS, urteil: 'hoch', kommentar: 'Farben super' }), 'A_AUS 1');
  ok(await bewerte({ quelle_art: 'inbox', quelle_ref: String(INB), identity_id: KOORD, urteil: 'runter', kommentar: 'zu bunt' }), 'INB runter');
  ok(await bewerte({ quelle_art: 'artefakt', quelle_ref: A_VERB, urteil: 'runter' }), 'A_VERB');
  ok(await bewerte({ quelle_art: 'artefakt', quelle_ref: A_UEB, urteil: 'runter', kommentar: 'mehr Luft' }), 'A_UEB');
  ok(await bewerte({ quelle_art: 'artefakt', quelle_ref: A_MAIN, urteil: 'hoch' }), 'A_MAIN');
  ok(await bewerte({ quelle_art: 'artefakt', quelle_ref: A_FREMD, urteil: 'hoch' }), 'A_FREMD');
  await pause(15);
  const B_VORL = ok(await bewerte({ quelle_art: 'artefakt', quelle_ref: A_VORL, urteil: 'hoch', kommentar: 'die farben anpassen :D' }), 'A_VORL');
  await pause(15);
  const B_VERL = ok(await bewerte({ quelle_art: 'verlauf', quelle_ref: String(VERL), identity_id: KOORD, urteil: 'hoch' }), 'VERL');
  await pause(15);
  ok(await bewerte({ quelle_art: 'artefakt', quelle_ref: A_AUS, urteil: 'hoch', kommentar: 'Farben super, wirklich' }), 'A_AUS 2');
  await pause(15);
  const B_INB = ok(await bewerte({ quelle_art: 'inbox', quelle_ref: String(INB), identity_id: KOORD, urteil: 'hoch' }), 'INB hoch');
  await pool.query('UPDATE agent_artifacts SET revision = revision + 1 WHERE id = $1', [A_AUS]);

  // C GET top?project=P
  let res = await top('project=' + encodeURIComponent(P));
  let j = res.json();
  check(res.statusCode === 200 && j.success === true && j.aktiv === true && j.project === P, 'C Antwort aktiv fuer das Projekt', j);
  const ids = (j.eintraege ?? []).map((e) => e.bewertung_id);
  check(ids.join(',') === [B_AUS, B_VERL, B_VORL, B_INB].join(','), 'C Rangfolge: Saldo 2 zuerst, dann Saldo 1 juengste zuerst, Saldo 0 zuletzt', { ids, erwartet: [B_AUS, B_VERL, B_VORL, B_INB] });
  const je = Object.fromEntries((j.eintraege ?? []).map((e) => [e.bewertung_id, e]));
  check(je[B_AUS]?.weg === 'ausweis' && je[B_VORL]?.weg === 'vorlage' && je[B_INB]?.weg === 'inbox' && je[B_VERL]?.weg === 'verlauf', 'C alle Wege mit Projektdaten enthalten', j.eintraege?.map((e) => [e.weg, e.titel]));
  check(je[B_VORL]?.modus === 'live' && je[B_VORL].hat_vorlage === true && je[B_VORL].standard_project === P && je[B_VORL].project === HA, 'C Vorlage ueber standard_project (Urheber-Projekt anders), Modus live', je[B_VORL]);
  check(!(j.eintraege ?? []).some((e) => ['Main ohne Projekt', 'Fremdes Projekt', 'Verbannt', 'Ueberarbeiten'].includes(e.titel)), 'C nicht: Main ohne Projektbezug, fremdes Projekt, verbannt, ueberarbeiten');
  check(je[B_AUS]?.saldo === 2 && je[B_AUS].anzahl_bewertungen === 2 && je[B_INB]?.saldo === 0 && je[B_INB].zustand === 'vorbild', 'C Saldo aus der Historie', [je[B_AUS], je[B_INB]]);
  check(je[B_AUS]?.bewertet_revision === 1 && je[B_AUS].aktuelle_revision === 2 && je[B_AUS].veraendert_seit_bewertung === true
    && je[B_VERL]?.bewertet_revision === null && je[B_VERL].veraendert_seit_bewertung === false, 'C Revision: bewertet in Rev. 1, jetzt Rev. 2', je[B_AUS]);
  check(je[B_VORL]?.kommentar_vorschau === 'die farben anpassen :D' && je[B_AUS].urheber_agent === 'koordinator' && !('html' in je[B_AUS]) && j.eintraege.every((e, i) => e.rang === i + 1),
    'C Kommentar-Vorschau, Urheber, kein HTML, Rang', je[B_VORL]);
  check(j.debug?.anzahl?.vorbild === 4 && j.debug.anzahl.verbannt === 1 && j.debug.anzahl.ueberarbeiten === 1 && j.debug.gekappt === false && typeof j.debug.dauer_ms === 'number'
    && j.live && typeof j.live.abonnenten === 'number', 'C Debug: Anzahl je Zustand im Projekt, gekappt, dauer_ms, live', j.debug);
  j = (await top('project=' + encodeURIComponent(Q))).json();
  check(j.eintraege?.length === 1 && j.eintraege[0].titel === 'Fremdes Projekt', 'C anderes Projekt sieht nur seins', j.eintraege);
  res = await top('');
  check(res.statusCode === 400 && res.json().error?.code === 'project_fehlt', 'C ohne project -> 400 project_fehlt', res.json());
  j = (await top('project=' + encodeURIComponent(P) + '&limit=2')).json();
  check(j.eintraege?.length === 2 && j.debug?.gekappt === true, 'C limit kappt, debug.gekappt', j.debug);

  // D alle=1
  j = (await top('project=' + encodeURIComponent(P) + '&alle=1')).json();
  const zustaende = (j.eintraege ?? []).map((e) => e.zustand);
  check(zustaende.join(',') === 'vorbild,vorbild,vorbild,vorbild,ueberarbeiten,verbannt', 'D alle: Vorbilder, dann ueberarbeiten, verbannt ganz unten', zustaende);
  // versuch_gezeigt verlaesst die Top-Liste
  const B_UEB = (j.eintraege ?? []).find((e) => e.zustand === 'ueberarbeiten')?.bewertung_id;
  await mit(() => C.verknuepfeVersuch({ bewertung_id: B_UEB, quelle_art: 'artefakt', quelle_ref: A_AUS, von: 'test' }));
  j = (await top('project=' + encodeURIComponent(P) + '&alle=1')).json();
  check((j.eintraege ?? []).map((e) => e.zustand).join(',') === 'vorbild,vorbild,vorbild,vorbild,versuch_gezeigt,verbannt', 'D versuch_gezeigt vor verbannt, nicht in der Vorbild-Liste', j.eintraege?.map((e) => e.zustand));

  // E Schnappschuss
  res = await mit(() => app.inject({ method: 'GET', url: '/api/main-agent/artefakte/top/' + B_AUS + '/schnappschuss' }));
  j = res.json();
  check(res.statusCode === 200 && j.schnappschuss?.html?.includes('Ausweis-Artefakt') && j.schnappschuss.bewertet_revision === 1 && j.schnappschuss.quelle?.ref === A_AUS, 'E Schnappschuss mit HTML und bewerteter Revision', j);
  res = await mit(() => app.inject({ method: 'GET', url: '/api/main-agent/artefakte/top/99999999/schnappschuss' }));
  check(res.statusCode === 404 && res.json().error?.code === 'bewertung_unbekannt', 'E unbekannte Bewertung -> 404', res.json());
  res = await mit(() => app.inject({ method: 'GET', url: '/api/main-agent/artefakte/top/abc/schnappschuss' }));
  check(res.statusCode === 400 && res.json().error?.code === 'bewertung_id_fehlt', 'E ungueltige ID -> 400', res.json());

  // F Live: echter NOTIFY ueber den Trigger -> gebuendeltes 'geaendert'
  const ereignisse = [];
  const abmelden = await L.abonniereBewertungsLive((event, data) => ereignisse.push({ event, data }));
  for (let i = 0; i < 30 && !L.bewertungLiveStatus().listener; i++) await pause(50);
  check(L.bewertungLiveStatus().listener === true && L.bewertungLiveStatus().abonnenten === 1, 'F Listener steht, ein Betrachter', L.bewertungLiveStatus());
  await bewerte({ quelle_art: 'artefakt', quelle_ref: A_VORL, urteil: 'hoch', kommentar: 'neu' });
  await bewerte({ quelle_art: 'artefakt', quelle_ref: A_FREMD, urteil: 'runter' });
  for (let i = 0; i < 40 && !ereignisse.some((e) => e.event === 'geaendert'); i++) await pause(100);
  const g = ereignisse.filter((e) => e.event === 'geaendert');
  check(g.length === 1 && g[0].data.anzahl === 2 && g[0].data.ereignisse.some((x) => x.id === B_VORL && x.project === HA), 'F zwei Bewertungen -> ein gebuendeltes geaendert mit id/project', g);
  abmelden();
  check(L.bewertungLiveStatus().abonnenten === 0 && L.bewertungLiveStatus().listener === false, 'F abmelden gibt Listener frei', L.bewertungLiveStatus());
  check(L.verarbeiteBewertungsBenachrichtigung('kein json') === 0, 'F kaputter Payload wirft nicht');

  // G Schalter AUS
  await schalter(false);
  j = (await top('project=' + encodeURIComponent(P))).json();
  check(j.success === true && j.aktiv === false && j.eintraege.length === 0, 'G AUS: aktiv false, leer', j);
  res = await mit(() => app.inject({ method: 'GET', url: '/api/main-agent/artefakte/top/' + B_AUS + '/schnappschuss' }));
  check(res.statusCode === 409 && res.json().error?.code === 'funktion_aus', 'G AUS: Schnappschuss funktion_aus', res.json());
  res = await mit(() => app.inject({ method: 'GET', url: '/api/main-agent/artefakte/top/stream' }));
  check(res.statusCode === 200 && /event: aus/.test(res.body) && /"schalter"/.test(res.body), 'G AUS: Strom meldet aus und endet', res.body);
  // Bestand: /api/main-agent/artefakte/:id bleibt erreichbar (statische top-Pfade gehen nur fuer 'top' vor)
  res = await mit(() => app.inject({ method: 'GET', url: '/api/main-agent/artefakte/' + A_AUS }));
  check(res.statusCode === 200 && res.json().artefakt?.id === A_AUS, 'G Regression: /api/main-agent/artefakte/:id unveraendert', res.json());
} finally {
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
