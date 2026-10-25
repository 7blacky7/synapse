/**
 * P22-T166: Helfer, den der Skript-Rahmen (SkriptRahmen.tsx) als ERSTES Skript in das srcdoc des iframe schreibt, vor dem Artefakt.
 * Keine Importe (rein, ohne DOM testbar: liefert nur Text).
 *
 * HANDSHAKE: schickt {synapse:1, typ:'hallo', kanal} an den Rahmen; nur eine Antwort {typ:'port', kanal} vom Elternfenster mit
 *   uebertragenem MessagePort wird angenommen. Danach laeuft alles nur ueber diesen Port (nach einer Wegnavigation ist er tot).
 * API (window.synapse, eingefroren):
 *   quelle(vertrag, args?) -> Promise<daten>   Katalogvertrag (plan.alle, plan.list, plan.get, channel.feed, agentennetzwerk.snapshot)
 *   lese(art, id)          -> Promise<{titel,text,meta}>   task | plan | thought | memory
 *   oeffne(verweis)        Lesefenster der Web-UI ('P22-T5', 'P22', 'thought:<id>'), ohne Rueckgabe
 *   bereit(fn)             fn(synapse) sobald die Bruecke steht
 *   beiNeuemStand(fn)      neuer Stand (Live-Vorlage) - das Skript liest selbst neu, der Rahmen laedt nicht neu
 *   projekt, thema         Render-Projekt, 'hell' | 'dunkel'
 * PULS: jede Sekunde {typ:'puls'} (Watchdog im Rahmen). HOEHE: ResizeObserver auf #synapse-inhalt -> {typ:'hoehe', px}.
 */
export const SKRIPT_HELFER_PLATZHALTER = '__SYNAPSE_KANAL__';

const HELFER = `(function () {
  'use strict';
  var KANAL = __SYNAPSE_KANAL__;
  var port = null, nr = 0, warte = Object.create(null), puffer = [], beiStand = [], beiBereit = [], info = { projekt: null, thema: null };
  function sende(m) { m.synapse = 1; if (port) port.postMessage(m); else if (puffer.length < 50) puffer.push(m); }
  function rufe(fns, arg) { fns.forEach(function (f) { try { f(arg); } catch (e) { console.error(e); } }); }
  function anfrage(op, daten) {
    return new Promise(function (ok, nein) { var id = ++nr; warte[id] = { ok: ok, nein: nein }; sende({ typ: 'anfrage', id: id, op: op, daten: daten }); });
  }
  function empfang(e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.typ === 'antwort') {
      var w = warte[m.id]; if (!w) return; delete warte[m.id];
      if (m.ok) w.ok(m.daten);
      else { var f = new Error((m.fehler && m.fehler.text) || 'abgelehnt'); f.code = (m.fehler && m.fehler.code) || 'abgelehnt'; w.nein(f); }
    } else if (m.typ === 'neuer_stand') rufe(beiStand, m.info || {});
  }
  var api = {
    quelle: function (vertrag, args) { return anfrage('quelle', { vertrag: String(vertrag), args: args || {} }); },
    lese: function (art, id) { return anfrage('lese', { art: String(art), ref: String(id) }); },
    oeffne: function (verweis) { sende({ typ: 'oeffne', verweis: String(verweis) }); },
    bereit: function (fn) { if (port) rufe([fn], api); else beiBereit.push(fn); },
    beiNeuemStand: function (fn) { beiStand.push(fn); }
  };
  Object.defineProperty(api, 'projekt', { get: function () { return info.projekt; } });
  Object.defineProperty(api, 'thema', { get: function () { return info.thema; } });
  window.synapse = Object.freeze(api);
  window.addEventListener('message', function hallo(e) {
    var d = e.data;
    if (port || e.source !== window.parent || !d || d.synapse !== 1 || d.typ !== 'port' || d.kanal !== KANAL || !e.ports || !e.ports[0]) return;
    window.removeEventListener('message', hallo);
    port = e.ports[0];
    port.onmessage = empfang;
    info.projekt = typeof d.projekt === 'string' ? d.projekt : null;
    info.thema = d.thema === 'hell' ? 'hell' : 'dunkel';
    puffer.splice(0).forEach(function (m) { port.postMessage(m); });
    rufe(beiBereit.splice(0), api);
  });
  var hallos = 0;
  function halloSenden() { if (port || hallos++ >= 10) return clearInterval(halloTakt); window.parent.postMessage({ synapse: 1, typ: 'hallo', kanal: KANAL }, '*'); }
  var halloTakt = setInterval(halloSenden, 300);
  halloSenden();
  setInterval(function () { if (port) port.postMessage({ synapse: 1, typ: 'puls' }); }, 1000);
  var letzte = 0;
  function hoehe() {
    var el = document.getElementById('synapse-inhalt'); if (!el) return;
    var h = Math.ceil(el.getBoundingClientRect().height);
    if (Math.abs(h - letzte) > 2) { letzte = h; sende({ typ: 'hoehe', px: h }); }
  }
  document.addEventListener('DOMContentLoaded', function () {
    var el = document.getElementById('synapse-inhalt');
    if (el && typeof ResizeObserver !== 'undefined') new ResizeObserver(hoehe).observe(el);
    hoehe();
  });
  window.addEventListener('load', hoehe);
})();`;

/** Helfer-Text mit eingesetzter Kanal-ID (als JSON-String; die ID kommt aus crypto.randomUUID). */
export function skriptHelfer(kanal: string): string {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(kanal)) throw new Error('Kanal-ID ungueltig');
  return HELFER.replace(SKRIPT_HELFER_PLATZHALTER, JSON.stringify(kanal));
}
