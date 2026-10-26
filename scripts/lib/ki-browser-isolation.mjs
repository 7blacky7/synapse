// ki-browser-isolation.mjs — P25-T19: KI-Browser-Tests voneinander isolieren (Storage und Zeitzone), ein Helfer fuer alle.
// Befunde: P25-T16 (thought 66e8db66) — der KI-Browser hat EIN Profil, localStorage/sessionStorage eines Origins ueberleben Tabs
// und Laeufe; t165 startete den hellen Durchgang mit der im dunklen gemerkten Plan-Auswahl (P22-T169). claude-linde (80a6df42) —
// die Uhrzeit erschien je Lauf in anderer Zeitzone. Ursache: POST /tabs/new vergibt ohne `identity` eine zufaellige
// Stealth-Identitaet (Standard "random", siehe /api-doc/openapi.json NewTabRequest), dazu gehoert die Zeitzone.
// Was isolierterTab(kb, body) tut:
//   1) /tabs/new mit fester Test-Identitaet (TEST_IDENTITAET: Zeitzone Europe/Berlin, Sprache de-DE, fester Seed), ausser der
//      Test gibt selbst `identity` mit.
//   2) Auf Test-Origins (TEST_HOSTS: lokale Vite-/API-Server der Tests) localStorage und sessionStorage leeren; war etwas
//      gespeichert, die Ziel-URL neu laden, damit die Seite ohne gemerkten Zustand startet. Fremde Origins (z. B. die Live-UI)
//      werden nie geleert.
//   3) Je Tab eine Debugzeile:
//      KI_BROWSER_ISOLATION tab=<id> origin=<o> geleert=<n> neu_geladen=0|1 zeitzone=<tz> sprache=<l>
//      Abweichende Zeitzone -> zusaetzlich KI_BROWSER_ISOLATION_WARNUNG ... grund=zeitzone_abweichend.
// opt.storage {schluessel: wert}: nach dem Leeren gezielt setzen, dann neu laden (Test braucht einen Anzeigezustand ausdruecklich,
// z. B. t149 synapse.agentennetzwerk.erklaerungen.v1='1'; frueher kam er zufaellig aus einem anderen Test). opt.leeren=false: nicht
// leeren (z. B. t169 prueft, dass eine Auswahl das Neuladen uebersteht).
// Schalter (Debug/Vergleich): KI_BROWSER_ISOLATION=0 -> /tabs/new unveraendert, nichts geleert (Zeile ... aus=1).
// KI_BROWSER_IDENTITAET='<json>' ersetzt TEST_IDENTITAET (z. B. falls der KI-Browser ein Feld anders erwartet).
// Nutzung im Test (kb = die eigene Funktion des Tests fuer POST an den KI-Browser, liefert d.data):
//   import {isolierterTab} from '../../../scripts/lib/ki-browser-isolation.mjs';
//   tab=(await isolierterTab(kb,{url:ui+'/tests/seite.html'})).tab_id;     // statt kb('/tabs/new',{url})

export const TEST_ZEITZONE = 'Europe/Berlin';
export const TEST_IDENTITAET = Object.freeze({ timezone: TEST_ZEITZONE, languages: ['de-DE', 'de'], seed: 'synapse-browser-tests' });
/** Hosts der Test-Server (Vite/Fastify der Tests). Nur dort wird Storage geleert. */
export const TEST_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '192.168.50.10']);
const WARTE_MS = 10_000;
const SCHRITT_MS = 150;

/** Leert localStorage/sessionStorage des aktuellen Dokuments; meldet Origin, Anzahl, Zeitzone und Sprache. */
export const STORAGE_LEEREN_SKRIPT = "(()=>{const n={local:0,session:0};"
  + "try{n.local=localStorage.length;localStorage.clear()}catch(e){n.local=-1}"
  + "try{n.session=sessionStorage.length;sessionStorage.clear()}catch(e){n.session=-1}"
  + "return JSON.stringify({origin:location.origin,local:n.local,session:n.session,"
  + "zeitzone:Intl.DateTimeFormat().resolvedOptions().timeZone,sprache:navigator.language})})()";

/** Setzt Vorgabewerte im localStorage des aktuellen Dokuments; liefert die Anzahl. */
export function storageSetzenSkript(werte) {
  return "(()=>{const v=" + JSON.stringify(werte) + ";for(const [k,w] of Object.entries(v))localStorage.setItem(k,String(w));return Object.keys(v).length})()";
}

