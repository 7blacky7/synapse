/**
 * P22-T278 P3 b (Kanal 37424): DeepSeek-Spitzenzeit in Ortszeit Europe/Berlin statt festem 'MEZ' (Sommer/Winter). Ohne DB und Netz.
 * Quelle: web-ui components/api-tarif-logik.ts (UTC-Fenster vom Server, core DEEPSEEK_SPITZE_UTC).
 *   node --experimental-strip-types packages/web-ui/tests/api-tarif-logik-p22-t278.test.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/api-tarif-logik.ts')).href);
const F = [[1, 4], [6, 10]];
const winter = L.spitzeOrtszeitText(F, new Date('2026-11-09T12:00:00Z'));
const sommer = L.spitzeOrtszeitText(F, new Date('2026-07-06T12:00:00Z'));
assert.equal(winter, '02:00–05:00 und 07:00–11:00 Uhr Ortszeit Berlin', 'Winter (MEZ) | tatsaechlich ' + winter);
assert.equal(sommer, '03:00–06:00 und 08:00–12:00 Uhr Ortszeit Berlin', 'Sommer (MESZ) | tatsaechlich ' + sommer);
assert.equal(L.spitzeOrtszeitText(null), 'Spitzenzeit laut Anbieter', 'ohne Fenster kein erfundener Wert');
console.log('P22-T278 Tarif-Ortszeit: 3 Pruefungen gruen');
