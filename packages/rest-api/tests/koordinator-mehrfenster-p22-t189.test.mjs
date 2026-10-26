/**
 * P22-T189 koordinatorMehrfensterSchalter (routes/agent-runtimes.ts) + agent-profil-schalter.ts:
 * PG-Produktwert Standard AUS, explizit/global/Projekt, befristeter intern-Override, Ablauf, Produktion, Fehler-Rueckfall.
 * Nur eigene Tabellen im privaten Schema auf synapse_test:5433; Schema wird danach entfernt. Kein KI-Browser.
 * Aufruf nach mise run build:core und mise run build:api:
 * node packages/rest-api/tests/koordinator-mehrfenster-p22-t189.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const url = new URL(process.env.SYNAPSE_DATABASE_URL || process.env.DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433', 'P22-T189 nur Test-Port'); assert.equal(url.pathname, '/synapse_test', 'P22-T189 nur Test-DB');
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.SYNAPSE_AGENT_TOKEN;
delete process.env.SYNAPSE_AGENT_IDENTITY_ID;
const worker = process.argv.includes('--produktion');
process.env.SYNAPSE_INTERN_TOOL = worker ? '0' : '1';
process.env.SYNAPSE_SHELL_JOB = '1';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.PARSER_LOOP_DISABLED = '1';
if (worker) {
  process.env.DATABASE_URL = url.href;
  const C = await import('../../core/dist/index.js');
  const { koordinatorMehrfensterSchalter } = await import('../dist/routes/agent-runtimes.js');
  try { console.log('P22_RESULT ' + JSON.stringify(await koordinatorMehrfensterSchalter('p22-t189-a'))); }
  finally { await C.getPool().end(); }
} else {
  const require = createRequire(new URL('../../core/package.json', import.meta.url));
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: url.href });
  const schema = 'p22_t189_' + randomUUID().replaceAll('-', '');
  let C, n = 0;
  const check = (stand, aktiv, quelle, why) => {
    const label = 'P22-T189 koordinatorMehrfensterSchalter routes/agent-runtimes.ts ' + why;
    try { assert.equal(stand.aktiv, aktiv); if (quelle) assert.equal(stand.quelle, quelle); }
    catch (error) { throw Error(label + ' erwartet=' + JSON.stringify({aktiv,quelle}) + ' ist=' + JSON.stringify(stand) + ' ' + error.message); }
    n++; console.log('OK ' + label);
  };
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    await admin.query('CREATE TABLE ' + schema + '.agent_profil_schalter (ebene text, project text, funktion text, aktiv boolean, grund text, gesetzt_von text, gesetzt_am timestamptz DEFAULT now())');
    await admin.query('CREATE TABLE ' + schema + '.intern_schalter (name text, modus text, aktiv boolean, bis timestamptz)');
    url.searchParams.set('options', '-c search_path=' + schema);
    process.env.DATABASE_URL = url.href;
    C = await import('../../core/dist/index.js');
    const { koordinatorMehrfensterSchalter: stand } = await import('../dist/routes/agent-runtimes.js');
    const pool = C.getPool();
    const produkt = async (funktion, aktiv, project = null) => {
      await pool.query('INSERT INTO agent_profil_schalter (ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES ($1,$2,$3,$4,$5,$6)',
        [project ? 'projekt' : 'global', project, funktion, aktiv, 'P22-T189 Test', 'user']);
    };
    check(await stand('p22-t189-a'), false, 'standard', 'ohne Freigabe AUS');
    await produkt('alle', true);
    check(await stand('p22-t189-a'), false, 'standard', 'alle gibt Neues nicht implizit frei');
    await produkt('koordinator_mehrfenster', true);
    check(await stand('neues-testprojekt'), true, 'produkt-schalter', 'neues Projekt erbt ausdruecklichen globalen Wert');
    await produkt('koordinator_mehrfenster', false, 'p22-t189-a');
    check(await stand('p22-t189-a'), false, 'produkt-schalter', 'Projekt-AUS schlaegt global EIN');
    check(await stand('p22-t189-b'), true, 'produkt-schalter', 'Projekt-AUS greift nicht auf fremdes Projekt ueber');
    await pool.query("INSERT INTO intern_schalter VALUES ('koordinator_mehrfenster','freigegeben',true,now()+interval '10 minutes')");
    let s = await stand('p22-t189-a'); check(s, true, 'intern', 'befristeter Override EIN'); assert(s.bis);
    const prod = () => {
      const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--produktion'], { env: { ...process.env, DATABASE_URL: url.href }, encoding: 'utf8' });
      const row = output.split('\n').find(z => z.startsWith('P22_RESULT ')); assert(row, output);
      return JSON.parse(row.slice('P22_RESULT '.length));
    };
    check(prod(), false, 'produkt-schalter', 'Produktion ignoriert aktiven intern-Override');
    await pool.query("UPDATE intern_schalter SET bis=now()-interval '1 second'");
    check(await stand('p22-t189-a'), false, 'produkt-schalter', 'Ablauf faellt auf PG-Wert zurueck');
    await pool.query('UPDATE intern_schalter SET bis=null');
    check(await stand('p22-t189-a'), false, 'produkt-schalter', 'unbefristeter Test-Override wird ignoriert');
    await pool.query('UPDATE agent_profil_schalter SET aktiv=true WHERE project=$1', ['p22-t189-a']);
    check(prod(), true, 'produkt-schalter', 'neuer Prozess liest dauerhaften Projektwert');
    await pool.query('DROP TABLE intern_schalter');
    s = await stand('p22-t189-a'); check(s, true, 'produkt-schalter', 'intern-Ausfall erhaelt Produktwert'); assert(s.intern_fehler);
    await pool.query('DROP TABLE agent_profil_schalter');
    check(await stand('p22-t189-a'), false, 'standard', 'PG-Lesefehler bleibt geschlossen');
    console.log('BESTANDEN ' + n + ' P22-T189 PG-Schalterpruefungen');
  } catch (error) {
    console.error('DEBUG P22-T189 routes/agent-runtimes.ts koordinatorMehrfensterSchalter erwartet=Schalterpruefungen gruen ist=' + error.message);
    process.exitCode = 1;
  } finally {
    if (C) await C.getPool().end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.end();
  }
}
