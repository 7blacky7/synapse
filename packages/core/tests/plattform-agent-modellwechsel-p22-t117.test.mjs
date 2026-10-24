// P22-T117 (Fix nach Abnahme 4bc05815): reine Logik des Plattform-Modellwechsels (ohne DB/Netz). Befehl:
//   pnpm --filter @synapse/core build && pnpm --filter @synapse/agents build && node packages/core/tests/plattform-agent-modellwechsel-p22-t117.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const M = await imp('packages/core/dist/services/plattform-agent-modellwechsel.js');
const St = await imp('packages/core/dist/services/runtime-agenten-steuerung.js');
const S = await imp('packages/core/dist/services/agent-profil-schalter.js');
const A = await imp('packages/agents/dist/agent-lauf.js');
let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) fail++; };
const huelle = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

check(M.PLATTFORM_MODELLWECHSEL_FUNKTION === 'plattform_agent_modellwechsel', 'Schaltername');
check(S.NUR_AUSDRUECKLICH.includes('plattform_agent_modellwechsel'), 'Schalter nur ausdruecklich (Std AUS)');

// R3: keine API-Runtime fuer Plattform-Agenten (User-Entscheidung), auch nicht mit Kostenbestaetigung
check(M.kostenArt('claude') === 'abo' && M.kostenArt('codex') === 'abo' && M.kostenArt('free-pool') === 'api', 'Kostenart');
check(M.kostenEntscheidung('claude') === null && M.kostenEntscheidung('codex') === null, 'Abo frei');
check(M.kostenEntscheidung('free-pool') === 'api_runtime_nicht_verfuegbar' && M.kostenEntscheidung('openrouter') === 'api_runtime_nicht_verfuegbar', 'API-Runtime abgelehnt');

// R1: fachliches Ergebnis (MCP-Huelle) wird geprueft, nicht verworfen
check(St.jobErfolgreich({ status: 'done', result: huelle({ success: true }) }) === true, 'done + Huelle success:true -> Erfolg');
check(St.jobErfolgreich({ status: 'done', result: huelle({ success: false, message: 'x' }) }) === false, 'done + Huelle success:false -> KEIN Erfolg');
check(St.jobErfolgreich({ status: 'done', result: { content: [{ type: 'text', text: 'roh' }], isError: true } }) === false, 'isError -> KEIN Erfolg');
check(St.jobErfolgreich({ status: 'done', result: { success: false } }) === false, 'done + success:false (flach)');
check(St.jobErfolgreich({ status: 'failed', result: null }) === false, 'failed');
check(St.jobErfolgreich({ status: 'timeout' }) === false, 'timeout');
check(St.jobInhalt(huelle({ success: true, specialist: { wrapperPid: 7 } })).specialist.wrapperPid === 7, 'jobInhalt packt aus');

// R4: bestaetigte Starts nur aus erfolgreichen Ergebnissen; Namens- und Batch-Starts
const hash = 'a'.repeat(64);
const ok1 = huelle({ success: true, specialist: { name: 'koord-a', model: 'sonnet', effort: 'high', wrapperPid: 4711, plattform_lauf_hash: hash } });
const s1 = M.bestaetigteStarts('spawn', { name: 'koord-a', model: 'opus' }, ok1);
check(s1.length === 1 && s1[0].modell === 'sonnet' && s1[0].wrapper_pid === 4711 && s1[0].lauf_hash === hash && s1[0].name === 'koord-a', 'Namensstart: bestaetigter Start mit Generation');
check(M.bestaetigteStarts('spawn', { name: 'x' }, huelle({ success: false })).length === 0, 'gescheiterter Spawn -> nichts');
check(M.bestaetigteStarts('spawn', { name: 'x' }, null).length === 0, 'kein Ergebnis -> nichts');
const batch = { success: false, results: [ok1, huelle({ success: false }), huelle({ success: true, specialist: { name: 'b', model: 'haiku', wrapperPid: 9, plattform_lauf_hash: hash } })] };
const sb = M.bestaetigteStarts('spawn_batch', { specialists: [{ name: 'koord-a' }, { name: 'kaputt' }, { name: 'b', identity_id: '00000000-0000-0000-0000-00000000000b' }] }, batch);
check(sb.length === 2 && sb[1].name === 'b' && sb[1].identity_id === '00000000-0000-0000-0000-00000000000b', 'Batch: nur erfolgreiche Eintraege, Identitaet je Item');
check(M.bestaetigteStarts('stop', {}, ok1).length === 0, 'nur spawn/spawn_batch');
check((await M.merkeAusweisModellNachStart({ id: 'j', project: 'x', action: 'spawn', args: { name: 'a', model: 'm' }, target_identity_id: null, result: ok1 })) === 0, 'PC-Start (ohne target_runtime): nichts');
check((await M.merkeModellAbsicht({ project: 'x', action: 'stop', args: {} })) === false, 'Absicht nur fuer spawn');
check(!('merkeAusweisModellAusJob' in M) && !('merkeAusweisModell' in M), 'kein Schreiben bei Startabsicht mehr');

