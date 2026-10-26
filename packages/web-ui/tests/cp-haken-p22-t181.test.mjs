/**
 * P22-T181 (Nebenbefund P22-T180, thought 2ef1d754): Checkboxen in den Einstellungen stehen neben ihrer Beschriftung - ohne DB und Netz.
 *   node packages/web-ui/tests/cp-haken-p22-t181.test.mjs
 * Sichert ab:
 *   A control-plane-settings.css: die Vollbreiten-Regel (.cp-setting-field input ... width:100%, padding) nimmt Checkboxen und Radios aus;
 *     Klassen .cp-haken (Haken neben dem Text) und .cp-feld (Beschriftung ueber dem Feld), Schrift wie das Panel (kompakt 9px, sonst 11px).
 *   B ApiFreigabenFeld.tsx (T180) und ApiBudgetPanel.tsx (Erlaubte Modelle, T175): keine Inline-Stile mehr fuer Haken/Labels, Klassen genutzt.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

// ---------------------------------------------------------------- A CSS-Quelle
const css = lies('packages/web-ui/src/control-plane-settings.css');
const HC = 'P22-T181 control-plane-settings.css';
const voll = css.match(/([^{}]*)\{width:100%;min-width:0;border:1px solid var\(--border\)[^}]*\}/);
ok(voll && voll[1].includes('.cp-setting-field input:not([type=checkbox]):not([type=radio])') && !/\.cp-setting-field input,/.test(voll[1]),
  HC + ': Vollbreiten-Regel gilt nicht fuer Checkboxen/Radios', voll?.[1]);
ok(/\.cp-haken\{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:9px\}/.test(css) && /\.cp-feld\{display:grid;gap:4px;font-size:9px\}/.test(css),
  HC + ': Klassen cp-haken (Haken neben dem Text) und cp-feld (Beschriftung ueber dem Feld), kompakt 9px');
ok(/\.synapse-control:not\(\.compact\) \.cp-haken,\.synapse-control:not\(\.compact\) \.cp-feld\{font-size:11px\}/.test(css), HC + ': nicht kompakt 11px wie die Panel-Beschriftungen');

// ---------------------------------------------------------------- B Komponenten
const feld = lies('packages/web-ui/src/components/ApiFreigabenFeld.tsx');
const HF = 'P22-T181 ApiFreigabenFeld.tsx';
ok(!/HAKEN|ZEILE|FELD|style=\{\{ display: 'block' \}\}/.test(feld) && !/<input type="checkbox" style=/.test(feld), HF + ': Inline-Stile aus T180 entfernt');
ok((feld.match(/className="cp-haken"/g) ?? []).length === 4 && (feld.match(/className="cp-feld"/g) ?? []).length === 2, HF + ': Modelle/Heartbeat/aktiv mit cp-haken, Agent/Grenze mit cp-feld',
  { haken: (feld.match(/className="cp-haken"/g) ?? []).length, feld: (feld.match(/className="cp-feld"/g) ?? []).length });
const panel = lies('packages/web-ui/src/components/ApiBudgetPanel.tsx');
const HP = 'P22-T181 ApiBudgetPanel.tsx';
ok(panel.includes('<label key={m.alias} className="cp-haken">') && !panel.includes("style={{ display: 'block' }}"), HP + ': Erlaubte Modelle mit cp-haken statt display block');
console.log('P22-T181 Web-UI: ' + n + ' Pruefungen bestanden');
