#!/usr/bin/env node
// test-jev-entscheidung.mjs — P7-T28 (JEV-10): Jev entscheidet Rueckfragen, wenn der User weg ist.
// Schalter je Projekt (nur Koordinator), Leitplanken (Kategorien), Jev-Aufruf (noul/choice/score),
// Confidence-Tor 0.7, Ratenbremse, Protokoll, ueberstimmen. Alles OHNE echte DB (pg-Mock im Speicher)
// und OHNE echten Jev-Aufruf (Fake-fetch). Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-jev-entscheidung.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
delete process.env.JEV_OPENROUTER_API_KEY;
delete process.env.JEV_API_URL;
delete process.env.JEV_MODELL;
delete process.env.JEV_TIMEOUT_MS;
delete process.env.JEV_ENTSCHEIDUNG_TOR;
delete process.env.JEV_ENTSCHEIDUNG_RATE;

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const pg = requireFromCore('pg');

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`OK     ${name}`);
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Fake-DB im Speicher: jev_entscheidet + jev_entscheidungen
// ---------------------------------------------------------------------------
const KEY = 'sk-or-test-GEHEIM-0123456789';
let schalter; // Map project -> {aktiv, seit, bis, gesetzt_von}
let zeilen; // jev_entscheidungen
let naechsteId;
let sqlLog;

function reset() {
  schalter = new Map();
  zeilen = [];
  naechsteId = 1;
  sqlLog = [];
  fetchAufrufe = [];
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.9 } });
  process.env.JEV_OPENROUTER_API_KEY = KEY;
  delete process.env.JEV_TIMEOUT_MS;
  delete process.env.JEV_ENTSCHEIDUNG_TOR;
  delete process.env.JEV_ENTSCHEIDUNG_RATE;
  delete process.env.JEV_MAX_RUNDEN;
}

pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  sqlLog.push({ text, params });
  if (/^SELECT aktiv, seit, bis, gesetzt_von FROM jev_entscheidet WHERE project = \$1/i.test(text)) {
    const z = schalter.get(params[0]);
    return { rows: z ? [{ ...z }] : [], rowCount: z ? 1 : 0 };
  }
  if (/^INSERT INTO jev_entscheidet/i.test(text)) {
    const [project, von, bis] = params;
    const alt = schalter.get(project);
    schalter.set(project, { aktiv: true, seit: alt?.aktiv ? alt.seit : new Date(), bis: bis ?? null, gesetzt_von: von });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE jev_entscheidet SET aktiv = false/i.test(text)) {
    const [project, von] = params;
    const alt = schalter.get(project);
    if (alt) schalter.set(project, { ...alt, aktiv: false, bis: null, gesetzt_von: von });
    return { rows: [], rowCount: alt ? 1 : 0 };
  }
  if (/^SELECT count\(\*\)::int AS n FROM jev_entscheidungen/i.test(text)) {
    const grenze = Date.now() - 3600_000;
    const n = zeilen.filter((z) => z.project === params[0] && z.jev_aufruf && new Date(z.zeit).getTime() > grenze).length;
    return { rows: [{ n }], rowCount: 1 };
  }
  if (/^INSERT INTO jev_entscheidungen/i.test(text)) {
    const [project, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, jev_aufruf, runde, erste_id, offen_fuer_user, blocker] = params;
    const zeile = {
      id: naechsteId++, zeit: new Date(), project, agent, task_id, kategorie, frage, typ,
      optionen: optionen ? JSON.parse(optionen) : null, wahl: wahl ? JSON.parse(wahl) : null,
      confidence, entschieden, grund, jev_aufruf, runde, erste_id, offen_fuer_user, blocker, ueberstimmt_von: null, ueberstimmt_wahl: null, ueberstimmt_notiz: null,
    };
    zeilen.push(zeile);
    return { rows: [{ id: zeile.id, zeit: zeile.zeit }], rowCount: 1 };
  }
  if (/^UPDATE jev_entscheidungen SET erste_id = id WHERE id = \$1/i.test(text)) {
    const z = zeilen.find((x) => x.id === Number(params[0]));
    if (z && (z.erste_id === null || z.erste_id === undefined)) z.erste_id = z.id;
    return { rows: [], rowCount: z ? 1 : 0 };
  }
  if (/^SELECT id FROM jev_entscheidungen WHERE project = \$1 AND id = \$2/i.test(text)) {
    const z = zeilen.find((x) => x.project === params[0] && x.id === Number(params[1]));
    return { rows: z ? [{ id: z.id }] : [], rowCount: z ? 1 : 0 };
  }
  if (/^SELECT id, zeit, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, runde, erste_id, offen_fuer_user, blocker, ueberstimmt_von, ueberstimmt_wahl, ueberstimmt_notiz FROM jev_entscheidungen WHERE project = \$1/i.test(text)) {
    const [project, seit, limit] = params;
    let r = zeilen.filter((z) => z.project === project && new Date(z.zeit) >= new Date(seit));
    if (/AND entschieden = true/i.test(text)) r = r.filter((z) => z.entschieden);
    r = r.sort((a, b) => b.id - a.id).slice(0, limit);
    return { rows: structuredClone(r), rowCount: r.length };
  }
  if (/^UPDATE jev_entscheidungen SET ueberstimmt_von/i.test(text)) {
    const [project, id, von, wahl, notiz] = params;
    const z = zeilen.find((x) => x.project === project && x.id === Number(id));
    if (!z) return { rows: [], rowCount: 0 };
    Object.assign(z, { ueberstimmt_von: von, ueberstimmt_wahl: JSON.parse(wahl), ueberstimmt_notiz: notiz });
    return { rows: [{ id: z.id }], rowCount: 1 };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

// ---------------------------------------------------------------------------
// Fake-Jev
// ---------------------------------------------------------------------------
let fetchAufrufe = [];
let antwortFuer;
function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  fetchAufrufe.push({ url, init, body });
  return Promise.resolve(new Response(JSON.stringify({ answers: antwortFuer(body), usage: { input_tokens: 50, cost: 0.00002 } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}
const deps = { fetch: fakeFetch };

const mod = await import('../packages/core/dist/services/jev-entscheidung.js');
const core = await import('../packages/core/dist/index.js');

const P = 'testprojekt';
const frage = (extra = {}) => ({
  agent_id: 'plan-specht', frage: 'Variante A oder B fuer den Endpunkt?', typ: 'choice', kategorie: 'variante',
  optionen: {
    a: 'Variante A: kleiner Umbau, richtig wenn wenig Aufrufer betroffen sind',
    b: 'Variante B: neuer Service, richtig wenn viele Aufrufer die Logik teilen',
    c: 'Variante C: Flag im bestehenden Code, richtig wenn es nur ein Uebergang ist',
    d: 'Variante D: Nachbau ausserhalb, richtig wenn der Kern unangetastet bleiben muss',
    weitere: 'egal, der Server ersetzt das',
  },
  ...extra,
});
const einschalten = () => mod.setzeAbwesenheit(P, { modus: 'an', agent_id: 'koordinator' });

await pruefe('Exporte ueber @synapse/core', () => {
  for (const n of ['entscheideRueckfrage', 'setzeAbwesenheit', 'holeEntscheidungsProtokoll', 'ueberstimmeEntscheidung', 'leseAbwesenheit']) {
    assert.equal(typeof core[n], 'function', n);
  }
});

// 1. Schalter -----------------------------------------------------------------
await pruefe('Schalter: nur Koordinator darf setzen (koordinator/coordinator), andere abgelehnt', async () => {
  reset();
  for (const wer of ['plan-specht', 'agent-7', '', undefined]) {
    const r = await mod.setzeAbwesenheit(P, { modus: 'an', agent_id: wer });
    assert.equal(r.success, false, String(wer));
    assert.match(r.message, /Koordinator/);
  }
  assert.equal(schalter.size, 0);
  for (const wer of ['koordinator', 'coordinator', 'Koordinator']) {
    assert.equal((await mod.setzeAbwesenheit(P, { modus: 'an', agent_id: wer })).success, true, wer);
  }
});

await pruefe('Schalter an/status/aus: seit + gesetzt_von, "seit" bleibt bei erneutem an', async () => {
  reset();
  let r = await mod.setzeAbwesenheit(P, { modus: 'status', agent_id: 'plan-specht' });
  assert.equal(r.success, true, 'status darf jeder');
  assert.equal(r.schalter.aktiv, false);
  r = await einschalten();
  assert.equal(r.schalter.aktiv, true);
  assert.equal(r.schalter.gesetzt_von, 'koordinator');
  const seit = new Date(r.schalter.seit).getTime();
  await new Promise((res) => setTimeout(res, 5));
  r = await einschalten();
  assert.equal(new Date(r.schalter.seit).getTime(), seit, 'seit darf nicht neu gesetzt werden');
  r = await mod.setzeAbwesenheit(P, { modus: 'aus', agent_id: 'koordinator' });
  assert.equal(r.schalter.aktiv, false);
  assert.ok(Array.isArray(r.protokoll), 'aus liefert das Protokoll seit dem Start');
});

await pruefe('Schalter bis: Ablauf wirkt (abgelaufen = aus), vergangenes bis wird abgelehnt', async () => {
  reset();
  let r = await mod.setzeAbwesenheit(P, { modus: 'an', agent_id: 'koordinator', bis: '2020-01-01T00:00:00Z' });
  assert.equal(r.success, false);
  assert.match(r.message, /Zukunft/);
  r = await mod.setzeAbwesenheit(P, { modus: 'an', agent_id: 'koordinator', stunden: 2 });
  assert.equal(r.success, true);
  assert.ok(new Date(r.schalter.bis).getTime() > Date.now() + 3600_000);
  schalter.get(P).bis = new Date(Date.now() - 1000);
  const s = await mod.leseAbwesenheit(P);
  assert.equal(s.aktiv, false);
  assert.equal(s.abgelaufen, true);
});

await pruefe('Schalter: ungueltiger modus -> Fehler mit erlaubten Werten', async () => {
  reset();
  const r = await mod.setzeAbwesenheit(P, { modus: 'vielleicht', agent_id: 'koordinator' });
  assert.equal(r.success, false);
  assert.match(r.message, /an, aus, status/);
});

// 2. entscheiden: Schalter aus, Leitplanken --------------------------------------
await pruefe('Schalter aus: KEIN Jev-Aufruf, KEINE Protokollzeile, Antwort "User/Koordinator fragen"', async () => {
  reset();
  const r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.success, true);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'schalter_aus');
  assert.match(r.message, /User\/Koordinator fragen/);
  assert.equal(fetchAufrufe.length, 0);
  assert.equal(zeilen.length, 0);
});

await pruefe('verbotene Kategorien werden abgelehnt (Server, mit Grund), protokolliert, kein Jev-Aufruf', async () => {
  reset();
  await einschalten();
  for (const k of ['loeschen', 'deploy', 'git', 'secrets', 'aussenwirkung', 'kosten', 'regeln']) {
    const r = await mod.entscheideRueckfrage(P, frage({ kategorie: k }), deps);
    assert.equal(r.entschieden, false, k);
    assert.equal(r.grund, 'kategorie_verboten', k);
    assert.match(r.message, /User\/Koordinator fragen/);
  }
  assert.equal(fetchAufrufe.length, 0);
  assert.equal(zeilen.length, 7);
  assert.ok(zeilen.every((z) => z.entschieden === false && z.jev_aufruf === false));
});

await pruefe('unbekannte Kategorie: abgelehnt mit Liste der erlaubten', async () => {
  reset();
  await einschalten();
  const r = await mod.entscheideRueckfrage(P, frage({ kategorie: 'zauberei' }), deps);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'kategorie_unbekannt');
  assert.match(r.message, /variante, reihenfolge, umsetzungsweg, formulierung/);
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('Pflichtangaben: agent_id, frage, typ, kategorie, Optionen bei choice', async () => {
  reset();
  await einschalten();
  for (const [name, extra] of [
    ['agent_id', { agent_id: '' }], ['frage', { frage: '  ' }], ['typ', { typ: 'egal' }],
    ['kategorie', { kategorie: undefined }], ['optionen', { optionen: { a: 'nur eine' } }],
  ]) {
    const r = await mod.entscheideRueckfrage(P, frage(extra), deps);
    assert.equal(r.success, false, name);
  }
  assert.equal(fetchAufrufe.length, 0);
});

// 3. entscheiden: Jev ------------------------------------------------------------
await pruefe('choice ueber dem Tor: entschieden, Kennzeichnung, Protokollzeile, Request-Form', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'b', confidence: 0.83 } });
  const r = await mod.entscheideRueckfrage(P, frage({ task_id: 'P7-T28', kontext: 'Kontext ' + 'x'.repeat(3000), hinweise: 'Abo schonen' }), deps);
  assert.equal(r.success, true, r.message);
  assert.equal(r.entschieden, true);
  assert.equal(r.wahl, 'b');
  assert.equal(r.confidence, 0.83);
  assert.equal(r.tor, 0.7);
  assert.match(r.kennzeichnung, /^entschieden von Jev \(Confidence 0\.83\), nicht vom User$/);
  assert.equal(r.schalter.aktiv, true);
  assert.ok(r.protokoll_id > 0);
  const { body, init } = fetchAufrufe[0];
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(body.state.kategorie, 'variante');
  assert.ok(body.state.kontext.length <= 1500);
  assert.equal(body.state.hinweise, 'Abo schonen');
  assert.deepEqual(Object.keys(body.questions), ['entscheidung']);
  assert.equal(body.questions.entscheidung.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.entscheidung.criteria).sort(), ['a', 'b', 'c', 'd', 'weitere']);
  const z = zeilen[0];
  assert.equal(z.entschieden, true);
  assert.equal(z.agent, 'plan-specht');
  assert.equal(z.task_id, 'P7-T28');
  assert.equal(z.jev_aufruf, true);
  assert.equal(z.wahl, 'b');
});

