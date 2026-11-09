// P22-T332: Lauf endet mit dem Wrapper - reine Zuordnung (ohne DB). Faelle aus PG vom 09.11.2026 (Ergebnis-thought P22-T332):
// hauptagent (main), t248-abnahme (stop), koordinator-test-t107 (Absturz, zuletzt_aktiv +58 s), koordinator (PC-Lauf nach Container-Stop),
// koordinator-opus (neuer Lauf nach Absturz).
//   pnpm --filter @synapse/core build && node packages/core/tests/lauf-ende-p22-t332.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const L = await imp('packages/core/dist/services/lauf-ende.js');
const S = await imp('packages/core/dist/services/agent-profil-schalter.js');
let fail = 0;
const check = (ok, msg, extra) => { console.log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) { fail++; if (extra !== undefined) console.log('     ', JSON.stringify(extra)); } };

check(L.LAUF_ENDE_FUNKTION === 'lauf_ende_bei_wrapper_ende', 'Schaltername');
check(S.PROFIL_PRODUKT_FUNKTIONEN.includes('lauf_ende_bei_wrapper_ende') && S.NUR_AUSDRUECKLICH.includes('lauf_ende_bei_wrapper_ende')
  && S.NICHT_FREIGEGEBEN.includes('lauf_ende_bei_wrapper_ende') && !S.STANDARD_EIN.includes('lauf_ende_bei_wrapper_ende'), 'Schalter: Katalog, nur ausdruecklich, Std AUS');

const k = (o) => ({ lauf_id: 'l', identity_id: 'i', rolle: 'koordinator', wrapper_status: 'stopped', wrapper_pid: 1, ...o });
const e = (o) => L.laufEndeEntscheidung(k(o));
// t248-abnahme: Stop, Lauf vorher, letzte Aktivitaet = Ende
let r = e({ lauf_seit: '2026-11-09T09:47:57.066Z', zuletzt_aktiv: '2026-11-09T09:49:12.900Z', wrapper_ende: '2026-11-09 09:49:12.904+00' });
check(r.beenden && r.grund === 'wrapper_beendet', 'Stop: Lauf des Wrappers wird beendet', r);
// koordinator-test-t107: Absturz, zuletzt_aktiv 58 s nach dem letzten Lebenszeichen (Kulanz)
r = e({ wrapper_status: 'crashed', lauf_seit: '2026-11-09T08:55:04.880Z', zuletzt_aktiv: '2026-11-09T09:43:26.492Z', wrapper_ende: '2026-11-09T09:42:28.012Z' });
check(r.beenden, 'Absturz: Lauf wird beendet (Aktivitaet innerhalb der Kulanz)', r);
// koordinator: Container 08:57 gestoppt, PC-Lauf ab 15:44 -> bleibt
r = e({ lauf_seit: '2026-11-09T15:44:47.404Z', zuletzt_aktiv: '2026-11-09T15:59:08.515Z', wrapper_ende: '2026-11-09T08:57:48.784Z' });
check(!r.beenden && r.grund === 'lauf_nach_wrapper_ende', 'PC-Lauf nach Container-Stop bleibt aktiv', r);
// Lauf vor dem Ende, aber Identitaet danach weiter aktiv (anderer Prozess) -> bleibt
r = e({ lauf_seit: '2026-11-09T08:00:00Z', zuletzt_aktiv: '2026-11-09T09:10:00Z', wrapper_ende: '2026-11-09T09:00:00Z' });
check(!r.beenden && r.grund === 'aktiv_nach_wrapper_ende', 'Aktivitaet nach dem Ende (> Kulanz) -> bleibt', r);
check(L.laufEndeEntscheidung(k({ lauf_seit: '2026-11-09T08:00:00Z', zuletzt_aktiv: '2026-11-09T09:10:00Z', wrapper_ende: '2026-11-09T09:00:00Z' }), 11 * 60_000).beenden, 'Kulanz ist Parameter');
// main ausgenommen, lebender Wrapper, Ende unbekannt
check(e({ rolle: 'main', lauf_seit: '2026-11-09T09:48:32Z', zuletzt_aktiv: '2026-11-09T15:16:22Z', wrapper_ende: '2026-11-09T15:16:22Z' }).grund === 'main_ausgenommen', 'Main ausgenommen');
check(e({ wrapper_status: 'running', lauf_seit: '2026-11-09T08:00:00Z', zuletzt_aktiv: null, wrapper_ende: '2026-11-09T09:00:00Z' }).grund === 'wrapper_lebt', 'lebender Wrapper -> nichts');
check(e({ wrapper_status: 'idle', lauf_seit: null, zuletzt_aktiv: null, wrapper_ende: '2026-11-09T09:00:00Z' }).grund === 'wrapper_lebt', 'idle -> nichts');
check(e({ lauf_seit: '2026-11-09T08:00:00Z', zuletzt_aktiv: null, wrapper_ende: null }).grund === 'ende_unbekannt', 'Ende unbekannt -> nichts');
check(e({ lauf_seit: null, zuletzt_aktiv: null, wrapper_ende: '2026-11-09T09:00:00Z' }).beenden, 'ohne Zeiten am Lauf: Ende genuegt');
check(e({ lauf_seit: new Date('2026-11-09T08:00:00Z'), zuletzt_aktiv: new Date('2026-11-09T09:00:30Z'), wrapper_ende: '2026-11-09T09:00:00Z' }).beenden, 'Date-Werte aus pg');

console.log(fail ? `FEHLER: ${fail}` : 'OK lauf-ende-p22-t332');
process.exit(fail ? 1 : 0);
