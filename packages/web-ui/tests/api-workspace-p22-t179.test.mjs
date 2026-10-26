/**
 * P22-T179 Nachtrag (Koordinator 26.10.2026 nach Live-Probe 04dd2649): Workspace-ID des Anthropic-Keys in der Web-UI - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/api-workspace-p22-t179.test.mjs
 * WARUM: Ein Key ohne Workspace-Zuordnung wird von Anthropic nur mit Header anthropic-workspace-id angenommen. Der Server setzt ihn aus
 *   Env SYNAPSE_ANTHROPIC_WORKSPACE_ID; die UI zeigt in der Statuszeile NUR "Workspace-ID gesetzt ja/nein" und erklaert den Fehlercode
 *   api_workspace_fehlt beim Key-Test.
 * Geprueft: components/api-budget-logik.ts apiKeyStandZeile (ja/nein-Zusatz, alter Server ohne Feld unveraendert), apiKeyTestText.
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/api-budget-logik.ts')).href);
let n = 0;
const ok = (wert, label, info) => {
  if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + JSON.stringify(info).slice(0, 500) : ''));
  assert.ok(wert, label); n++;
};
const STAND = (o = {}) => ({
  vorhanden: true, quelle: 'env', gesetzt_am: null, letzte4: 'ab12',
  webui: { gespeichert: false, gesetzt_am: null, letzte4: null, lesbar: false }, env: { vorhanden: true, letzte4: 'ab12' },
  schalter: { aktiv: false, quelle: 'standard', letzter_fehler: null }, tresor: { vorhanden: false, schluessel_id: null }, fehler: null, debug: 'x', ...o,
});

let z = L.apiKeyStandZeile(STAND({ workspace_id_gesetzt: true }));
ok(z.wert === 'ja' && /Workspace-ID gesetzt: ja\./.test(z.text), 'P22-T179 api-budget-logik.ts apiKeyStandZeile: Key ja, Workspace-ID gesetzt ja', z);
z = L.apiKeyStandZeile(STAND({ workspace_id_gesetzt: false }));
ok(/Workspace-ID gesetzt: nein\./.test(z.text) && !/wrkspc/.test(z.text), 'P22-T179 apiKeyStandZeile: Workspace-ID nein, nie ein Wert', z);
z = L.apiKeyStandZeile(STAND({ vorhanden: false, quelle: null, letzte4: null, workspace_id_gesetzt: false }));
ok(z.wert === 'nein' && /secrets\.env/.test(z.text) && /Workspace-ID gesetzt: nein/.test(z.text), 'P22-T179 apiKeyStandZeile: kein Key (Schalter AUS) + Workspace nein', z);
z = L.apiKeyStandZeile(STAND());
ok(!/Workspace/.test(z.text), 'P22-T179 apiKeyStandZeile: aelterer Server ohne Feld -> kein Zusatz (Bestand T176)', z);
const t = L.apiKeyTestText({ ok: false, quelle: 'env', http_status: 400, fehler: 'api_workspace_fehlt', dauer_ms: 5 });
ok(/keinem Workspace zugeordnet/.test(t) && /SYNAPSE_ANTHROPIC_WORKSPACE_ID/.test(t), 'P22-T179 apiKeyTestText: api_workspace_fehlt nennt, wo die ID hingehoert', t);
ok(L.apiKeyTestText({ ok: false, quelle: 'env', http_status: 401, fehler: 'api_zugang_ungueltig', dauer_ms: 5 }) === 'Key-Test fehlgeschlagen: api_zugang_ungueltig (HTTP 401).',
  'P22-T179 apiKeyTestText: andere Fehler unveraendert (Bestand T176)');
console.log('PASS P22-T179 Web-UI Workspace-ID ' + n + ' Pruefungen');
