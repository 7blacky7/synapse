/**
 * P22-T175: API-Budget in der Web-UI (nur User) - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/api-budget-p22-t175.test.mjs
 * Sichert ab (Task P22-T175, User inbox 1276 'limit 25 euro am tag, wo api key hinterlegen'):
 *   A components/api-budget-logik.ts: ohne Budget Vorschlag 25 USD je Tag mit Haiku + Sonnet (nur Modelle der Registry), gesetztes
 *     Budget unveraendert ins Formular, Budgetzeile gebucht/offen/verfallen/Rest/ERSCHOEPFT, API-Key nur ja/nein mit Ort.
 *   B components/ApiBudgetPanel.tsx: Logik eingebunden, Anzeige 'API-Key vorhanden' mit data-Attribut, kein Key-Wert/process.env,
 *     Reset-Tag nur bei monat, Schreibwege nur ueber den bestehenden Vertrag (PUT/DELETE /api/main-agent/api/...).
 *   C components/ControlPlaneSettingsView.tsx: eigener Bereich 'api' (API-Agenten) rendert ApiBudgetPanel, Main-Agent verweist dorthin.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/api-budget-logik.ts')).href);
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

const OHNE = { gesetzt: false, grenze_usd: null, zeitraum: null, reset_tag: null, erlaubte_modelle: [], beginn: null, gebucht_usd: 0, offen_usd: 0,
  verfallen_usd: 0, verbraucht_usd: 0, rest_usd: null, erschoepft: true, hinweis: 'Kein API-Budget gesetzt: keine kostenpflichtigen Aufrufe.' };
const GESETZT = { gesetzt: true, grenze_usd: 25, zeitraum: 'tag', reset_tag: 1, erlaubte_modelle: ['api-haiku', 'api-sonnet'], beginn: '2026-10-26',
  gebucht_usd: 1.5, offen_usd: 0.5, verfallen_usd: 0, verbraucht_usd: 2, rest_usd: 23, erschoepft: false };

// ---------------------------------------------------------------- A Logik (api-budget-logik.ts)
let f = L.budgetFormular(OHNE, ['api-fable', 'api-haiku', 'api-opus', 'api-sonnet']);
ok(f.grenze === '25' && f.zeitraum === 'tag' && f.vorschlag === true && f.modelle.join() === 'api-haiku,api-sonnet',
  'P22-T175 api-budget-logik.ts budgetFormular: ohne Budget Vorschlag 25 USD je Tag, Haiku + Sonnet', f);
f = L.budgetFormular(OHNE, ['api-opus', 'api-sonnet']);
ok(f.modelle.join() === 'api-sonnet', 'P22-T175 api-budget-logik.ts budgetFormular: Vorschlag nur mit Modellen, die die Registry kennt', f);
f = L.budgetFormular({ ...GESETZT, grenze_usd: 40, zeitraum: 'monat', reset_tag: 15, erlaubte_modelle: ['api-opus'] }, ['api-haiku', 'api-opus']);
ok(f.grenze === '40' && f.zeitraum === 'monat' && f.resetTag === '15' && f.modelle.join() === 'api-opus' && f.vorschlag === false,
  'P22-T175 api-budget-logik.ts budgetFormular: gesetztes Budget unveraendert, kein Vorschlag', f);
let z = L.budgetZeile(GESETZT);
ok(z === 'Grenze 25.0000 USD je Tag (seit 2026-10-26) · gebucht 1.5000 USD · offen 0.5000 USD · Rest 23.0000 USD',
  'P22-T175 api-budget-logik.ts budgetZeile: Grenze je Tag, gebucht, offen, Rest (verfallen nur wenn > 0)', z);
z = L.budgetZeile({ ...GESETZT, verfallen_usd: 0.25, rest_usd: 0, erschoepft: true, zeitraum: 'woche' });
ok(/je Woche/.test(z) && /verfallen 0\.2500 USD/.test(z) && /Rest 0\.0000 USD · ERSCHÖPFT$/.test(z), 'P22-T175 api-budget-logik.ts budgetZeile: verfallen und ERSCHÖPFT sichtbar', z);
ok(L.budgetZeile(OHNE) === OHNE.hinweis && /keine kostenpflichtigen/.test(L.budgetZeile({ ...OHNE, hinweis: undefined })),
  'P22-T175 api-budget-logik.ts budgetZeile: ohne Budget der Server-Hinweis bzw. Ersatztext');
ok(L.usd(null) === '–' && L.usd(Number.NaN) === '–' && L.usd(0.1) === '0.1000 USD', 'P22-T175 api-budget-logik.ts usd: Zahl mit 4 Stellen, sonst Strich');
const ja = L.apiKeyAnzeige(true), nein = L.apiKeyAnzeige(false);
ok(ja.wert === 'ja' && /nie angezeigt/.test(ja.text) && !/secrets\.env/.test(ja.text), 'P22-T175 api-budget-logik.ts apiKeyAnzeige(true): ja, Wert nie sichtbar', ja);
ok(nein.wert === 'nein' && nein.text.includes('SYNAPSE_ANTHROPIC_API_KEY=… in ~/.config/synapse/secrets.env') && /synapse-api/.test(nein.text) && /nie angezeigt/.test(nein.text),
  'P22-T175 api-budget-logik.ts apiKeyAnzeige(false): nein mit Ort zum Hinterlegen (Antwort auf "wo soll ich den api key hinterlegen")', nein);
ok(L.API_BUDGET_VORSCHLAG.grenze_usd === 25 && L.API_BUDGET_VORSCHLAG.zeitraum === 'tag', 'P22-T175 api-budget-logik.ts API_BUDGET_VORSCHLAG: Erstwert nach User-Wunsch');

// ---------------------------------------------------------------- B Panel (ApiBudgetPanel.tsx)
const panel = lies('packages/web-ui/src/components/ApiBudgetPanel.tsx');
ok(/from '\.\/api-budget-logik'/.test(panel) && /budgetFormular\(s\.budget, s\.modelle\.map\(m => m\.alias\)\)/.test(panel) && /budgetZeile\(s\.budget\)/.test(panel),
  'P22-T175 ApiBudgetPanel.tsx: Formular und Budgetzeile aus api-budget-logik.ts');
ok(/data-api-key-vorhanden=\{key\?\.wert \?\? ''\}><b>API-Key vorhanden: \{key\?\.wert \?\? '…'\}<\/b>/.test(panel) && /apiKeyAnzeige\(s\.api_key_vorhanden\)/.test(panel),
  'P22-T175 ApiBudgetPanel.tsx: Anzeige API-Key vorhanden ja/nein aus api_key_vorhanden');
ok(!/process\.env/.test(panel) && !/api_key[^_]/.test(panel.replace(/api_key_vorhanden/g, '')), 'P22-T175 ApiBudgetPanel.tsx: kein Key-Wert, kein Umgebungszugriff in der Web-UI');
ok(/disabled=\{zeitraum !== 'monat'\}/.test(panel), 'P22-T175 ApiBudgetPanel.tsx: Reset-Tag nur bei Zeitraum monat');
ok(/\{vorschlag && <div className="scope-warning wide" data-api-budget-vorschlag="">/.test(panel), 'P22-T175 ApiBudgetPanel.tsx: Vorschlag sichtbar, solange kein Budget gesetzt ist');
const pfade = [...panel.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]);
ok(pfade.length > 0 && pfade.every((p) => p.startsWith('/api/main-agent/api')), 'P22-T175 ApiBudgetPanel.tsx: nur der bestehende Vertrag /api/main-agent/api*', pfade);

// ---------------------------------------------------------------- C Einbau (ControlPlaneSettingsView.tsx)
const cp = lies('packages/web-ui/src/components/ControlPlaneSettingsView.tsx');
ok(/\| 'main' \| 'api' \|/.test(cp) && /\{ id: 'api', label: 'API-Agenten', detail: '[^']*API-Key vorhanden'/.test(cp), 'P22-T175 ControlPlaneSettingsView.tsx: Kategorie API-Agenten (suchbar)');
ok(/\{category === 'api' && <ApiBudgetPanel \/>\}/.test(cp) && (cp.match(/<ApiBudgetPanel \/>/g) ?? []).length === 1, 'P22-T175 ControlPlaneSettingsView.tsx: ApiBudgetPanel genau einmal, im Bereich api');
ok(/onClick=\{\(\) => setCategory\('api'\)\}>API-Agenten öffnen<\/button>/.test(cp), 'P22-T175 ControlPlaneSettingsView.tsx: Main-Agent verweist auf API-Agenten');
console.log('P22-T175 Web-UI: ' + n + ' Pruefungen bestanden');
