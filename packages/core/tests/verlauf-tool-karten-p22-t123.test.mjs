/**
 * P22-T123: Tool-Karten aus tool_calls je Identitaet (verlauf-tool-karten.ts), inkl. Nacharbeit Abnahme 2ecbc7e7.
 *   A reine Funktionen: Fenster je Antwort (Main-Zug agent, Koordinator-Zug nachricht -> ausgabe, erster Ausloeser),
 *     Ausgaben ohne Ausloeser (R3) + Anker, Zuordnung nach ts mit Nachlauf, keine Doppelten, Zeile -> Karte.
 *   B PG (nur mit SYNAPSE_TEST_DATABASE_URL gegen synapse_test):
 *     B1 Schalter AUS -> keine Karten; B2 EIN -> eigener Aufruf am Zug, fremder nie;
 *     B3 R1: identity_id NULL + agent_id 'hauptagent' (nur Name) -> KEINE Karte; akteur_identity_id belegt -> Karte;
 *     B4 R3: Delta/Seite nur mit der Ausgabe -> Zuganker aus PG, Karte bleibt;
 *     B5 R2: toolKarteFuerStrom liefert bei Schalter AUS { aus: true } (SSE endet);
 *     B6 R4: Einstellungen aus PG mit Quelle, ungueltige Werte abgewiesen, max_aufrufe -> gekappt sichtbar;
 *     B7 R1: logToolCall im fremden Projekt (Kontext fremdprojekt) schreibt akteur_identity_id, identity_id bleibt NULL;
 *     B8 R3-Rest: Ausschnitt ab dem ZWEITEN Ausloeser behaelt die Karte des frueheren Zugteils (Anker je Antwort aus PG).
 * Aufruf: pnpm --filter @synapse/core build && node packages/core/tests/verlauf-tool-karten-p22-t123.test.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const K = await import(join(hier, '..', 'dist', 'services', 'verlauf-tool-karten.js'));

let fehler = 0;
const check = (ok, text, info) => { if (ok) console.log('ok   ' + text); else { fehler += 1; console.error('FAIL ' + text, info ?? ''); } };

const e = (id, rolle, weg, erstellt, aktualisiert, extra = {}) => ({
  id: String(id), rolle, weg, status: 'fertig', gehoert_zu: null, erstellt_am: erstellt, aktualisiert_am: aktualisiert ?? erstellt,
  werkzeuge: { calls: [], phasen: [] }, text: 'x', ...extra,
});
const zeile = (id, ts, extra = {}) => ({ id: String(id), ts, project: 'p', tool_name: 'chat', action: 'inbox_check', ok: true,
  args_preview: '{"limit":5}', result: '{"success":true}', error: null, duration_ms: 100, result_truncated: false, ...extra });

// --- A: reine Funktionen ---
{
  const main = [e(177, 'user', 'webui', '2026-10-24T15:01:23.139Z'), e(178, 'agent', 'webui', '2026-10-24T15:01:23.139Z', '2026-10-24T15:01:43.058Z')];
  const koord = [
    e(179, 'nachricht', 'lauf', '2026-10-24T15:01:30.165Z'), e(180, 'ausgabe', 'werkzeug', '2026-10-24T15:01:34.079Z'),
    e(181, 'nachricht', 'werkzeug', '2026-10-24T15:01:34.213Z'), e(182, 'ausgabe', 'lauf', '2026-10-24T15:01:35.676Z'),
  ];
  const fm = K.toolKartenFenster(main);
  check(fm.length === 1 && fm[0].eintrag.id === '178', 'A1 Main: ein Fenster an der Agent-Zeile', fm);
  const fk = K.toolKartenFenster(koord);
  check(fk.length === 1 && fk[0].eintrag.id === '182' && fk[0].von === Date.parse('2026-10-24T15:01:30.165Z'),
    'A2 Koordinator: Fenster Ausloeser -> Ausgabe, Werkzeugzeilen zaehlen nicht', fk);
  const zwei = [e(1, 'nachricht', 'inbox', '2026-10-24T15:00:00.000Z'), e(2, 'nachricht', 'inbox', '2026-10-24T15:00:05.000Z'), e(3, 'ausgabe', 'lauf', '2026-10-24T15:00:09.000Z')];
  check(K.toolKartenFenster(zwei)[0].von === Date.parse('2026-10-24T15:00:00.000Z'), 'A3 mehrere Ausloeser: Fenster ab dem ERSTEN');

  // R3: Delta/Seite nur mit der Ausgabe
  const delta = [e(182, 'ausgabe', 'lauf', '2026-10-24T15:01:35.676Z')];
  check(K.ausgabenOhneAusloeser(delta).join() === '182', 'A4 R3: Ausgabe ohne Ausloeser erkannt');
  check(K.ausgabenOhneAusloeser(koord).length === 0, 'A5 R3: mit Ausloeser in der Liste kein Nachladen');
  check(K.toolKartenFenster(delta).length === 0, 'A6 R3: ohne Anker kein Fenster (deshalb ankerAusPg)');
  const fa = K.toolKartenFenster(delta, Date.now(), new Map([['182', Date.parse('2026-10-24T15:01:30.165Z')]]));
  check(fa.length === 1 && fa[0].von === Date.parse('2026-10-24T15:01:30.165Z'), 'A7 R3: Anker aus PG ergibt das Zugfenster', fa);

  const karten = [
    K.toolKarteAusZeile(zeile(1, '2026-10-24T15:01:27.771Z')),
    K.toolKarteAusZeile(zeile(2, '2026-10-24T15:01:44.000Z')),
    K.toolKarteAusZeile(zeile(3, '2026-10-24T15:01:50.000Z')),
    K.toolKarteAusZeile(zeile(1, '2026-10-24T15:01:27.771Z')),
  ];
  const z = K.ordneToolKartenZu(fm, karten);
  check(z.zugeordnet === 3 && z.ohne_fenster === 1, 'A8 Zuordnung: Fenster + Nachlauf, ausserhalb gezaehlt', z);
  check(main[1].werkzeuge.calls.map((c) => c.id).join(',') === 'tc:1,tc:2', 'A9 keine doppelte Karte, Reihenfolge nach ts', main[1].werkzeuge.calls);
  const ohneNachlauf = [e(5, 'agent', 'webui', '2026-10-24T15:00:00.000Z', '2026-10-24T15:00:10.000Z')];
  check(K.ordneToolKartenZu(K.toolKartenFenster(ohneNachlauf), [K.toolKarteAusZeile(zeile(9, '2026-10-24T15:00:11.000Z'))], 0).ohne_fenster === 1,
    'A10 R4: Nachlauf aus der Einstellung (0 ms) wird verwendet');

  const k = K.toolKarteAusZeile(zeile(7, '2026-10-24T15:00:00.000Z'));
  check(k.id === 'tc:7' && k.input.action === 'inbox_check' && k.input.limit === 5 && k.quelle === 'tool_calls' && k.isError === false, 'A11 Karte: id, action in input, Quelle', k);
  check(Date.parse(k.ende) - Date.parse(k.start) === 100, 'A12 Karte: start = ts - duration_ms', k);
  const f = K.toolKarteAusZeile(zeile(8, '2026-10-24T15:00:00.000Z', { ok: false, error: 'kaputt' }));
  check(f.isError === true && f.output === 'kaputt', 'A13 Fehlerkarte zeigt error', f);
  const g = K.toolKarteAusZeile(zeile(9, '2026-10-24T15:00:00.000Z', { result_truncated: true }));
  check(String(g.output).includes('gekuerzt') && String(g.output).includes('#9'), 'A14 Kuerzung sichtbar mit tool_calls-ID', g);
  const l = K.toolKartenFenster([e(1, 'user', 'webui', '2026-10-24T15:00:00.000Z'), e(2, 'agent', 'webui', '2026-10-24T15:00:00.000Z', '2026-10-24T15:00:01.000Z', { status: 'laeuft' })], Date.parse('2026-10-24T16:00:00.000Z'));
  check(l[0].bis === Date.parse('2026-10-24T16:00:00.000Z'), 'A15 laufende Antwort: Fenster bis jetzt', l);
  // A17 R3-Rest: Seite beginnt mit dem ZWEITEN Ausloeser; PG-Anker (erster Ausloeser) gewinnt
  const rest = [e(20, 'nachricht', 'inbox', '2026-10-24T15:00:10.000Z'), e(30, 'ausgabe', 'lauf', '2026-10-24T15:00:20.000Z')];
  check(K.ausgabenFuerAnker(rest).join() === '30', 'A17a R3-Rest: Anker fuer jede Ausgabe angefragt');
  const fr = K.toolKartenFenster(rest, Date.now(), new Map([['30', Date.parse('2026-10-24T15:00:00.000Z')]]));
  check(fr.length === 1 && fr[0].von === Date.parse('2026-10-24T15:00:00.000Z'), 'A17b R3-Rest: PG-Anker vor spaeterem sichtbarem Ausloeser', fr);
  check(K.TOOL_KARTEN_EINSTELLUNGEN.max_aufrufe.standard === 500 && K.TOOL_KARTEN_EINSTELLUNGEN.sse_takt_ms.standard === 15000, 'A16 R4: Code-Standards im Katalog');
}

// --- B: PG (nur Testdatenbank) ---
if (process.env.SYNAPSE_TEST_DATABASE_URL) {
  process.env.SYNAPSE_DATABASE_URL = process.env.SYNAPSE_TEST_DATABASE_URL;
  const C = await import(join(hier, '..', 'dist', 'index.js'));
  const B = await import(join(hier, '..', 'dist', 'services', 'agent-bezug.js'));
  const pool = C.getPool();
  await C.ensureSchema?.();
  const P = 'p22-t123-test';
  const FREMD = 'p22-t123-fremd';
  const ID_A = '00000000-0000-4000-8000-00000a123101';
  const ID_B = '00000000-0000-4000-8000-00000b123102';
  const ID_C = '00000000-0000-4000-8000-00000c123103';
  const schalter = (aktiv) => C.setzeProfilProduktSchalter({ ebene: 'global', funktion: 'verlauf_tool_karten', aktiv, grund: 'Test P22-T123 ' + (aktiv ? 'EIN' : 'AUS') }, { system: 'user' });
  try {
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv) SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::timestamptz[]) ON CONFLICT (id) DO NOTHING",
      [[ID_A, ID_B], [P, P], ['agent-a-t123', 'agent-b-t123'], ['koordinator', 'koordinator'], ['aktiv', 'aktiv'], ['test', 'test'], [new Date(), new Date()]]);
    await pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,text,erstellt_am) VALUES($1,'nachricht','ein','lauf','Auftrag',NOW()-interval '10 seconds')", [ID_A]);
    await pool.query(`INSERT INTO tool_calls(project,agent_id,identity_id,akteur_identity_id,tool_name,action,ok,args_preview,result,ts) VALUES
      ($1,'agent-a-t123',$2,$2,'chat','inbox_check',true,'{}','eigen',NOW()-interval '6 seconds'),
      ($1,'agent-b-t123',$3,$3,'plan','get',true,'{}','fremd',NOW()-interval '6 seconds'),
      ($4,'agent-a-t123',NULL,NULL,'memory','read',true,'{}','nur-name',NOW()-interval '5 seconds'),
      ($4,'agent-a-t123',NULL,$2,'thought','add',true,'{}','belegt-fremdprojekt',NOW()-interval '4 seconds')`, [P, ID_A, ID_B, FREMD]);
    const aus = (await pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,text) VALUES($1,'ausgabe','aus','lauf','Fertig') RETURNING id::text, rev::text", [ID_A])).rows[0];

    await schalter(false);
    let v = await C.leseVerlaufFuer(ID_A, { limit: 10 });
    check(v.tool_karten?.aktiv === false && v.eintraege.every((x) => x.werkzeuge.calls.length === 0), 'B1 Schalter AUS: keine Karten', v.tool_karten);
    await schalter(true);
    v = await C.leseVerlaufFuer(ID_A, { limit: 10 });
    const a = v.eintraege.find((x) => x.id === aus.id);
    const namen = (a?.werkzeuge.calls ?? []).map((c) => c.name).sort().join(',');
    check(namen === 'chat,thought', 'B2/B3 eigener + belegter Fremdprojekt-Aufruf, NICHT fremde Identitaet, NICHT nur-Name', { namen, debug: v.tool_karten });

    // B4 R3: Delta ab der Ausgabe (Ausloeser nicht in der Liste)
    const d = await C.leseVerlaufFuer(ID_A, { seit_rev: String(Number(aus.rev) - 1), ab_id: aus.id });
    const da = d.eintraege.find((x) => x.id === aus.id);
    check(da?.werkzeuge.calls.length === 2 && d.tool_karten?.anker_nachgeladen === 1, 'B4 R3: Delta nur mit Ausgabe behaelt die Karten (Anker aus PG)', d.tool_karten);

    // B5 R2
    const eigen = (await pool.query("SELECT id::text FROM tool_calls WHERE project=$1 AND identity_id=$2", [P, ID_A])).rows[0].id;
    const fremdId = (await pool.query("SELECT id::text FROM tool_calls WHERE project=$1 AND identity_id=$2", [P, ID_B])).rows[0].id;
    const nurName = (await pool.query("SELECT id::text FROM tool_calls WHERE project=$1 AND akteur_identity_id IS NULL", [FREMD])).rows[0].id;
    let s = await C.toolKarteFuerStrom(ID_A, { id: eigen, identity_id: ID_A });
    check(s.aus === false && s.karte?.name === 'chat', 'B5a Strom EIN: eigene Karte', s);
    check((await C.toolKarteFuerStrom(ID_A, { id: fremdId, identity_id: ID_B })).karte === null, 'B5b Strom: fremde Identitaet -> keine Karte');
    check((await C.ladeToolKarte(ID_A, nurName)) === null, 'B5c R1: nur-Name-Zeile -> ladeToolKarte null');
    await schalter(false);
    s = await C.toolKarteFuerStrom(ID_A, { id: eigen, identity_id: ID_A });
    check(s.aus === true, 'B5d R2: Schalter AUS waehrend des Stroms -> aus (Strom endet)', s);
    await schalter(true);

    // B6 R4
    let st = await C.leseToolKartenEinstellungen();
    check(st.einstellungen.max_aufrufe.quelle === 'standard' && st.werte.max_aufrufe === 500, 'B6a Standard mit Quelle', st.einstellungen.max_aufrufe);
    let abgewiesen = false;
    try { await C.setzeToolKartenEinstellungen({ max_aufrufe: 1 }, 'Test P22-T123', 'test'); } catch { abgewiesen = true; }
    check(abgewiesen, 'B6b ungueltiger Wert abgewiesen');
    st = await C.setzeToolKartenEinstellungen({ max_aufrufe: 10 }, 'Test P22-T123', 'test');
    check(st.einstellungen.max_aufrufe.quelle === 'einstellung' && st.werte.max_aufrufe === 10, 'B6c Einstellung aus PG wirksam', st.einstellungen.max_aufrufe);
    await pool.query("INSERT INTO tool_calls(project,agent_id,identity_id,tool_name,action,ok,args_preview,ts) SELECT $1,'agent-a-t123',$2,'code_intel','search',true,'{}',NOW()-interval '7 seconds' FROM generate_series(1,12)", [P, ID_A]);
    v = await C.leseVerlaufFuer(ID_A, { limit: 10 });
    check(v.tool_karten?.gekappt === true && v.tool_karten.max_aufrufe === 10, 'B6d Kappung sichtbar (gekappt, max_aufrufe)', v.tool_karten);
    await C.setzeToolKartenEinstellungen({ max_aufrufe: null }, 'Test P22-T123 zurueck', 'test');

    // B7 R1: logToolCall im fremden Projekt
    const bezug = { modus: 'neu', standard: 'alt', quelle: 'standard', bis: null, letzter_fehler: null };
    await B.mitAgentAufrufKontext({ principal: { art: 'legacy', project: FREMD, agent_id: 'agent-a-t123' }, bezug,
      fremdprojekt: { project: FREMD, heimat: P, zugang: 'frei', identity_id: ID_A } },
      () => C.logToolCall({ project: FREMD, agentId: 'agent-a-t123', tool: 'plan', action: 'list', ok: true, argsPreview: '{}', result: 'b7' }));
    const b7 = (await pool.query("SELECT identity_id, akteur_identity_id FROM tool_calls WHERE project=$1 AND result='b7'", [FREMD])).rows[0];
    check(b7?.identity_id === null && b7?.akteur_identity_id === ID_A, 'B7 logToolCall fremdprojekt: akteur_identity_id belegt, identity_id unveraendert NULL', b7);

    // B8 R3-Rest (Repro ffa953c4): Nachricht T-30, Tool T-25, Nachricht T-20, Ausgabe T-10; Karte in jedem Ausschnitt
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv) VALUES($1,$2,'agent-c-t123','agent-c-t123','koordinator','aktiv','test',NOW()) ON CONFLICT (id) DO NOTHING", [ID_C, P]);
    const zug = (await pool.query(`INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,text,erstellt_am) VALUES
      ($1,'nachricht','ein','lauf','Auftrag 1',NOW()-interval '30 seconds'),
      ($1,'nachricht','ein','inbox','Auftrag 2',NOW()-interval '20 seconds'),
      ($1,'ausgabe','aus','lauf','Fertig',NOW()-interval '10 seconds') RETURNING id::text, rolle, weg, erstellt_am`, [ID_C])).rows
      .sort((x, y) => Number(x.id) - Number(y.id)).map((r) => e(r.id, r.rolle, r.weg, new Date(r.erstellt_am).toISOString()));
    await pool.query("INSERT INTO tool_calls(project,agent_id,identity_id,akteur_identity_id,tool_name,action,ok,args_preview,result,ts) VALUES($1,'agent-c-t123',$2,$2,'chat','get',true,'{}','b8',NOW()-interval '25 seconds')", [P, ID_C]);
    const kopie = (l) => l.map((x) => ({ ...x, werkzeuge: { calls: [], phasen: [] } }));
    for (const [name, l] of [['voll', kopie(zug)], ['ab zweitem Ausloeser', kopie(zug.slice(1))], ['nur Antwort', kopie(zug.slice(2))]]) {
      const dbg = await C.ergaenzeToolKarten(ID_C, l);
      const calls = l[l.length - 1].werkzeuge.calls;
      check(calls.length === 1 && calls[0].output === 'b8' && dbg.anker_nachgeladen === 1, 'B8 R3-Rest: Karte des frueheren Zugteils bleibt (' + name + ')', dbg);
    }
  } finally {
    await schalter(false).catch(() => undefined);
    await pool.query("DELETE FROM verlauf_tool_karten_einstellungen WHERE gesetzt_von='test'").catch(() => undefined);
    await pool.query('DELETE FROM tool_calls WHERE project = ANY($1)', [[P, FREMD]]);
    await pool.query('DELETE FROM hauptagent_verlauf WHERE identity_id = ANY($1)', [[ID_A, ID_B, ID_C]]);
    await pool.query('DELETE FROM agent_identitaeten WHERE id = ANY($1)', [[ID_A, ID_B, ID_C]]);
    await pool.end();
  }
} else {
  console.log('skip B (PG): SYNAPSE_TEST_DATABASE_URL nicht gesetzt');
}

assert.equal(fehler, 0, fehler + ' Pruefung(en) fehlgeschlagen');
console.log('P22-T123 verlauf-tool-karten: alles gruen');
