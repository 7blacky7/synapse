/**
 * P22-T126: Schema-Start zieht opus (claude-opus-5-5) und sonnet-5 (claude-sonnet-5) auf 1M Kontext, Korridor 80/97
 * (MODELL_KONTEXT_1M_NACHZUG_SQL). Idempotent; sonnet-4.6, haiku-4.5 und gepflegte Werte unberuehrt.
 * SICHERHEIT: nur synapse_test:5433 (sonst Exit 2); TEMP-Kopie der Tabelle in Transaktion mit ROLLBACK; ensureSchema nurProbe.
 *   pnpm --filter @synapse/core build && node packages/core/tests/modell-kontext-1m-p22-t126.test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (url.port !== '5433' || url.pathname !== '/synapse_test') { console.error('ABBRUCH: nur gegen synapse_test auf Port 5433.'); process.exit(2); }
const { Pool } = createRequire(join(hier, '..', 'package.json'))('pg');
const schema = await import('../dist/db/schema.js');
let fehler = 0;
const pruefe = (b, t, d) => { if (b) console.log('OK      ' + t); else { fehler++; console.error('FEHLER  ' + t + (d !== undefined ? ' — ' + JSON.stringify(d) : '')); } };

const pool = new Pool({ connectionString: url.href });
const c = await pool.connect();
try {
  pruefe(typeof schema.MODELL_KONTEXT_1M_NACHZUG_SQL === 'string', 'Export MODELL_KONTEXT_1M_NACHZUG_SQL');
  await c.query('BEGIN');
  await c.query('CREATE TEMP TABLE model_registry (LIKE public.model_registry INCLUDING DEFAULTS)');
  const zeile = (alias, fullId, ctx, cmin, cmax) => c.query(
    `INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, corridor_min, corridor_max, output_limit,
       pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok)
     VALUES ($1,$2,'anthropic',$3,ARRAY[]::TEXT[],'claude',$4,$5,64000,1,5,0.1)`, [alias, fullId, ctx, cmin, cmax]);
  const ZIEL = ['opus', 'opus-5', 'opus-4.8', 'opus-4.7', 'sonnet-5'];
  await zeile('opus', 'claude-opus-5-5', 200000, 73, 88);
  await zeile('opus-5', 'claude-opus-5', 200000, 73, 88);
  await zeile('opus-4.8', 'claude-opus-4-8', 200000, 73, 88);
  await zeile('opus-4.7', 'claude-opus-4-7', 200000, 73, 88);
  await zeile('sonnet-5', 'claude-sonnet-5', 200000, 73, 88);
  await zeile('sonnet-4.6', 'claude-sonnet-4-6', 200000, 73, 88);
  await zeile('opus-4.6', 'claude-opus-4-6', 200000, 73, 88);
  await zeile('haiku-4.5', 'claude-haiku-4-5-20251001', 200000, 73, 88);
  await zeile('opus[1m]', 'claude-opus-5-5[1m]', 1000000, 80, 97);
  const lies = async (a) => (await c.query('SELECT full_id, context_window, corridor_min, corridor_max, updated_at FROM model_registry WHERE alias = $1', [a])).rows[0];
  const unberuehrt = {}; for (const a of ['sonnet-4.6', 'opus-4.6', 'haiku-4.5', 'opus[1m]']) unberuehrt[a] = JSON.stringify(await lies(a));

  const a = await c.query(schema.MODELL_KONTEXT_1M_NACHZUG_SQL);
  pruefe(a.rowCount === 5, 'A: genau 5 Zeilen (opus, opus-5, opus-4.8, opus-4.7, sonnet-5)', a.rowCount);
  for (const al of ZIEL) { const z = await lies(al); pruefe(z.context_window === 1000000 && z.corridor_min === 80 && z.corridor_max === 97, 'A: ' + al + ' 1M, 80/97', z); }
  for (const al of Object.keys(unberuehrt)) pruefe(JSON.stringify(await lies(al)) === unberuehrt[al], 'A: ' + al + ' unberuehrt');

  const alle = async () => JSON.stringify(await Promise.all(ZIEL.map(lies)));
  const nach = await alle();
  const b = await c.query(schema.MODELL_KONTEXT_1M_NACHZUG_SQL);
  pruefe(b.rowCount === 0 && (await alle()) === nach, 'B: zweiter Lauf aendert nichts', b.rowCount);

  // C: gepflegter Wert (anderes Fenster als 200k) bleibt
  await c.query("UPDATE model_registry SET context_window = 400000 WHERE alias = 'sonnet-5'");
  const g = await c.query(schema.MODELL_KONTEXT_1M_NACHZUG_SQL);
  pruefe(g.rowCount === 0 && (await lies('sonnet-5')).context_window === 400000, 'C: gepflegte Werte nie ueberschrieben', g.rowCount);
  await c.query('ROLLBACK');

  const quelle = readFileSync(join(hier, '..', 'dist', 'db', 'schema.js'), 'utf8');
  pruefe(/\$\{MODELL_KONTEXT_1M_NACHZUG_SQL\};/.test(quelle), 'D: SCHEMA_SQL fuehrt den Nachzug aus');
  const probe = await schema.ensureSchema({ nurProbe: true });
  pruefe(probe.probe === true, 'D: ensureSchema-Probelauf (Rollback) besteht', probe);
} catch (e) {
  fehler++; console.error('FEHLER  unerwartet:', e?.code ?? '', e?.message ?? e);
  await c.query('ROLLBACK').catch(() => undefined);
} finally { c.release(); await pool.end(); }
console.log(fehler ? `${fehler} FEHLER` : 'alle OK');
process.exit(fehler ? 1 : 0);
