/**
 * P22-T180: Freigaben je Agent in Einstellungen > API-Agenten (nur User) - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/api-freigaben-p22-t180.test.mjs
 * Sichert ab (Task P22-T180, Folge aus P22-T179 thought 42fe86c8; Grundsatz P22-T106 'kostenpflichtig nie automatisch'):
 *   A components/api-freigaben-logik.ts: Zeile (Modelle, eigene Grenze, Verbrauch, Rest, Heartbeat, wer/wann), Kandidat, Rolle,
 *     Schalter api_agenten je Projekt (EIN/AUS/unbekannt), Grenze (leer = nur globales Budget), Formular -> PUT-Body,
 *     leeres Formular ohne Agent und mit Heartbeat AUS (Vorschlag nur Haiku).
 *   B components/ApiFreigabenFeld.tsx: Logik eingebunden, Lauf-Herkunft-Marke (P22-T178) am Agenten, nur Route
 *     /api/main-agent/api/freigaben, Schreiben nur ueber senden (Grund des Panels), Setzen/Entziehen ohne Grund gesperrt, Setzen bei
 *     Schalter AUS gesperrt, kein Browser-Speicher/Umgebungszugriff, Debug-Attribute.
 *   C components/ApiBudgetPanel.tsx (nach t211 D0): Feld importiert und genau einmal eingebunden, nach dem Budget und vor den Kosten,
 *     nur Modelle mit Preis, Grund/busy/senden des Panels.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/api-freigaben-logik.ts')).href);
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const HL = 'P22-T180 api-freigaben-logik.ts', HF = 'P22-T180 ApiFreigabenFeld.tsx';

const F = { identity_id: 'id-w', project: 'p-a', agent_id: 'claude-w', rolle: 'subagent', aktiv: true, modelle: ['api-haiku'], grenze_usd: 0.5,
  heartbeat: false, grund: 'Test', user_auftrag: null, gesetzt_von: 'user', gesetzt_am: '2026-10-26T01:00:00Z', verbraucht_usd: 0.0015, rest_usd: 0.4985,
  api_agenten_aktiv: true };

// ---------------------------------------------------------------- A Logik
let z = L.freigabeZeile(F);
ok(z.startsWith('aktiv · Modelle api-haiku · Grenze 0.5000 USD · verbraucht 0.0015 USD · Rest 0.4985 USD · Heartbeat AUS · gesetzt von User am '),
  HL + ' freigabeZeile: Modelle, eigene Grenze, Verbrauch, Rest, Heartbeat, gesetzt von', z);
z = L.freigabeZeile({ ...F, aktiv: false, grenze_usd: null, rest_usd: null, heartbeat: true, gesetzt_von: 'main', modelle: [] });
ok(z.startsWith('pausiert · Modelle – · Grenze nur globales Budget · verbraucht 0.0015 USD · Heartbeat EIN · gesetzt von Main (User-Auftrag)') && !z.includes('Rest'),
  HL + ' freigabeZeile: pausiert, ohne eigene Grenze kein Rest, Main mit User-Auftrag', z);
ok(L.rolleText('subagent') === 'Arbeitsagent' && L.rolleText('koordinator') === 'Koordinator' && L.rolleText('x') === 'x', HL + ' rolleText: Arbeitsagent/Koordinator, sonst roh');
ok(L.kandidatLabel({ identity_id: 'k', project: 'p-a', agent_id: 'claude-k', rolle: 'koordinator', freigabe: true, api_agenten_aktiv: true })
  === 'p-a · claude-k (Koordinator) · hat Freigabe', HL + ' kandidatLabel: Projekt, Agent, Rolle, hat Freigabe');
let s = L.schalterText('p-a', { aktiv: true, quelle: 'produkt-schalter', letzter_fehler: null });
ok(s.aktiv === true && s.text === 'Schalter api_agenten im Projekt p-a: EIN (produkt-schalter).', HL + ' schalterText: EIN mit Quelle', s);
s = L.schalterText('p-b', { aktiv: false, quelle: 'standard', letzter_fehler: 'kaputt' });
ok(s.aktiv === false && /AUS \(standard\)/.test(s.text) && /abgelehnt/.test(s.text) && /nur ausdruecklich/.test(s.text) && /Fehler: kaputt/.test(s.text),
  HL + ' schalterText: AUS erklaert Ablehnung und Weg (nur ausdruecklich), Fehler sichtbar', s);
s = L.schalterText('p-c', undefined);
ok(s.aktiv === false && /unbekannt/.test(s.text), HL + ' schalterText: ohne Daten unbekannt (nicht EIN)', s);
ok(L.grenzeWert('') === null && L.grenzeWert('  ') === null && L.grenzeWert('0,25') === 0.25 && L.grenzeWert('2') === 2
  && L.grenzeWert('0') === 'ungueltig' && L.grenzeWert('-1') === 'ungueltig' && L.grenzeWert('abc') === 'ungueltig',
  HL + ' grenzeWert: leer = nur globales Budget, Komma erlaubt, <= 0/keine Zahl ungueltig');
const leer = L.formularAus(null, ['api-sonnet', 'api-haiku']);
ok(leer.identity_id === '' && leer.modelle.join() === 'api-haiku' && leer.grenze === '' && leer.heartbeat === false && leer.aktiv === true,
  HL + ' formularAus(null): kein Agent vorgewaehlt, Vorschlag nur Haiku, Heartbeat AUS (kostenpflichtig nie automatisch)', leer);
ok(L.formularAus(null, ['api-sonnet']).modelle.length === 0, HL + ' formularAus(null): ohne Haiku in der Registry kein Modell vorgewaehlt');
const bearb = L.formularAus(F, ['api-haiku']);
ok(bearb.identity_id === 'id-w' && bearb.grenze === '0.5' && bearb.modelle.join() === 'api-haiku' && bearb.heartbeat === false, HL + ' formularAus(Freigabe): Bearbeiten uebernimmt die Werte', bearb);
let k = L.freigabeKoerper(leer);
ok(k.ok === false && k.grund === 'Agent waehlen.', HL + ' freigabeKoerper: ohne Agent kein Body', k);
k = L.freigabeKoerper({ ...leer, identity_id: 'id-w', modelle: [] });
ok(k.ok === false && /Modell/.test(k.grund), HL + ' freigabeKoerper: ohne Modell kein Body', k);
k = L.freigabeKoerper({ ...leer, identity_id: 'id-w', grenze: '0' });
ok(k.ok === false && /Grenze/.test(k.grund), HL + ' freigabeKoerper: Grenze 0 abgelehnt', k);
k = L.freigabeKoerper({ ...leer, identity_id: 'id-w', grenze: '0,1' });
ok(k.ok === true && kurz(k.koerper) === kurz({ identity_id: 'id-w', modelle: ['api-haiku'], grenze_usd: 0.1, heartbeat: false, aktiv: true }) && !('grund' in k.koerper),
  HL + ' freigabeKoerper: PUT-Body (identity_id, modelle, grenze_usd, heartbeat, aktiv), Grund haengt das Panel an', k);
ok(L.freigabeKoerper({ ...leer, identity_id: 'id-w' }).koerper.grenze_usd === null, HL + ' freigabeKoerper: leere Grenze -> null (nur globales Budget)');

// ---------------------------------------------------------------- B Komponente
const feld = lies('packages/web-ui/src/components/ApiFreigabenFeld.tsx');
ok(/from '\.\/api-freigaben-logik'/.test(feld) && ['freigabeZeile(f)', 'kandidatLabel(k)', 'schalterText(', 'freigabeKoerper(form)', 'formularAus('].every((t) => feld.includes(t)),
  HF + ': Anzeige und Formular aus api-freigaben-logik.ts');
ok(/<LaufHerkunftMarke project=\{f\.project\} identityId=\{f\.identity_id\} name=\{f\.agent_id\} \/>/.test(feld) && /from '\.\/LaufHerkunftMarke'/.test(feld),
  HF + ': Lauf-Herkunft-Marke (P22-T178) am Agenten jeder Freigabe');
const pfade = [...feld.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]);
ok(pfade.length >= 3 && pfade.every((p) => p.startsWith('/api/main-agent/api/freigaben')) && pfade.includes('/api/main-agent/api/freigaben?kandidaten=1'),
  HF + ': nur die Route /api/main-agent/api/freigaben (GET mit kandidaten=1, PUT, DELETE)', pfade);
ok(/senden\('\/api\/main-agent\/api\/freigaben', 'PUT', pruefung\.koerper/.test(feld) && /senden\('\/api\/main-agent\/api\/freigaben', 'DELETE', \{ identity_id: f\.identity_id \}/.test(feld)
  && !/method: 'PUT'|method: 'DELETE'/.test(feld), HF + ': Schreiben nur ueber senden des Panels (Grund Pflicht, gleiche Fehleranzeige)');
ok(/disabled=\{busy \|\| !grundOk \|\| !pruefung\.ok \|\| schalter\?\.aktiv === false\}/.test(feld), HF + ': Freigabe setzen ohne Grund, ungueltig oder bei Schalter AUS gesperrt');
ok(/disabled=\{busy \|\| !grundOk\} onClick=\{\(\) => void entziehen\(f\)\}>Entziehen/.test(feld), HF + ': Entziehen ohne Grund gesperrt');
ok(!/process\.env/.test(feld) && !/localStorage|sessionStorage/.test(feld), HF + ': kein Umgebungszugriff, kein Browser-Speicher');
ok(/useEffect\(\(\) => \{ void laden\(\); \}, \[laden\]\)/.test(feld) && !/setzen\(\)[^;]*useEffect/.test(feld) && (feld.match(/'PUT'/g) ?? []).length === 1,
  HF + ': beim Laden nur GET, genau ein PUT-Weg (nur per Klick, nie automatisch)');
ok(['data-api-freigaben=', 'data-api-freigabe=', 'data-api-freigabe-aktiv=', 'data-api-agenten-schalter=', 'data-api-freigaben-leer=', 'data-api-freigabe-formular='].every((t) => feld.includes(t)),
  HF + ': Debug-Attribute fuer KI-Browser-Abnahme');
ok(/Schalter api_agenten \(global\)/.test(feld) && /stand\?\.schalter/.test(feld), HF + ': globaler Schalter api_agenten sichtbar');
// ---------------------------------------------------------------- C Einbindung (ApiBudgetPanel.tsx)
const panel = lies('packages/web-ui/src/components/ApiBudgetPanel.tsx');
const HP = 'P22-T180 ApiBudgetPanel.tsx';
ok(/import \{ ApiFreigabenFeld \} from '\.\/ApiFreigabenFeld';/.test(panel) && (panel.match(/<ApiFreigabenFeld /g) ?? []).length === 1, HP + ': Feld importiert und genau einmal eingebunden');
ok(panel.includes('{s && <ApiFreigabenFeld modelle={s.modelle.filter(m => (m.eingabe ?? 0) > 0 && (m.ausgabe ?? 0) > 0).map(m => m.alias)} grundOk={grundOk} busy={busy} senden={senden} />}'),
  HP + ': nur Modelle mit Preis (Server lehnt sonst preis_unbekannt ab), Grund/busy/senden des Panels');
const pos = panel.indexOf('<ApiFreigabenFeld ');
ok(pos > panel.indexOf('data-api-budget=') && pos < panel.indexOf('<b>Kosten</b>'), HP + ': Abschnitt nach dem Budget, vor den Kosten', pos);
console.log('P22-T180 Web-UI: ' + n + ' Pruefungen bestanden');
