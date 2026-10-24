// P22-T117: reine Logik des Plattform-Modellwechsels (ohne DB/Netz). Befehl:
//   pnpm --filter @synapse/core build && node packages/core/tests/plattform-agent-modellwechsel-p22-t117.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const M = await import(pathToFileURL(path.join(root, 'packages/core/dist/services/plattform-agent-modellwechsel.js')).href);
const S = await import(pathToFileURL(path.join(root, 'packages/core/dist/services/agent-profil-schalter.js')).href);
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) fail++; };

check(M.PLATTFORM_MODELLWECHSEL_FUNKTION === 'plattform_agent_modellwechsel', 'Schaltername');
check(S.NUR_AUSDRUECKLICH.includes('plattform_agent_modellwechsel'), 'Schalter nur ausdruecklich (Std AUS, nicht in alle)');
check(M.kostenArt('claude') === 'abo' && M.kostenArt('codex') === 'abo', 'claude/codex = Abo');
check(M.kostenArt('free-pool') === 'api' && M.kostenArt('openrouter') === 'api', 'andere Runtimes = API');
const user = { art: 'user' }, koord = { art: 'identity', identity_id: '00000000-0000-0000-0000-000000000001' };
check(M.kostenEntscheidung('claude', koord, false) === null, 'Abo: Koordinator frei');
check(M.kostenEntscheidung('codex', user, false) === null, 'Abo: User frei');
check(M.kostenEntscheidung('free-pool', koord, true) === 'kosten_rueckfrage_user', 'API: Koordinator -> Rueckfrage beim User (auch mit kosten_bestaetigt)');
check(M.kostenEntscheidung('free-pool', null, false) === 'kosten_rueckfrage_user', 'API: ohne Akteur -> Rueckfrage');
check(M.kostenEntscheidung('free-pool', user, false) === 'kosten_bestaetigung_fehlt', 'API: User ohne Bestaetigung abgelehnt');
check(M.kostenEntscheidung('free-pool', user, true) === null, 'API: User mit Bestaetigung erlaubt');
const m = { modell: 'sonnet' };
check(M.modellSichtbarFuerLauf({ rolle: 'koordinator', start_ort: 'container', wrapper_status: 'running', socket_path: '/projects/x/.synapse/a.sock', m }) === true, 'Plattform-Lauf: Modell sichtbar');
check(M.modellSichtbarFuerLauf({ rolle: 'koordinator', start_ort: 'extern', wrapper_status: null, socket_path: null, m }) === false, 'Ausweis extern (chatgpt.com): ausgeblendet');
check(M.modellSichtbarFuerLauf({ rolle: 'koordinator', start_ort: 'container', wrapper_status: 'stopped', socket_path: '/projects/x/a.sock', m }) === false, 'Container-Ort ohne lebenden Wrapper: ausgeblendet');
check(M.modellSichtbarFuerLauf({ rolle: 'koordinator', start_ort: 'container', wrapper_status: 'running', socket_path: '/home/u/.synapse/a.sock', m }) === false, 'Wrapper am PC: ausgeblendet');
check(M.modellSichtbarFuerLauf({ rolle: 'main', start_ort: 'container', wrapper_status: 'running', socket_path: '/projects/x/a.sock', m }) === false, 'Main: eigener Weg');
check(!('KEIN_MODELL_HINWEIS' in M), 'kein Hinweistext mehr');
check((await M.merkeAusweisModellAusJob({ project: 'x', action: 'spawn', args: { identity_id: '00000000-0000-0000-0000-000000000002', model: 'sonnet' } })) === false, 'PC-Start (ohne target_runtime) fuehrt kein Modell');
check((await M.merkeAusweisModellAusJob({ project: 'x', action: 'stop', args: {} })) === false, 'nur spawn-Jobs merken');
check((await M.merkeAusweisModellAusJob({ project: 'x', action: 'spawn', args: { name: 'ohne-identitaet', model: 'sonnet' } })) === false, 'ohne Identitaet nichts merken');

console.log(fail ? `\n${fail} FEHLER` : '\nALLE OK');
process.exit(fail ? 1 : 0);
