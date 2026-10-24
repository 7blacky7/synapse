/**
 * P22-T119: (1) Zielmodell vs Selbstauskunft, (2) Schalter Laufbindung, (3) echter wake-Absender. Rein, ohne DB/Netz.
 *   pnpm --filter @synapse/core build && node packages/core/tests/zielmodell-absender-p22-t119.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const F = await load('packages/core/dist/services/agent-selbstfelder.js');
const S = await load('packages/core/dist/services/agent-profil-schalter.js');
const M = await load('packages/core/dist/services/plattform-agent-modellwechsel.js');
const W = await load('packages/core/dist/services/wake-absender.js');

for (const f of ['ausweis_zielmodell', 'modell_lauf_bindung', 'wake_echter_absender']) assert.ok(S.NUR_AUSDRUECKLICH.includes(f), f + ' nur ausdruecklich (Std AUS)');

// (1) Reviewerfall: Main (Opus) spawnt mit Haiku
const opus = 'claude-opus-5-5', haiku = 'claude-haiku-5-5';
assert.deepEqual(F.modellNachBezeugung('specialist', 'spawn', haiku, opus, false), { model: opus, art: 'unveraendert_bezeugt' }, 'Schalter AUS: Bestand (Aufrufer-Modell)');
assert.deepEqual(F.modellNachBezeugung('specialist', 'spawn', haiku, opus, true), { model: haiku, art: 'zielmodell_angefordert' }, 'EIN: angefordertes Haiku gewinnt');
assert.equal(F.modellNachBezeugung('specialist', 'runtime_modellwechsel', haiku, opus, true).model, haiku, 'runtime_modellwechsel ebenso');
assert.deepEqual(F.modellNachBezeugung('specialist', 'spawn', '', opus, true), { model: opus, art: 'zielmodell_rueckfall' }, 'ohne Angabe: Aufrufer-Modell als Rueckfall');
assert.equal(F.modellNachBezeugung('specialist', 'spawn', null, opus, true).model, opus);
// Ursprung erhalten (P22-T10): Selbstauskunft bei chat register/anmelden wird weiter bezeugt
assert.deepEqual(F.modellNachBezeugung('chat', 'anmelden', 'gpt-x', opus, true), { model: opus, art: 'selbstauskunft_bezeugt' });
assert.equal(F.modellNachBezeugung('chat', 'register', 'gpt-x', opus, true).model, opus);
assert.equal(F.feldBedeutung('specialist', 'spawn', 'model'), 'fach', 'spawn.model ist Zielmodell');

// (2) Schalter Laufbindung: Name + Leser wirft nie (ohne DB -> AUS)
assert.equal(M.MODELL_LAUF_BINDUNG_FUNKTION, 'modell_lauf_bindung');
assert.equal(await M.modellLaufBindungAktiv('x'), false, 'Lesefehler -> AUS');

// (3) Absender
assert.deepEqual(W.waehleWakeAbsender(false, { agent_id: 'hauptagent', project: 'synapse-hauptagent' }, 'x'), { absender: 'rest-api', quelle: 'schalter_aus', principal_project: null }, 'AUS: Bestand rest-api');
assert.deepEqual(W.waehleWakeAbsender(true, { agent_id: 'hauptagent', project: 'synapse-hauptagent' }, 'gpt-abc'), { absender: 'hauptagent', quelle: 'principal', principal_project: 'synapse-hauptagent' }, 'EIN: Ausweis-Principal');
assert.deepEqual(W.waehleWakeAbsender(true, null, 'gpt-abc'), { absender: 'gpt-abc', quelle: 'aufrufer', principal_project: null }, 'ohne Ausweis: Transport-Aufrufer');
assert.deepEqual(W.waehleWakeAbsender(true, null, null), { absender: 'rest-api', quelle: 'rest_api_rueckfall', principal_project: null }, 'ohne Aufrufer: rest-api');
assert.equal(W.waehleWakeAbsender(true, { agent_id: '  ' }, '').absender, 'rest-api');
console.log('OK zielmodell-absender-p22-t119');
