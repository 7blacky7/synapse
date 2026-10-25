/**
 * P22-T166: Artefakte mit Skript nur in den Top-Artefakten - reine Logik des Skript-Rahmens (Web-UI).
 * Aufruf: node --experimental-strip-types packages/web-ui/tests/skript-rahmen-p22-t166.test.mjs
 * Rahmen-Attribute und CSP, srcdoc (CSP zuerst, Helfer vor dem Artefakt), Helfer (Kanal, Handshake nur vom Elternfenster),
 * Nachrichtenpruefung, Bruecken-Koerper (project vom Rahmen), Grenzen (Rate, Hoehe), Watchdog, Weiche F1, Verdrahtung im Quelltext.
 */
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const L = await import(pathToFileURL(join(hier, '..', 'src', 'kios', 'skript-rahmen-logik.ts')).href);
const H = await import(pathToFileURL(join(hier, '..', 'src', 'kios', 'skript-helfer.ts')).href);
let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 600) : '')); } };
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Attribute + CSP
check(L.SKRIPT_SANDBOX === 'allow-scripts', 'sandbox genau allow-scripts (kein same-origin, forms, popups, modals, top-navigation)');
for (const f of ['camera', 'microphone', 'geolocation', 'clipboard-read', 'clipboard-write', 'fullscreen', 'payment', 'usb']) {
  if (!L.SKRIPT_ALLOW.includes(f + " 'none'")) check(false, 'allow: ' + f + " 'none'", L.SKRIPT_ALLOW);
}
check(!/\*|self|src/.test(L.SKRIPT_ALLOW.replaceAll("'none'", '')), 'allow: nur none, nichts erlaubt', L.SKRIPT_ALLOW);
const csp = Object.fromEntries(L.SKRIPT_CSP.split(';').map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
check(csp['default-src'] === "'none'" && csp['connect-src'] === "'none'" && csp['form-action'] === "'none'" && csp['base-uri'] === "'none'"
  && csp['frame-src'] === "'none'" && csp['worker-src'] === "'none'" && csp['object-src'] === "'none'", 'CSP: default/connect/form/base/frame/worker/object none', csp);
check(csp['script-src'] === "'unsafe-inline'" && !L.SKRIPT_CSP.includes('unsafe-eval') && csp['img-src'] === 'data: blob:' && !/https?:/.test(L.SKRIPT_CSP),
  'CSP: nur inline-Skript, kein eval, keine externen Quellen', csp);

// Helfer
const kanal = '0f6a3c1e-1111-4222-8333-944455556666';
const helfer = H.skriptHelfer(kanal);
check(helfer.includes('var KANAL = "' + kanal + '"') && !helfer.includes(H.SKRIPT_HELFER_PLATZHALTER) && !/<\/script/i.test(helfer), 'Helfer: Kanal eingesetzt, kein </script>');
check(/e\.source !== window\.parent/.test(helfer) && /d\.kanal !== KANAL/.test(helfer) && /window\.removeEventListener\('message', hallo\)/.test(helfer) && /e\.ports\[0\]/.test(helfer),
  'Helfer: Port nur vom Elternfenster mit passendem Kanal, danach kein window-Listener mehr');
check(/Object\.freeze\(api\)/.test(helfer) && /quelle: function/.test(helfer) && /lese: function/.test(helfer) && /oeffne: function/.test(helfer)
  && /beiNeuemStand/.test(helfer) && /typ: 'puls'/.test(helfer) && /ResizeObserver/.test(helfer) && !/fetch\(|XMLHttpRequest|localStorage/.test(helfer), 'Helfer: API, Puls, Hoehe; kein fetch/XHR/localStorage');
let wirft = false; try { H.skriptHelfer('"><script>'); } catch { wirft = true; }
check(wirft, 'Helfer: ungueltige Kanal-ID wird abgelehnt');
new Function(helfer); // Syntax (wird nicht ausgefuehrt)
check(true, 'Helfer: syntaktisch gueltiges JavaScript');

// srcdoc
const art = '<h1>Hallo</h1><script>synapse.bereit(function(){})</script>';
const doc = L.baueSrcdoc(art, { helfer, thema: 'hell', farben: { bg: '#ebe8e2', text: 'rgb(30, 32, 35)', boese: 'red;}</style><script>x()</script>', accent: '#e7650b' } });
const iCsp = doc.indexOf('Content-Security-Policy'), iHelfer = doc.indexOf('var KANAL'), iArt = doc.indexOf('<h1>Hallo');
check(iCsp > 0 && iCsp < iHelfer && iHelfer < iArt && doc.indexOf('<meta charset="utf-8">') < iCsp, 'srcdoc: charset, dann CSP, dann Helfer, dann Artefakt', { iCsp, iHelfer, iArt });
check(doc.includes('content="' + L.SKRIPT_CSP + '"') && doc.includes('name="referrer" content="no-referrer"') && doc.includes('data-thema="hell"') && doc.includes('color-scheme:light'),
  'srcdoc: CSP-Meta, no-referrer, Thema hell');
check(doc.includes('--synapse-bg:#ebe8e2') && doc.includes('--synapse-text:rgb(30, 32, 35)') && !doc.includes('boese') && (doc.match(/<\/style>/g) ?? []).length === 1,
  'srcdoc: nur harmlose Farbvariablen (Einschleusen in <style> verhindert)');
check(L.baueSrcdoc('x', { helfer: '', thema: 'dunkel' }).includes('color-scheme:dark'), 'srcdoc: Thema dunkel');
wirft = false; try { L.baueSrcdoc('x', { helfer: 'a</script>b', thema: 'hell' }); } catch { wirft = true; }
check(wirft, 'srcdoc: Helfer mit </script> abgelehnt');

// Nachrichten
check(L.istHallo({ synapse: 1, typ: 'hallo', kanal }, kanal) && !L.istHallo({ synapse: 1, typ: 'hallo', kanal: 'x' }, kanal) && !L.istHallo(null, kanal) && !L.istHallo('hallo', kanal), 'istHallo nur mit Kanal');
check(gleich(L.pruefeRahmenNachricht({ synapse: 1, typ: 'puls' }), { typ: 'puls' }) && gleich(L.pruefeRahmenNachricht({ synapse: 1, typ: 'hoehe', px: 300 }), { typ: 'hoehe', px: 300 })
  && L.pruefeRahmenNachricht({ synapse: 1, typ: 'hoehe', px: 'x' }).typ === 'abgelehnt', 'Puls und Hoehe');
check(gleich(L.pruefeRahmenNachricht({ synapse: 1, typ: 'oeffne', verweis: ' P22-T5 ' }), { typ: 'oeffne', verweis: 'P22-T5' }) && L.pruefeRahmenNachricht({ synapse: 1, typ: 'oeffne', verweis: 'x'.repeat(301) }).typ === 'abgelehnt',
  'oeffne mit Laengengrenze');
const a = L.pruefeRahmenNachricht({ synapse: 1, typ: 'anfrage', id: 3, op: 'quelle', daten: { vertrag: 'plan.alle', args: { offen: true } } });
check(a.typ === 'anfrage' && a.id === 3 && a.op === 'quelle' && a.daten.vertrag === 'plan.alle', 'Anfrage quelle', a);
check(gleich(L.pruefeRahmenNachricht({ synapse: 1, typ: 'anfrage', id: 4, op: 'schreibe', daten: {} }), { typ: 'abgelehnt', grund: 'op_unbekannt', id: 4 }), 'Anfrage: unbekannte op abgelehnt (kein Schreiben)');
check(gleich(L.pruefeRahmenNachricht({ synapse: 1, typ: 'anfrage', id: 5, op: 'lese', daten: { ref: 'x'.repeat(5000) } }), { typ: 'abgelehnt', grund: 'groesse', id: 5 }), 'Anfrage: zu gross abgelehnt');
check(L.pruefeRahmenNachricht({ synapse: 1, typ: 'anfrage', id: 0, op: 'lese' }).grund === 'id' && L.pruefeRahmenNachricht({ typ: 'puls' }).grund === 'format'
  && L.pruefeRahmenNachricht({ synapse: 1, typ: 'eval' }).grund === 'typ', 'ungueltige id, fehlendes synapse, unbekannter typ');

// Bruecken-Koerper: project vom Rahmen
check(gleich(L.brueckeKoerper('quelle', { vertrag: 'plan.alle', args: { offen: true }, project: 'fremd' }, 'synapse'), { op: 'quelle', vertrag: 'plan.alle', args: { offen: true }, project: 'synapse' })
  && gleich(L.brueckeKoerper('lese', { art: 'task', ref: 'P22-T5', project: 'fremd' }, 'synapse'), { op: 'lese', art: 'task', ref: 'P22-T5', project: 'synapse' })
  && gleich(L.brueckeKoerper('quelle', { vertrag: 'x', args: [1] }, 'p').args, {}), 'Bruecken-Koerper: project setzt der Rahmen, Skript-project ignoriert');

// Grenzen
const e = L.erzeugeEimer(3, 1000);
check(e.nehmen(0) && e.nehmen(10) && e.nehmen(20) && !e.nehmen(30) && e.nehmen(1001), 'Eimer: 3 je Sekunde, danach wieder frei');
check(L.hoeheBegrenzen(10, 0) === 80 && L.hoeheBegrenzen(99999, 0) === 2400 && L.hoeheBegrenzen(301, 300) === null && L.hoeheBegrenzen(310, 300) === 310, 'Hoehe gedeckelt, 2-px-Schwelle');
check(L.SKRIPT_GRENZEN.rate_anzahl === 30 && L.SKRIPT_GRENZEN.parallel === 4 && L.SKRIPT_GRENZEN.zeit_ms === 10000 && L.SKRIPT_GRENZEN.puls_frist_ms === 5000, 'Grenzen wie im Entwurf');

// Watchdog
check(L.watchdog({ letzterPuls: 0, jetzt: 4000, sichtbar: true }) === 'ok' && L.watchdog({ letzterPuls: 0, jetzt: 5001, sichtbar: true }) === 'stopp'
  && L.watchdog({ letzterPuls: 0, jetzt: 60000, sichtbar: false }) === 'reset', 'Watchdog: 5 s ohne Puls -> Stopp, unsichtbarer Tab -> reset');
check(L.watchdog({ letzterPuls: 9000, jetzt: 10000, sichtbar: true, letzterTakt: 5000 }) === 'stopp' && L.watchdog({ letzterPuls: 9000, jetzt: 10000, sichtbar: true, letzterTakt: 9000 }) === 'ok'
  && L.watchdog({ letzterPuls: 0, jetzt: 10000, sichtbar: false, letzterTakt: 0 }) === 'reset', 'Watchdog: Takt-Verzug > 4 s (Hauptthread blockiert, iframe im selben Prozess) -> Stopp');
check(/visibilitychange/.test(readFileSync(join(hier, '..', 'src', 'kios', 'SkriptRahmen.tsx'), 'utf8')), 'Rahmen: Takt/Puls nach Rueckkehr in den sichtbaren Tab zurueckgesetzt');

// Weiche F1
check(L.skriptErlaubt({ schalter: true, quelleArt: 'artefakt', html: '<script>1</script>' }) && !L.skriptErlaubt({ schalter: false, quelleArt: 'artefakt', html: '<script>1</script>' })
  && !L.skriptErlaubt({ schalter: true, quelleArt: 'inbox', html: '<script>1</script>' }) && !L.skriptErlaubt({ schalter: true, quelleArt: 'verlauf', html: '<SCRIPT src=x>' })
  && !L.skriptErlaubt({ schalter: true, quelleArt: 'artefakt', html: '<p>kein</p><scripts>' }), 'Weiche: nur Schalter + Quelle artefakt + Skript im HTML');
check(L.enthaeltSkript('<Script>') && L.enthaeltSkript('<script\n type="module">') && !L.enthaeltSkript('&lt;script&gt;') && !L.enthaeltSkript(null), 'enthaeltSkript');

// Verdrahtung (Quelltext)
const src = (p) => readFileSync(join(hier, '..', 'src', p), 'utf8');
const rahmen = src('kios/SkriptRahmen.tsx');
check(/sandbox=\{SKRIPT_SANDBOX\}/.test(rahmen) && /allow=\{SKRIPT_ALLOW\}/.test(rahmen) && /srcDoc=\{start\.srcdoc\}/.test(rahmen)
  && !/allow-same-origin/.test(rahmen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
  'Rahmen: iframe mit sandbox/allow/srcDoc, nirgends allow-same-origin');
check(/ev\.source !== iframe\.contentWindow/.test(rahmen) && /new MessageChannel\(\)/.test(rahmen) && /removeEventListener\('message', beiNachricht\)/.test(rahmen)
  && /ladungen > 1\) stopp\('navigation'\)/.test(rahmen) && /useLayoutEffect/.test(rahmen), 'Rahmen: Herkunft, MessageChannel, Navigation -> Stopp, Listener vor dem Laden');
check(/'Skript starten'/.test(rahmen) && /SKRIPT_WARNUNG/.test(rahmen) && /neuer Stand · neu laden/.test(rahmen) && /typ: 'neuer_stand'/.test(rahmen)
  && /skriptHinweis=\{false\}/.test(rahmen), 'Rahmen: Start per Klick mit Warnung (F6), neuer Stand ohne Neuladen (F5), Vorschau bereinigt');
const top = src('components/TopArtefakte.tsx');
check(/skriptErlaubt\(\{ schalter: skripteAktiv, quelleArt: e\.quelle\.art, html: inhalt\.html \}\)/.test(top) && /!e\.artefakt_fehlt/.test(top) && /<SkriptRahmen /.test(top)
  && /skript=\{skript \? \{ titel: e\.titel \} : null\}/.test(top) && /top-chip skript/.test(top), 'Top-Artefakte: Weiche, Live-Vorlage im Rahmen, Chip');
check(/skript \? <SkriptRahmen/.test(src('components/ArtefaktLiveBlock.tsx')), 'ArtefaktLiveBlock: optionaler Skript-Rahmen');
const surface = src('kios/AgentRenderingSurface.tsx');
check(/sanitizeAgentHtml\(html\)/.test(surface) && /Skript entfernt · läuft nur in den Top-Artefakten/.test(surface) && /leseArtefaktSkripteAktiv/.test(surface),
  'Chatfenster: weiter bereinigt, Hinweis nur mit Schalter (F9)');
for (const p of ['components/KnowledgeView.tsx', 'components/EinheitlicherAgentChat.tsx', 'components/SynapseWorkspaceMock.tsx']) {
  if (/SkriptRahmen|skript=\{/.test(src(p))) check(false, 'kein Skript-Rahmen in ' + p);
}
check(true, 'Persoenliche Artefakte, Koordinator-Fenster, Main-Chat ohne Skript-Rahmen (F2)');
check(/BLOCKED_TAGS = new Set\(\['SCRIPT'/.test(src('kios/sanitize.ts')), 'sanitize entfernt SCRIPT weiterhin');

console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