// R1-Rest (06068f63): vor dem Spawn darf kein Wrapper der Identitaet laufen - weder alte PID noch fremde Generation
check(M.spawnSperreNachStop(100, []) === null, 'nichts laeuft -> Spawn erlaubt');
check(M.spawnSperreNachStop(100, [{ status: 'stopped', wrapperPid: 100 }]) === null, 'alter Wrapper gestoppt -> Spawn erlaubt');
check(M.spawnSperreNachStop(100, [{ status: 'running', wrapperPid: 100 }]) === 'stop_nicht_bestaetigt', 'alte PID laeuft noch -> Abbruch');
check(M.spawnSperreNachStop(100, [{ status: 'stopped', wrapperPid: 100 }, { status: 'running', wrapperPid: 300 }]) === 'anderer_lauf_aktiv', 'Stop bestaetigt, aber fremder Wrapper PID300 laeuft -> Abbruch, kein Ersetzen');
check(M.spawnSperreNachStop(null, [{ status: 'idle', wrapperPid: 300 }]) === 'anderer_lauf_aktiv', 'Vorschau ohne Lauf, inzwischen anderer Lauf -> Abbruch');

// R2: Bindung an den AKTUELLEN Lauf (Nachweis + Generation + echter agent-runs-Pfad)
const id = '11111111-2222-3333-4444-555555555555';
const nachweis = 'f'.repeat(48);
const lh = createHash('sha256').update(nachweis).digest('hex');
check(M.plattformLaufHash(nachweis) === lh && M.plattformLaufHash('kurz') === null && M.plattformLaufHash(undefined) === null, 'Nachweis-Hash');
// Laufpfad wie im echten Identitaetslauf: innerhalb der Agent-Laufumgebung mit SYNAPSE_AGENT_IDENTITY_ID (unabhaengig von der Shell-Umgebung)
const sock = A.mitAgentLaufUmgebung('identity:' + id, 'synapse', { SYNAPSE_AGENT_IDENTITY_ID: id },
  () => path.join(A.agentLaufPfad('/workspace/synapse', 'identity:' + id), 'identity:' + id + '.sock'));
check(M.istIdentitaetsLaufSocket(sock, id), 'echter Laufpfad aus agentLaufPfad erkannt: ' + sock);
check(M.istIdentitaetsLaufSocket('/root/.synapse/agent-runs/' + id + '/x.sock', id), 'Container-Pfad /root/.synapse/agent-runs');
check(!M.istIdentitaetsLaufSocket('/projects/x/.synapse/sockets/a.sock', id), 'Altweg-Socket kein Identitaetslauf');
const m = { modell: 'sonnet', wrapper_pid: 4711, lauf_hash: lh };
const basis = { identity_id: id, rolle: 'koordinator', wrapper_status: 'running', wrapper_pid: 4711, socket_path: '/root/.synapse/agent-runs/' + id + '/s.sock', m };
check(M.modellSichtbarFuerLauf({ ...basis, lauf_hash: lh }) === true, 'POSITIV: tatsaechlicher Plattformlauf mit Nachweis -> Modell sichtbar');
check(M.modellSichtbarFuerLauf({ ...basis, lauf_hash: null }) === false, 'Ausweis extern uebernommen (chatgpt.com) bei STEHENGEBLIEBENEM altem Wrapper -> ausgeblendet');
check(M.modellSichtbarFuerLauf({ ...basis, lauf_hash: 'b'.repeat(64) }) === false, 'fremder/alter Nachweis -> ausgeblendet');
check(M.modellSichtbarFuerLauf({ ...basis, lauf_hash: lh, wrapper_pid: 4712 }) === false, 'andere Wrapper-Generation -> ausgeblendet');
check(M.modellSichtbarFuerLauf({ ...basis, lauf_hash: lh, wrapper_status: 'stopped' }) === false, 'Wrapper tot -> ausgeblendet');
check(M.modellSichtbarFuerLauf({ ...basis, lauf_hash: lh, rolle: 'main' }) === false, 'Main: eigener Weg');
check(M.modellSichtbarFuerLauf({ ...basis, lauf_hash: lh, m: { modell: 'sonnet', wrapper_pid: 4711 } }) === false, 'Altbestand ohne lauf_hash -> ausgeblendet');
check((await M.ausweisModellFuerAnmeldung(id, 'x', undefined)) === null, 'Anmeldung ohne Nachweis -> null (ohne DB)');
check(M.PLATTFORM_LAUF_HEADER === 'x-synapse-plattform-lauf' && M.PLATTFORM_LAUF_ENV === 'SYNAPSE_PLATTFORM_LAUF', 'Header/Env-Namen');

// R5: gemeinsamer Tool-Vertrag enthaelt runtime_modellwechsel
check(St.RUNTIME_TOOL_AKTIONEN.includes('runtime_modellwechsel'), 'runtime_modellwechsel im gemeinsamen Vertrag (stdio+REST)');
check(/nur Abo/.test(St.RUNTIME_TOOL_PROPERTIES.runtime.description), 'Schema: nur Abo-Runtimes');
const r = await St.fuehreRuntimeAgentenAktion({ action: 'runtime_modellwechsel', identity_id: 'kaputt' }, { art: 'user' });
check(r && r.success === false && r.error === 'identity_id_fehlt', 'Dispatcher leitet runtime_modellwechsel an den Dienst (Fachfehler sauber)');

console.log(fail ? `\n${fail} FEHLER` : '\nALLE OK');
process.exit(fail ? 1 : 0);