await pruefe('choice unter dem Tor 0.7: nicht entschieden (unsicher), protokolliert', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.6 } });
  const r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'unsicher');
  assert.equal(r.confidence, 0.6);
  assert.match(r.message, /User\/Koordinator fragen/);
  assert.equal(zeilen[0].entschieden, false);
  assert.equal(zeilen[0].jev_aufruf, true);
});

await pruefe('eigenes Tor: Parameter confidence_tor und Env JEV_ENTSCHEIDUNG_TOR', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.6 } });
  let r = await mod.entscheideRueckfrage(P, frage({ confidence_tor: 0.5 }), deps);
  assert.equal(r.entschieden, true);
  assert.equal(r.tor, 0.5);
  process.env.JEV_ENTSCHEIDUNG_TOR = '0.95';
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.9 } });
  r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.entschieden, false);
  assert.equal(r.tor, 0.95);
});

await pruefe('noul: p >= Tor = ja, p <= 1-Tor = nein, dazwischen unsicher; Confidence = max(p, 1-p)', async () => {
  reset();
  await einschalten();
  const noul = (p) => { antwortFuer = () => ({ entscheidung: { type: 'noul', noul: p } }); return mod.entscheideRueckfrage(P, { agent_id: 'a', frage: 'Soll ich Tests ergaenzen?', typ: 'noul', kategorie: 'umsetzungsweg' }, deps); };
  let r = await noul(0.85);
  assert.equal(r.entschieden, true);
  assert.equal(r.wahl, 'ja');
  assert.equal(r.confidence, 0.85);
  r = await noul(0.1);
  assert.equal(r.entschieden, true);
  assert.equal(r.wahl, 'nein');
  assert.equal(r.confidence, 0.9);
  r = await noul(0.5);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'unsicher');
  assert.equal(fetchAufrufe[0].body.questions.entscheidung.type, 'noul');
  assert.equal(fetchAufrufe[0].body.questions.entscheidung.criteria, undefined);
});

await pruefe('score: Skala 1..5 (Standard) intern als choice ueber die Zahlenlabels; Wahl ist eine Zahl', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: '4', confidence: 0.8 } });
  const r = await mod.entscheideRueckfrage(P, { agent_id: 'a', frage: 'Wie wichtig ist die Doku?', typ: 'score', kategorie: 'formulierung' }, deps);
  assert.equal(r.entschieden, true, r.message);
  assert.equal(r.wahl, 4);
  const q = fetchAufrufe[0].body.questions.entscheidung;
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), ['1', '2', '3', '4', '5']);
});

await pruefe('ungueltige Jev-Antwort (unbekannte Option): nicht raten, entschieden:false', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'zzz', confidence: 0.99 } });
  const r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'ungueltige_antwort');
});

// 4. Fehlerfaelle ------------------------------------------------------------------
await pruefe('kein Key: entschieden:false, kein Aufruf, Key nie im Ergebnis', async () => {
  reset();
  await einschalten();
  delete process.env.JEV_OPENROUTER_API_KEY;
  const r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'kein_key');
  assert.equal(fetchAufrufe.length, 0);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

await pruefe('HTTP-Fehler und Timeout: entschieden:false, success:false, Key nicht im Text', async () => {
  reset();
  await einschalten();
  const kaputt = () => Promise.resolve(new Response(`Fehler mit ${KEY}`, { status: 500 }));
  let r = await mod.entscheideRueckfrage(P, frage(), { fetch: kaputt });
  assert.equal(r.success, false);
  assert.equal(r.entschieden, false);
  assert.ok(!JSON.stringify(r).includes(KEY));
  process.env.JEV_TIMEOUT_MS = '30';
  const haengt = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  r = await mod.entscheideRueckfrage(P, frage(), { fetch: haengt });
  assert.equal(r.success, false);
  assert.equal(r.entschieden, false);
  assert.match(r.message, /Timeout/);
});

await pruefe('Ratenbremse: ab 30 Jev-Aufrufen je Stunde und Projekt Ablehnung (Env JEV_ENTSCHEIDUNG_RATE)', async () => {
  reset();
  await einschalten();
  process.env.JEV_ENTSCHEIDUNG_RATE = '2';
  for (let i = 0; i < 2; i++) assert.equal((await mod.entscheideRueckfrage(P, frage(), deps)).entschieden, true);
  const r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'rate_limit');
  assert.equal(fetchAufrufe.length, 2);
  delete process.env.JEV_ENTSCHEIDUNG_RATE;
  reset();
  await einschalten();
  zeilen = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, project: P, zeit: new Date(), jev_aufruf: true, entschieden: true }));
  assert.equal((await mod.entscheideRueckfrage(P, frage(), deps)).grund, 'rate_limit', 'Standard 30 je Stunde');
});

