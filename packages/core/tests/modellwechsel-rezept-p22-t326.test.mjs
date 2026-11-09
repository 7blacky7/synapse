// P22-T326 (User 09.11.2026, Befund 1994b888): Modellwechsel ohne Startrezept, externer Lauf, Rueckfall - reine Logik (ohne DB/Netz).
// Herkunft: Fehlerfall koordinator/synapse 09.11. (kein Spawn-Job, gescheiterter Spawn als Rezept, stiller Ersatz des PC-Laufs, kein Rueckfall).
//   pnpm --filter @synapse/core build && node packages/core/tests/modellwechsel-rezept-p22-t326.test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const M = await imp('packages/core/dist/services/plattform-agent-modellwechsel.js');
const S = await imp('packages/core/dist/services/agent-profil-schalter.js');
let fail = 0;
const check = (ok, msg, extra) => { console.log((ok ? 'OK   ' : 'FAIL ') + msg); if (!ok) { fail++; if (extra !== undefined) console.log('     ', JSON.stringify(extra)); } };
const huelle = v => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

// Schalter: Katalog, nur ausdruecklich, nicht freigegeben (Standard AUS)
check(M.MODELLWECHSEL_REZEPT_FUNKTION === 'modellwechsel_rezept_erzeugen', 'Schaltername');
check(S.PROFIL_PRODUKT_FUNKTIONEN.includes('modellwechsel_rezept_erzeugen'), 'Schalter im Katalog');
check(S.NUR_AUSDRUECKLICH.includes('modellwechsel_rezept_erzeugen'), 'Schalter nur ausdruecklich');
check(S.NICHT_FREIGEGEBEN.includes('modellwechsel_rezept_erzeugen'), 'Schalter nicht freigegeben');
check(!S.STANDARD_EIN.includes('modellwechsel_rezept_erzeugen'), 'Schalter Standard AUS');

// F1: Rezeptwahl
const id = '2324e2ed-19ad-42ed-92c0-6782b6023ec7';
const ident = { identity_id: id, agent_id: 'koordinator', project: 'synapse', rolle: 'koordinator' };
const fehl = { args: { name: 'koordinator', model: 'claude-opus-5-5', target_runtime: 'claude' }, status: 'done', result: huelle({ success: false, message: 'E2BIG' }) };
const gut = { args: { name: 'koordinator', model: 'codex/gpt-6.1-terra', target_runtime: 'codex' }, status: 'done', result: huelle({ success: true, specialist: { wrapperPid: 7 } }) };
check(M.waehleStartrezept([], ident, false) === null, 'AUS: ohne Spawn-Job -> null (kein_startrezept wie bisher)');
const ausLetzter = M.waehleStartrezept([fehl, gut], ident, false);
check(ausLetzter?.quelle === 'spawn_letzter' && ausLetzter.rezept === fehl.args, 'AUS: juengster Job (Bestand, auch gescheitert)');
const ok = M.waehleStartrezept([fehl, gut], ident, true);
check(ok?.quelle === 'spawn_ok' && ok.rezept === gut.args, 'EIN: gescheiterter Spawn (E2BIG) zaehlt nicht, letzter erfolgreicher gewinnt', ok);
const nurFehl = M.waehleStartrezept([fehl], ident, true);
check(nurFehl?.quelle === 'spawn_letzter' && nurFehl.rezept === fehl.args, 'EIN: nur gescheiterte -> juengster');
check(M.waehleStartrezept([{ args: { x: 1 }, status: 'failed', result: null }], ident, true)?.quelle === 'spawn_letzter', 'EIN: Status failed -> nicht spawn_ok');
const erz = M.waehleStartrezept([], ident, true);
check(erz?.quelle === 'erzeugt', 'EIN: ohne Spawn-Job -> erzeugt');
check(erz?.rezept.identity_id === id && erz.rezept.name === 'identity:' + id && erz.rezept.project === 'synapse' && erz.rezept.keep_alive === true, 'erzeugtes Rezept: Identitaet, Name, Projekt, keep_alive', erz);
check(erz?.rezept.task === M.ERZEUGTER_AUFTRAG && /Koordinator synapse/.test(String(erz.rezept.expertise)), 'erzeugtes Rezept: Auftrag + Expertise Koordinator');
check(!('model' in (erz?.rezept ?? {})) && !('target_runtime' in (erz?.rezept ?? {})), 'erzeugtes Rezept: Modell/Runtime setzt erst der Wechsel');
const spez = M.waehleStartrezept([], { ...ident, agent_id: 'aldi-dienst', rolle: 'spezialist' }, true);
check(String(spez?.rezept.expertise) === 'aldi-dienst (spezialist)', 'erzeugtes Rezept: Expertise fuer Nicht-Koordinator');
check(M.waehleStartrezept([{ args: null }], ident, true)?.quelle === 'erzeugt', 'Jobs ohne args werden ignoriert');

