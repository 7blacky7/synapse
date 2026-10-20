/**
 * P22-T75: Schema-Start zieht den Alias haiku auf Haiku 5.5 nach (MODELL_HAIKU_55_NACHZUG_SQL), eng begrenzt und idempotent.
 *  A alter Stand (haiku -> claude-haiku-4-5-20251001, 200k) -> neu: full_id, Fenster, Korridor, Output, Preise, Cutoff, Effort
 *  B zweiter Lauf aendert nichts (0 Zeilen)
 *  C gepflegte Zeile (anderer full_id unter alias haiku) bleibt unberuehrt; andere Aliase auch
 *  D das UPDATE steht in SCHEMA_SQL (Seed legt haiku-4.5 an), und der ensureSchema-Probelauf (Rollback) besteht
 * SICHERHEIT: nur synapse_test auf Port 5433 (sonst Exit 2); A-C laufen auf einer TEMP-Kopie der Tabelle in einer Transaktion mit
 * ROLLBACK, D als nurProbe (Rollback). Aufruf: node packages/core/tests/modell-haiku-nachzug-p22-t75.test.mjs (nach pnpm build in core)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
if (url.port !== '5433' || url.pathname !== '/synapse_test') {
  console.error('ABBRUCH: nur gegen synapse_test auf Port 5433 (DATABASE_URL zeigt woanders hin).');
  process.exit(2);
}
const { Pool } = createRequire(join(hier, '..', 'package.json'))('pg');
const schema = await import('../dist/db/schema.js');
let fehler = 0;
const pruefe = (b, t, d) => { if (b) console.log('OK      ' + t); else { fehler++; console.error('FEHLER  ' + t + (d !== undefined ? ' — ' + JSON.stringify(d) : '')); } };

const pool = new Pool({ connectionString: url.href });
const c = await pool.connect();
try {
  pruefe(typeof schema.MODELL_HAIKU_55_NACHZUG_SQL === 'string', 'Export MODELL_HAIKU_55_NACHZUG_SQL');
  await c.query('BEGIN');
  // TEMP-Kopie schattet public.model_registry (pg_temp steht vorn im search_path); keine Daten der echten Tabelle betroffen.
  await c.query('CREATE TEMP TABLE model_registry (LIKE public.model_registry INCLUDING DEFAULTS)');
  const zeile = (alias, fullId, ctx, cmin, cmax, out, pin, pout, pc, cutoff, stufen, std) => c.query(
    `INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, corridor_min, corridor_max, output_limit,
       pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, effort_stufen, default_effort)
     VALUES ($1,$2,'anthropic',$3,ARRAY[]::TEXT[],'claude',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [alias, fullId, ctx, cmin, cmax, out, pin, pout, pc, cutoff, stufen, std]);
  await zeile('haiku', 'claude-haiku-4-5-20251001', 200000, 73, 88, 64000, 1, 5, 0.1, '2025-02-28', [], null);
  await zeile('haiku-4.5', 'claude-haiku-4-5-20251001', 200000, 73, 88, 64000, 1, 5, 0.1, '2025-02-28', [], null);
  await zeile('opus', 'claude-opus-5-5', 200000, 73, 88, 128000, 4, 20, 0.2, '2026-06-01', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium');
  const lies = async (alias) => (await c.query('SELECT full_id, context_window, corridor_min, corridor_max, output_limit, pricing_input_usd_per_mtok::float8 AS pin, pricing_output_usd_per_mtok::float8 AS pout, pricing_cache_usd_per_mtok::float8 AS pc, cutoff_date::text AS cutoff, effort_stufen, default_effort, updated_at FROM model_registry WHERE alias = $1', [alias])).rows[0];

  const opusVorher = JSON.stringify(await lies('opus'));
  const alt45 = JSON.stringify(await lies('haiku-4.5'));
  const a = await c.query(schema.MODELL_HAIKU_55_NACHZUG_SQL);
  const h = await lies('haiku');
  pruefe(a.rowCount === 1, 'A: alter Stand -> genau 1 Zeile aktualisiert', a.rowCount);
  pruefe(h.full_id === 'claude-haiku-5-5' && h.context_window === 1000000 && h.corridor_min === 80 && h.corridor_max === 97 && h.output_limit === 128000, 'A: full_id, Fenster 1M, Korridor 80/97, Output', h);
  pruefe(h.pin === 0.1 && h.pout === 0.5 && h.pc === 0.01 && h.cutoff === '2026-06-01', 'A: Preise 0.10/0.50/0.01, Cutoff 2026-06-01', h);
  pruefe(JSON.stringify(h.effort_stufen) === JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']) && h.default_effort === 'medium', 'A: Effort-Stufen und Standard medium', h);

  const nachErstem = JSON.stringify(h);
  const b = await c.query(schema.MODELL_HAIKU_55_NACHZUG_SQL);
  pruefe(b.rowCount === 0 && JSON.stringify(await lies('haiku')) === nachErstem, 'B: zweiter Lauf aendert nichts (0 Zeilen, updated_at gleich)', b.rowCount);
  pruefe(JSON.stringify(await lies('opus')) === opusVorher && JSON.stringify(await lies('haiku-4.5')) === alt45, 'C: andere Aliase (opus, haiku-4.5) unberuehrt');

  // C: gepflegte Zeile: alias haiku zeigt bewusst auf eine andere ID mit eigenen Werten -> bleibt
  await c.query("UPDATE model_registry SET full_id = 'claude-haiku-7-7', context_window = 555000, pricing_input_usd_per_mtok = 0.2 WHERE alias = 'haiku'");
  const gepflegt = JSON.stringify(await lies('haiku'));
  const g = await c.query(schema.MODELL_HAIKU_55_NACHZUG_SQL);
  pruefe(g.rowCount === 0 && JSON.stringify(await lies('haiku')) === gepflegt, 'C: gepflegter Wert (anderer full_id) wird nie ueberschrieben', g.rowCount);
  await c.query('ROLLBACK');

  // D: Einbindung in SCHEMA_SQL (Text der gebauten Datei) und Probelauf mit Rollback
  const quelle = readFileSync(join(hier, '..', 'dist', 'db', 'schema.js'), 'utf8');
  pruefe(/\$\{MODELL_HAIKU_55_NACHZUG_SQL\};/.test(quelle), 'D: SCHEMA_SQL fuehrt das Nachziehen aus');
  pruefe(/\('haiku-4\.5',\s*'claude-haiku-4-5-20251001',\s*'anthropic'/.test(quelle), 'D: Seed legt haiku-4.5 an (ON CONFLICT DO NOTHING)');
  const probe = await schema.ensureSchema({ nurProbe: true });
  pruefe(probe.probe === true, 'D: ensureSchema-Probelauf (Rollback) besteht', probe);
} catch (e) {
  fehler++;
  console.error('FEHLER  unerwartet:', e?.code ?? '', e?.message ?? e);
  await c.query('ROLLBACK').catch(() => undefined);
} finally {
  c.release();
  await pool.end();
}
console.log(fehler ? `${fehler} FEHLER` : 'alle OK');
process.exit(fehler ? 1 : 0);