// 5. Protokoll -------------------------------------------------------------------------
await pruefe('Protokoll: seit Schalter-Beginn, auch abgelehnte; nur_entschieden filtert; limit', async () => {
  reset();
  await einschalten();
  await mod.entscheideRueckfrage(P, frage(), deps);
  await mod.entscheideRueckfrage(P, frage({ kategorie: 'deploy' }), deps);
  let p = await mod.holeEntscheidungsProtokoll(P, {});
  assert.equal(p.success, true);
  assert.equal(p.anzahl, 2);
  assert.equal(p.eintraege[0].kategorie, 'deploy', 'neueste zuerst');
  assert.ok(p.seit);
  p = await mod.holeEntscheidungsProtokoll(P, { nur_entschieden: true });
  assert.equal(p.anzahl, 1);
  p = await mod.holeEntscheidungsProtokoll(P, { limit: 1 });
  assert.equal(p.anzahl, 1);
});

await pruefe('Protokoll bei "aus": Liste seit Schalter-Beginn kommt mit zurueck', async () => {
  reset();
  await einschalten();
  await mod.entscheideRueckfrage(P, frage(), deps);
  const r = await mod.setzeAbwesenheit(P, { modus: 'aus', agent_id: 'koordinator' });
  assert.equal(r.protokoll.length, 1);
  assert.equal(r.protokoll[0].wahl, 'a');
});

await pruefe('ueberstimmen: nur Koordinator, markiert die Zeile, unbekannte id -> Fehler', async () => {
  reset();
  await einschalten();
  await mod.entscheideRueckfrage(P, frage(), deps);
  let r = await mod.ueberstimmeEntscheidung(P, { id: 1, wahl: 'b', notiz: 'User wollte B', agent_id: 'plan-specht' });
  assert.equal(r.success, false);
  r = await mod.ueberstimmeEntscheidung(P, { id: 1, wahl: 'b', notiz: 'User wollte B', agent_id: 'koordinator' });
  assert.equal(r.success, true);
  assert.equal(zeilen[0].ueberstimmt_von, 'koordinator');
  assert.equal(zeilen[0].ueberstimmt_wahl, 'b');
  assert.equal(zeilen[0].ueberstimmt_notiz, 'User wollte B');
  r = await mod.ueberstimmeEntscheidung(P, { id: 999, wahl: 'b', agent_id: 'koordinator' });
  assert.equal(r.success, false);
});

// 6. Leitplanken-Konstanten + Schema ----------------------------------------------------------
await pruefe('Konstanten: erlaubte/verbotene Kategorien wie festgelegt', () => {
  assert.deepEqual([...mod.ERLAUBTE_KATEGORIEN], ['variante', 'reihenfolge', 'umsetzungsweg', 'formulierung']);
  assert.deepEqual([...mod.VERBOTENE_KATEGORIEN], ['loeschen', 'deploy', 'git', 'secrets', 'aussenwirkung', 'kosten', 'regeln']);
  assert.equal(mod.STANDARD_ENTSCHEIDUNG_TOR, 0.7);
  assert.equal(mod.STANDARD_RATE_PRO_STUNDE, 30);
});

await pruefe('SCHEMA_SQL: nur CREATE TABLE/INDEX IF NOT EXISTS fuer die neuen Tabellen (keine Sperren)', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = await readFile(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS jev_entscheidet \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS jev_entscheidungen \(/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_jev_entscheidungen_project_zeit/);
  // JEV-12: nur ADD COLUMN IF NOT EXISTS (nullable/Default), sonst keine ALTER-Statements an den neuen Tabellen
  const alters = schema.match(/ALTER TABLE jev_entscheid[^;]*;/gi) ?? [];
  assert.ok(alters.every((a) => /ADD COLUMN IF NOT EXISTS/i.test(a) && !/DROP|TYPE|SET NOT NULL/i.test(a)), 'nur ADD COLUMN IF NOT EXISTS an den neuen Tabellen');
});


// 6a. JEV-12: 5 Optionen, die fuenfte immer 'weitere'; Runden; offene Fragen (P7-T31) -------------
const ANLEITUNG = /guide\(tool_name:jev\).*Vorgehen/s;
const ohne = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const OPT5 = frage().optionen;
const WEITERE_WAEHLEN = () => ({ entscheidung: { type: 'choice', choice: 'weitere', confidence: 0.9 } });
const nurKeys = (...keys) => Object.fromEntries(keys.map((k) => [k, OPT5[k]]));

await pruefe('choice: genau 5 Optionen inkl. Schluessel weitere Pflicht; sonst Fehler mit Fix und Anleitung, kein Jev-Aufruf', async () => {
  reset();
  await einschalten();
  const sechs = { ...OPT5, f: 'Variante F: noch etwas, richtig wenn alles andere ausscheidet' };
  for (const [name, optionen] of [
    ['4 ohne weitere', ohne(OPT5, 'weitere')],
    ['5 aber ohne weitere', { ...ohne(OPT5, 'weitere'), e: 'Variante E: fuenfte echte Option, richtig wenn Zeit knapp ist' }],
    ['6 Optionen', sechs],
    ['3 inkl. weitere', nurKeys('a', 'b', 'weitere')],
  ]) {
    const r = await mod.entscheideRueckfrage(P, frage({ optionen }), deps);
    assert.equal(r.success, false, name);
    assert.match(r.message, /weitere/, name);
    assert.match(r.message, /5/, name);
    assert.match(r.message, ANLEITUNG, name);
  }
  assert.equal(fetchAufrufe.length, 0);
  assert.equal(zeilen.length, 0);
});

await pruefe('weitere: Beschreibung setzt IMMER der Server (vereinheitlicht), egal was der Agent schickt', async () => {
  reset();
  await einschalten();
  for (const beschr of ['egal', '', undefined]) {
    fetchAufrufe = [];
    const o = { ...OPT5, weitere: beschr };
    const r = await mod.entscheideRueckfrage(P, frage({ optionen: o }), deps);
    assert.equal(r.success, true, r.message);
    const crit = fetchAufrufe[0].body.questions.entscheidung.criteria;
    assert.match(crit.weitere, /none of the four fits well enough/);
    assert.match(crit.weitere, /better options exist/);
  }
});

