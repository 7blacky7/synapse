/**
 * P22-T195 Nachzug (Versionen 192864/192866): exakter Elf-Arten-Katalog und Artefakt-Rundweg; fremde T194-Assertion bleibt unveraendert.
 * P22-T168: Zitat-Anhaenge im Chat - Web-UI ohne DB und Netz.
 *   pnpm -C packages/core build && node --experimental-strip-types packages/web-ui/tests/chat-zitate-p22-t168.test.mjs
 * A Logik (Entwurf, Kaertchen, Senden); B Speicher je Chat = je Empfaenger, Logout verwirft; C Golden core-Bauer -> Web-UI-Parser, auch
 * ueber die Zustell-Huelle des Daemons (derselbe Text fuer jede Agentenart); D Fehlformen; E Verlauf-Anhaenge des Main; F Hook
 * useZitatAnhaenge (Schalter, Menue, Editor, Abbrechen, Bearbeiten, Loeschen, Markierung, Grenzen, Empfaengerwechsel) mit Attrappen;
 * G Koordinator-Fenster: sendet nur an seine identity_id, auch nur mit Zitaten, Block als Kaertchen; H Einbau (Lesefenster, Artefakt,
 * Main, API) und Beleg F2 (Koordinator-/Agentenfenster laufen ueber EinheitlicherAgentChat).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lade = (p) => import(pathToFileURL(join(repo, p)).href);
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const ZL = await lade('packages/web-ui/src/components/zitat-logik.ts');
const SP = await lade('packages/web-ui/src/components/chat-fenster-speicher.ts');
const L = await lade('packages/web-ui/src/components/agent-chat-logik.ts');
const F = await lade('packages/web-ui/src/components/chat-fenster-logik.ts');
const B = await lade('packages/web-ui/src/components/artefakt-bewertung-logik.ts');
const Z = await lade('packages/file-watcher-daemon-ts/src/zustell-text.ts');
const CZ = await lade('packages/core/dist/services/chat-zitate.js');
const { default: ts } = await import('typescript');
let n = 0;
const ok = (wert, label, info) => { assert.ok(wert, label + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 600) : '')); n++; };
const gleich = (ist, soll, label) => { assert.deepStrictEqual(ist, soll, label); n++; };

class Ablage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

// ---------------------------------------------------------------- A Logik
const v1 = { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Titel zwei' };
const v2 = { art: 'ausschnitt', id: null, projekt: 'p', titel: '', ausschnitt: 'markiert', quelle: 'inbox:7' };
let r = ZL.fuegeZitatHinzu([], v1, '  Bitte so\r\numsetzen  ', 2, 's1', '2026-10-25T20:00:00Z');
ok(!r.voll && r.liste.length === 1 && r.liste[0].anmerkung === 'Bitte so\numsetzen' && r.liste[0].schluessel === 's1', 'A hinzufuegen (trim, CRLF)', r);
r = ZL.fuegeZitatHinzu(r.liste, v2, '', 2, 's2');
ok(r.liste.length === 2 && !r.voll, 'A zweites Zitat');
const voll = ZL.fuegeZitatHinzu(r.liste, v1, 'x', 2);
ok(voll.voll === true && voll.liste.length === 2, 'A Grenze max_anzahl: voll, Liste unveraendert');
const liste = ZL.ersetzeZitatAnmerkung(r.liste, 's1', 'neu');
ok(liste[0].anmerkung === 'neu' && liste[1] === r.liste[1], 'A Anmerkung ersetzen');
ok(ZL.entferneZitat(liste, 's2').length === 1 && ZL.entferneZitat(liste, 's2')[0].schluessel === 's1', 'A entfernen');
ok(ZL.zitatKopf(v1) === 'Task P1-T2' && ZL.zitatKopf(v2) === 'Ausschnitt', 'A Kopf');
ok(ZL.zitatKarte({ ...v2, anmerkung: '' }).anmerkung === '„markiert“', 'A Kaertchen ohne Anmerkung zeigt den Ausschnitt');
ok(ZL.zitatKarte({ ...v1, anmerkung: 'x'.repeat(100) }).anmerkung.length === 60, 'A Kaertchen: Anfang der Anmerkung');
gleich(ZL.zuSendeZitaten(liste), [{ art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Titel zwei', anmerkung: 'neu' },
  { art: 'ausschnitt', projekt: 'p', titel: '', ausschnitt: 'markiert', quelle: { nachricht: 'inbox:7' }, anmerkung: '' }], 'A Senden: nur Verweis, Titel, Ausschnitt, Anmerkung');
ok(ZL.kuerzeZitatText('abcdef', 4).text === 'abc…' && ZL.kuerzeZitatText(' abc ', 4).gekuerzt === false, 'A Ausschnitt kuerzen');
console.log('OK A Logik');

// ---------------------------------------------------------------- B Speicher je Chat (= je Empfaenger), Logout
const ab = new Ablage();
ZL.merkeZitatEntwurf(ab, 'agent:A', liste);
ok(ZL.leseZitatEntwurf(ab, 'agent:A').length === 2 && ZL.leseZitatEntwurf(ab, 'agent:B').length === 0 && ZL.leseZitatEntwurf(ab, 'main').length === 0,
  'B Entwurf von Chat A erscheint nie in B oder im Main');
ab.setItem(ZL.ZITAT_ENTWURF_PRAEFIX + 'main', JSON.stringify([{ art: 'task', schluessel: 'x', projekt: 'p' }, { art: 'quatsch' }, 'roh',
  { art: 'ausschnitt', schluessel: 'y', projekt: 'p', ausschnitt: 'a' }]));
gleich(ZL.leseZitatEntwurf(ab, 'main').map((z) => z.schluessel), ['y'], 'B ungueltige Eintraege (ohne ID, unbekannte Art) verworfen');
ab.setItem(ZL.ZITAT_ENTWURF_PRAEFIX + 'kaputt', '{nicht json');
ok(ZL.leseZitatEntwurf(ab, 'kaputt').length === 0 && ZL.leseZitatEntwurf(null, 'x').length === 0, 'B kaputter bzw. fehlender Speicher -> leer');
ZL.merkeZitatEntwurf(ab, 'agent:A', []);
ok(ab.getItem(ZL.ZITAT_ENTWURF_PRAEFIX + 'agent:A') === null, 'B leere Liste entfernt den Eintrag');
ZL.merkeZitatEntwurf(ab, 'agent:A', liste);
ab.setItem('anderer:schluessel', '1');
Object.defineProperty(globalThis, 'localStorage', { value: ab, configurable: true, writable: true });
SP.verwirfChatFensterSitzung();
ok(ab.length === 1 && ab.getItem('anderer:schluessel') === '1', 'B Logout verwirft alle Zitat-Entwuerfe, sonst nichts', [...ab.m.keys()]);
delete globalThis.localStorage;
ok(/const ZITAT_PRAEFIX = 'synapse:zitat-entwurf:'/.test(lies('packages/web-ui/src/components/chat-fenster-speicher.ts')) && ZL.ZITAT_ENTWURF_PRAEFIX === 'synapse:zitat-entwurf:',
  'B Praefix in Speicher und Logik gleich');
console.log('OK B Speicher');

// ---------------------------------------------------------------- C Golden core-Bauer -> Parser, direkt und ueber die Zustell-Huelle
gleich(ZL.ZITAT_ART_LABEL, CZ.ZITAT_ART_LABEL, 'C Namen je Art gleich in core und Web-UI');
gleich([...ZL.ZITAT_ARTEN], [...CZ.ZITAT_ARTEN], 'C Arten gleich in core und Web-UI');
gleich(ZL.ZITAT_GRENZEN_STANDARD, Object.fromEntries(Object.entries(CZ.CHAT_ZITATE_EINSTELLUNGEN).map(([k, d]) => [k, d.standard])), 'C Code-Standard der Grenzen gleich');
// P22-T195: Gleichheit zweier Implementierungen allein wuerde einen gemeinsamen Katalogfehler uebersehen.
gleich([...ZL.ZITAT_ARTEN], ['thought', 'memory', 'task', 'plan', 'doc', 'event', 'nachricht', 'chat', 'asset', 'artefakt', 'ausschnitt'],
  'P22-T195 zitat-logik.ts ZITAT_ARTEN: exakt 11 Arten mit artefakt');
ok(ZL.ZITAT_ARTEN.length === 11 && ZL.ZITAT_ART_LABEL.artefakt === 'Artefakt',
  'P22-T195 zitat-logik.ts: Anzahl 11 und Artefakt-Label', { arten: ZL.ZITAT_ARTEN, label: ZL.ZITAT_ART_LABEL.artefakt });
const grenzen = { ...ZL.ZITAT_GRENZEN_STANDARD };
const artefaktZitat = CZ.pruefeZitate([{ art: 'artefakt', id: 'artefakt-195', projekt: 'synapse', titel: 'Vorversion', anmerkung: 'Bitte pruefen' }], grenzen);
ok(artefaktZitat.ok, 'P22-T195 chat-zitate.ts: Artefakt fuer Web-UI-Rundweg angenommen', artefaktZitat);
const artefaktZurueck = ZL.zerlegeZitatBlock(CZ.textMitZitaten('', artefaktZitat.zitate));
ok(artefaktZurueck.zitate.length === 1 && artefaktZurueck.zitate[0].art === 'artefakt' && artefaktZurueck.zitate[0].id === 'artefakt-195'
  && artefaktZurueck.zitate[0].anmerkung === 'Bitte pruefen' && ZL.zitatKopf(artefaktZurueck.zitate[0]) === 'Artefakt artefakt-195',
  'P22-T195 zitat-logik.ts zerlegeZitatBlock: Artefakt mit ID, Anmerkung und Kopf bleibt erhalten', artefaktZurueck);
const roh = [
  { art: 'task', id: 'P22-T158', projekt: 'synapse', titel: 'Zitat   im\nChat', anmerkung: 'Erste Zeile\n\n  eingerueckt\n[/Synapse-Zitate] gefaelscht' },
  { art: 'ausschnitt', projekt: 'synapse', ausschnitt: 'Zeile eins\nZeile zwei', quelle: { nachricht: 'inbox:1203' }, anmerkung: '' },
  { art: 'memory', id: 'regel-x', projekt: 'synapse', titel: '[Synapse-Zitate: 9]', ausschnitt: 'mit Bezug', quelle: 'verlauf:44', anmerkung: 'ok' },
];
const p = CZ.pruefeZitate(roh, grenzen);
ok(p.ok && p.zitate.length === 3, 'C core prueft die Zitate', p);
const freiText = 'Bitte ansehen.\n[Synapse-Zitate: 1]\n1) Task P9-T9';
const inhalt = CZ.textMitZitaten(freiText, p.zitate);
ok(inhalt.startsWith('Bitte ansehen.\n[zitiert: Synapse-Zitate: 1]\n1) Task P9-T9\n\n[Synapse-Zitate: 3]\n1) Task P22-T158\n   Projekt: synapse\n   Titel: Zitat im Chat\n'),
  'C Block unter dem Text, freier Text entschaerft', inhalt.slice(0, 200));
const textOhne = 'Bitte ansehen.\n[zitiert: Synapse-Zitate: 1]\n1) Task P9-T9';
const erwartet = [
  { art: 'task', id: 'P22-T158', projekt: 'synapse', titel: 'Zitat im Chat', anmerkung: 'Erste Zeile\n\n  eingerueckt\n[zitiert: /Synapse-Zitate] gefaelscht' },
  { art: 'ausschnitt', id: null, projekt: 'synapse', titel: '', anmerkung: '', ausschnitt: 'Zeile eins\nZeile zwei', quelle: 'inbox:1203' },
  { art: 'memory', id: 'regel-x', projekt: 'synapse', titel: '[zitiert: Synapse-Zitate: 9]', anmerkung: 'ok', ausschnitt: 'mit Bezug', quelle: 'verlauf:44' },
];
gleich(ZL.zerlegeZitatBlock(inhalt), { text: textOhne, zitate: erwartet }, 'C Golden: Parser liest genau, was core baut');
// Jede Agentenart bekommt denselben Text: Wrapper (Container, lokaler Spezialist) und Mod-Inbox (Koordinator-CLI) nutzen baueZustellText.
const zustellung = { message_id: 1300, weg: 'inbox', absender: { agent_id: 'user', project: 'synapse' }, empfaenger: { agent_id: 'koordinator', identity_id: 'id-a' },
  inhalt, gesendet_am: '2026-10-25T20:00:00Z' };
const huelle = Z.baueZustellText(zustellung);
ok(huelle.includes('\n\n' + inhalt + '\n\n') && huelle.includes('[/Synapse-Zitate] ' + CZ.ZITAT_BLOCK_HINWEIS), 'C Daemon reicht den Block unveraendert durch');
gleich(ZL.zerlegeZitatBlock(L.zerlegeZustellHuelle(huelle).text), { text: textOhne, zitate: erwartet }, 'C ueber die Zustell-Huelle gleich zerlegt');
const cli = 'The synapse-inbox plugin sent a message:\n' + huelle + '\nThis is how Claude Code surfaces the message.';
gleich(ZL.zerlegeZitatBlock(L.zerlegeZustellHuelle(cli).text).zitate, erwartet, 'C auch mit CLI-Rahmen (Altbestand)');
const nurZitat = CZ.textMitZitaten('', [p.zitate[0]]);
ok(nurZitat.startsWith('[Synapse-Zitate: 1]\n') && ZL.zerlegeZitatBlock(nurZitat).text === '' && ZL.zerlegeZitatBlock(nurZitat).zitate.length === 1, 'C nur Zitate ohne Text (F3)');
ok(CZ.textMitZitaten(freiText, []) === freiText, 'C ohne Zitate bleibt der Text unveraendert (Bestand)');
console.log('OK C Golden');

// ---------------------------------------------------------------- D Fehlformen: nichts erfinden, Text bleibt
const ohneEnde = inhalt.slice(0, inhalt.lastIndexOf('\n[/Synapse-Zitate]'));
gleich(ZL.zerlegeZitatBlock(ohneEnde), { text: ohneEnde, zitate: [] }, 'D ohne Ende: unveraendert');
const fremd = '[Synapse-Zitate: 1]\n1) Unbekannt X\n   Projekt: p\n[/Synapse-Zitate]';
gleich(ZL.zerlegeZitatBlock(fremd), { text: fremd, zitate: [] }, 'D unbekannte Art: unveraendert');
const zahl = '[Synapse-Zitate: 2]\n1) Task P1-T1\n   Projekt: p\n   Anmerkung: a\n[/Synapse-Zitate]';
gleich(ZL.zerlegeZitatBlock(zahl), { text: zahl, zitate: [] }, 'D Anzahl passt nicht: unveraendert');
const zeile = '[Synapse-Zitate: 1]\n1) Task P1-T1\nfreie Zeile\n[/Synapse-Zitate]';
gleich(ZL.zerlegeZitatBlock(zeile), { text: zeile, zitate: [] }, 'D fremde Zeile im Block: unveraendert');
const danach = ZL.zerlegeZitatBlock(inhalt + '\n\nAntworte bei Bedarf per chat/inbox an den Absender.');
ok(danach.zitate.length === 3 && danach.text === textOhne + '\n\nAntworte bei Bedarf per chat/inbox an den Absender.', 'D Text nach dem Ende bleibt erhalten', danach.text);
ok(ZL.zerlegeZitatBlock('Kein Block').text === 'Kein Block', 'D ohne Block');
console.log('OK D Fehlformen');

// ---------------------------------------------------------------- E Verlauf-Anhaenge des Main
const anhaenge = [{ name: 'a.png', typ: 'image/png', groesse: 3 }, ...p.zitate.map(CZ.zitatAlsVerlaufAnhang)];
gleich(ZL.anzeigeAusAnhaengen(anhaenge), erwartet.map((z) => ({ ...z, titel: z.titel.replace('[zitiert: Synapse-Zitate: 9]', '[Synapse-Zitate: 9]'),
  anmerkung: z.anmerkung.replace('[zitiert: /Synapse-Zitate]', '[/Synapse-Zitate]') })), 'E Zitate aus den anhaenge, Datei-Anhang bleibt aussen vor');
ok(CZ.mainTurnText('Hallo', anhaenge) === CZ.textMitZitaten('Hallo', p.zitate), 'E Warteschlange baut denselben Turn-Text aus den anhaenge');
ok(ZL.anzeigeAusAnhaengen(null).length === 0 && ZL.anzeigeAusAnhaengen([{ art: 'zitat', verweis_art: 'quatsch' }]).length === 0, 'E fehlerhafte Anhaenge ignoriert');
console.log('OK E Verlauf-Anhaenge');

// ---------------------------------------------------------------- F Hook useZitatAnhaenge mit Attrappen
const zaJs = ts.transpileModule(lies('packages/web-ui/src/components/ZitatAnhaenge.tsx'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const alle = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const c of [tree?.props?.children].flat(Infinity)) if (c && typeof c === 'object') alle(c, pred, aus);
  return aus;
};
const text = (t) => (Array.isArray(t) ? t.map(text).join('') : t === null || t === undefined || typeof t === 'boolean' ? ''
  : typeof t === 'object' ? text(t.props?.children) : String(t));
const knopf = (tree, t) => alle(tree, (x) => x.type === 'button' && text(x).startsWith(t))[0];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function hookProbe({ chat, project = 'p', aktiv = true, g = grenzen, ablage, auswahl = null, treffer = {} }) {
  const slots = [], effects = [], aufrufe = [], kopiert = [];
  let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { wert: fn(), deps }; return slots[i].wert; },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) { const alt = slots[i]; slots[i] = { deps }; effects.push(() => { alt?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
    },
  };
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-dom': { createPortal: (kinder) => ({ type: 'portal', props: { children: kinder } }) },
    '../api/chat-zitate': { leseChatZitateStand: async (pr) => { aufrufe.push(pr); return { aktiv, quelle: aktiv ? 'intern' : 'standard', grenzen: g }; } },
    '../api/verweise': { bekannteTreffer: (_p, k) => treffer[k.text] },
    './Lesefenster': { findeKandidaten: (t) => [...t.matchAll(/P\d+-T\d+/g)].map((m) => ({ kandidat: { text: m[0] } })), useVerweisFenster: () => null },
    './zitat-logik': ZL,
  };
  const fenster = { innerWidth: 1200, innerHeight: 800, getSelection: () => auswahl };
  const doc = { querySelector: () => null, body: 'body', addEventListener() {}, removeEventListener() {} };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'document', 'localStorage', 'navigator', zaJs)((x) => {
    if (x.endsWith('.css')) return {};
    assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x);
    return modules[x];
  }, module, module.exports, fenster, doc, ablage, { clipboard: { writeText: async (t) => { kopiert.push(t); } } });
  let props = { chat, empfaenger: 'Agent ' + chat, project };
  const render = (aenderung = {}) => { props = { ...props, ...aenderung }; cursor = 0; const s = module.exports.useZitatAnhaenge(props); while (effects.length) effects.shift()(); return s; };
  return { render, aufrufe, kopiert, ZitatKarten: module.exports.ZitatKarten };
}
const editorVon = (s) => alle(s.oberflaeche, (x) => x.props?.['data-zitat-editor'] === '')[0];
const textareaVon = (s) => alle(editorVon(s), (x) => x.type === 'textarea')[0];

{
  const ablageF = new Ablage();
  const h = hookProbe({ chat: 'agent:A', ablage: ablageF });
  let s = h.render(); await flush(); s = h.render();
  ok(s.aktiv && s.anbieter && s.debug['data-zitat-schalter'] === 'ein' && h.aufrufe[0] === 'p', 'F Schalter EIN laut Status-Route (Projekt des Empfaengers)', s.debug);
  ok(s.anbieter.empfaenger === 'Agent agent:A', 'F Anbieter nennt den Empfaenger');
  const geoeffnet = [];
  s.anbieter.menue({ x: 10, y: 20 }, [v1], { oeffnen: () => geoeffnet.push(1) });
  s = h.render();
  ok(alle(s.oberflaeche, (x) => x.props?.['data-zitat-menue'] === '').length === 1 && knopf(s.oberflaeche, 'Zitat anfügen') && knopf(s.oberflaeche, 'Öffnen'), 'F Menue: Zitat anfügen + Öffnen');
  knopf(s.oberflaeche, 'Öffnen').props.onClick(); s = h.render();
  ok(geoeffnet.length === 1 && !s.oberflaeche, 'F Öffnen schliesst das Menue und oeffnet das Lesefenster');
  s.anbieter.menue({ x: 10, y: 20 }, [v1]); s = h.render();
  knopf(s.oberflaeche, 'Zitat anfügen').props.onClick(); s = h.render();
  ok(editorVon(s) && text(editorVon(s)).includes('Task P1-T2') && text(editorVon(s)).includes('Titel zwei') && text(editorVon(s)).includes('Agent agent:A'), 'F Editor: Art, ID, Titel, Empfaenger');
  textareaVon(s).props.onChange({ target: { value: 'Bitte so umsetzen' } }); s = h.render();
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  ok(s.entwuerfe.length === 1 && s.oberflaeche === null && s.debug['data-zitate-entwurf'] === 1, 'F Speichern -> Kaertchen, Editor zu');
  ok(ZL.leseZitatEntwurf(ablageF, 'agent:A').length === 1, 'F Entwurf liegt im localStorage dieses Chats');
  const karte = alle(s.karten, (x) => x.props?.className === 'zitat-karte')[0];
  ok(karte && text(karte).includes('Task P1-T2') && text(karte).includes('Titel zwei') && text(karte).includes('Bitte so umsetzen'), 'F Kaertchen: Art, ID, Titel, Anfang der Anmerkung');
  gleich(s.sendeZitate, [{ art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Titel zwei', anmerkung: 'Bitte so umsetzen' }], 'F sendeZitate fuer die Senderoute');
  // Abbrechen fuegt nichts hinzu
  s.anbieter.anfuegen(v1); s = h.render();
  knopf(s.oberflaeche, 'Abbrechen').props.onClick(); s = h.render();
  ok(s.entwuerfe.length === 1 && !s.oberflaeche, 'F Abbrechen fuegt nichts hinzu');
  // Klick aufs Kaertchen = bearbeiten
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-inhalt')[0].props.onClick({ clientX: 100, clientY: 500 }); s = h.render();
  ok(textareaVon(s).props.value === 'Bitte so umsetzen', 'F Klick aufs Kaertchen oeffnet die Anmerkung zum Bearbeiten');
  textareaVon(s).props.onChange({ target: { value: 'geändert' } }); s = h.render();
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  ok(s.entwuerfe.length === 1 && s.entwuerfe[0].anmerkung === 'geändert', 'F bearbeitet, kein zweites Zitat');
  // zweites Zitat, dann x loescht nur dieses
  s.anbieter.anfuegen(v2); s = h.render(); knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  ok(s.entwuerfe.length === 2, 'F beliebig viele (hier zwei)');
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-weg')[1].props.onClick(); s = h.render();
  ok(s.entwuerfe.length === 1 && s.entwuerfe[0].art === 'task', 'F x loescht genau dieses Zitat');
  // Empfaengerwechsel im selben Fenster: nie den Entwurf des vorigen mitnehmen
  s = h.render({ chat: 'agent:B', empfaenger: 'Agent B' });
  s = h.render();
  ok(s.entwuerfe.length === 0 && s.sendeZitate.length === 0, 'F Empfaengerwechsel: Entwurf von A erscheint nicht bei B');
  s = h.render({ chat: 'agent:A', empfaenger: 'Agent agent:A' }); s = h.render();
  ok(s.entwuerfe.length === 1, 'F zurueck zu A: dessen Entwurf ist noch da (F5/Tab-Schliessen)');
  s.leeren(); s = h.render();
  ok(s.entwuerfe.length === 0 && ZL.leseZitatEntwurf(ablageF, 'agent:A').length === 0, 'F nach dem Senden geleert (Speicher auch)');
}
{
  // Grenzen aus der Status-Route
  const h = hookProbe({ chat: 'main', project: null, g: { ...grenzen, max_anzahl: 1, anmerkung_max: 5 }, ablage: new Ablage() });
  let s = h.render(); await flush(); s = h.render();
  ok(h.aufrufe[0] === null, 'F Main fragt den globalen Schalter');
  s.anbieter.anfuegen(v1); s = h.render();
  textareaVon(s).props.onChange({ target: { value: 'zu lang' } }); s = h.render();
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  ok(s.entwuerfe.length === 0 && text(editorVon(s)).includes('Höchstens 5 Zeichen'), 'F Grenze anmerkung_max sichtbar, nichts gespeichert');
  textareaVon(s).props.onChange({ target: { value: 'kurz' } }); s = h.render();
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  s.anbieter.anfuegen(v2); s = h.render(); knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  ok(s.entwuerfe.length === 1 && text(editorVon(s)).includes('Höchstens 1 Zitate'), 'F Grenze max_anzahl sichtbar');
}
{
  // Schalter AUS = Bestand: kein Anbieter (Browser-Menue), keine Kaertchen, nichts geht mit
  const ablageAus = new Ablage();
  ZL.merkeZitatEntwurf(ablageAus, 'agent:A', liste);
  const h = hookProbe({ chat: 'agent:A', aktiv: false, ablage: ablageAus });
  let s = h.render(); await flush(); s = h.render();
  ok(s.anbieter === null && s.karten === null && s.oberflaeche === null && s.sendeZitate.length === 0 && s.debug['data-zitat-schalter'] === 'aus', 'F Schalter AUS: alles aus', s.debug);
}
{
  // Markierter Text in EINER Nachricht -> Zitat (mit Bezug auf genau einen erkannten Verweis), Kopieren, Shift = Browser-Menue
  const auswahl = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: 'knoten' }), toString: () => 'Siehe P1-T2 bitte' };
  const h = hookProbe({ chat: 'agent:A', ablage: new Ablage(), auswahl, treffer: { 'P1-T2': [{ art: 'task', id: 'P1-T2', titel: 'Titel zwei' }] } });
  let s = h.render(); await flush(); s = h.render();
  const ev = (o = {}) => ({ shiftKey: false, defaultPrevented: false, clientX: 5, clientY: 6, nativeEvent: {}, currentTarget: { contains: (k) => k === 'knoten' },
    preventDefault() { this.defaultPrevented = true; }, ...o });
  let e = ev({ shiftKey: true }); s.beiKontextmenue(e, 'inbox:9', 'p'); s = h.render();
  ok(!e.defaultPrevented && !s.oberflaeche, 'F Shift+Rechtsklick: Browser-Menue (F4)');
  e = ev({ currentTarget: { contains: () => false } }); s.beiKontextmenue(e, 'inbox:9', 'p'); s = h.render();
  ok(!e.defaultPrevented && !s.oberflaeche, 'F Markierung ausserhalb dieser Nachricht: Browser-Menue');
  e = ev(); s.beiKontextmenue(e, 'inbox:9', 'p'); s = h.render();
  ok(e.defaultPrevented && knopf(s.oberflaeche, 'Zitat anfügen') && knopf(s.oberflaeche, 'Kopieren'), 'F Markierung: eigenes Menue mit Kopieren');
  knopf(s.oberflaeche, 'Kopieren').props.onClick(); await flush(); s = h.render();
  ok(h.kopiert[0] === 'Siehe P1-T2 bitte' && !s.oberflaeche, 'F Kopieren schreibt die Markierung in die Zwischenablage');
  s.beiKontextmenue(ev(), 'inbox:9', 'p'); s = h.render();
  knopf(s.oberflaeche, 'Zitat anfügen').props.onClick(); s = h.render();
  ok(text(editorVon(s)).includes('Task P1-T2') && text(editorVon(s)).includes('Siehe P1-T2 bitte'), 'F Ausschnitt mit Bezug auf den einen erkannten Verweis');
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  gleich(s.sendeZitate, [{ art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Titel zwei', ausschnitt: 'Siehe P1-T2 bitte', quelle: { nachricht: 'inbox:9' }, anmerkung: '' }], 'F Ausschnitt-Zitat mit Quelle');
  const h2 = hookProbe({ chat: 'agent:A', ablage: new Ablage(), auswahl: { ...auswahl, toString: () => 'nur Text' } });
  s = h2.render(); await flush(); s = h2.render();
  s.beiKontextmenue(ev(), 'verlauf:3', 'p'); s = h2.render();
  knopf(s.oberflaeche, 'Zitat anfügen').props.onClick(); s = h2.render(); knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h2.render();
  gleich(s.sendeZitate, [{ art: 'ausschnitt', projekt: 'p', titel: '', ausschnitt: 'nur Text', quelle: { nachricht: 'verlauf:3' }, anmerkung: '' }], 'F Ausschnitt ohne Verweis');
  // Kaertchen in Nachrichten
  const karten = h.ZitatKarten({ zitate: erwartet, project: 'p' });
  ok(karten.props['data-zitate'] === 3 && text(karten).includes('Task P22-T158') && text(karten).includes('aus inbox:1203') && text(karten).includes('Zeile eins'), 'F Zitate einer Nachricht als Kaertchen');
}
console.log('OK F Hook');

// ---------------------------------------------------------------- G Koordinator-Fenster (EinheitlicherAgentChat)
const chatJs = ts.transpileModule(lies('packages/web-ui/src/components/EinheitlicherAgentChat.tsx'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const defer = () => { let res, rej; const promise = new Promise((a, b) => { res = a; rej = b; }); return { promise, resolve: res, reject: rej }; };
function chatProbe() {
  const slots = [], effects = [], timers = new Map(), verlauf = [], inbox = [], sends = [], hookAufrufe = [];
  let cursor = 0, timerId = 0, geleert = 0;
  let props = { identityId: 'synthetisch-A', name: 'Agent A', project: 'synthetisch', pollMs: 4000 };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { const old = slots[i]; effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); } },
    useLayoutEffect(fn, deps) { return hooks.useEffect(fn, deps); },
  };
  const anbieter = { empfaenger: 'Agent A', menue() {}, anfuegen() {} };
  const zitatStand = (o) => ({ aktiv: true, anbieter, entwuerfe: [], sendeZitate: [{ art: 'task', id: 'P1-T2', projekt: 'synthetisch', titel: 'T', anmerkung: 'A' }],
    anzeige: [{ art: 'task', id: 'P1-T2', projekt: 'synthetisch', titel: 'T', anmerkung: 'A' }], leeren() { geleert++; }, beiKontextmenue() {}, oberflaeche: 'OBERFLAECHE',
    karten: 'KARTEN', debug: { 'data-zitat-schalter': 'ein', 'data-zitate-entwurf': 1 }, ...o });
  const api = {
    getAgentVerlauf(id, abfrage) { const d = { ...defer(), abfrage }; verlauf.push(d); return d.promise; },
    getAgentChatInbox(id, o) { const d = { ...defer(), o }; inbox.push(d); return d.promise; },
    sendePlattformAgentChat(identityId, text, zitate) { const d = { ...defer(), identityId, text, zitate }; sends.push(d); return d.promise; },
    abonniereToolKarten() { return () => {}; },
  };
  const modules = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../api/agent-runtime': api,
    './ChatEingabefeld': { ChatEingabefeld: 'ChatEingabefeld' }, './Lesefenster': { VerweisFensterProvider: 'Provider', KlartextText: 'KlartextText', NachrichtBilder: 'NachrichtBilder' },
    '../kios/AgentRenderingSurface': { default: 'AgentRenderingSurface' },
    './ArtefaktBewertung': { ArtefaktBewertung: 'ArtefaktBewertung', useArtefaktBewertungen: () => ({ aktiv: false, je: {}, setze() {} }) },
    './ArtefaktLiveBlock': { ArtefaktLiveBlock: 'ArtefaktLiveBlock' },
    './artefakt-bewertung-logik': B, './agent-chat-teile': { ToolActivity: 'ToolActivity' }, './agent-chat-logik': L,
    './chat-fenster-logik': F, './chat-fenster-speicher': SP,
    './ZitatAnhaenge': { ZitatKarten: 'ZitatKarten', useZitatAnhaenge: (o) => { hookAufrufe.push(o); return zitatStand(); } }, './zitat-logik': ZL,
  };
  const window = { setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval(id) { timers.delete(id); }, setTimeout() { return 0; }, clearTimeout() {} };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', chatJs)((x) => {
    if (x.endsWith('.css')) return {};
    assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x);
    return modules[x];
  }, module, module.exports, window);
  const render = (aenderung = {}) => { props = { ...props, ...aenderung }; cursor = 0; const tree = module.exports.EinheitlicherAgentChat(props); while (effects.length) effects.shift()(); return tree; };
  return { render, verlauf, inbox, sends, hookAufrufe, anbieter, get geleert() { return geleert; }, unmount() { for (const s of slots) s?.cleanup?.(); } };
}
{
  SP.verwirfChatFensterSitzung();
  const zeit = (i) => new Date(Date.UTC(2026, 9, 25, 20, 0, i)).toISOString();
  const pr = chatProbe();
  let tree = pr.render();
  ok(pr.hookAufrufe[0].chat === 'agent:synthetisch-A' && pr.hookAufrufe[0].project === 'synthetisch' && pr.hookAufrufe[0].empfaenger === 'Agent A',
    'G Zitate je Empfaenger (identity_id) und Projekt der Zielidentitaet', pr.hookAufrufe[0]);
  const provider = alle(tree, (x) => x.type === 'Provider')[0];
  ok(provider.props.zitat === pr.anbieter, 'G Provider des Fensters traegt den Anbieter (Lesefenster/Verweise haengen nur hier an)');
  const section = alle(tree, (x) => x.type === 'section')[0];
  ok(section.props['data-zitat-schalter'] === 'ein' && section.props['data-zitate-entwurf'] === 1, 'G Debug-Attribute an der Wurzel');
  ok(JSON.stringify(tree).includes('KARTEN') && JSON.stringify(tree).includes('OBERFLAECHE'), 'G Kaertchen ueber dem Eingabefeld, Menue/Editor eingebunden');
  pr.verlauf[0].resolve({ verfuegbar: true, identity_id: 'x', eintraege: [], mehr: false, max_rev: '0', geleert_rev: '0', tool_karten: { aktiv: false } });
  pr.inbox[0].resolve({ aktiv: true, nachrichten: [{ id: 501, richtung: 'aus', von: 'koordinator', an: 'user', text: inhalt, erstellt_am: zeit(1) }], mehr: false });
  await flush(); tree = pr.render();
  const msg = alle(tree, (x) => x.props && x.props['data-nachricht'] === 'inbox:501')[0];
  const klar = alle(msg, (x) => x.type === 'KlartextText')[0];
  const zk = alle(msg, (x) => x.type === 'ZitatKarten')[0];
  ok(klar.props.text === textOhne && zk.props.zitate.length === 3 && typeof msg.props.onContextMenu === 'function', 'G Nachricht mit Block: Text ohne Block, Zitate als Kaertchen, Markierung zitierbar');
  // Nur Zitate ohne Text: Senden frei, geht an DIESE identity_id
  const feld = alle(tree, (x) => x.type === 'ChatEingabefeld')[0];
  ok(feld.props.sendeGesperrt === false, 'G Senden mit Zitaten auch ohne Text frei (F3)');
  const form = alle(tree, (x) => x.type === 'form')[0];
  const lauf = form.props.onSubmit({ preventDefault() {} });
  ok(pr.sends.length === 1 && pr.sends[0].identityId === 'synthetisch-A' && pr.sends[0].text === '' && pr.sends[0].zitate.length === 1, 'G sendet genau einmal an die eigene identity_id mit den Zitaten');
  pr.sends[0].resolve({ inbox_id: 777 }); await lauf; await flush(); tree = pr.render();
  ok(pr.geleert === 1, 'G Entwurf nach Erfolg geleert');
  const offen = alle(tree, (x) => x.type === 'article' && JSON.stringify(x).includes('zugestellt per Inbox #777'))[0];
  ok(offen && alle(offen, (x) => x.type === 'ZitatKarten')[0]?.props.zitate.length === 1 && !alle(offen, (x) => x.type === 'KlartextText').length, 'G gesendete Nachricht zeigt ihre Zitate (ohne leeren Text)');
  // Anderer Empfaenger im selben Fenster: eigener Entwurf, Senden an B
  tree = pr.render({ identityId: 'synthetisch-B', name: 'Agent B' }); tree = pr.render();
  ok(pr.hookAufrufe.at(-1).chat === 'agent:synthetisch-B', 'G Fenster fuer B nutzt den Entwurf von B');
  pr.unmount();
}
console.log('OK G Koordinator-Fenster');

// ---------------------------------------------------------------- H Einbau und Beleg F2
const lese = lies('packages/web-ui/src/components/Lesefenster.tsx');
ok(/export function VerweisFensterProvider\(\{ children, zitat = null \}/.test(lese) && /zitat\?: ZitatAnbieter \| null;/.test(lese), 'H Provider traegt die Zitate des Fensters');
ok(/onContextMenu: \(event: ReactMouseEvent<HTMLElement>\) => \{\n\s+druck\.abbrechen\(\);\n\s+if \(event\.shiftKey\) return;\n\s+event\.preventDefault\(\);/.test(lese), 'H Verweis: Rechtsklick -> Menue, Shift = Browser-Menue');
ok(/event\.pointerType !== 'touch'/.test(lese) && /LANG_DRUECKEN_MS = 550/.test(lese), 'H mobil: langes Druecken');
ok(/className="verweis-zitat"[\s\S]{0,300}zitat\.anfuegen\(\{ art: fenster\.art, id: inhalt\.id \|\| fenster\.id, projekt: fenster\.project, titel: inhalt\.titel \}/.test(lese), 'H Knopf Zitat anfügen im Lesefenster');
const flaeche = lies('packages/web-ui/src/kios/AgentRenderingSurface.tsx');
ok(/content\.addEventListener\('contextmenu'/.test(flaeche) && /const zitat = fenster\?\.zitat;/.test(flaeche), 'H Verweise im Artefakt (Shadow-DOM) zitierbar');
const main = lies('packages/web-ui/src/views/hauptagent/MainAgentView.tsx');
const verlauf = lies('packages/web-ui/src/views/hauptagent/verlauf.ts');
ok(/useZitatAnhaenge\(\{ chat: 'main', empfaenger: 'Hauptagent', project: null \}\)/.test(main) && /<VerweisFensterProvider zitat=\{zitat\.anbieter\}>/.test(main), 'H Main-Chat: Zitate nur an den Hauptagenten');
ok(/\}, controller\.signal, zitate\.length \? zitate : undefined\);/.test(main) && /anzeigeAusAnhaengen\(eintrag\.anhaenge\)/.test(verlauf), 'H Main sendet die Zitate mit und zeigt sie aus dem Verlauf');
const api = lies('packages/web-ui/src/api/agent-runtime.ts');
ok(/body: JSON\.stringify\(\{ message, \.\.\.\(zitate\?\.length \? \{ zitate \} : \{\}\) \}\)/.test(api) && /body: JSON\.stringify\(\{ identity_id: identityId, text, \.\.\.\(zitate\?\.length \? \{ zitate \} : \{\}\) \}\)/.test(api), 'H API: zitate nur bei Bedarf im Body');
// F2: Koordinator-Fenster (Dock) und Agenten-/Spezialisten-Fenster (Channel-Weiche) laufen ueber PlattformAgentChat -> EinheitlicherAgentChat.
ok(/<PlattformAgentChat\b[^>]*identityId=\{open\.id\}/.test(lies('packages/web-ui/src/components/ProjectCoordinatorDock.tsx')), 'H F2 Koordinator-Dock -> PlattformAgentChat');
ok(/<PlattformAgentChat\b[^>]*identityId=\{id\}/.test(lies('packages/web-ui/src/components/ChannelAgentFensterWeiche.tsx')), 'H F2 Agenten-/Spezialisten-Fenster (Weiche) -> PlattformAgentChat');
const pac = lies('packages/web-ui/src/components/PlattformAgentChat.tsx');
ok(/einheitlich\.aktiv\) return <EinheitlicherAgentChat /.test(pac) && !/zitat/i.test(pac), 'H F2 PlattformAgentChat -> EinheitlicherAgentChat (Altansicht ohne Zitate, Stufe 1)');
ok(!/zitat/i.test(lies('packages/web-ui/src/components/ChannelAgentChatWindow.tsx')), 'H F2 Channel-Fenster ohne Zitate (Stufe 1, Channel hat mehrere Leser)');
console.log('OK H Einbau');
console.log('P22-T168 Web-UI: ' + n + ' Pruefungen bestanden');
