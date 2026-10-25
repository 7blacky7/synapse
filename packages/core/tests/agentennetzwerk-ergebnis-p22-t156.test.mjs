/**
 * P22-T156: Klassifikation der Ergebnisart (core services/agentennetzwerk-ergebnis.ts). Keine DB, kein Netz.
 *   pnpm -C packages/core build && node packages/core/tests/agentennetzwerk-ergebnis-p22-t156.test.mjs
 * A jeder Code der Tabelle -> seine Art (ok=false und ok=true mit success:false); B Entscheidungen R2/R3; C echte Freitexte aus tool_calls
 * (Entwurf 7cf4ac63) -> normalisierter Code; D unbekannt -> sonstiges, geworfene Ausnahme -> serverfehler; E Erfolg/leer/Rueckfrage;
 * F nie Rohtext im Code; G netzwerkEreignis traegt ergebnis_art/fehler_code und keine Ausschnittsfelder.
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const E = await load('packages/core/dist/services/agentennetzwerk-ergebnis.js');
let n = 0;
const ok = (v, label) => { assert(v, label); n++; };
const k = (r) => E.netzwerkErgebnis({ tool_name: 'mcp__synapse__shell', action: 'exec', ...r });

// A Tabelle vollstaendig
for (const [code, art] of Object.entries(E.NETZ_FEHLERCODE_ART)) {
  const erwartet = art === 'erfolg' ? { ergebnis_art: 'erfolg', fehler_code: null } : { ergebnis_art: art, fehler_code: code };
  assert.deepEqual(k({ ok: false, error: code }), erwartet, 'Fehlerspalte ' + code); n++;
  assert.deepEqual(k({ ok: true, erfolg_false: true, ergebnis_code: code }), erwartet, 'success:false ' + code); n++;
}
ok(E.NETZ_ERGEBNIS_ARTEN.length === 9, 'neun Arten');
for (const art of ['falsch_aufgerufen', 'gesperrt', 'nicht_gefunden', 'konflikt', 'serverfehler', 'wartet'])
  ok(Object.values(E.NETZ_FEHLERCODE_ART).includes(art), 'Art ' + art + ' hat Codes');

// B Koordinator-Entscheidungen
assert.deepEqual(E.netzwerkErgebnis({ ok: false, tool_name: 'intern', action: 'db_lesen', error: 'sql_fehler' }), { ergebnis_art: 'falsch_aufgerufen', fehler_code: 'sql_fehler' }, 'R2 db_lesen'); n++;
assert.deepEqual(E.netzwerkErgebnis({ ok: false, tool_name: 'files', action: 'plan', error: 'sql_fehler' }), { ergebnis_art: 'serverfehler', fehler_code: 'sql_fehler' }, 'R2 sonst'); n++;
ok(k({ ok: true, erfolg_false: true, ergebnis_code: 'shell_anleitung' }).ergebnis_art === 'gesperrt', 'R3 shell_anleitung');
ok(k({ ok: true, erfolg_false: true, ergebnis_code: 'build_pruefung_eingereiht' }).ergebnis_art === 'erfolg', 'R3 build_pruefung_eingereiht');
ok(k({ ok: false, error: 'duplicate key value violates unique constraint "idx_plans_ein_aktiver"' }).ergebnis_art === 'serverfehler', 'R2 DB-Ausnahme');

// C echte Freitexte
const frei = [
  ['Parameter "file_path" ist erforderlich', 'falsch_aufgerufen', 'parameter_erforderlich'],
  ['Parameter "file_path" oder "path" ist erforderlich fuer action "file"', 'falsch_aufgerufen', 'parameter_erforderlich'],
  ['ops[] muss mindestens eine Operation enthalten', 'falsch_aufgerufen', 'parameter_erforderlich'],
  ['scope \'project\' braucht project', 'falsch_aufgerufen', 'parameter_erforderlich'],
  ['channel_name darf nicht leer sein', 'falsch_aufgerufen', 'parameter_erforderlich'],
  ['Unbekannte channel action: "x"', 'falsch_aufgerufen', 'action_unbekannt'],
  ['unbekannter_parameter: paths', 'falsch_aufgerufen', 'unbekannter_parameter'],
  ['Version(en) nicht gefunden in diesem Projekt', 'nicht_gefunden', 'nicht_gefunden_text'],
  ['Plan "18" nicht gefunden im Projekt synapse. Vorhanden: P1 "synapse"', 'nicht_gefunden', 'nicht_gefunden_text'],
  ['Not Found', 'nicht_gefunden', 'nicht_gefunden_text'],
  ['Datei nicht im Index: cpp/README.md', 'nicht_gefunden', 'nicht_im_index'],
  ['Kein verbundener aktiver Wait von sol-3 fuer Plan 28000', 'konflikt', 'wait_fehlt'],
  ['Kein aktiver Wait von luna-2 fuer Primaeragent sol-3', 'konflikt', 'wait_fehlt'],
  ['Syntaxfehler in coedit-test/zz.php Z.1: Syntaxfehler: syntax error', 'konflikt', 'syntaxfehler'],
  ['Platte weicht von PostgreSQL ab. Nichts geschrieben.', 'konflikt', 'platte_weicht_ab'],
  ['1/3 Edits passen nicht — nichts geschrieben in "a.ts"', 'konflikt', 'edits_passen_nicht'],
  ['Plan 123 ist nicht offen', 'konflikt', 'zustand_passt_nicht'],
  ['Nicht berechtigt: nur Autor oder Koordinator darf Versionen zuordnen', 'gesperrt', 'nicht_berechtigt'],
  ['This operation was aborted', 'serverfehler', 'zeitueberschreitung'],
  ['spawn bash ENOENT', 'serverfehler', 'ausnahme'],
  ['invalid input syntax for type bigint: "x"', 'serverfehler', 'datenbankfehler'],
  ['get_stream via REST-API noch nicht implementiert', 'serverfehler', 'nicht_implementiert'],
];
for (const [text, art, code] of frei) assert.deepEqual(k({ ok: false, error: text }), { ergebnis_art: art, fehler_code: code }, text), n++;
// stdio-Weg: Fehlerspalte enthaelt das JSON der Antwort
assert.deepEqual(k({ ok: false, error: '{"success":false,"error":"recht_fehlt","message":"x"}' }), { ergebnis_art: 'gesperrt', fehler_code: 'recht_fehlt' }, 'JSON in Fehlerspalte'); n++;
// success:false nur mit message (ok=true)
assert.deepEqual(k({ ok: true, erfolg_false: true, ergebnis_meldung: 'Datei nicht gefunden: ui-screenshots/a.png' }), { ergebnis_art: 'nicht_gefunden', fehler_code: 'nicht_gefunden_text' }, 'nur message'); n++;
assert.deepEqual(k({ ok: true, erfolg_false: true, ergebnis_status: 'nicht_gefunden', ergebnis_meldung: 'Gedanke "fc85" nicht gefunden' }), { ergebnis_art: 'nicht_gefunden', fehler_code: 'nicht_gefunden' }, 'status nicht_gefunden'); n++;

// D unbekannt
assert.deepEqual(k({ ok: true, erfolg_false: true, ergebnis_code: 'voellig_neu_x' }), { ergebnis_art: 'sonstiges', fehler_code: 'voellig_neu_x' }, 'unbekannter Code'); n++;
assert.deepEqual(k({ ok: true, erfolg_false: true }), { ergebnis_art: 'sonstiges', fehler_code: 'ohne_code' }, 'ohne Code'); n++;
assert.deepEqual(k({ ok: true, erfolg_false: true, ergebnis_status: 'rejected' }), { ergebnis_art: 'sonstiges', fehler_code: 'ohne_code' }, 'Status ist kein Code'); n++;
assert.deepEqual(k({ ok: false, error: 'Irgendwas ist kaputt gegangen' }), { ergebnis_art: 'serverfehler', fehler_code: 'ausnahme' }, 'geworfen ohne Muster'); n++;

// E Erfolg, leer, Rueckfrage
assert.deepEqual(k({ ok: true }), { ergebnis_art: 'erfolg', fehler_code: null }, 'erfolg'); n++;
assert.deepEqual(k({ ok: true, ergebnis_leer: true }), { ergebnis_art: 'leer', fehler_code: null }, 'leer'); n++;
assert.deepEqual(k({ ok: true, rueckfrage: true }), { ergebnis_art: 'wartet', fehler_code: 'shell_rueckfrage' }, 'Rueckfrage-Vermerk'); n++;
assert.deepEqual(k({ ok: true, rueckfrage: true, ergebnis_code: 'bestaetigung_unbekannt' }), { ergebnis_art: 'nicht_gefunden', fehler_code: 'bestaetigung_unbekannt' }, 'Rueckfrage mit Code'); n++;
ok(k({ ok: true, erfolg_false: true, ergebnis_code: 'waiting_for_contributors' }).ergebnis_art === 'wartet', 'files wartet');
assert.deepEqual(k({ ok: true, erfolg_false: true, anleitung: true, ergebnis_status: 'rejected' }), { ergebnis_art: 'gesperrt', fehler_code: 'shell_anleitung' }, 'R3 Anleitung ohne error-Feld'); n++;

// F nie Rohtext
for (const [text] of frei) ok(/^[a-z][a-z0-9_]{1,39}$/.test(k({ ok: false, error: text }).fehler_code), 'normalisiert: ' + text.slice(0, 30));
ok(E.netzFehlerCode('Datei /home/x nicht gefunden') === null && E.netzFehlerCode('recht_fehlt') === 'recht_fehlt', 'netzFehlerCode nur Codeform');

// G Ereignis-Vertrag
const N = await load('packages/core/dist/services/agentennetzwerk.js');
const ev = N.netzwerkEreignis({ id: '1', ts: new Date().toISOString(), project: 'p', agent_id: 'a', source: 'cloud', tool_name: 'shell', action: 'exec',
  args_preview: '{"action":"exec","timeout":5}', ok: false, error: 'unbekannter_parameter', duration_ms: 1, is_mutation: false,
  ergebnis_meldung: 'Pfad /geheim/x', ergebnis_code: 'unbekannter_parameter', erfolg_false: true, rueckfrage: false });
ok(ev.ergebnis_art === 'falsch_aufgerufen' && ev.fehler_code === 'unbekannter_parameter', 'G Ereignis traegt Art/Code');
ok(!JSON.stringify(ev).includes('/geheim/') && !('ergebnis_meldung' in ev) && !('error' in ev), 'G kein Rohtext im Ereignis');
ok(N.netzwerkEreignis({ id: '2', ts: new Date().toISOString(), project: 'p', agent_id: null, source: 'cloud', tool_name: 'x', action: 'y', args_preview: null, ok: true, error: null, duration_ms: 1, is_mutation: false }).agent === '', 'P22-T155: agent nie aus source');
ok(N.netzwerkErfolg({ ergebnis_art: 'leer' }) && !N.netzwerkErfolg({ ergebnis_art: 'wartet' }), 'netzwerkErfolg');
ok(['fehler_effekte', 'fehler_effekt_ms', 'wartet_halte_ms'].every((x) => x in N.NETZWERK_EINSTELLUNGEN) && N.NETZWERK_EINSTELLUNGEN.fehler_effekte.standard === 1, 'Einstellungen im Katalog');
// P22-T162: Katalog stern_max_promille 1000..2000, Standard 1000 (Abweisung ausserhalb ueber die generische Grenzpruefung von admin(agentennetzwerk)).
const sm = N.NETZWERK_EINSTELLUNGEN.stern_max_promille;
ok(sm && sm.standard === 1000 && sm.min === 1000 && sm.max === 2000, 'P22-T162 Katalog stern_max_promille');
console.log('P22-T156 Klassifikation PASS ' + n + ' Pruefungen');