await pruefe('Jev waehlt weitere: entschieden:false, weiter:true, naechster_schritt, Protokollzeile Runde 1 mit erste_id = eigene id', async () => {
  reset();
  await einschalten();
  antwortFuer = WEITERE_WAEHLEN;
  const r = await mod.entscheideRueckfrage(P, frage({ task_id: 'P7-T31' }), deps);
  assert.equal(r.success, true, r.message);
  assert.equal(r.entschieden, false);
  assert.equal(r.weiter, true);
  assert.equal(r.runde, 1);
  assert.equal(r.gewaehlt, 'weitere');
  assert.equal(r.confidence, 0.9);
  assert.equal(r.kennzeichnung, undefined, 'nichts entschieden -> keine Jev-Kennzeichnung');
  assert.match(r.naechster_schritt, /4 neue Optionen/);
  assert.match(r.naechster_schritt, /verworfen/);
  assert.match(r.naechster_schritt, /runde 2/);
  assert.match(r.naechster_schritt, /erste_id/);
  assert.match(r.naechster_schritt, /letzte_runde/);
  assert.ok(r.protokoll_id > 0);
  assert.equal(r.erste_id, r.protokoll_id);
  const z = zeilen[0];
  assert.equal(z.grund, 'weitere');
  assert.equal(z.wahl, 'weitere');
  assert.equal(z.entschieden, false);
  assert.equal(z.runde, 1);
  assert.equal(z.erste_id, z.id);
  assert.equal(z.offen_fuer_user, false);
  assert.equal(z.jev_aufruf, true);
});

await pruefe('weitere unter dem Tor: normale unsicher-Antwort mit tipp, kein weiter', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'weitere', confidence: 0.5 } });
  const r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.grund, 'unsicher');
  assert.equal(r.weiter, undefined);
  assert.match(r.tipp, /trennschaerfer/);
});

await pruefe('Runde 2: verworfen + runde im state und in den Anweisungen; Zeile traegt runde und erste_id der Kette', async () => {
  reset();
  await einschalten();
  antwortFuer = WEITERE_WAEHLEN;
  const r1 = await mod.entscheideRueckfrage(P, frage(), deps);
  const verworfen = ['a', 'b', 'c', 'd'].map((k) => ({ key: k, beschreibung: OPT5[k] }));
  const neu = {
    n1: 'Neue Variante 1: Adapter davor, richtig wenn die Schnittstelle stabil bleiben muss',
    n2: 'Neue Variante 2: Feature-Toggle pro Projekt, richtig wenn nur ein Projekt betroffen ist',
    n3: 'Neue Variante 3: Migration in zwei Schritten, richtig wenn Ausfallzeit nicht erlaubt ist',
    n4: 'Neue Variante 4: nichts aendern und dokumentieren, richtig wenn der Nutzen klein ist',
    weitere: 'x',
  };
  fetchAufrufe = [];
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'n3', confidence: 0.85 } });
  const r2 = await mod.entscheideRueckfrage(P, frage({ optionen: neu, runde: 2, verworfen, erste_id: r1.erste_id }), deps);
  assert.equal(r2.success, true, r2.message);
  assert.equal(r2.entschieden, true);
  assert.equal(r2.wahl, 'n3');
  const { body } = fetchAufrufe[0];
  assert.equal(body.state.runde, 2);
  assert.deepEqual(body.state.verworfen.map((v) => v.key), ['a', 'b', 'c', 'd']);
  assert.match(body.questions.entscheidung.instructions, /state\.verworfen/);
  const z = zeilen[1];
  assert.equal(z.runde, 2);
  assert.equal(z.erste_id, r1.erste_id);
  assert.equal(z.entschieden, true);
});

await pruefe('verworfene Optionen duerfen nicht wiederkommen (Key oder Beschreibung) -> Fehler, kein Jev-Aufruf', async () => {
  reset();
  await einschalten();
  antwortFuer = WEITERE_WAEHLEN;
  const r1 = await mod.entscheideRueckfrage(P, frage(), deps);
  fetchAufrufe = [];
  const verworfen = [{ key: 'a', beschreibung: OPT5.a }];
  const basisNeu = {
    n1: 'Neue Variante 1: Adapter davor, richtig wenn die Schnittstelle stabil bleiben muss',
    n2: 'Neue Variante 2: Feature-Toggle pro Projekt, richtig wenn nur ein Projekt betroffen ist',
    n3: 'Neue Variante 3: Migration in zwei Schritten, richtig wenn Ausfallzeit nicht erlaubt ist',
    n4: 'Neue Variante 4: nichts aendern und dokumentieren, richtig wenn der Nutzen klein ist',
    weitere: 'x',
  };
  let r = await mod.entscheideRueckfrage(P, frage({ optionen: { ...ohne(basisNeu, 'n4'), a: 'Ganz anderer Text fuer alten Key, richtig wenn Zeit knapp ist' }, runde: 2, verworfen, erste_id: r1.erste_id }), deps);
  assert.equal(r.success, false);
  assert.match(r.message, /verworfen/);
  assert.match(r.message, /"a"/);
  r = await mod.entscheideRueckfrage(P, frage({ optionen: { ...ohne(basisNeu, 'n4'), n4: OPT5.a }, runde: 2, verworfen, erste_id: r1.erste_id }), deps);
  assert.equal(r.success, false);
  assert.match(r.message, /verworfen/);
  assert.match(r.message, ANLEITUNG);
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('Kette: ab Runde 2 ist erste_id Pflicht und muss im Projekt existieren; runde muss ganze Zahl >= 1 sein', async () => {
  reset();
  await einschalten();
  let r = await mod.entscheideRueckfrage(P, frage({ runde: 2 }), deps);
  assert.equal(r.success, false);
  assert.match(r.message, /erste_id/);
  r = await mod.entscheideRueckfrage(P, frage({ runde: 2, erste_id: 999 }), deps);
  assert.equal(r.success, false);
  assert.match(r.message, /999/);
  for (const runde of [0, -1, 1.5, 'x']) {
    r = await mod.entscheideRueckfrage(P, frage({ runde }), deps);
    assert.equal(r.success, false, String(runde));
    assert.match(r.message, /runde/);
  }
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('letzte_runde: weitere verboten, 2-5 echte Optionen erlaubt, kein weitere im Jev-Aufruf', async () => {
  reset();
  await einschalten();
  let r = await mod.entscheideRueckfrage(P, frage({ letzte_runde: true }), deps);
  assert.equal(r.success, false, 'weitere in der letzten Runde');
  assert.match(r.message, /weitere/);
  assert.match(r.message, /letzte_runde/);
  for (const optionen of [nurKeys('a', 'b'), nurKeys('a', 'b', 'c', 'd'), { ...nurKeys('a', 'b', 'c', 'd'), e: 'Variante E: fuenfte echte Option, richtig wenn Zeit knapp ist' }]) {
    fetchAufrufe = [];
    antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.8 } });
    r = await mod.entscheideRueckfrage(P, frage({ optionen, letzte_runde: true }), deps);
    assert.equal(r.success, true, r.message);
    assert.equal(r.entschieden, true);
    assert.ok(!('weitere' in fetchAufrufe[0].body.questions.entscheidung.criteria));
  }
  r = await mod.entscheideRueckfrage(P, frage({ optionen: nurKeys('a'), letzte_runde: true }), deps);
  assert.equal(r.success, false, 'mindestens 2');
});

await pruefe('letzte_runde unsicher: KEIN Blocker — offen_fuer_user in der Zeile, naechster_schritt (Fall a) mit Task-auf-todo und anderer Task', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.5 } });
  const r = await mod.entscheideRueckfrage(P, frage({ optionen: nurKeys('a', 'b', 'c', 'd'), letzte_runde: true, task_id: 'P7-T31' }), deps);
  assert.equal(r.entschieden, false);
  assert.equal(r.offen_fuer_user, true);
  assert.equal(r.blocker, false);
  assert.match(r.naechster_schritt, /Notiz an den User ist im Protokoll/);
  assert.match(r.naechster_schritt, /todo/);
  assert.match(r.naechster_schritt, /update_task/);
  assert.match(r.naechster_schritt, /passende_tasks/);
  assert.match(r.naechster_schritt, /Nicht warten/);
  assert.equal(zeilen[0].offen_fuer_user, true);
  assert.equal(zeilen[0].blocker, false);
});