export function isolationAktiv(env = process.env) {
  return env.KI_BROWSER_ISOLATION !== '0';
}

export function testIdentitaet(env = process.env) {
  if (!env.KI_BROWSER_IDENTITAET) return TEST_IDENTITAET;
  try { return JSON.parse(env.KI_BROWSER_IDENTITAET); } catch { return TEST_IDENTITAET; }
}

export function istTestOrigin(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && TEST_HOSTS.has(u.hostname);
  } catch { return false; }
}

/** Ergebnis von POST /evaluate (d.data) auf den Wert bringen: result.result, JSON-Text wird gelesen. */
export function evaluateWert(daten) {
  const v = daten?.result?.result !== undefined ? daten.result.result : daten?.result;
  if (typeof v !== 'string') return v ?? null;
  try { return JSON.parse(v); } catch { return v; }
}

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Neuer KI-Browser-Tab mit fester Test-Identitaet und leerem Storage des Test-Origins.
 * kb(path, body) -> d.data des KI-Browsers; body wie POST /tabs/new ({url, active, ...}).
 * opt: { env, log, leeren (Standard true), warteMs }. Rueckgabe: Antwort von /tabs/new plus isolation:{...}.
 */
export async function isolierterTab(kb, body = {}, opt = {}) {
  const env = opt.env ?? process.env;
  const log = opt.log ?? ((z) => console.log(z));
  if (!isolationAktiv(env)) {
    const tab = await kb('/tabs/new', body);
    log(`KI_BROWSER_ISOLATION tab=${tab?.tab_id ?? '-'} aus=1`);
    return tab;
  }
  const identitaet = body.identity ?? testIdentitaet(env);
  const tab = await kb('/tabs/new', { ...body, identity: identitaet });
  const url = body.url;
  const vorgabe = opt.storage && typeof opt.storage === 'object' && Object.keys(opt.storage).length ? opt.storage : null;
  const isolation = { geleert: 0, vorgabe: 0, neu_geladen: false, origin: null, zeitzone: null, sprache: null, grund: null };
  if (!url || opt.leeren === false) isolation.grund = url ? 'abgeschaltet' : 'ohne_url';
  else if (!istTestOrigin(url)) isolation.grund = 'fremder_origin';
  else {
    // Die Seite laedt evtl. noch (about:blank vorher): warten, bis das Dokument zum Ziel-Origin gehoert.
    const ziel = new URL(url).origin;
    const frist = Date.now() + (opt.warteMs ?? WARTE_MS);
    let s = null;
    for (;;) {
      s = evaluateWert(await kb('/evaluate', { tab_id: tab.tab_id, script: STORAGE_LEEREN_SKRIPT }).catch(() => null));
      if (s && s.origin === ziel) break;
      if (Date.now() >= frist) { isolation.grund = 'origin_nicht_erreicht'; break; }
      await schlaf(SCHRITT_MS);
    }
    if (s && s.origin === ziel) {
      Object.assign(isolation, { origin: s.origin, zeitzone: s.zeitzone ?? null, sprache: s.sprache ?? null,
        geleert: Math.max(0, s.local) + Math.max(0, s.session) });
      if (s.local < 0 || s.session < 0) isolation.grund = 'storage_gesperrt';
      if (vorgabe) { await kb('/evaluate', { tab_id: tab.tab_id, script: storageSetzenSkript(vorgabe) }); isolation.vorgabe = Object.keys(vorgabe).length; }
      if (isolation.geleert > 0 || isolation.vorgabe > 0) { await kb('/navigate', { tab_id: tab.tab_id, url }); isolation.neu_geladen = true; }
    }
  }
  log(`KI_BROWSER_ISOLATION tab=${tab?.tab_id ?? '-'} origin=${isolation.origin ?? '-'} geleert=${isolation.geleert}${isolation.vorgabe ? ` vorgabe=${isolation.vorgabe}` : ''} neu_geladen=${isolation.neu_geladen ? 1 : 0}`
    + ` zeitzone=${isolation.zeitzone ?? '-'} sprache=${isolation.sprache ?? '-'}${isolation.grund ? ` grund=${isolation.grund}` : ''}`);
  if (isolation.zeitzone && identitaet?.timezone && isolation.zeitzone !== identitaet.timezone)
    log(`KI_BROWSER_ISOLATION_WARNUNG tab=${tab.tab_id} grund=zeitzone_abweichend soll=${identitaet.timezone} ist=${isolation.zeitzone}`);
  return { ...tab, isolation };
}
