/**
 * P22-T176: API-Key in der Web-UI - Logik und Einbau ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/api-key-p22-t176.test.mjs
 * Sichert ab (Task P22-T176, User 26.10.2026 ~01:30):
 *   A components/api-budget-logik.ts: apiKeyStandZeile (Quelle, gesetzt am, letzte 4; 'nein' je nach Schalter), apiKeyTestText, apiKeyFormOk.
 *   B components/ApiKeyFeld.tsx (Render mit Stub-React): Schalter AUS ohne Eingabefeld; EIN Passwortfeld ohne Autofill, Hinterlegen gesperrt
 *     ohne Grund bzw. Form, Entfernen nur mit gespeichertem Key; Feld wird nur nach Erfolg geleert; Routen nur /api/main-agent/api/key*;
 *     kein Browser-Speicher; Debugzeile.
 *   C components/ApiBudgetPanel.tsx: Grund oben, ApiKeyFeld eingebunden, Kopfzeile aus api_key (Rueckfall api_key_vorhanden).
 *   D core api-schluessel-dienst.ts: gleiche Key-Form wie die Web-UI.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/api-budget-logik.ts')).href);
const { default: ts } = await import('typescript');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const transpile = (p) => ts.transpileModule(lies(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const alle = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const c of [tree?.props?.children].flat(Infinity)) if (c && typeof c === 'object') alle(c, pred, aus);
  return aus;
};
const text = (t) => (Array.isArray(t) ? t.map(text).join('') : t === null || t === undefined || typeof t === 'boolean' ? ''
  : typeof t === 'object' ? text(t.props?.children) : String(t));
function lade(js, modules) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)((x) => { assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x); return modules[x]; }, module, module.exports);
  return module.exports;
}

const STAND = (o = {}) => ({
  vorhanden: true, quelle: 'webui', gesetzt_am: '2026-10-26T00:40:00.000Z', letzte4: 'ab12',
  webui: { gespeichert: true, gesetzt_am: '2026-10-26T00:40:00.000Z', letzte4: 'ab12', lesbar: true }, env: { vorhanden: true, letzte4: 'zz99' },
  schalter: { aktiv: true, quelle: 'produkt-schalter', letzter_fehler: null }, tresor: { vorhanden: true, schluessel_id: '0123456789abcdef' },
  fehler: null, debug: 'quelle=webui schalter=EIN(produkt-schalter) webui_zeile=ja tresor=ja(0123456789abcdef) env=ja', ...o,
});

// ---------------------------------------------------------------- A Logik (api-budget-logik.ts)
let z = L.apiKeyStandZeile(STAND());
ok(z.wert === 'ja' && /^Quelle: Web-UI \(verschlüsselt auf dem Server\)/.test(z.text) && /gesetzt am /.test(z.text) && /endet auf …ab12/.test(z.text) && /nie angezeigt/.test(z.text),
  'P22-T176 api-budget-logik.ts apiKeyStandZeile: Quelle Web-UI, gesetzt am, letzte 4, Wert nie', z);
z = L.apiKeyStandZeile(STAND({ quelle: 'env', gesetzt_am: null, letzte4: 'zz99' }));
ok(z.wert === 'ja' && /Server-Umgebung \(SYNAPSE_ANTHROPIC_API_KEY\)/.test(z.text) && /…zz99/.test(z.text) && !/gesetzt am/.test(z.text), 'P22-T176 api-budget-logik.ts apiKeyStandZeile: Quelle Env', z);
z = L.apiKeyStandZeile(STAND({ vorhanden: false, quelle: null, letzte4: null }));
ok(z.wert === 'nein' && /Trage den Key unten ein/.test(z.text), 'P22-T176 api-budget-logik.ts apiKeyStandZeile: nein bei Schalter EIN -> Hinweis aufs Eingabefeld', z);
z = L.apiKeyStandZeile(STAND({ vorhanden: false, quelle: null, schalter: { aktiv: false, quelle: 'standard', letzter_fehler: null } }));
ok(z.wert === 'nein' && /secrets\.env/.test(z.text), 'P22-T176 api-budget-logik.ts apiKeyStandZeile: nein bei Schalter AUS -> Altverhalten (Env-Weg aus T175)', z);
ok(/^Key gültig \(Quelle Web-UI, 12 ms, ohne Token-Verbrauch\)\.$/.test(L.apiKeyTestText({ ok: true, quelle: 'webui', http_status: 200, dauer_ms: 12 }))
  && L.apiKeyTestText({ ok: false, quelle: 'env', http_status: 401, fehler: 'api_zugang_ungueltig', dauer_ms: 3 }) === 'Key-Test fehlgeschlagen: api_zugang_ungueltig (HTTP 401).',
  'P22-T176 api-budget-logik.ts apiKeyTestText: gueltig / abgelehnt mit HTTP-Status');
ok(L.apiKeyFormOk('  sk-ant-api03-abcDEF_123-xyz\n') && !L.apiKeyFormOk('sk-ant-kurz') && !L.apiKeyFormOk('sk-ant-mit leerzeichen 1234') && !L.apiKeyFormOk('sk-proj-abcdefghijk'),
  'P22-T176 api-budget-logik.ts apiKeyFormOk: Anthropic-Form, Leerraum aussen erlaubt');

// ---------------------------------------------------------------- B Feld (ApiKeyFeld.tsx)
const feldQuelle = lies('packages/web-ui/src/components/ApiKeyFeld.tsx');
const gesendet = [];
function ladeFeld() {
  const react = { useState: (i) => [typeof i === 'function' ? i() : i, () => undefined] };
  return lade(transpile('packages/web-ui/src/components/ApiKeyFeld.tsx'), {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../api/auth': { apiFetch: async () => ({ ok: true, json: async () => ({}) }) }, './api-budget-logik': L,
  });
}
const F = ladeFeld();
const senden = async (...a) => { gesendet.push(a); return true; };
const knopf = (baum, t) => alle(baum, (x) => x.type === 'button' && text(x).trim() === t)[0];
let baum = F.ApiKeyFeld({ stand: STAND({ schalter: { aktiv: false, quelle: 'standard', letzter_fehler: null }, webui: { gespeichert: false, gesetzt_am: null, letzte4: null, lesbar: false } }), grundOk: true, busy: false, senden });
ok(baum.props['data-api-key-schalter'] === 'aus' && !alle(baum, (x) => x.type === 'input').length && !knopf(baum, 'Key hinterlegen') && !!knopf(baum, 'Eingabe einschalten'),
  'P22-T176 ApiKeyFeld.tsx Schalter AUS: kein Eingabefeld, nur Einschalten (Altverhalten Env)', text(baum));
baum = F.ApiKeyFeld({ stand: STAND(), grundOk: false, busy: false, senden });
const feld = alle(baum, (x) => x.type === 'input')[0];
ok(feld && feld.props.type === 'password' && feld.props.autoComplete === 'new-password' && feld.props.spellCheck === false && feld.props.value === '',
  'P22-T176 ApiKeyFeld.tsx Schalter EIN: Passwortfeld ohne Autofill/Rechtschreibpruefung, leer', feld?.props);
ok(knopf(baum, 'Key ersetzen')?.props.disabled === true && knopf(baum, 'Key entfernen')?.props.disabled === true && knopf(baum, 'Key testen')?.props.disabled === false,
  'P22-T176 ApiKeyFeld.tsx: ohne Grund Ersetzen/Entfernen gesperrt, Testen frei');
baum = F.ApiKeyFeld({ stand: STAND({ webui: { gespeichert: false, gesetzt_am: null, letzte4: null, lesbar: false }, quelle: 'env' }), grundOk: true, busy: false, senden });
ok(knopf(baum, 'Key hinterlegen')?.props.disabled === true && !knopf(baum, 'Key entfernen'), 'P22-T176 ApiKeyFeld.tsx: leeres Feld -> Hinterlegen gesperrt (Form), ohne gespeicherten Key kein Entfernen');
knopf(baum, 'Eingabe ausschalten').props.onClick();
await new Promise((r) => setTimeout(r, 1));
ok(gesendet.at(-1)?.[0] === '/api/main-agent/api/key/schalter' && gesendet.at(-1)?.[1] === 'PUT' && gesendet.at(-1)?.[2].aktiv === false, 'P22-T176 ApiKeyFeld.tsx: Schalter ueber PUT /api/main-agent/api/key/schalter', gesendet.at(-1));
ok(/data-api-key-debug="">Debug: \{stand\.debug\}/.test(feldQuelle), 'P22-T176 ApiKeyFeld.tsx: Debugzeile (regel-neue-funktionen-mit-schalter-und-debug)');
ok(/if \(await senden\('\/api\/main-agent\/api\/key', 'PUT', \{ key: eingabe \}[^)]*\)\) setEingabe\(''\);/.test(feldQuelle), 'P22-T176 ApiKeyFeld.tsx: Feld wird nach erfolgreichem Speichern geleert');
ok(!/localStorage|sessionStorage|console\.|process\.env/.test(feldQuelle), 'P22-T176 ApiKeyFeld.tsx: kein Browser-Speicher, kein Logging des Werts');
const pfade = [...feldQuelle.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]);
ok(pfade.length >= 3 && pfade.every((p) => p.startsWith('/api/main-agent/api/key')), 'P22-T176 ApiKeyFeld.tsx: nur Routen /api/main-agent/api/key*', pfade);

// ---------------------------------------------------------------- C Panel (ApiBudgetPanel.tsx)
const panel = lies('packages/web-ui/src/components/ApiBudgetPanel.tsx');
ok(/s\.api_key \? apiKeyStandZeile\(s\.api_key\) : apiKeyAnzeige\(s\.api_key_vorhanden\)/.test(panel), 'P22-T176 ApiBudgetPanel.tsx: Kopfzeile aus api_key, Rueckfall api_key_vorhanden (alter Server)');
ok(/\{s\?\.api_key && <ApiKeyFeld stand=\{s\.api_key\} grundOk=\{grundOk\} busy=\{busy\} senden=\{senden\} \/>\}/.test(panel), 'P22-T176 ApiBudgetPanel.tsx: ApiKeyFeld eingebunden');
ok(panel.indexOf('<b>Grund</b>') < panel.indexOf('data-api-key-vorhanden') && (panel.match(/<b>Grund<\/b>/g) ?? []).length === 1, 'P22-T176 ApiBudgetPanel.tsx: Grund steht einmal, oben');
ok(/return true;\n {4}\} catch \(reason\) \{\n {6}setError\(reason instanceof Error \? reason\.message : String\(reason\)\);\n {6}return false;/.test(panel), 'P22-T176 ApiBudgetPanel.tsx senden: meldet Erfolg (Feld leeren nur nach Erfolg)');

// ---------------------------------------------------------------- D gleiche Form an beiden Stellen
const serverForm = /export const API_KEY_FORM = (\/.*\/);/.exec(lies('packages/core/src/services/api-schluessel-dienst.ts'))?.[1];
ok(serverForm === String(L.API_KEY_FORM), 'P22-T176 core api-schluessel-dienst.ts API_KEY_FORM = web-ui api-budget-logik.ts API_KEY_FORM', { serverForm, web: String(L.API_KEY_FORM) });
console.log('P22-T176 Web-UI: ' + n + ' Pruefungen bestanden');
