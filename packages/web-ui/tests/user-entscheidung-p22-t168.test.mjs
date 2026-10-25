/**
 * P22-T168 Punkte 8/9: 'User-Entscheidung anpinnen' - Web-UI ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/user-entscheidung-p22-t168.test.mjs
 * A Hook useUserEntscheidung mit Attrappen (Schalter, Knopf, Editor, Pruefung, Speichern, Liste, Kontextmenue-Zaehler, Fehler,
 *   nur Task/Plan); B API-Client (Route, Body, Empfaenger); C Kontextmenue im Chat (ZitatAnhaenge: Menuepunkt nur mit anpinnen);
 * D Einbau (Lesefenster: Knopf im Kopf, Bereich unter den Metadaten, Verweis-Menue nur fuer Task/Plan; Artefakt unveraendert).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const ZL = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/zitat-logik.ts')).href);
const { default: ts } = await import('typescript');
let n = 0;
const ok = (wert, label, info) => { assert.ok(wert, label + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 600) : '')); n++; };
const gleich = (ist, soll, label) => { assert.deepStrictEqual(ist, soll, label); n++; };

const transpile = (p) => ts.transpileModule(lies(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const alle = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const c of [tree?.props?.children].flat(Infinity)) if (c && typeof c === 'object') alle(c, pred, aus);
  return aus;
};
const text = (t) => (Array.isArray(t) ? t.map(text).join('') : t === null || t === undefined || typeof t === 'boolean' ? ''
  : typeof t === 'object' ? text(t.props?.children) : String(t));
const knopf = (tree, t) => alle(tree, (x) => x.type === 'button' && text(x).startsWith(t))[0];
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function reactAttrappe() {
  const slots = [], effects = [];
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
  return { react, start: () => { cursor = 0; }, effekte: () => { while (effects.length) effects.shift()(); } };
}

function lade(js, modules, globals = {}) {
  const module = { exports: {} };
  const namen = Object.keys(globals);
  new Function('require', 'module', 'exports', ...namen, js)((x) => {
    if (x.endsWith('.css')) return {};
    assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x);
    return modules[x];
  }, module, module.exports, ...namen.map((k) => globals[k]));
  return module.exports;
}

const ART_LABEL = { task: 'Task', plan: 'Plan', thought: 'Thought', memory: 'Memory' };
const ueJs = transpile('packages/web-ui/src/components/UserEntscheidung.tsx');

function hookProbe({ aktiv = true, max = 40, liste = [], pinne } = {}) {
  const r = reactAttrappe();
  const aufrufe = { stand: [], liste: [], pinne: [] };
  let eintraege = liste;
  const UE = lade(ueJs, {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '../api/chat-zitate': { leseChatZitateStand: async (p) => { aufrufe.stand.push(p); return { aktiv, quelle: aktiv ? 'intern' : 'standard', grenzen: { ...ZL.ZITAT_GRENZEN_STANDARD, anmerkung_max: max } }; } },
    '../api/user-entscheidung': {
      leseUserEntscheidungen: async (p, a, i) => { aufrufe.liste.push([p, a, i]); return { aktiv, eintraege, fehler: null }; },
      pinneUserEntscheidung: async (e) => {
        aufrufe.pinne.push(e);
        const erg = pinne ? pinne(e) : { ok: true, thought_id: 'abcdef12-0000-4000-8000-000000000001', task_id: e.art === 'task' ? e.id : null, empfaenger: ['rea4'] };
        if (erg.ok) eintraege = [{ id: erg.thought_id, source: 'user', content: e.text, tags: ['user-entscheidung', e.id], timestamp: '2026-10-25T20:00:00Z', task_id: erg.task_id }, ...eintraege];
        return erg;
      },
    },
    '../api/verweise': { ART_LABEL },
  }, { console: { debug() {}, log: console.log } });
  let props = { project: 'p', art: 'task', id: 'P1-T2', anzeigeId: 'P1-T2', titel: 'Zweite Aufgabe', anpinnen: 0 };
  const render = (aenderung = {}) => { props = { ...props, ...aenderung }; r.start(); const s = UE.useUserEntscheidung(props); r.effekte(); return s; };
  return { render, aufrufe, UE };
}
const editorVon = (s) => alle(s.bereich, (x) => x.props?.['data-user-entscheidung-editor'] === '')[0];
const textareaVon = (s) => alle(editorVon(s), (x) => x.type === 'textarea')[0];

// ---------------------------------------------------------------- A Hook
{
  const h = hookProbe({ aktiv: false });
  let s = h.render(); await flush(); s = h.render();
  ok(!s.aktiv && s.knopf === null && s.bereich === null, 'A Schalter AUS: kein Knopf, kein Bereich');
  ok(h.aufrufe.stand[0] === 'p' && h.aufrufe.liste.length === 0, 'A AUS: Schalter im Projekt des Verweises gelesen, Liste nicht geladen', h.aufrufe);
}
{
  // (angepasst P22-T171, User 83b5014f Punkt 4: jede Verweis-Art des Lesefensters; ausgeschlossen bleibt nur, was das Lesefenster nicht oeffnet)
  const h = hookProbe({ liste: [] });
  let s = h.render({ art: 'ausschnitt', id: 'abc12345' }); await flush(); s = h.render();
  ok(s.knopf === null && h.aufrufe.stand.length === 0 && h.aufrufe.liste.length === 0, 'A keine Verweis-Art (ausschnitt): ohne Knopf und ohne Abfrage');
  ok(h.UE.kannAnpinnen('task') && h.UE.kannAnpinnen('plan') && h.UE.kannAnpinnen('memory') && h.UE.kannAnpinnen('asset') && h.UE.kannAnpinnen('thought') && !h.UE.kannAnpinnen('ausschnitt'),
    'A kannAnpinnen jede Verweis-Art (P22-T171)');
}
{
  const alt = { id: 'aaaaaaaa-0000-4000-8000-000000000000', source: 'koordinator', content: 'USER-ENTSCHEIDUNG alt', tags: ['user-entscheidung'], timestamp: '2026-10-25T19:00:00Z', task_id: 'P1-T2' };
  const h = hookProbe({ liste: [alt], max: 40 });
  let s = h.render(); await flush(); s = h.render();
  ok(s.aktiv && knopf(s.knopf, 'User-Entscheidung anpinnen'), 'A EIN: Knopf User-Entscheidung anpinnen');
  gleich(h.aufrufe.liste[0], ['p', 'task', 'P1-T2'], 'A Liste der Task geladen');
  ok(/User-Entscheidungen \(1\)/.test(text(s.bereich)) && /USER-ENTSCHEIDUNG alt/.test(text(s.bereich)) && /koordinator/.test(text(s.bereich)), 'A angepinnte Entscheidungen sichtbar (auch die des Koordinators)', text(s.bereich));
  ok(!editorVon(s), 'A Editor anfangs zu');
  s.knopf.props.onClick(); s = h.render();
  ok(editorVon(s) && /Task P1-T2/.test(text(editorVon(s))) && /Zweite Aufgabe/.test(text(editorVon(s))), 'A Knopf oeffnet den Editor mit Art, ID, Titel');
  knopf(s.bereich, 'Speichern').props.onClick(); await flush(); s = h.render();
  ok(/Bitte die Entscheidung eintragen/.test(text(editorVon(s))) && h.aufrufe.pinne.length === 0, 'A leer: Hinweis, nichts gespeichert');
  textareaVon(s).props.onChange({ target: { value: 'x'.repeat(41) } }); s = h.render();
  knopf(s.bereich, 'Speichern').props.onClick(); await flush(); s = h.render();
  ok(/Höchstens 40 Zeichen/.test(text(editorVon(s))) && h.aufrufe.pinne.length === 0, 'A zu lang (anmerkung_max): Hinweis, nichts gespeichert');
  knopf(s.bereich, 'Abbrechen').props.onClick(); s = h.render();
  ok(!editorVon(s) && h.aufrufe.pinne.length === 0, 'A Abbrechen schliesst ohne Speichern');
  s.knopf.props.onClick(); s = h.render();
  textareaVon(s).props.onChange({ target: { value: '  So machen wir es: erst B, dann A.  ' } }); s = h.render();
  knopf(s.bereich, 'Speichern').props.onClick(); await flush(); s = h.render();
  gleich(h.aufrufe.pinne, [{ project: 'p', art: 'task', id: 'P1-T2', text: 'So machen wir es: erst B, dann A.', titel: 'Zweite Aufgabe' }], 'A Speichern -> POST mit Projekt, Art, ID und Wortlaut (aussen getrimmt; P22-T171: Titel des Bezugs)');
  ok(!editorVon(s) && /Angepinnt an Task P1-T2\. Hinweis an rea4\./.test(text(s.bereich)), 'A nach Speichern: Editor zu, Meldung mit Empfaenger des Hinweises', text(s.bereich));
  ok(/User-Entscheidungen \(2\)/.test(text(s.bereich)) && text(s.bereich).indexOf('So machen wir es') < text(s.bereich).indexOf('USER-ENTSCHEIDUNG alt'), 'A Liste neu geladen, neueste zuerst');
  ok(s.bereich.props['data-user-entscheidung'] === 2, 'A Debug-Attribut zaehlt die Eintraege');
  // Kontextmenue: Zaehler oeffnet den Editor (auch erneut)
  h.render({ anpinnen: 1 }); s = h.render();
  ok(editorVon(s), 'A Kontextmenue-Zaehler 1 oeffnet den Editor');
  knopf(s.bereich, 'Abbrechen').props.onClick(); s = h.render();
  h.render({ anpinnen: 2 }); s = h.render();
  ok(editorVon(s), 'A Zaehler 2 oeffnet den Editor im offenen Fenster erneut');
  // Escape schliesst
  textareaVon(s).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); s = h.render();
  ok(!editorVon(s), 'A Escape schliesst den Editor');
}
{
  const h = hookProbe({ pinne: () => ({ ok: false, code: 'funktion_aus', message: 'User-Entscheidung anpinnen ist aus (chat_zitate)' }) });
  let s = h.render({ art: 'plan', id: 'P1', anzeigeId: 'P1', titel: 'Plan eins' }); await flush(); s = h.render();
  s.knopf.props.onClick(); s = h.render();
  ok(/Plan P1/.test(text(editorVon(s))), 'A Plan: Editor mit Plan-Kurz-ID');
  textareaVon(s).props.onChange({ target: { value: 'Plan bleibt hoch' } }); s = h.render();
  knopf(s.bereich, 'Speichern').props.onClick(); await flush(); s = h.render();
  ok(editorVon(s) && /ist aus \(chat_zitate\)/.test(text(editorVon(s))) && textareaVon(s).props.value === 'Plan bleibt hoch', 'A Fehler: Editor bleibt mit Text und Meldung offen');
  gleich(h.aufrufe.pinne[0], { project: 'p', art: 'plan', id: 'P1', text: 'Plan bleibt hoch', titel: 'Plan eins' }, 'A Plan: art plan im POST');
}
console.log('OK A Hook');

// ---------------------------------------------------------------- B API-Client
{
  const anfragen = [];
  const antworten = [];
  const API = lade(transpile('packages/web-ui/src/api/user-entscheidung.ts'), {
    './auth': { apiFetch: async (url, init = {}) => { anfragen.push({ url, init }); const a = antworten.shift(); return { ok: a.status < 400, status: a.status, json: async () => a.body }; } },
  });
  antworten.push({ status: 200, body: { success: true, thought_id: 't1', task_id: 'P1-T2', hinweis: { empfaenger: [{ agent_id: 'rea4', inbox_id: 7 }, { agent_id: 'weg', inbox_id: null, fehler: 'x' }] } } });
  const r = await API.pinneUserEntscheidung({ project: 'p x', art: 'task', id: 'P1-T2', text: 'Wortlaut' });
  ok(anfragen[0].url === '/api/agent-runtimes/user-entscheidung' && anfragen[0].init.method === 'POST', 'B POST an die Anpinn-Route');
  gleich(JSON.parse(anfragen[0].init.body), { project: 'p x', art: 'task', id: 'P1-T2', text: 'Wortlaut' }, 'B Body unveraendert');
  gleich(r, { ok: true, thought_id: 't1', task_id: 'P1-T2', empfaenger: ['rea4'] }, 'B Empfaenger nur mit zugestelltem Hinweis');
  antworten.push({ status: 409, body: { success: false, error: { code: 'funktion_aus', message: 'aus' } } });
  gleich(await API.pinneUserEntscheidung({ project: 'p', art: 'plan', id: 'P1', text: 'x' }), { ok: false, code: 'funktion_aus', message: 'aus' }, 'B Fehler mit Code');
  antworten.push({ status: 200, body: { success: true, aktiv: true, eintraege: [{ id: 'a' }] } });
  const l = await API.leseUserEntscheidungen('p x', 'task', 'P1-T2');
  ok(anfragen[2].url === '/api/agent-runtimes/user-entscheidungen?project=p%20x&art=task&id=P1-T2' && l.aktiv && l.eintraege.length === 1 && l.fehler === null, 'B Liste: GET mit Projekt, Art, ID', anfragen[2]);
}
console.log('OK B API-Client');

// ---------------------------------------------------------------- C Kontextmenue im Chat (ZitatAnhaenge)
{
  const r = reactAttrappe();
  const Ablage = class { constructor() { this.m = new Map(); } get length() { return this.m.size; } key(i) { return [...this.m.keys()][i] ?? null; }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } };
  const ZA = lade(transpile('packages/web-ui/src/components/ZitatAnhaenge.tsx'), {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-dom': { createPortal: (kinder) => ({ type: 'portal', props: { children: kinder } }) },
    '../api/chat-zitate': { leseChatZitateStand: async () => ({ aktiv: true, quelle: 'intern', grenzen: ZL.ZITAT_GRENZEN_STANDARD }) },
    '../api/verweise': { bekannteTreffer: () => null },
    './Lesefenster': { findeKandidaten: () => [], useVerweisFenster: () => null },
    './zitat-logik': ZL,
  }, { window: { innerWidth: 1200, innerHeight: 800, getSelection: () => null }, document: { querySelector: () => null, body: 'body', addEventListener() {}, removeEventListener() {} },
    localStorage: new Ablage(), navigator: {} });
  const render = () => { r.start(); const s = ZA.useZitatAnhaenge({ chat: 'agent:A', empfaenger: 'Agent A', project: 'p' }); r.effekte(); return s; };
  let s = render(); await flush(); s = render();
  const v = { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe' };
  const angepinnt = [], geoeffnet = [];
  s.anbieter.menue({ x: 10, y: 20 }, [v], { oeffnen: () => geoeffnet.push(1), anpinnen: () => angepinnt.push(1) }); s = render();
  const punkte = alle(s.oberflaeche, (x) => x.type === 'button').map((b) => text(b));
  gleich(punkte, ['Zitat anfügen', 'User-Entscheidung anpinnen', 'Öffnen'], 'C Menue an Task-Verweis: Zitat anfügen, User-Entscheidung anpinnen, Öffnen');
  knopf(s.oberflaeche, 'User-Entscheidung anpinnen').props.onClick(); s = render();
  ok(angepinnt.length === 1 && geoeffnet.length === 0 && !s.oberflaeche, 'C Menuepunkt schliesst das Menue und oeffnet das Lesefenster zum Anpinnen');
  s.anbieter.menue({ x: 10, y: 20 }, [{ ...v, art: 'thought', id: 'abcdef12' }], { oeffnen: () => geoeffnet.push(1) }); s = render();
  ok(!knopf(s.oberflaeche, 'User-Entscheidung anpinnen') && knopf(s.oberflaeche, 'Öffnen'), 'C ohne anpinnen (z. B. Thought) kein Menuepunkt');
}
console.log('OK C Kontextmenue');

// ---------------------------------------------------------------- D Einbau
const lese = lies('packages/web-ui/src/components/Lesefenster.tsx');
// (angepasst P22-T171: id fuer andere Arten aus dem aufgeloesten Inhalt, Task/Plan wie bisher fenster.id)
ok(/const entscheidung = useUserEntscheidung\(\{\n\s+project: fenster\.project, art: fenster\.art, id: fenster\.art === 'task' \|\| fenster\.art === 'plan' \? fenster\.id : inhalt\?\.id \?\? '',\n\s+anzeigeId: inhalt\?\.id, titel: inhalt\?\.titel, anpinnen: fenster\.anpinnen,/.test(lese), 'D Lesefenster nutzt useUserEntscheidung je Fenster');
// P22-T170: zwischen 'Zitat anfügen' (Herkunft Chat/Channel) und dem Anpinn-Knopf steht der Knopf der Empfaengerauswahl (Herkunft ohne).
ok(/Zitat anfügen<\/button>\}\n\s+\{inhalt && auswahl\.knopf\}\n\s+\{inhalt && entscheidung\.knopf\}\n\s+<button type="button" onClick=\{onSchliessen\}/.test(lese), 'D Knopf im Kopf des Lesefensters (unabhaengig vom Chat)');
ok(/<\/dl>\n\s+\{entscheidung\.bereich\}/.test(lese), 'D Editor und angepinnte Entscheidungen unter den Metadaten');
ok(/kannAnpinnen\(treffer\[0\]\.art\) \? \{ anpinnen: \(\) => fenster\.oeffne\(\{ project, art: treffer\[0\]\.art, id: treffer\[0\]\.id, anpinnen: true \}\) \}/.test(lese), 'D Verweis-Menue im Chat: anpinnen fuer jede Verweis-Art (kannAnpinnen, P22-T171)');
ok(/anpinnen: \(f\?\.anpinnen \?\? 0\) \+ 1/.test(lese), 'D erneutes Anpinnen im offenen Fenster zaehlt hoch');
const flaeche = lies('packages/web-ui/src/kios/AgentRenderingSurface.tsx');
ok(!/anpinnen|UserEntscheidung/.test(flaeche), 'D Artefakt-Flaeche unveraendert (kein Anpinnen-Menue in Artefakten/Top-Artefakten)');
ok(!/anpinnen|UserEntscheidung/.test(lies('packages/web-ui/src/components/ArtefaktLiveBlock.tsx')), 'D ArtefaktLiveBlock unveraendert');
console.log('OK D Einbau');
console.log('P22-T168 User-Entscheidung Web-UI: ' + n + ' Pruefungen bestanden');
