/**
 * P15 Nachtrunde B (11.10.2026): Entscheidungs-Topf E2 ohne Schema (Bezug E1-Bericht 2206e6d0 "Durchsicht-Zahl nicht
 * im Koordinator-Onboarding"). Vorbild: Zeile erklaerung_faelle aus dem Erklaerungs-Topf E2 (a08e83a3).
 *
 * ZUSAGEN:
 *   Z  Koordinator: "N autonome Entscheidungen zur Durchsicht (davon M ohne Praezedenz), jev(durchsicht)".
 *      N = dieselbe Menge wie jev(durchsicht) ohne urteil (entschieden, ohne Durchsicht, letzte 30 Tage).
 *      ANKER: die Testzeilen existieren (sonst waere "keine Zeile" in den Negativfaellen automatisch erfuellt).
 *   N  Keine Zeile: andere Rolle, Projekt ohne offene Durchsicht, nach Durchsicht aller Eintraege.
 *   R  REST (routes/mcp.ts) und stdio (tools/onboarding.ts) liefern das Feld entscheidungen_durchsicht.
 *
 * Nur synapse_test (sonst Exit 2). Testzeilen in Projekt zz-durchsicht-p15n, danach geloescht.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/entscheidung-durchsicht-zeile.test.mjs   (core vorher bauen)
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('entscheidung-durchsicht-zeile.test');
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', PARSER_LOOP_DISABLED: '1' });

const hier = dirname(fileURLToPath(import.meta.url));
const J = await import(pathToFileURL(join(hier, '..', 'dist', 'services', 'jev-entscheidung.js')).href);
const { getPool } = await import(pathToFileURL(join(hier, '..', 'dist', 'db', 'client.js')).href);

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 800) : '')); }
}

const PRJ = 'zz-durchsicht-p15n';
const pool = getPool();
const aufraeumen = () => pool.query('DELETE FROM jev_entscheidungen WHERE project = $1', [PRJ]);
const zeile = (o) => J.entscheidungsDurchsichtZeile(o);

try {
  await aufraeumen();
  const neu = (entschieden, ohne, durchsicht, tageAlt = 0) => pool.query(
    `INSERT INTO jev_entscheidungen (project, zeit, agent, kategorie, frage, typ, entschieden, ohne_praezedenz, durchsicht)
     VALUES ($1, NOW() - ($2::text || ' days')::interval, 'p15n-test', 'variante', 'Probefrage', 'choice', $3, $4, $5) RETURNING id`,
    [PRJ, String(tageAlt), entschieden, ohne, durchsicht]);
  await neu(true, true, null);
  await neu(true, true, null);
  await neu(true, false, null);
  await neu(true, false, 'bestaetigt');
  await neu(false, false, null);
  await neu(true, true, null, 40);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM jev_entscheidungen WHERE project = $1', [PRJ]);
  pruefe(rows[0].n === 6, 'Z ANKER 6 Testzeilen angelegt', rows[0]);

  const z = await zeile({ project: PRJ, koordinator: true });
  pruefe(z === '3 autonome Entscheidungen zur Durchsicht (davon 2 ohne Praezedenz), jev(durchsicht)', 'Z Koordinator-Zeile mit N=3, M=2', z);
  const d = await J.durchsichtEntscheidung(PRJ, {});
  pruefe(d.success === true && d.anzahl === 3, 'Z N stimmt mit jev(durchsicht) ueberein', { anzahl: d.anzahl });

  pruefe(await zeile({ project: PRJ, koordinator: false }) === undefined, 'N andere Rolle: keine Zeile');
  pruefe(await zeile({ project: 'zz-durchsicht-leer-p15n', koordinator: true }) === undefined, 'N Projekt ohne offene Durchsicht: keine Zeile');
  await pool.query(`UPDATE jev_entscheidungen SET durchsicht = 'bestaetigt' WHERE project = $1 AND entschieden AND ohne_praezedenz IS NOT TRUE`, [PRJ]);
  const z2 = await zeile({ project: PRJ, koordinator: true });
  pruefe(z2 === '2 autonome Entscheidungen zur Durchsicht (davon 2 ohne Praezedenz), jev(durchsicht)', 'Z nach Teil-Durchsicht N=2, M=2', z2);
  await pool.query(`UPDATE jev_entscheidungen SET durchsicht = 'bestaetigt' WHERE project = $1 AND entschieden`, [PRJ]);
  pruefe(await zeile({ project: PRJ, koordinator: true }) === undefined, 'N alles durchgesehen: keine Zeile');

  const wurzel = join(hier, '..', '..', '..');
  const rest = readFileSync(join(wurzel, 'packages', 'rest-api', 'src', 'routes', 'mcp.ts'), 'utf8');
  const stdio = readFileSync(join(wurzel, 'packages', 'mcp-server', 'src', 'tools', 'onboarding.ts'), 'utf8');
  pruefe(/entscheidungsDurchsichtZeile\(/.test(rest) && /\.\.\.durchsichtBlock/.test(rest)
    && /entscheidungsDurchsichtZeile\(/.test(stdio) && /entscheidungen_durchsicht: durchsichtZeile/.test(stdio),
    'R REST und stdio liefern entscheidungen_durchsicht');
} finally {
  await aufraeumen().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