// F2: externer aktiver Lauf
const jetzt = Date.parse('2026-11-09T09:00:00Z');
const frist = 10 * 60_000;
const pcLauf = { herkunftsort: 'CLI (Claude Code)', beginn_art: 'anmelden', erstellt_am: '2026-11-09T07:00:00Z', context_epoch: 50, zuletzt_aktiv: new Date(jetzt - 60_000) };
const ext = M.externerLaufAktiv(pcLauf, false, jetzt, frist);
check(ext?.herkunftsort === 'CLI (Claude Code)' && ext.context_epoch === 50 && ext.seit_ms === 60_000, 'PC-Lauf vor 1 min aktiv -> extern', ext);
check(M.externerLaufAktiv(pcLauf, true, jetzt, frist) === null, 'Plattform-Wrapper laeuft -> kein externer Lauf (normaler Stop)');
check(M.externerLaufAktiv(null, false, jetzt, frist) === null, 'kein aktiver Lauf -> null');
check(M.externerLaufAktiv({ ...pcLauf, zuletzt_aktiv: new Date(jetzt - 11 * 60_000) }, false, jetzt, frist) === null, 'zuletzt aktiv ausserhalb der Frist -> null');
check(M.externerLaufAktiv({ ...pcLauf, zuletzt_aktiv: null, erstellt_am: new Date(jetzt - 30_000).toISOString() }, false, jetzt, frist)?.seit_ms === 30_000, 'ohne zuletzt_aktiv zaehlt erstellt_am');
check(M.externerLaufAktiv({ ...pcLauf, herkunftsort: null }, false, jetzt, frist)?.herkunftsort === 'extern (Ort unbekannt)', 'Ort unbekannt benannt');
check(M.externerLaufAktiv({ ...pcLauf, herkunftsort: null, beginn_art: 'uebernahme' }, false, jetzt, frist)?.herkunftsort === 'uebernommen', 'Uebernahme benannt');
check(M.externerLaufAktiv({ ...pcLauf, zuletzt_aktiv: 'kaputt', erstellt_am: null }, false, jetzt, frist) === null, 'ungueltige Zeiten -> null');

// F3: Rueckfall-Entscheidung
const basis = { stopOk: true, altModell: 'codex/gpt-6.1-terra', rezeptQuelle: 'spawn_ok', lebend: 0 };
check(M.rueckfallHindernis(basis) === null, 'Stop ok, altes Modell, nichts lebt -> Rueckfall starten');
check(M.rueckfallHindernis({ ...basis, stopOk: false }) === 'kein_stop', 'ohne Stop kein Rueckfall');
check(M.rueckfallHindernis({ ...basis, rezeptQuelle: 'erzeugt' }) === 'kein_altes_rezept', 'erzeugtes Rezept -> kein Rueckfall');
check(M.rueckfallHindernis({ ...basis, altModell: null }) === 'kein_altes_modell', 'ohne altes Modell kein Rueckfall');
check(M.rueckfallHindernis({ ...basis, lebend: 1 }) === 'anderer_lauf_aktiv', 'lebender Wrapper -> kein zweiter Start');

// F3: Profilstand wiederherstellen (query injiziert)
const aufrufe = [];
const q = async (sql, p) => { aufrufe.push({ sql, p }); return { rowCount: 1 }; };
const stand = { modell_bestaetigt: 'codex/gpt-6.1-terra', plattform_modell: { modell: 'codex/gpt-6.1-terra', wrapper_pid: 7, effort: null }, plattform_modell_absicht: null };
check(await M.stelleProfilStandHer(id, stand, q) === true, 'Profilstand: geschrieben');
const a = aufrufe[0];
check(a.p[0] === id && a.p[1] === 'codex/gpt-6.1-terra', 'Profilstand: modell_bestaetigt zurueck', a.p);
check(a.p[2] === JSON.stringify(stand.plattform_modell) && a.p[3] === null, 'Profilstand: plattform_modell exakt (auch null-Felder), Absicht entfernt', a.p);
check(/rolle <> 'main'/.test(a.sql) && /- 'plattform_modell_absicht'/.test(a.sql), 'Profilstand: nie Main, Absicht-Schluessel wird entfernt');
check(await M.stelleProfilStandHer(id, stand, async () => { throw new Error('pg weg'); }) === false, 'Profilstand: Fehler -> false, wirft nicht');
check(await M.stelleProfilStandHer(id, stand, async () => ({ rowCount: 0 })) === false, 'Profilstand: keine Zeile -> false');

console.log(fail ? `FEHLER: ${fail}` : 'OK modellwechsel-rezept-p22-t326');
process.exit(fail ? 1 : 0);
