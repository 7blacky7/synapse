// P15-T33 E1: Messung der Jev-Sprache (en | de | mix) am E0-Korpus - ueber den ECHTEN Dienst (erklaerungen.ts:
// baueSchatten = State V3, waehleErklaerung = Kriterien + Jev-Client mit Schalter/Budget/Kosten).
// Ablage = je bekannter Klasse die erste Mutations-Instanz (wie E0), Test = Rest (bekannt + 'keine'-Faelle).
// Kandidaten = Gold-Erklaerungen derselben Pruefer-Familie (gemischt wie E0). Tor 0,7 (JEV_ERKLAERUNG_TOR).
//
// AUFRUF (core gebaut, Test-DB gesetzt):
//   set -a; . <test-db.env>; set +a
//   node scripts/erklaerungen/messung-sprache.mjs <situationen.json> <ausgabe-ordner> [--mock] [--sprachen en,de,mix] [--deckel 0.09] [--limit N]
// --mock: Fake-fetch (waehlt das Gold-Kriterium, Confidence 0,9) - prueft nur den Ablauf, keine Qualitaet, kostet nichts.
// Ohne --mock: echte Jev-Aufrufe. Key aus JEV_OPENROUTER_API_KEY oder ~/dev/JEV-Test/.env (OPENROUTER_API_KEY); nie
// ausgegeben. Kostendeckel (Standard 0,09 USD) ueber die gebuchten Kosten; 400 ms Abstand. Fortsetzbar (jsonl).
// NUR gegen die Test-DB (...:5433/synapse_test): Jev-Client bucht jev_aufrufe (project zz-erklaerungen-messung).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ERKLAERUNGEN, FAMILIE } from './gold-erklaerungen.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const wert = (n, std) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : std; };
const [KORPUS, AUS] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--mock'].includes(args[i - 1])));
if (!KORPUS || !AUS) { console.error('Aufruf: messung-sprache.mjs <situationen.json> <ausgabe-ordner> [--mock] [--sprachen en,de,mix] [--deckel 0.09] [--limit N]'); process.exit(2); }
if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) { console.error('ABBRUCH: nur gegen die Test-DB (...:5433/synapse_test).'); process.exit(2); }
const MOCK = flag('--mock');
const SPRACHEN = wert('--sprachen', 'en,de,mix').split(',');
const DECKEL = Number(wert('--deckel', '0.09'));
const LIMIT = Number(wert('--limit', '1000000'));
const PROJEKT = 'zz-erklaerungen-messung';
fs.mkdirSync(AUS, { recursive: true });

if (!MOCK && !process.env.JEV_OPENROUTER_API_KEY) {
  const env = fs.readFileSync(path.join(os.homedir(), 'dev/JEV-Test/.env'), 'utf8');
  process.env.JEV_OPENROUTER_API_KEY = (env.match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
}
if (MOCK) process.env.JEV_OPENROUTER_API_KEY = 'sk-or-mock-messung';
if (!process.env.JEV_OPENROUTER_API_KEY) { console.error('kein Jev-Key'); process.exit(2); }
process.env.JEV_TIMEOUT_MS ??= '20000';
const KEY = process.env.JEV_OPENROUTER_API_KEY;
const ohneKey = (t) => String(t ?? '').split(KEY).join('<key>');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const E = await import(pathToFileURL(path.join(ROOT, 'packages/core/dist/services/erklaerungen.js')).href);
const db = await import(pathToFileURL(path.join(ROOT, 'packages/core/dist/db/client.js')).href);

const S = JSON.parse(fs.readFileSync(KORPUS, 'utf8'));
const ablage = {};
for (const s of S) if (ERKLAERUNGEN[s.klasse] && s.quelle === 'mutation' && !ablage[s.klasse]) ablage[s.klasse] = s;
const ablageIds = new Set(Object.values(ablage).map((s) => s.id));
const test = S.filter((s) => !ablageIds.has(s.id)).slice(0, LIMIT);
const famVon = (k) => ablage[k]?.fam;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function mische(arr, seed) { const r = rng(seed); const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const hash = (t) => [...t].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

function befundVon(s) {
  const z = s.fehler.zeile ?? 1;
  return {
    quelle: 'syntax', pruefer: `syntax:${FAMILIE[s.fam]}@messung`, severity: 'error', datei: `korpus/${s.id}.${s.endung}`,
    zeilen: [z, z], code: s.fehler.code ?? undefined, was: `Syntaxfehler${s.fehler.code ? ' ' + s.fehler.code : ''}: ${s.fehler.meldung}`, wo: [],
  };
}

/** Mock-fetch: waehlt das Kriterium, das die Lage der Gold-Erklaerung enthaelt (sonst keine). */
function mockFetch(gold) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const crit = body.questions.erklaerung.criteria;
    const g = ERKLAERUNGEN[gold];
    const k = g ? Object.keys(crit).find((x) => x !== 'keine' && (crit[x].includes(g.en.lage) || crit[x].includes(g.de.lage))) : null;
    const tokens = Math.round(JSON.stringify(body).length / 4);
    return new Response(JSON.stringify({ answers: { erklaerung: { choice: k ?? 'keine', confidence: 0.9 } }, usage: { input_tokens: tokens, output_tokens: 70 } }), { status: 200 });
  };
}

