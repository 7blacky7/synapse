/**
 * P22-T231/P22-T233: Hauptagent-Fenster, Standard und Einheiten der Auto-Weiter-Zeit.
 * Quelle: packages/web-ui/src/views/hauptagent/MainAgentView.tsx; kein DB- oder Browserzugriff.
 * UI-Browserabnahme nach Deploy separat. Jede Fehlermeldung nennt Quelle und Soll/Ist.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const datei = fileURLToPath(new URL('../src/views/hauptagent/MainAgentView.tsx', import.meta.url));
const src = readFileSync(datei, 'utf8');
let fehler = 0;
function pruefe(ok, einheit, erwartet, tatsaechlich) {
  const label = 'P22-T231 MainAgentView.tsx ' + einheit;
  if (ok) console.log('OK ' + label);
  else { fehler++; console.error('FAIL ' + label + ' ' + JSON.stringify({erwartet,tatsaechlich})); }
}
// User 31.10.2026: neu geoeffnetes Fenster startet mit drei Sekunden.
const delay = src.match(/\[collapseDelay,\s*setCollapseDelay\]\s*=\s*useState\((\d+)\)/)?.[1];
const unit = src.match(/\[collapseUnit,\s*setCollapseUnit\]\s*=\s*useState<[^>]+>\('([^']+)'\)/)?.[1];
pruefe(delay === '3' && unit === 'sec', 'Startwert', '3 sec', {delay,unit});
// Auswahl pruefen: ms darf weder angeboten noch als Timer-Einheit benutzt werden.
const controls = src.match(/<label className="chat-auto-time">[\s\S]*?<\/label>/)?.[0] ?? '';
const options = [...controls.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(m => [m[1],m[2]]);
pruefe(JSON.stringify(options) === JSON.stringify([['sec','Sek.'],['min','Min.']]), 'Einheiten-Auswahl', [['sec','Sek.'],['min','Min.']], options);
const timer = src.match(/const unitFactor = ([^;]+);/)?.[1] ?? '';
pruefe(/collapseUnit\s*===\s*'sec'\s*\?\s*1000\s*:\s*60_000/.test(timer)
  && /Math\.max\(1,\s*collapseDelay\)\s*\*\s*unitFactor/.test(src),
  'Zeitfaktor', 'Sekunden 1000 ms, Minuten 60000 ms, Minimum 1', timer);
pruefe(!controls.includes('value="ms"') && !/collapseUnit\s*===\s*'ms'/.test(src),
  'ms entfernt', 'keine ms-Auswahl oder ms-Zeitfaktor', options);
if (fehler) process.exitCode = 1;