await pruefe('blocker:true (Fall b): Einsprung Koordinator — Channel-Frage + cc-send, Zeile blocker:true, kein Warten auf User', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.5 } });
  const r = await mod.entscheideRueckfrage(P, frage({ optionen: nurKeys('a', 'b'), letzte_runde: true, blocker: true }), deps);
  assert.equal(r.offen_fuer_user, true);
  assert.equal(r.blocker, true);
  assert.match(r.naechster_schritt, /KOORDINATOR/);
  assert.match(r.naechster_schritt, /Channel/);
  assert.match(r.naechster_schritt, /cc-send/);
  assert.ok(!/passende_tasks/.test(r.naechster_schritt), 'im Blocker-Fall keine andere Task');
  assert.equal(zeilen[0].blocker, true);
  assert.equal(zeilen[0].offen_fuer_user, true);
});

await pruefe('keine_plausible_option:true: ohne Jev-Aufruf und ohne optionen offen_fuer_user protokolliert (Fall a/b je nach blocker)', async () => {
  reset();
  await einschalten();
  const basis = { agent_id: 'plan-specht', frage: 'Wie binden wir das ein?', typ: 'choice', kategorie: 'umsetzungsweg', keine_plausible_option: true, task_id: 'P7-T31' };
  let r = await mod.entscheideRueckfrage(P, basis, deps);
  assert.equal(r.success, true, r.message);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'keine_plausible_option');
  assert.equal(r.offen_fuer_user, true);
  assert.equal(r.blocker, false);
  assert.match(r.naechster_schritt, /Notiz an den User ist im Protokoll/);
  assert.equal(fetchAufrufe.length, 0);
  r = await mod.entscheideRueckfrage(P, { ...basis, blocker: true }, deps);
  assert.equal(r.blocker, true);
  assert.match(r.naechster_schritt, /KOORDINATOR/);
  assert.equal(zeilen.length, 2);
  assert.ok(zeilen.every((z) => z.offen_fuer_user === true && z.jev_aufruf === false));
  assert.equal(zeilen[1].blocker, true);
  // Schalter aus -> wie immer nichts protokollieren
  reset();
  r = await mod.entscheideRueckfrage(P, basis, deps);
  assert.equal(r.grund, 'schalter_aus');
  assert.equal(zeilen.length, 0);
});

await pruefe('Rundengrenze: Standard 4 (Env JEV_MAX_RUNDEN); Grenzrunde nur mit letzte_runde; darueber max_runden ohne Jev-Aufruf', async () => {
  reset();
  await einschalten();
  const kette = await mod.entscheideRueckfrage(P, frage(), deps);
  const erste = kette.protokoll_id;
  fetchAufrufe = [];
  let r = await mod.entscheideRueckfrage(P, frage({ runde: 4, erste_id: erste }), deps);
  assert.equal(r.success, false, 'Runde == Grenze braucht letzte_runde');
  assert.match(r.message, /letzte_runde/);
  assert.equal(fetchAufrufe.length, 0);
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.9 } });
  r = await mod.entscheideRueckfrage(P, frage({ optionen: nurKeys('a', 'b'), runde: 4, erste_id: erste, letzte_runde: true }), deps);
  assert.equal(r.entschieden, true, r.message);
  fetchAufrufe = [];
  r = await mod.entscheideRueckfrage(P, frage({ runde: 5, erste_id: erste }), deps);
  assert.equal(r.success, true);
  assert.equal(r.entschieden, false);
  assert.equal(r.grund, 'max_runden');
  assert.equal(r.offen_fuer_user, true);
  assert.match(r.message, /Rundengrenze/);
  assert.match(r.message, /OFFENE FRAGE/);
  assert.equal(fetchAufrufe.length, 0);
  assert.equal(zeilen.at(-1).grund, 'max_runden');
  assert.equal(zeilen.at(-1).offen_fuer_user, true);
  process.env.JEV_MAX_RUNDEN = '2';
  r = await mod.entscheideRueckfrage(P, frage({ runde: 2, erste_id: erste }), deps);
  assert.equal(r.success, false, 'Env: Grenzrunde 2 braucht letzte_runde');
  r = await mod.entscheideRueckfrage(P, frage({ runde: 3, erste_id: erste }), deps);
  assert.equal(r.grund, 'max_runden');
  assert.equal(mod.STANDARD_MAX_RUNDEN, 4);
});

