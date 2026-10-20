/**
 * P22-T61 Testphase: Modelllisten der CLI-Container AUSLESEN statt fester Listen (cli-modelle.ts).
 *  A Claude-Katalog: Felder, Effort-Stufen/-Details (P22-T65), Familie (P22-T62), alias_ziele, veraltet-Hinweis
 *  B Codex model/list (CLI) vor models_cache.json; CLI-Meldungen als Hinweis; Kontext aus dem Cache
 *  C Rueckfall models_cache.json (priority-Reihenfolge, visibility hide -> versteckt)
 *  D Ohne Quelle: leere Liste + grund (nie feste Listen)
 *  E leseCliModelleImContainer mit Fake-Docker: nicht konfiguriert, Container fehlt/laeuft nicht/fremd, Ausgabe unlesbar, Erfolg
 * Keine DB, kein Docker, kein Netz.
 *   node packages/rest-api/tests/cli-modelle-p22-t61.test.mjs
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
let network = 0;
globalThis.fetch = async () => { network++; throw Error('Testnetz gesperrt'); };
const failures = []; let checks = 0;
function check(ok, label) { checks++; if (!ok) { failures.push(label); console.error('FAIL ' + label); } }
async function section(name, fn) { try { await fn(); console.log('ABSCHNITT ' + name + ' durchlaufen'); } catch (e) { failures.push(name + ': ' + e.message); console.error('FAIL Abschnitt ' + name + ': ' + e.stack); } }

const M = await load('packages/rest-api/dist/services/agent-runtime/cli-modelle.js');
const jetzt = new Date('2026-10-20T12:00:00Z');

await section('A Claude-Katalog', async () => {
  const roh = { cli_version: '2.1.304 (Claude Code)', katalog: { datei: 'abc-cc.json', fetchedAt: 1760961600000, staleAt: '2026-10-19T00:00:00Z',
    alias_ziele: { opus: 'claude-opus-5', haiku: 'claude-haiku-4-5-20251001', kaputt: 7 },
    models: [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'For complex work', section: 'main', effort_options: ['low', 'medium'],
        effort_details: [{ stufe: 'medium', name: 'Medium', hinweis: 'Recommended' }, { stufe: 'max', name: 'Max', hinweis: '3.5× or more usage' }, { kaputt: 1 }],
        runtime: { max_input_tokens: 1000000, max_output_tokens: 128000, effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium', family: 'opus' } },
      { id: 'claude-haiku-5-5', name: 'Haiku', section: 'main', runtime: { family: 'haiku' } },
      { name: 'ohne id' },
    ] } };
  const l = M.normalisiereClaudeModelle(roh, jetzt);
  check(l.runtime === 'claude' && l.quelle === 'datei' && l.quelle_detail === 'model-catalog/abc-cc.json' && l.grund === null, 'Quelle/Detail/kein Grund');
  check(l.modelle.length === 2, 'Eintrag ohne id verworfen');
  const o = l.modelle[0];
  check(o.id === 'claude-opus-5-5' && o.name === 'Opus 5.5' && o.gruppe === 'main' && o.familie === 'opus', 'Felder inkl. Familie (runtime.family)');
  check(JSON.stringify(o.effort_stufen) === '["low","medium","high","xhigh","max"]' && o.standard_effort === 'medium', 'effort_levels vor effort_options, default_effort');
  check(o.effort_details.length === 2 && o.effort_details[1].hinweis.includes('3.5'), 'effort_details aus Badge/Tooltip, unlesbare verworfen');
  check(o.kontext_ein === 1000000 && o.kontext_aus === 128000, 'Kontext aus runtime');
  check(l.modelle[1].effort_stufen.length === 0 && l.modelle[1].standard_effort === null, 'ohne Stufen: leer');
  check(l.veraltet_ab === '2026-10-19T00:00:00.000Z' && l.hinweise.some(h => /veraltet/.test(h)), 'staleAt in der Vergangenheit -> Hinweis, nicht verworfen');
  check(JSON.stringify(l.alias_ziele) === JSON.stringify({ opus: 'claude-opus-5', haiku: 'claude-haiku-4-5-20251001' }), 'alias_ziele ohne kaputte Werte');
  const leer = M.normalisiereClaudeModelle({ cli_version: null, fehler: 'verzeichnis_fehlt: x' }, jetzt);
  check(leer.modelle.length === 0 && leer.grund === 'verzeichnis_fehlt: x' && leer.quelle === null, 'ohne Katalog: leer + grund');
});

await section('B Codex model/list vor Cache', async () => {
  const roh = { cli_version: 'codex-cli 0.163.0',
    cli: { ok: true, cli_meldungen: [], data: [
      { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: 'Workhorse', hidden: false, efforts: ['low', 'medium'], defaultReasoningEffort: 'low', isDefault: true,
        effort_details: [{ stufe: 'low', name: null, hinweis: 'Fast responses' }] },
      { id: 'gpt-reserve', hidden: true, efforts: [] },
    ] },
    cache: { client_version: '0.163.0', fetched_at: '2026-10-20T10:02:16Z', models: [{ slug: 'gpt-6.1-sol', context_window: 500000 }] } };
  const l = M.normalisiereCodexModelle(roh, jetzt);
  check(l.quelle === 'cli' && l.quelle_detail === 'codex app-server model/list' && l.modelle.length === 2, 'CLI-Liste genommen');
  const s = l.modelle[0];
  check(s.id === 'gpt-6.1-sol' && s.standard === true && s.standard_effort === 'low' && s.kontext_ein === 500000 && s.familie === null, 'Felder, isDefault, Kontext aus Cache');
  check(s.effort_details[0].hinweis === 'Fast responses', 'effort_details');
  check(l.modelle[1].id === 'gpt-reserve' && l.modelle[1].sichtbar === false, 'hidden -> versteckt, id als Rueckfall');
  check(l.hinweise.length === 0 && l.stand === '2026-10-20T10:02:16.000Z', 'ohne Meldungen kein Hinweis, Stand aus Cache');
  const mit = M.normalisiereCodexModelle({ ...roh, cache: { ...roh.cache, client_version: '0.162.0' }, cli: { ...roh.cli, cli_meldungen: ['failed to load models cache'] } }, jetzt);
  check(mit.hinweise.some(h => /eingebaute Liste/.test(h)) && mit.hinweise.some(h => /0\.162\.0/.test(h)) && mit.stand === null, 'CLI-Meldung + Versionsabweichung als Hinweis');
  check(JSON.stringify(l.alias_ziele) === '{}', 'codex ohne alias_ziele');
});

await section('C Rueckfall models_cache.json', async () => {
  const roh = { cli_version: 'codex-cli 0.163.0', cli: { ok: false, fehler: 'zeitlimit' }, cache: { fetched_at: '2026-10-20T10:00:00Z', models: [
    { slug: 'gpt-6-luna', priority: 5, visibility: 'list', efforts: ['low', 'medium'], default_reasoning_level: 'medium', context_window: 272000 },
    { slug: 'gpt-6.1-sol', priority: 1, visibility: 'list' },
    { slug: 'gpt-reserve', priority: 4, visibility: 'hide' },
  ] } };
  const l = M.normalisiereCodexModelle(roh, jetzt);
  check(l.quelle === 'datei' && l.modelle.map(m => m.id).join() === 'gpt-6.1-sol,gpt-reserve,gpt-6-luna', 'nach priority sortiert');
  check(l.modelle[1].sichtbar === false && l.modelle[2].standard_effort === 'medium' && l.modelle[2].kontext_ein === 272000, 'visibility hide, Effort, Kontext');
  check(l.hinweise.some(h => /zeitlimit/.test(h)), 'CLI-Fehler als Hinweis');
});

await section('D ohne Quelle: leer + grund', async () => {
  const l = M.normalisiereCodexModelle({ cli_version: null, cli: { ok: false, fehler: 'spawn codex ENOENT' }, cache: { fehler: 'ENOENT models_cache.json', models: [] } }, jetzt);
  check(l.modelle.length === 0 && l.quelle === null && /spawn codex ENOENT/.test(l.grund) && /models_cache.json/.test(l.grund), 'beide Quellen leer -> Grund nennt beide');
  const l2 = M.normalisiereCodexModelle({ cli: { ok: true, data: [] }, cache: { models: [] } }, jetzt);
  check(l2.modelle.length === 0 && /cli_liste_leer/.test(l2.grund), 'leere CLI-Liste ohne Cache -> cli_liste_leer');
});

await section('E Container-Probe mit Fakes', async () => {
  const cfg = { runtime: 'claude', containerName: 'synapse-runtime-claude', rootPath: '/x', image: 'synapse-agent-runtime:test', model: null, role: 'main', assignedToMain: true };
  const fakeDocker = (inspect, ausgabe) => ({
    getContainer: () => ({
      inspect: async () => { if (inspect instanceof Error) throw inspect; return inspect; },
      exec: async () => ({ start: async () => { const { PassThrough } = await import('node:stream'); const s = new PassThrough(); s.resume(); setImmediate(() => s.end()); return s; },
        inspect: async () => ({ ExitCode: 0 }) }),
    }),
    modem: { demuxStream: (stream, out) => { out.write(ausgabe); } },
  });
  const o = { env: [], istEigener: (info) => info?.Config?.Labels?.eigen === '1', jetzt: () => jetzt };
  check((await M.leseCliModelleImContainer(fakeDocker({}), null, 'claude', o)).grund === 'nicht_konfiguriert', 'ohne Konfiguration');
  check((await M.leseCliModelleImContainer(fakeDocker(new Error('No such container: x')), cfg, 'claude', o)).grund === 'container_fehlt', 'Container fehlt');
  check((await M.leseCliModelleImContainer(fakeDocker({ Config: { Labels: {} }, State: { Running: true } }), cfg, 'claude', o)).grund === 'fremder_container', 'fremder Container');
  check((await M.leseCliModelleImContainer(fakeDocker({ Config: { Labels: { eigen: '1' } }, State: { Running: false } }), cfg, 'claude', o)).grund === 'container_laeuft_nicht', 'Container laeuft nicht');
  const kaputt = await M.leseCliModelleImContainer(fakeDocker({ Config: { Labels: { eigen: '1' }, Image: 'node:22' }, State: { Running: true } }, 'kein json\n'), cfg, 'claude', o);
  check(/abfrage_ohne_ergebnis/.test(kaputt.grund ?? ''), 'unlesbare Ausgabe -> abfrage_ohne_ergebnis');
  const gut = await M.leseCliModelleImContainer(fakeDocker({ Config: { Labels: { eigen: '1' }, Image: 'node:22' }, State: { Running: true } },
    JSON.stringify({ runtime: 'claude', cli_version: 'x', katalog: { datei: 'k-cc.json', models: [{ id: 'claude-haiku-5-5', section: 'main', runtime: { family: 'haiku' } }] } }) + '\n'), cfg, 'claude', o);
  check(gut.quelle === 'datei' && gut.modelle[0]?.id === 'claude-haiku-5-5' && gut.hinweise.some(h => /ohne Agent-Runtime-Image/.test(h)), 'Erfolg + Hinweis fremdes Image');
  check(typeof M.CLI_MODELLE_SKRIPT === 'string' && !/identity|etag|auth\.json/.test(M.CLI_MODELLE_SKRIPT.replace(/\/\/.*$/gm, '')), 'Skript liest keine Konten-/Login-Felder');
});

check(network === 0, 'keine Netzwerkaufrufe');
console.log('P22-T61: ' + checks + ' Pruefungen, ' + failures.length + ' Fehler');
process.exit(failures.length ? 1 : 0);
