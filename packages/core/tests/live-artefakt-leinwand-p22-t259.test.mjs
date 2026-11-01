/**
 * P22-T259 L3/L4 (User 01.11.2026 ~12:05, thought c737a806; Bauplan 8609a6f9): Feld auf_leinwand im bestehenden Layout-Speicher.
 * Prueft gegen synapse_test (Port 5433) in einem EIGENEN Wegwerf-Schema (search_path), ohne core/dist und ohne Server:
 *   A Einmal-Umstieg (DO-Block aus schema.ts, woertlich ausgeschnitten): Spalte entsteht, bestehende Zeile bleibt unveraendert und
 *     liegt auf der Leinwand, jedes Katalogpaar ohne Zeile bekommt die bisherige Standardlage (Reihenfolge artefakt_id, project;
 *     x=(i%2)*50, y=floor(i/2)*340, 48 x 320). Nicht-live bzw. ohne Vorlage bleibt draussen.
 *   B Idempotenz: zweiter Lauf ohne Fehler und ohne neue Zeilen; ein spaeter angelegtes Live-Artefakt landet NICHT automatisch.
 *   C Katalog-SQL (GET /api/main-agent/live-artefakte, woertlich aus agent-runtimes.ts): liefert auf_leinwand (null = nie).
 *   D Layout-SQL (PUT .../layout, woertlich): Herunternehmen behaelt Lage, Revision +1; falsche Revision -> keine Zeile;
 *     Hinzufuegen eines neuen Paars mit Revision 0; Artefakt ausserhalb des Katalogs -> keine Zeile.
 * Herkunft je Assertion im Label; Fehlschlag gibt 'DEBUG <Label> | tatsaechlich: ...' aus.
 *   DATABASE_URL=postgres://<user>:<pw>@<host>:5433/synapse_test node packages/core/tests/live-artefakt-leinwand-p22-t259.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433', 'P22-T259 Testziel Port 5433'); assert.equal(url.pathname, '/synapse_test', 'P22-T259 Testziel synapse_test');
const hier = dirname(fileURLToPath(import.meta.url)), repo = resolve(hier, '../../..');
const { Client } = createRequire(join(repo, 'packages/core/package.json'))('pg');
const lies = (p) => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 700); } catch { return String(v).slice(0, 700); } };
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

// SQL woertlich aus dem Quelltext, damit der Test genau das prueft, was ausgeliefert wird.
const schema = lies('packages/core/src/db/schema.ts');
const tabelle = (schema.match(/CREATE TABLE IF NOT EXISTS user_live_artefakt_layout \([\s\S]*?\n\);/) ?? [''])[0];
const umstieg = (schema.match(/-- P22-T259 L3\/L4[\s\S]*?\n(DO \$block\$[\s\S]*?\n\$block\$;)/) ?? ['', ''])[1];
const api = lies('packages/rest-api/src/routes/agent-runtimes.ts');
const ab = (s, von) => s.slice(s.indexOf(von));
const katalogSql = (ab(api, "'/api/main-agent/live-artefakte', async").match(/query\(`([\s\S]*?)`, \[id,projekt\]\)/) ?? ['', ''])[1];
const layoutSql = (ab(api, "'/api/main-agent/live-artefakte/:id/layout'").match(/p\.query\(`([\s\S]*?)`,\[id,b\.project/) ?? ['', ''])[1];
ok(tabelle && umstieg && katalogSql && layoutSql, 'P22-T259 Quelltext: Tabelle, Umstieg, Katalog- und Layout-SQL gefunden', { tabelle: !!tabelle, umstieg: !!umstieg, katalogSql: !!katalogSql, layoutSql: !!layoutSql });

const schemaName = 't259_leinwand_' + randomBytes(4).toString('hex');
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = (sql, p) => c.query(sql, p);
const zeile = async (id, project) => (await q('SELECT x,y,breite,hoehe,revision::int AS revision,auf_leinwand FROM user_live_artefakt_layout WHERE user_key=$1 AND artefakt_id=$2 AND project=$3', ['user', id, project])).rows[0];
const id = (k) => '00000000-0000-4000-8000-00000000000' + k;
try {
  await q('CREATE SCHEMA ' + schemaName); await q('SET search_path TO ' + schemaName);
  // Minimal-Abbild der beteiligten Tabellen (Spalten wie im Produktschema, nur was die SQL nutzt).
  await q('CREATE TABLE agent_artifacts (id UUID PRIMARY KEY, title TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), modus TEXT, vorlage TEXT, standard_project TEXT)');
  await q('CREATE TABLE artefakt_renderungen (artefakt_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE, project TEXT NOT NULL, PRIMARY KEY (artefakt_id, project))');
  await q(tabelle);
  await q(`INSERT INTO agent_artifacts(id,title,modus,vorlage,standard_project) VALUES
    ($1,'Leitstand pa','live','<v/>','pa'), ($2,'Leitstand pb','live','<v/>','pb'), ($3,'fest','fest','<v/>','pa'), ($4,'ohne Vorlage','live',NULL,'pa')`, [id(1), id(2), id(3), id(4)]);
  await q('INSERT INTO artefakt_renderungen(artefakt_id,project) VALUES ($1,$2)', [id(2), 'pc']);
  // Der User hat (a2,pb) schon verschoben: diese Zeile muss den Umstieg unveraendert ueberstehen.
  await q("INSERT INTO user_live_artefakt_layout(user_key,artefakt_id,project,x,y,breite,hoehe,revision) VALUES ('user',$1,'pb',10,900,30,200,4)", [id(2)]);

  // ---------------------------------------------------------------- A Einmal-Umstieg
  await q(umstieg);
  const spalte = (await q("SELECT data_type, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='user_live_artefakt_layout' AND column_name='auf_leinwand'", [schemaName])).rows[0];
  ok(spalte?.data_type === 'boolean' && /true/i.test(spalte?.column_default ?? ''), 'P22-T259 A schema.ts: Spalte auf_leinwand BOOLEAN DEFAULT TRUE im bestehenden Layout-Speicher', spalte);
  const a1 = await zeile(id(1), 'pa'), a2b = await zeile(id(2), 'pb'), a2c = await zeile(id(2), 'pc');
  ok(a1 && a1.x === 0 && a1.y === 0 && a1.breite === 48 && a1.hoehe === 320 && a1.auf_leinwand === true, 'P22-T259 A Umstieg: erstes Katalogpaar an der bisherigen Standardlage (i=0)', a1);
  ok(a2b && a2b.x === 10 && a2b.y === 900 && a2b.breite === 30 && a2b.hoehe === 200 && a2b.revision === 4 && a2b.auf_leinwand === true, 'P22-T259 A Umstieg: vom User verschobene Zeile bleibt unveraendert und liegt auf der Leinwand', a2b);
  ok(a2c && a2c.x === 0 && a2c.y === 340 && a2c.auf_leinwand === true, 'P22-T259 A Umstieg: drittes Paar (Renderprojekt) an Standardlage i=2 (x=0, y=340)', a2c);
  const gesamt = Number((await q('SELECT count(*) FROM user_live_artefakt_layout')).rows[0].count);
  ok(gesamt === 3, 'P22-T259 A Umstieg: nur Katalogpaare (nicht fest, nicht ohne Vorlage)', gesamt);

  // ---------------------------------------------------------------- B Idempotenz, keine Automatik fuer spaetere Artefakte
  await q("INSERT INTO agent_artifacts(id,title,modus,vorlage,standard_project) VALUES ($1,'Neu nach Umstieg','live','<v/>','pa')", [id(5)]);
  await q(umstieg);
  const nachher = Number((await q('SELECT count(*) FROM user_live_artefakt_layout')).rows[0].count);
  ok(nachher === 3 && !(await zeile(id(5), 'pa')), 'P22-T259 B Umstieg: zweiter Lauf ohne neue Zeilen, neues Live-Artefakt landet nicht automatisch auf der Leinwand', nachher);

  // ---------------------------------------------------------------- C Katalog-SQL
  const katalog = (await q(katalogSql, ['', ''])).rows;
  const k = Object.fromEntries(katalog.map((r) => [r.id + ':' + r.project, r.auf_leinwand]));
  ok(katalog.length === 4 && k[id(1) + ':pa'] === true && k[id(2) + ':pb'] === true && k[id(2) + ':pc'] === true && k[id(5) + ':pa'] === null,
    'P22-T259 C Katalog (GET): alle Paare, auf_leinwand true fuer die Leinwand, null fuer nie hinzugefuegt', k);

  // ---------------------------------------------------------------- D Layout-SQL (PUT)
  const put = async (aid, project, lage, rev, leinwand) => (await q(layoutSql, [aid, project, lage.x, lage.y, lage.breite, lage.hoehe, rev, leinwand])).rows;
  const weg = await put(id(1), 'pa', { x: 0, y: 0, breite: 48, hoehe: 320 }, 1, false);
  const a1weg = await zeile(id(1), 'pa');
  ok(weg.length === 1 && Number(weg[0].revision) === 2 && weg[0].auf_leinwand === false && a1weg.x === 0 && a1weg.breite === 48, 'P22-T259 D PUT: Herunternehmen behaelt Lage, Revision +1, auf_leinwand false', { weg, a1weg });
  const konflikt = await put(id(1), 'pa', { x: 5, y: 5, breite: 48, hoehe: 320 }, 1, true);
  ok(konflikt.length === 0 && (await zeile(id(1), 'pa')).auf_leinwand === false, 'P22-T259 D PUT: veraltete Revision -> keine Zeile (409), nichts geaendert', konflikt);
  const wieder = await put(id(1), 'pa', { x: 0, y: 700, breite: 48, hoehe: 320 }, 2, true);
  ok(wieder.length === 1 && Number(wieder[0].revision) === 3 && wieder[0].auf_leinwand === true && (await zeile(id(1), 'pa')).y === 700, 'P22-T259 D PUT: wieder Hinzufuegen mit aktueller Revision legt auf die Leinwand (freie Lage)', wieder);
  const neu = await put(id(5), 'pa', { x: 0, y: 1060, breite: 48, hoehe: 320 }, 0, true);
  ok(neu.length === 1 && Number(neu[0].revision) === 1 && neu[0].auf_leinwand === true, 'P22-T259 D PUT: neues Paar mit Revision 0 wird angelegt', neu);
  const fremd = await put(id(3), 'pa', { x: 0, y: 0, breite: 48, hoehe: 320 }, 0, true);
  ok(fremd.length === 0, 'P22-T259 D PUT: Artefakt ausserhalb des Katalogs (nicht live) -> keine Zeile', fremd);
  console.log('P22-T259 Leinwand-DB: ' + n + ' Pruefungen bestanden (Schema ' + schemaName + ')');
} finally {
  try { await q('SET search_path TO public'); await q('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE'); } catch (e) { console.error('Aufraeumen fehlgeschlagen: ' + e.message); }
  await c.end();
}