await pruefe('Protokoll: Runde/erste_id/offen_fuer_user je Eintrag, Ketten zusammenhaengend, offene_fragen gesondert oben', async () => {
  reset();
  await einschalten();
  antwortFuer = WEITERE_WAEHLEN;
  const r1 = await mod.entscheideRueckfrage(P, frage({ task_id: 'P7-T31' }), deps);
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.4 } });
  await mod.entscheideRueckfrage(P, frage({ optionen: nurKeys('a', 'b'), letzte_runde: true, runde: 2, erste_id: r1.erste_id, task_id: 'P7-T31' }), deps);
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'b', confidence: 0.95 } });
  await mod.entscheideRueckfrage(P, frage({ task_id: 'P7-T99' }), deps);
  const p = await mod.holeEntscheidungsProtokoll(P, {});
  assert.equal(p.success, true);
  assert.equal(p.anzahl, 3);
  for (const e of p.eintraege) {
    assert.ok(Number.isInteger(e.runde));
    assert.ok(e.erste_id !== undefined);
    assert.equal(typeof e.offen_fuer_user, 'boolean');
  }
  assert.equal(p.offene_fragen.length, 1);
  assert.equal(p.offene_fragen[0].erste_id, r1.erste_id);
  assert.equal(p.offene_fragen[0].runden, 2);
  assert.equal(p.offene_fragen[0].task_id, 'P7-T31');
  assert.equal(p.ketten.length, 2);
  const k = p.ketten.find((x) => x.erste_id === r1.erste_id);
  assert.deepEqual(k.eintraege.map((e) => e.runde), [1, 2], 'Runden aufsteigend in der Kette');
  assert.equal(p.ketten[0].erste_id, r1.erste_id, 'Ketten nach erster Frage sortiert');
  const aus = await mod.setzeAbwesenheit(P, { modus: 'aus', agent_id: 'koordinator' });
  assert.equal(aus.offene_fragen.length, 1, 'bin wieder da: offene Fragen stehen oben');
  assert.equal(aus.protokoll.length, 3);
});

