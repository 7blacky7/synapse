/**
 * P22-T62/T65 Testphase: gemeinsamer Aufbau der DB-Tests der Modellwahl (nur synapse_test:5433, eigenes privates Schema).
 * Fake-Katalog statt Container (registriereCliModellKatalog); kein Netz, kein Docker.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);

/** Katalogdaten wie aus den echten CLI-Listen (Stand 20.10.2026, gekuerzt). */
export function claudeKatalog() {
  const alle = ['low', 'medium', 'high', 'xhigh', 'max'];
  const m = (id, familie, gruppe, stufen = alle, std = 'medium') => ({ id, name: id, beschreibung: null, sichtbar: true, gruppe, familie, standard: false,
    effort_stufen: stufen, standard_effort: stufen.length ? std : null });
  return { grund: null, alias_ziele: { opus: 'claude-opus-5', haiku: 'claude-haiku-4-5-20251001' }, modelle: [
    m('claude-opus-5-5', 'opus', 'main'), m('claude-fable-5-1', 'fable', 'main', alle, 'high'), m('claude-sonnet-5-5', 'sonnet', 'main'),
    m('claude-haiku-5-5', 'haiku', 'main'), m('claude-haiku-4-5-20251001', 'haiku', 'overflow', []), m('claude-opus-5', 'opus', 'overflow', ['low', 'medium', 'high']),
  ] };
}
export function codexKatalog() {
  const s = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const m = (id, sichtbar = true, std = 'medium', standard = false) => ({ id, name: id, beschreibung: null, sichtbar, gruppe: null, familie: null, standard,
    effort_stufen: s, standard_effort: std });
  return { grund: null, alias_ziele: {}, modelle: [
    m('gpt-6.1-sol', true, 'low', true), m('gpt-6-astra'), m('gpt-6-sol'), m('gpt-reserve', false), m('gpt-6-luna'), m('gpt-5.6-sol', true, 'low'),
    m('gpt-5.6-terra'), m('gpt-5.6-luna'),
  ] };
}

export async function baueUmgebung(name) {
  const require = createRequire(join(repo, 'packages/core/package.json'));
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
  for (const k of ['SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID', 'SYNAPSE_AUTH_DISABLED', 'SYNAPSE_W1B_DURCHSETZUNG', 'SYNAPSE_MAIN_SYNAPSE',
    'SYNAPSE_HAUPTAGENT', 'SYNAPSE_AGENTEN_AUSWEIS', 'SYNAPSE_VERBRAUCH']) delete process.env[k];
  Object.assign(process.env, { SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_INTERN_TOOL: '0',
    SYNAPSE_AGENT_BEZUG_MODUS: 'beide', SYNAPSE_W1B_GATE_TTL_MS: '0', SYNAPSE_ONBOARDING_RUHE_MIN: '0', DOCKER_SOCKET: '/nonexistent/docker.sock',
    QDRANT_URL: 'http://127.0.0.1:1', OLLAMA_URL: 'http://127.0.0.1:1', EMBEDDING_BASE_URL: 'http://127.0.0.1:1' });
  const net = { n: 0 };
  globalThis.fetch = async () => { net.n++; throw Error('Testnetz gesperrt'); };
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: url.href });
  const schema = name + '_' + process.pid + '_' + randomUUID().slice(0, 8);
  await admin.query('CREATE SCHEMA ' + schema);
  const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
  for (const { tablename } of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    await admin.query('CREATE TABLE ' + schema + '.' + quote(tablename) + ' (LIKE public.' + quote(tablename) + ' INCLUDING ALL)');
  }
  const serials = await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name", [schema]);
  for (const [i, r] of serials.rows.entries()) {
    const seq = schema + '.private_serial_' + i;
    await admin.query('CREATE SEQUENCE ' + seq);
    await admin.query('ALTER TABLE ' + schema + '.' + quote(r.table_name) + ' ALTER COLUMN ' + quote(r.column_name) + " SET DEFAULT nextval('" + seq + "'::regclass)");
  }
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  process.env.DATABASE_URL = url.href;
  const C = await load('packages/core/dist/index.js');
  const pool = C.getPool();
  for (const file of ['agent-identitaet-schema', 'agent-bezug-schema', 'agent-profil-schema', 'agent-ausweis-schema', 'agent-ausweis-nr-schema',
    'agent-runtime-auftraege-schema', 'hauptagent-verlauf-schema', 'main-warteschlange-schema', 'runtime-ueberwachung-schema']) {
    const mod = await load('packages/core/dist/db/' + file + '.js');
    const sql = Object.values(mod).find((v) => typeof v === 'string');
    await pool.query(sql); await pool.query(sql);
  }
  await pool.query('CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr');
  const kat = { claude: claudeKatalog(), codex: codexKatalog() };
  C.registriereCliModellKatalog(async (rt) => kat[rt]);
  const USER = { art: 'user' };
  await C.setzeProfilProduktSchalter({ ebene: 'global', funktion: 'agenten_ausweis', aktiv: true, grund: 'Test ' + name + ' Ausweis-Kern' }, { system: 'user' });
  await C.setzeHauptagentSchalter(USER, { aktiv: true, grund: 'Test ' + name + ' hauptagent EIN' });
  const main = await C.stelleMainIdentitaetSicher(USER, { modell: 'opus', runtime: 'claude' });
  const failures = []; let checks = 0;
  const check = (ok, label) => { checks++; if (!ok) { failures.push(label); console.error('FAIL ' + label); } };
  const mask = (s) => String(s).replace(/sai_[a-z0-9]{1,64}/g, '[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[DB]');
  const section = async (n, fn) => { try { await fn(); console.log('ABSCHNITT ' + n + ' durchlaufen'); } catch (e) { failures.push(n + ': ' + mask(e.message)); console.error('FAIL Abschnitt ' + n + ': ' + mask(e.stack)); } };
  const err = async (f) => { try { await f(); return 'kein_fehler'; } catch (e) { return e.code ?? e.message; } };
  const schalterCli = (aktiv) => C.setzeProfilProduktSchalter({ ebene: 'global', funktion: 'hauptagent_cli_modelle', aktiv, grund: 'Test ' + name + ' cli_modelle' }, { system: 'user' });
  const startrezept = async (patch) => pool.query("UPDATE agent_identitaeten SET startrezept = COALESCE(startrezept,'{}'::jsonb) || $2::jsonb WHERE id=$1", [main.identity_id, JSON.stringify(patch)]);
  const offeneWeg = () => pool.query("UPDATE agent_runtime_auftraege SET status='cancelled', abgeschlossen_am=NOW() WHERE status IN ('pending','claimed','accepted')");
  const ende = async (titel) => {
    check(net.n === 0, 'keine Netzwerkaufrufe');
    console.log(titel + ': ' + checks + ' Pruefungen, ' + failures.length + ' Fehler');
    C.registriereCliModellKatalog(null);
    await C.closePool().catch(() => undefined);
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
    process.exit(failures.length ? 1 : 0);
  };
  return { C, pool, kat, USER, main, HP: C.HAUPTAGENT_PROJEKT, check, section, err, schalterCli, startrezept, offeneWeg, ende, mask, net };
}
