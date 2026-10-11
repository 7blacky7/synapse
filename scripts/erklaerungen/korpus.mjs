// P15-T33 E0 (M1): Korpus aus echten Dateien (PG, NUR LESEND) mit Mutationen je Fehlerklasse + echten Modellfehlern.
// Aus dem E0-Scratchpad uebernommen (thought 1486172c), Ausgabeordner jetzt als Argument.
// Aufruf: node scripts/erklaerungen/korpus.mjs <ausgabe-ordner> [gemma-ordner]
//   DATABASE_URL = Datenbank mit code_files (read-only Sitzung); core vorher bauen (Syntaxpruefer-Katalog aus dist).
// Ergebnis: <ausgabe-ordner>/situationen.json - ENTHAELT DATEIINHALTE (_alt/_neu) und gehoert NICHT ins Repo.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2];
const GEMMA = process.argv[3] ?? null;
if (!OUT) { console.error('Aufruf: node scripts/erklaerungen/korpus.mjs <ausgabe-ordner> [gemma-ordner]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const pg = createRequire(path.join(ROOT, 'packages/core/package.json'))('pg');
const K = await import(path.join(ROOT, 'packages/core/dist/services/syntax-pruefer/katalog.js'));

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(4711);
const pick = (arr) => arr[Math.floor(R() * arr.length)];

const KAT = K.katalog();
function prueferFuer(p) { const e = p.split('.').pop().toLowerCase(); return KAT.find((d) => d.endungen.includes(e)); }
async function pruefe(inhalt, p) { const d = prueferFuer(p); if (!d) return null; try { return await d.pruefe(inhalt, p); } catch (e) { return [{ zeile: 1, meldung: 'Pruefer-Ausnahme: ' + e.message }]; } }

// ---------- Mutationen: lines -> lines | null ----------
const idx = (L, re, f = () => true) => L.map((l, i) => (re.test(l) && f(i) ? i : -1)).filter((i) => i >= 0);
const M = {
  K1: (L) => { const c = idx(L, /^\s*\}\s*$/, (i) => i < L.length - 2 && i > 3); if (!c.length) return null; const i = pick(c); return [...L.slice(0, i), ...L.slice(i + 1)]; },
  K2: (L) => { const c = idx(L, /^\s*\}\s*$/, (i) => i < L.length - 3 && i > 3); if (!c.length) return null; const i = pick(c); return [...L.slice(0, i + 1), L[i], ...L.slice(i + 1)]; },
  K3: (L) => { const c = idx(L, /^\s+[A-Za-z_$][\w$]*\s*:\s*\S.*,\s*$/, (i) => /^\s+[A-Za-z_$][\w$]*\s*:\s*\S/.test(L[i + 1] ?? '')); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/,\s*$/, ''); return n; },
  K4: (L) => { const c = idx(L, /'[^'\\\n]{3,}'/, (i) => !/^\s*(\/\/|\*)/.test(L[i])); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/'([^'\\\n]{3,})'/, (_m, x) => "'" + x); return n; },
  K5: (L) => { const c = idx(L, /\basync\s+(function\b|\(|[A-Za-z_$][\w$]*\s*\()/, (i) => L.slice(i, i + 40).some((x) => /\bawait\b/.test(x))); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/\basync\s+/, ''); return n; },
  K6: (L) => { const c = idx(L, /^import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\s*$/); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/^import\s+(\{[^}]+\})\s+from\s+(['"][^'"]+['"]);?/, (_m, a, b) => `import ${a} = require(${b});`); return n; },
  K7: (L) => { const c = idx(L, /\S/, (i) => i > 5 && i < L.length - 5); if (!c.length) return null; const i = pick(c); return [...L.slice(0, i), '<<<<<<< HEAD', L[i], '=======', L[i].replace(/\S.*$/, (s) => s + ' // alt'), '>>>>>>> feature', ...L.slice(i + 1)]; },
  K8: (L) => { const c = idx(L, /^\s+[A-Za-z_$][\w$]*\s*:\s*\S.*,\s*$/, (i) => /^\s+[A-Za-z_$][\w$]*\s*:/.test(L[i + 1] ?? '')); if (!c.length) return null; const i = pick(c); const ind = L[i].match(/^\s*/)[0]; return [...L.slice(0, i + 1), ind + 'function hilfsWert() { return 1; }', ...L.slice(i + 1)]; },
  K9: (L) => { const c = idx(L, /\w\([^()\n]*\);\s*$/); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/\);\s*$/, ';'); return n; },
  K10: (L) => { const c = idx(L, /=\s*'[^'\\\n]{2,}'/); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/=\s*'([^'\\\n]{2,})'/, (_m, x) => '= \\"' + x + '\\"'); return n; },
  K11: (L) => { const nz = L.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0); if (nz.length < 12) return null; const tail = nz.slice(-6)[0]; return [...L, ...L.slice(tail)]; },
  J1: (L) => { const c = idx(L, /^\s*"[^"]+"\s*:\s*[^,{[\s][^,]*$/, (i) => /^\s*\}/.test(L[i + 1] ?? '')); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i] + ','; return n; },
  J2: (L) => { const c = idx(L, /,\s*$/, (i) => /^\s*"/.test(L[i + 1] ?? '')); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/,\s*$/, ''); return n; },
  J3: (L) => { const c = idx(L, /^\s*"[^"]+"\s*:/); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/^(\s*)"([^"]+)"/, (_m, a, b) => `${a}'${b}'`); return n; },
  J4: (L) => { const c = idx(L, /,\s*$/, (i) => i > 1); if (!c.length) return null; const i = pick(c); const ind = (L[i + 1] ?? '').match(/^\s*/)[0]; return [...L.slice(0, i + 1), ind + '// Hinweis: Wert pruefen', ...L.slice(i + 1)]; },
  S1: (L) => { const c = idx(L, /^\s*(CREATE|ALTER|INSERT|SELECT|UPDATE)\b/i); if (!c.length) return null; const i = pick(c); return [...L.slice(0, i), '// Aenderung fuer neue Spalte', ...L.slice(i)]; },
  S2: (L) => { const c = idx(L, /\S/, (i) => /^\s*\)\s*;/.test(L[i + 1] ?? '') && !/[,(]\s*$/.test(L[i]) && !/^\s*--/.test(L[i])); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i] + ','; return n; },
  S3: (L) => { const c = idx(L, /^\s+[a-z_][\w]*\s+[A-Za-z]+.*,\s*$/, (i) => /^\s+[a-z_][\w]*\s+[A-Za-z]/.test(L[i + 1] ?? '')); if (!c.length) return null; const i = pick(c); const n = [...L]; n[i] = n[i].replace(/,\s*$/, ''); return n; },
};
const FAMILIE = { K: 'ts', J: 'json', S: 'sql' };
const ENDUNGEN = { ts: ['ts'], json: ['json'], sql: ['sql'] };
const ZIEL_JE_KLASSE = 6;

// ---------- Quelle: echte Dateien aus PG (read-only) ----------
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
await c.query("SET statement_timeout='30s'");
await c.query('SET default_transaction_read_only=on');
const dateien = {};
for (const [fam, ends] of Object.entries(ENDUNGEN)) {
  const r = await c.query(
    `SELECT file_path, content FROM code_files WHERE project='synapse' AND deleted_at IS NULL AND coalesce(ignored,false)=false
       AND file_type = ANY($1) AND length(content) BETWEEN 800 AND 40000
       AND file_path NOT LIKE '%node_modules%' AND file_path NOT LIKE '%/dist/%' AND file_path NOT LIKE '%fixture%'
       AND file_path NOT LIKE '%testkorpus%' AND file_path NOT LIKE '%tsconfig%' AND file_path NOT LIKE '%.env%'
     ORDER BY md5(file_path) LIMIT 120`, [ends]);
  dateien[fam] = r.rows;
}
await c.end();

// ---------- Hilfen (Ausschnitte wie E0; der Dienst baut sie in E1 selbst: erklaerungen.baueSchatten) ----------
function diffBereich(a, b) { let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++; let ea = a.length - 1, eb = b.length - 1; while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; } return { s, ea, eb }; }
const meldungsKlasse = (m) => String(m ?? '').replace(/'[^']{2,}'/g, "'<X>'").replace(/"[^"]{2,}"/g, '"<X>"').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 120);
const schluessel = (fam, m) => `syntax|${fam}|${m.code ?? meldungsKlasse(m.meldung)}`;

async function baueSituation({ id, klasse, fam, pfad, alt, neu, quelle }) {
  const vorBef = alt === null ? [] : await pruefe(alt, pfad);
  const nachBef = await pruefe(neu, pfad);
  if (nachBef === null || !nachBef.length) return { verworfen: 'kein_befund' };
  if (vorBef && vorBef.length) return { verworfen: 'altlast_im_original' };
  const m = nachBef[0];
  const d = alt === null ? { s: 0 } : diffBereich(alt.split('\n'), neu.split('\n'));
  return {
    id, klasse, fam, quelle, endung: pfad.split('.').pop(),
    fehler: { code: m.code ?? null, meldung: m.meldung, zeile: m.zeile ?? null, spalte: m.spalte ?? null, anzahl: nachBef.length },
    schluessel: schluessel(fam, m), meldungsklasse: meldungsKlasse(m.meldung), erste_aenderung: d.s + 1,
    zeilen_gesamt: neu.split('\n').length,
    _alt: alt, _neu: neu, _pfad: pfad,
  };
}

const situationen = [];
const verworfen = {};
for (const klasse of Object.keys(M)) {
  const fam = FAMILIE[klasse[0]];
  let n = 0;
  for (const f of dateien[fam]) {
    if (n >= ZIEL_JE_KLASSE) break;
    const neuL = M[klasse](f.content.split('\n'));
    if (!neuL) continue;
    const s = await baueSituation({ id: `${klasse}-${n}`, klasse, fam, pfad: f.file_path, alt: f.content, neu: neuL.join('\n'), quelle: 'mutation' });
    if (s.verworfen) { verworfen[`${klasse}:${s.verworfen}`] = (verworfen[`${klasse}:${s.verworfen}`] ?? 0) + 1; continue; }
    situationen.push(s); n++;
  }
}
// echte Modellfehler (gemma-Korpus, optional)
const GEMMA_GOLD = { 'javascript_1.mjs': 'K5', 'javascript_4.mjs': 'K6', 'json_1.json': 'J2', 'json_4.json': 'X_escape', 'typescript_3.ts': 'X_erfunden' };
if (GEMMA) {
  for (const [datei, klasse] of Object.entries(GEMMA_GOLD)) {
    const p = path.join(GEMMA, datei);
    if (!fs.existsSync(p)) continue;
    const fam = datei.endsWith('.json') ? 'json' : 'ts';
    const s = await baueSituation({ id: `G-${datei}`, klasse, fam, pfad: p, alt: null, neu: fs.readFileSync(p, 'utf8'), quelle: 'gemma' });
    if (s.verworfen) { verworfen[`G:${datei}:${s.verworfen}`] = 1; continue; }
    situationen.push(s);
  }
}
fs.writeFileSync(path.join(OUT, 'situationen.json'), JSON.stringify(situationen, null, 1));
console.log('SITUATIONEN', situationen.length, 'VERWORFEN', JSON.stringify(verworfen));
