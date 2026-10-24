/**
 * P22-T122: reine Logik des Runtime-Agenten-Panels + Schalter. Browser-Test der Darstellung macht rea1.
 *   pnpm --filter @synapse/core build && node --experimental-strip-types packages/web-ui/tests/runtime-agenten-panel-p22-t122.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/runtime-agenten-panel-logik.ts')).href);
const S = await import(pathToFileURL(join(repo, 'packages/core/dist/services/agent-profil-schalter.js')).href);

assert.ok(S.NUR_AUSDRUECKLICH.includes('runtime_agenten_panel_neu'), 'Schalter nur ausdruecklich (Std AUS)');
assert.ok(S.PROFIL_PRODUKT_FUNKTIONEN.includes('runtime_agenten_panel_neu'));

// Nur Abo, keine API-Option
assert.deepEqual([...L.PANEL_RUNTIMES], ['claude', 'codex']);
for (const api of ['anthropic-api', 'openai-api', 'api', 'gemini']) assert.match(L.pruefeModellWechsel({ runtime: api, modell: 'x', grund: 'ausreichend lang', optionen: [{ id: 'x' }] }), /Abo/);

// Ort: AUS -> unter Channels (Bestand), EIN -> beim Agententeam
assert.equal(L.panelSichtbarAn('channel', false), true); assert.equal(L.panelSichtbarAn('team', false), false);
assert.equal(L.panelSichtbarAn('channel', true), false); assert.equal(L.panelSichtbarAn('team', true), true);

// Modelloptionen aus dem Katalog
const kat = [{ id: 'opus', name: 'Opus', sichtbar: true }, { id: 'alt', name: 'Alt', sichtbar: false }, { id: 'opus', name: 'dup' }, { id: '' }, { id: 'sonnet', sichtbar: true }];
assert.deepEqual(L.modellOptionen(kat, null), [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'sonnet' }]);
assert.deepEqual(L.modellOptionen(kat, 'alt').map(o => o.id), ['opus', 'alt', 'sonnet'], 'aktuelles verstecktes Modell bleibt waehlbar');

// Pruefung vor dem Bestaetigungsschritt
const opt = L.modellOptionen(kat, null);
assert.equal(L.pruefeModellWechsel({ runtime: 'claude', modell: 'opus', grund: 'Wechsel fuer Test', optionen: opt }), null);
assert.match(L.pruefeModellWechsel({ runtime: 'claude', modell: '', grund: 'Wechsel fuer Test', optionen: opt }), /auswählen/);
assert.match(L.pruefeModellWechsel({ runtime: 'codex', modell: 'frei-erfunden', grund: 'Wechsel fuer Test', optionen: opt }), /Modellliste/);
assert.match(L.pruefeModellWechsel({ runtime: 'claude', modell: 'opus', grund: 'kurz', optionen: opt }), /10 Zeichen/);
// R1 (rea4 9d143cb0): Modell-Request nur bei aktiver Instanz, unveraenderter Generation und gleichem Projekt
assert.equal(L.modellRequestErlaubt(true, 3, 3, 'p', 'p'), true);
assert.equal(L.modellRequestErlaubt(false, 3, 4, 'p', 'p'), false, 'Unmount (aktiv=false, Generation++) -> kein Request');
assert.equal(L.modellRequestErlaubt(true, 3, 4, 'p', 'q'), false, 'Projektwechsel -> kein Request');
assert.equal(L.modellRequestErlaubt(true, 3, 3, 'p', 'q'), false, 'Dialog eines anderen Projekts');
// Simulierter Ablauf wie im Panel: Dialog oeffnen (g merken), Unmount-Cleanup, dann Rueckruf -> API-Zaehler bleibt 0
{ let aktiv = true, gen = 1, api = 0; const d = { project: 'p', g: gen };
  const ausfuehren = async () => { if (!L.modellRequestErlaubt(aktiv, d.g, gen, d.project, 'p')) return; api++; };
  aktiv = false; gen++; await ausfuehren(); assert.equal(api, 0, 'nach Unmount kein Modell-Request');
  aktiv = true; const d2 = { project: 'p', g: gen }; await (async () => { if (L.modellRequestErlaubt(aktiv, d2.g, gen, d2.project, 'p')) api++; })();
  assert.equal(api, 1, 'aktive Instanz sendet'); }

// R2: Katalogantwort an angefragte Runtime + juengste Anfrage gebunden; Validierung nur gegen gewaehlten Katalog
{ // Requests claude (g1), codex (g2); Antworten codex zuerst, dann spaet claude
  let gen = 0, aktuell = 'claude', liste = null; const g1 = ++gen; aktuell = 'codex'; const g2 = ++gen;
  const commit = (g, rt, l) => { if (L.katalogAntwortGilt(true, g, gen, rt, aktuell)) liste = l; };
  commit(g2, 'codex', { runtime: 'codex', modelle: [{ id: 'gpt-5-codex' }] });
  commit(g1, 'claude', { runtime: 'claude', modelle: [{ id: 'claude-opus' }] });
  assert.equal(liste.runtime, 'codex', 'spaete Claude-Antwort ueberschreibt Codex nicht');
  assert.equal(L.katalogAntwortGilt(false, g2, gen, 'codex', 'codex'), false, 'nach Unmount kein Commit');
  // Selbst wenn eine fremde Liste anlag: Validierung nur gegen Katalog der gewaehlten Runtime
  const fremd = { runtime: 'claude', modelle: [{ id: 'claude-opus', sichtbar: true }] };
  assert.deepEqual(L.katalogFuerRuntime(fremd, 'codex'), []);
  const opt2 = L.modellOptionen(L.katalogFuerRuntime(fremd, 'codex'), null);
  assert.notEqual(L.pruefeModellWechsel({ runtime: 'codex', modell: 'claude-opus', grund: 'Wechsel fuer Test', optionen: opt2 }), null, 'codex + claude-Modell abgewiesen');
  assert.deepEqual(L.katalogFuerRuntime(fremd, 'claude').map(m => m.id), ['claude-opus']);
  assert.deepEqual(L.katalogFuerRuntime(null, 'claude'), []); }
console.log('OK runtime-agenten-panel-p22-t122');