await pruefe('SCHEMA_SQL: runde, erste_id, offen_fuer_user, blocker als ADD COLUMN IF NOT EXISTS (und in CREATE TABLE)', async () => {
  const { readFile } = await import('node:fs/promises');
  const schema = await readFile(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  for (const spalte of ['runde', 'erste_id', 'offen_fuer_user', 'blocker']) {
    assert.match(schema, new RegExp(`ALTER TABLE jev_entscheidungen ADD COLUMN IF NOT EXISTS ${spalte} `), spalte);
  }
});

await pruefe('Tool-Schemas (REST + stdio) kennen runde, verworfen, letzte_runde, erste_id, keine_plausible_option, blocker', async () => {
  const { readFile } = await import('node:fs/promises');
  const rest = await readFile(new URL('../packages/rest-api/dist/routes/mcp.js', import.meta.url), 'utf8');
  const stdio = await readFile(new URL('../packages/mcp-server/dist/tools/consolidated/jev.js', import.meta.url), 'utf8');
  for (const [name, src] of [['REST', rest], ['stdio', stdio]]) {
    for (const p of ['runde:', 'verworfen:', 'letzte_runde:', 'erste_id:', 'keine_plausible_option:', 'blocker:']) {
      assert.ok(src.includes(p), `${name}: ${p}`);
    }
  }
});

await pruefe('Guide jev: Vorgehen mit 5 Optionen/weitere/Runden, Vorlage "Was Jev bekommt", Schluss (a) kein Blocker und (b) Blocker', async () => {
  const { TOOL_GUIDES } = await import('../packages/core/dist/guide/content.js');
  const t = (TOOL_GUIDES.jev.workflow_examples ?? []).join('\n');
  for (const wort of ['weitere', 'verworfen', 'letzte_runde', 'erste_id', 'runde', 'Was Jev bekommt', 'Tech-Stack', 'geplant', 'Randbedingungen', 'offen_fuer_user', 'blocker', 'todo', 'passende_tasks', 'cc-send', 'KOORDINATOR', 'keine_plausible_option']) {
    assert.ok(t.includes(wort), `Abschnitt nennt ${wort}`);
  }
  assert.match(t, /kein Code/i);
});

// 6b. Hilfreiche Fehler statt nacktem 'geht nicht' (P7-T30 Ergaenzung) -------------------------

await pruefe('choice: Ein-Wort-/leere/nur-Key-Beschreibungen -> success:false mit Key-Nennung und Verweis auf guide(jev) Vorgehen', async () => {
  reset();
  await einschalten();
  for (const [name, optionen, key] of [
    ['ein Wort', { a: 'Variante A: kleiner Umbau mit wenig Risiko', b: 'schnell' }, 'b'],
    ['leer', { a: 'Variante A: kleiner Umbau mit wenig Risiko', b: '   ' }, 'b'],
    ['nur der Key', { a: 'a', b: 'Variante B: neuer Service, wenn viele Aufrufer' }, 'a'],
  ]) {
    const r = await mod.entscheideRueckfrage(P, frage({ optionen }), deps);
    assert.equal(r.success, false, name);
    assert.equal(r.entschieden, false, name);
    assert.match(r.message, new RegExp(`"${key}"`), `${name}: nennt den Key`);
    assert.match(r.message, /WANN|wann/, `${name}: sagt, was fehlt (wann ist die Option richtig)`);
    assert.match(r.message, ANLEITUNG, `${name}: Verweis auf guide(jev) Vorgehen`);
  }
  assert.equal(fetchAufrufe.length, 0, 'kein Jev-Aufruf bei schlechter Eingabe');
  assert.equal(zeilen.length, 0, 'keine Protokollzeile bei Eingabefehlern');
});

await pruefe('choice ohne optionen / mit zu wenigen -> Fehler mit Anleitung und Hinweis auf 2..5 Optionen', async () => {
  reset();
  await einschalten();
  for (const optionen of [undefined, {}, { a: 'Variante A: kleiner Umbau mit wenig Risiko' }]) {
    const r = await mod.entscheideRueckfrage(P, frage({ optionen }), deps);
    assert.equal(r.success, false);
    assert.match(r.message, /optionen/);
    assert.match(r.message, ANLEITUNG);
  }
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('offene W-Frage als noul -> Fehler: noul braucht eine Aussage, wahr oder falsch', async () => {
  reset();
  await einschalten();
  const basis = { agent_id: 'a', typ: 'noul', kategorie: 'umsetzungsweg' };
  for (const f of ['Wie soll ich den Endpunkt bauen?', 'Welche Variante ist besser?', 'Warum bricht der Test?']) {
    const r = await mod.entscheideRueckfrage(P, { ...basis, frage: f }, deps);
    assert.equal(r.success, false, f);
    assert.match(r.message, /Aussage|wahr oder falsch/, f);
    assert.match(r.message, ANLEITUNG, f);
  }
  assert.equal(fetchAufrufe.length, 0);
  // Gegenprobe: klare Aussage / Ja-Nein-Frage geht durch
  antwortFuer = () => ({ entscheidung: { type: 'noul', noul: 0.9 } });
  let r = await mod.entscheideRueckfrage(P, { ...basis, frage: 'Die Aenderung bricht keine alten Aufrufe.' }, deps);
  assert.equal(r.success, true, r.message);
  r = await mod.entscheideRueckfrage(P, { ...basis, frage: 'Soll ich Tests ergaenzen?' }, deps);
  assert.equal(r.success, true, r.message);
});

await pruefe('W-Frage als choice MIT guten Optionen bleibt erlaubt', async () => {
  reset();
  await einschalten();
  const r = await mod.entscheideRueckfrage(P, frage({ frage: 'Welche Variante nehmen wir fuer den Endpunkt?' }), deps);
  assert.equal(r.success, true, r.message);
  assert.equal(r.entschieden, true);
});

await pruefe('unsicher: Antwort enthaelt den Tipp (Optionen trennschaerfer beschreiben / Kontext ergaenzen), choice und noul', async () => {
  reset();
  await einschalten();
  antwortFuer = () => ({ entscheidung: { type: 'choice', choice: 'a', confidence: 0.55 } });
  let r = await mod.entscheideRueckfrage(P, frage(), deps);
  assert.equal(r.grund, 'unsicher');
  assert.match(r.tipp, /trennschaerfer/);
  assert.match(r.tipp, /Kontext/);
  assert.match(r.tipp, /einmal|EINMAL/);
  assert.match(r.message, /User\/Koordinator fragen/);
  antwortFuer = () => ({ entscheidung: { type: 'noul', noul: 0.5 } });
  r = await mod.entscheideRueckfrage(P, { agent_id: 'a', frage: 'Soll ich Tests ergaenzen?', typ: 'noul', kategorie: 'umsetzungsweg' }, deps);
  assert.equal(r.grund, 'unsicher');
  assert.match(r.tipp, /trennschaerfer/);
  // andere Ablehnungen tragen KEINEN Tipp
  r = await mod.entscheideRueckfrage(P, frage({ kategorie: 'deploy' }), deps);
  assert.equal(r.grund, 'kategorie_verboten');
  assert.equal(r.tipp, undefined);
});

await pruefe('Guide jev: Abschnitt "Vorgehen Schritt fuer Schritt" mit 6 Schritten, gutem und schlechtem Beispiel', async () => {
  const { TOOL_GUIDES } = await import('../packages/core/dist/guide/content.ts'.replace('.ts', '.js'));
  const g = TOOL_GUIDES.jev;
  const abschnitt = (g.workflow_examples ?? []).join('\n');
  assert.match(abschnitt, /Vorgehen Schritt fuer Schritt/);
  for (let i = 1; i <= 6; i++) assert.match(abschnitt, new RegExp(`(^|\\n)\\s*${i}\\.`), `Schritt ${i}`);
  for (const wort of ['brainstorming', 'writing-plans', 'WANN', 'kontext', 'kategorie', '0.7', 'einmal', 'GUTES BEISPIEL', 'SCHLECHTES BEISPIEL']) {
    assert.ok(abschnitt.toLowerCase().includes(wort.toLowerCase()), `Abschnitt nennt ${wort}`);
  }
  assert.match(abschnitt, /wahr oder falsch/);
  assert.match(abschnitt, /Anker/);
});

// 7. Guide-Eintrag + Onboarding-Hinweis (Nachzug 29.09.) --------------------------------------
await pruefe('Guide: TOOL_GUIDES.jev mit allen 4 Actions, Leitplanken und Beispiel', async () => {
  const { TOOL_GUIDES } = await import('../packages/core/dist/guide/content.js');
  const g = TOOL_GUIDES.jev;
  assert.ok(g, 'Eintrag jev fehlt');
  assert.ok(g.summary && g.when_to_use, 'summary/when_to_use');
  assert.deepEqual(Object.keys(g.actions ?? {}).sort(), ['abwesend', 'entscheiden', 'protokoll', 'ueberstimmen']);
  for (const a of Object.values(g.actions)) assert.ok(a.description && a.params && a.example, 'Action unvollstaendig');
  const text = JSON.stringify(g);
  for (const k of mod.VERBOTENE_KATEGORIEN) assert.ok(text.includes(k), `Leitplanke ${k} fehlt im Guide`);
  for (const k of mod.ERLAUBTE_KATEGORIEN) assert.ok(text.includes(k), `Kategorie ${k} fehlt im Guide`);
  assert.ok(text.includes('0.7'), 'Confidence-Tor fehlt');
  assert.ok((g.examples ?? []).length > 0, 'Beispiel fehlt');
});

await pruefe('Onboarding-Hinweis: nur bei aktivem Schalter, sonst undefined', async () => {
  reset();
  assert.equal(typeof core.baueAbwesenheitsHinweis, 'function', 'baueAbwesenheitsHinweis nicht exportiert');
  assert.equal(await core.baueAbwesenheitsHinweis(P), undefined, 'Schalter aus -> kein Hinweis');
  await einschalten();
  const h = await core.baueAbwesenheitsHinweis(P);
  assert.match(h, /^User abwesend — Jev entscheidet erlaubte R/);
  assert.match(h, /jev\(entscheiden\)/);
  assert.match(h, /warten weiter/);
  await mod.setzeAbwesenheit(P, { modus: 'aus', agent_id: 'koordinator' });
  assert.equal(await core.baueAbwesenheitsHinweis(P), undefined, 'wieder aus -> kein Hinweis');
});

await pruefe('Onboarding-Hinweis: DB-Fehler bricht das Onboarding nicht (undefined)', async () => {
  reset();
  const alt = pg.Pool.prototype.query;
  pg.Pool.prototype.query = async () => { throw new Error('db weg'); };
  try {
    assert.equal(await core.baueAbwesenheitsHinweis(P), undefined);
  } finally {
    pg.Pool.prototype.query = alt;
  }
});

await pruefe('Onboarding: beide Strecken (stdio + REST) binden den Hinweis ein', async () => {
  const { readFile } = await import('node:fs/promises');
  const stdio = await readFile(new URL('../packages/mcp-server/dist/tools/onboarding.js', import.meta.url), 'utf8');
  const rest = await readFile(new URL('../packages/rest-api/dist/routes/mcp.js', import.meta.url), 'utf8');
  assert.match(stdio, /baueAbwesenheitsHinweis/);
  assert.match(rest, /baueAbwesenheitsHinweis/);
  assert.match(stdio, /jev_hinweis/);
  assert.match(rest, /jev_hinweis/);
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