const ausgabe = path.join(AUS, `sprache${MOCK ? '-mock' : ''}.jsonl`);
let kosten = 0;
const erledigt = new Set();
if (fs.existsSync(ausgabe)) {
  for (const l of fs.readFileSync(ausgabe, 'utf8').trim().split('\n').filter(Boolean)) { const x = JSON.parse(l); kosten += x.usd ?? 0; erledigt.add(`${x.sid}|${x.sprache}`); }
}
let letzter = 0;
let aufrufe = 0;
try {
  for (const s of test) {
    const gold = ERKLAERUNGEN[s.klasse] ? s.klasse : 'keine';
    const befund = befundVon(s);
    const schatten = E.baueSchatten({ datei: befund.datei, befund, basis: s._alt ?? '', ergebnis: s._neu });
    for (const sprache of SPRACHEN) {
      if (erledigt.has(`${s.id}|${sprache}`)) continue;
      if (kosten >= DECKEL) { console.log('KOSTENDECKEL erreicht', kosten.toFixed(5)); throw new Error('deckel'); }
      const kand = mische(Object.keys(ERKLAERUNGEN).filter((k) => famVon(k) === s.fam), hash(s.id + sprache))
        .map((k) => ({ id: k, de: ERKLAERUNGEN[k].de, en: ERKLAERUNGEN[k].en }));
      if (!MOCK) { const w = letzter + 400 - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); letzter = Date.now(); }
      const r = await E.waehleErklaerung({ project: PROJEKT, agent_id: 'messung-sprache', schatten, kandidaten: kand, sprache }, MOCK ? { fetch: mockFetch(gold) } : {});
      if (r.jev.aufgerufen) aufrufe++;
      const usd = r.jev.usd ?? 0;
      kosten += usd;
      const zeile = { sid: s.id, klasse: s.klasse, fam: s.fam, quelle: s.quelle, sprache, gold, kandidaten: kand.length,
        wahl: r.jev.wahl === 'keine' ? 'keine' : (r.jev.erklaerung_id ?? (r.jev.wahl ? `?${r.jev.wahl}` : null)),
        confidence: r.jev.confidence ?? null, geliefert: r.gewaehlt?.id ?? null, usd, ms: r.jev.ms ?? null, grund: r.jev.grund ?? null,
        ...(r.jev.message ? { fehler: ohneKey(r.jev.message) } : {}) };
      fs.appendFileSync(ausgabe, JSON.stringify(zeile) + '\n');
      if (zeile.fehler) console.log('FEHLER', s.id, sprache, zeile.fehler);
    }
  }
} catch (err) {
  if (err.message !== 'deckel') throw err;
}

// ---------- Auswertung je Sprache ----------
const R = fs.readFileSync(ausgabe, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * p))] : null; };
const out = { mock: MOCK, test_n: test.length, aufrufe_dieser_lauf: aufrufe, kosten_usd_gesamt: +R.reduce((x, r) => x + (r.usd ?? 0), 0).toFixed(6), sprachen: {} };
for (const sprache of SPRACHEN) {
  const rv = R.filter((r) => r.sprache === sprache && !r.fehler);
  const bek = rv.filter((r) => r.gold !== 'keine');
  const fremd = rv.filter((r) => r.gold === 'keine');
  const tore = {};
  for (const t of [0.5, 0.7, 0.8]) {
    const gel = (r) => r.wahl && r.wahl !== 'keine' && !String(r.wahl).startsWith('?') && (r.confidence ?? 0) >= t;
    const g = rv.filter(gel);
    tore[t] = { praezision: pct(g.filter((r) => r.wahl === r.gold).length, g.length), abdeckung: pct(bek.filter((r) => gel(r) && r.wahl === r.gold).length, bek.length),
      schutz_keine: pct(fremd.filter((r) => !gel(r)).length, fremd.length), falsch_geliefert: g.filter((r) => r.wahl !== r.gold).length };
  }
  out.sprachen[sprache] = {
    n: rv.length, fehler: R.filter((r) => r.sprache === sprache && r.fehler).length,
    top1_ohne_tor: pct(bek.filter((r) => r.wahl === r.gold).length, bek.length),
    tore, usd_summe: +rv.reduce((x, r) => x + (r.usd ?? 0), 0).toFixed(6), usd_je_aufruf: +(rv.reduce((x, r) => x + (r.usd ?? 0), 0) / (rv.length || 1)).toFixed(7),
    ms_p50: q(rv.map((r) => r.ms).filter((x) => x != null), 0.5), ms_p95: q(rv.map((r) => r.ms).filter((x) => x != null), 0.95),
    fehlgriffe_07: rv.filter((r) => r.wahl && r.wahl !== 'keine' && (r.confidence ?? 0) >= 0.7 && r.wahl !== r.gold).map((r) => `${r.sid}->${r.wahl}(${r.confidence})`),
  };
}
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(AUS, `auswertung-sprache${MOCK ? '-mock' : ''}.json`), JSON.stringify(out, null, 1));
// Gebuchte Messaufrufe wieder aus jev_aufrufe der Test-DB entfernen: setzeJevBudget zaehlt die Monatssumme aus ALLEN
// Zeilen - liegengelassene Messkosten verfaelschen sonst andere Tests (jev-schalter.test.mjs B). Kosten stehen in der jsonl.
await db.getPool().query('DELETE FROM jev_aufrufe WHERE project = $1', [PROJEKT]).catch(() => {});
await db.getPool().end().catch(() => {});
process.exit(0);
