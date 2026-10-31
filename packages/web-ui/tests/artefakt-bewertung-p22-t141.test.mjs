/**
 * P22-T141: Artefakt-Bewertung in der Web-UI - reine Logik, der gemeinsame Baustein (echter TSX-Code mit Hook-/API-Attrappen) und der
 * Einbau in beide Fenster (Main-Chat NativeHtmlMessage, Koordinator-Fenster EinheitlicherAgentChat). Keine DB, kein Netz.
 *   node --experimental-strip-types packages/web-ui/tests/artefakt-bewertung-p22-t141.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const B = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/artefakt-bewertung-logik.ts')).href);
const lies = (p) => readFileSync(join(repo, p), 'utf8');

// A Logik: Zustand wie im Server, Vorschau, Anfrage, Quellen
assert.equal(B.erwarteterZustand('hoch', ''), 'vorbild');
assert.equal(B.erwarteterZustand('hoch', 'schoen'), 'vorbild', 'hoch bleibt Vorbild, auch mit Kommentar');
assert.equal(B.erwarteterZustand('runter', 'Farben zu grell'), 'ueberarbeiten');
assert.equal(B.erwarteterZustand('runter', '   '), 'verbannt', 'nur Leerraum zaehlt nicht als Kommentar');
assert.deepEqual([B.ZUSTAND_CHIP.vorbild, B.ZUSTAND_CHIP.ueberarbeiten, B.ZUSTAND_CHIP.verbannt], ['Vorbild', 'Wird überarbeitet', 'Verbannt'], 'Chips wie vorgegeben');
assert.equal(B.vorschauText('runter', ''), 'Wird gespeichert als: Verbannt');
assert.deepEqual(B.baueAnfrage({ art: 'inbox', ref: '1038', identityId: 'id-1' }, 'runter', '  zu bunt '), { quelle_art: 'inbox', quelle_ref: '1038', identity_id: 'id-1', urteil: 'runter', kommentar: 'zu bunt' });
assert.deepEqual(B.baueAnfrage({ art: 'artefakt', ref: 'a-1' }, 'hoch', ''), { quelle_art: 'artefakt', quelle_ref: 'a-1', urteil: 'hoch' }, 'ohne identity_id und leeren Kommentar');
assert.deepEqual(B.quelleFuerChatNachricht({ id: 'inbox:1038', inboxId: 1038 }, 'K'), { art: 'inbox', ref: '1038', identityId: 'K' });
assert.deepEqual(B.quelleFuerChatNachricht({ id: '4711' }, 'K'), { art: 'verlauf', ref: '4711', identityId: 'K' });
assert.equal(B.quelleFuerChatNachricht({ id: 'inbox:9' }, 'K'), null, 'Inbox ohne inboxId nicht bewertbar');
assert.equal(B.quelleFuerChatNachricht({ id: 'lokal-1' }, 'K'), null, 'lokale Eintraege nicht bewertbar');
assert.equal(B.quellenListeParam([{ art: 'inbox', ref: '1' }, { art: 'verlauf', ref: '2' }, { art: 'inbox', ref: '1' }]), 'inbox:1,verlauf:2', 'eindeutig');
assert.equal(B.quellenListeParam([]), '');
assert.match(B.SYMBOL_TEXT.hoch, /gefällt/);
assert.match(B.SYMBOL_TEXT.runter, /ohne Kommentar verbannen/);
console.log('OK A Logik');

// B Baustein: echter TSX-Code, Hooks/API als Attrappen
const { default: ts } = await import('typescript');
const quelltext = lies('packages/web-ui/src/components/ArtefaktBewertung.tsx');
const js = ts.transpileModule(quelltext, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function probe() {
  const slots = []; const sends = []; let cursor = 0;
  const hooks = {
    useState(i) { const k = cursor++; if (!(k in slots)) slots[k] = typeof i === 'function' ? i() : i; return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }]; },
    useEffect() { cursor++; }, useCallback(fn) { cursor++; return fn; },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const api = {
    getArtefaktBewertungen: async () => ({ aktiv: true, bewertungen: [] }),
    sendeArtefaktBewertung: async (b) => { sends.push(b); return { bewertung: { id: '7', quelle_art: b.quelle_art, quelle_ref: b.quelle_ref, urteil: b.urteil, kommentar: b.kommentar ?? null, zustand: B.erwarteterZustand(b.urteil, b.kommentar ?? '') } }; },
  };
  const modules = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, '../api/agent-runtime': api, './artefakt-bewertung-logik': B };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)((p) => (p.endsWith('.css') ? {} : modules[p]), module, module.exports);
  return { M: module.exports, sends, render: (props) => { cursor = 0; return module.exports.ArtefaktBewertung(props); } };
}
const alle = (baum, pruefe, aus = []) => {
  if (!baum || typeof baum !== 'object') return aus;
  if (Array.isArray(baum)) { for (const k of baum) alle(k, pruefe, aus); return aus; }
  if (pruefe(baum)) aus.push(baum);
  alle(baum.props?.children, pruefe, aus);
  return aus;
};
const knoepfe = (baum) => alle(baum, (n) => n.type === 'button' && n.props.className?.startsWith('bewertung-knopf'));
const text = (baum) => alle(baum, () => true).flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join(' ');

{
  const p = probe();
  const gespeichert = [];
  const props = { quelle: { art: 'inbox', ref: '1038', identityId: 'K' }, onGespeichert: (b) => gespeichert.push(b) };
  let baum = p.render(props);
  let [hoch, runter] = knoepfe(baum);
  assert.equal(hoch.props['aria-label'], B.SYMBOL_TEXT.hoch);
  assert.equal(hoch.props.title, B.SYMBOL_TEXT.hoch, 'Tooltip');
  assert.equal(runter.props['aria-label'], B.SYMBOL_TEXT.runter);
  assert.equal(hoch.props['aria-pressed'], false);
  assert.equal(runter.props['aria-pressed'], false);
  assert.equal(alle(baum, (n) => n.type === 'form').length, 0, 'ohne Wahl kein Formular');
  assert.equal(alle(baum, (n) => n.props?.className?.startsWith?.('bewertung-chip')).length, 0, 'ohne Stand kein Chip');
  // Symbol: eigenes Inline-SVG, Linien in currentColor, kein Emoji
  const svgHoch = p.M.BewertungsSymbol({ art: 'hoch' });
  const svgRunter = p.M.BewertungsSymbol({ art: 'runter' });
  assert.equal(svgHoch.type, 'svg');
  assert.equal(svgHoch.props.stroke, 'currentColor');
  assert.equal(svgHoch.props.fill, 'none');
  assert.equal(svgHoch.props['aria-hidden'], 'true', 'Symbol ist Deko, Beschriftung traegt der Knopf');
  assert.notDeepEqual(JSON.stringify(svgHoch), JSON.stringify(svgRunter), 'zwei verschiedene Symbole');
  assert.equal(hoch.props.children.type, p.M.BewertungsSymbol);
  // hoch waehlen -> Formular mit Vorschau, Senden
  hoch.props.onClick();
  baum = p.render(props);
  [hoch] = knoepfe(baum);
  assert.equal(hoch.props['aria-pressed'], true, 'gewaehlt sichtbar');
  assert.match(hoch.props.className, /gewaehlt/);
  assert.match(text(baum), /Wird gespeichert als: Vorbild/);
  const form = alle(baum, (n) => n.type === 'form')[0];
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(p.sends[0], { quelle_art: 'inbox', quelle_ref: '1038', identity_id: 'K', urteil: 'hoch' });
  assert.equal(gespeichert[0].zustand, 'vorbild', 'Stand an das Fenster gemeldet');
  baum = p.render({ ...props, stand: gespeichert[0] });
  assert.equal(alle(baum, (n) => n.type === 'form').length, 0, 'nach dem Senden zu');
  assert.match(text(baum), /Vorbild/, 'Chip Vorbild');
  // aendern: runter + Kommentar -> ueberarbeiten
  [, runter] = knoepfe(baum);
  runter.props.onClick();
  baum = p.render({ ...props, stand: gespeichert[0] });
  alle(baum, (n) => n.type === 'textarea')[0].props.onChange({ target: { value: 'Rahmen zu dick' } });
  baum = p.render({ ...props, stand: gespeichert[0] });
  assert.match(text(baum), /Wird gespeichert als: Wird überarbeitet/);
  await alle(baum, (n) => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(p.sends[1], { quelle_art: 'inbox', quelle_ref: '1038', identity_id: 'K', urteil: 'runter', kommentar: 'Rahmen zu dick' });
  assert.equal(gespeichert[1].zustand, 'ueberarbeiten');
}
{
  const p = probe();
  const baum = p.render({ quelle: { art: 'artefakt', ref: 'a1' }, onGespeichert() {}, stand: { id: '3', quelle_art: 'artefakt', quelle_ref: 'a1', urteil: 'runter', kommentar: null, zustand: 'verbannt' } });
  const [hoch, runter] = knoepfe(baum);
  assert.equal(runter.props['aria-pressed'], true);
  assert.match(runter.props.className, /gewaehlt/);
  assert.match(runter.props.className, /verbannt/, 'verbannt gedaempft rot');
  assert.equal(hoch.props['aria-pressed'], false);
  assert.match(text(baum), /Verbannt/);
  assert.equal(alle(baum, (n) => n.props?.['data-zustand'] === 'verbannt').length, 1, 'DEBUG data-zustand');
}
console.log('OK B Baustein (Symbole, aria, Zustaende, Senden)');

// C Stil, kein Emoji, keine Icon-Bibliothek
const css = lies('packages/web-ui/src/artefakt-bewertung.css');
for (const r of [/\.bewertung-knopf:hover/, /\.bewertung-knopf:focus-visible/, /\.bewertung-knopf\.gewaehlt/, /\.bewertung-chip\.vorbild/, /var\(--accent\)/]) assert.match(css, r);
// Akzentfarbe ist in den Einstellungen waehlbar (--accent am Wurzelelement): keine feste Farbe in Stil, Baustein und Logik.
const farbe = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:orange|red|crimson)\b/i;
assert.ok(!farbe.test(css), 'CSS ohne feste Farbe');
assert.ok(!farbe.test(quelltext), 'Baustein ohne feste Farbe');
assert.ok(!farbe.test(lies('packages/web-ui/src/components/artefakt-bewertung-logik.ts')), 'Logik ohne feste Farbe');
assert.match(css, /var\(--danger\)/, 'verbannt ueber die Status-Variable');
assert.match(lies('packages/web-ui/src/components/workspace/SynapseWorkspace.tsx'), /'--accent': settings\.accentColor/, 'Quelle der Akzentfarbe: Darstellungs-Einstellung');
const emoji = /[\u{1F300}-\u{1FAFF}✅✓\u{1F44D}\u{1F44E}]/u;
assert.ok(!emoji.test(quelltext), 'Baustein ohne Emoji');
assert.ok(!/from ['"](?:lucide|react-icons|@heroicons|@fortawesome)/.test(quelltext), 'keine Icon-Bibliothek');
console.log('OK C Stil');

// D Einbau: ein Baustein fuer beide Fenster; ohne Schalter Altansicht im Main
const chat = lies('packages/web-ui/src/components/EinheitlicherAgentChat.tsx');
assert.match(chat, /import \{ ArtefaktBewertung, useArtefaktBewertungen \} from '\.\/ArtefaktBewertung';/);
assert.match(chat, /quelleFuerChatNachricht\(m, identityId\)/);
assert.match(chat, /bewertung\.aktiv && htmlQuellen\.has\(m\.id\) && <ArtefaktBewertung quelle=\{htmlQuellen\.get\(m\.id\)!\}/, 'Leiste unter HTML-Antworten im Koordinator-Fenster');
const main = lies('packages/web-ui/src/components/gemeinsam/NativeHtmlMessage.tsx');
assert.match(main, /import \{ ArtefaktBewertung, useArtefaktBewertungen \} from '\.\.\/ArtefaktBewertung';/);
assert.match(main, /useArtefaktBewertungen\(message\.mock \? \[\] : \(message\.blocks \|\| \[\]\)\.map\(\(block\) => \(\{ art: 'artefakt' as const, ref: block\.id \}\)\)\)/, 'Main: je Block, Mock nicht');
assert.match(main, /bewertung\.aktiv && \(message\.blocks \|\| \[\]\)\.map\(\(block, index, alle\) => \(\s*<ArtefaktBewertung key=\{block\.id\}/, 'Main: Leiste je Block');
assert.match(main, /bewertung\.aktiv\s*\? <button[^>]*>\{message\.saved \? 'Gesichert' : 'Sichern'\}<\/button>/, 'Main: bei Schalter EIN keine Emoji-Knoepfe');
const zweig = main.slice(main.indexOf('{bewertung.aktiv\n'), main.indexOf('</div>', main.indexOf('{bewertung.aktiv\n')));
assert.ok(zweig.indexOf(': <>') > 0 && !emoji.test(zweig.slice(0, zweig.indexOf(': <>'))) && emoji.test(zweig.slice(zweig.indexOf(': <>'))), 'Emoji-Knoepfe nur im Zweig ohne Schalter (Altansicht)');
console.log('OK D Einbau Main-Chat und Koordinator-Fenster');
console.log('P22-T141 Web-UI: alle Pruefungen bestanden');
