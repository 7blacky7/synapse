import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import AgentRenderingSurface from './AgentRenderingSurface';
import { skriptHelfer } from './skript-helfer';
import {
  baueSrcdoc, brueckeKoerper, erzeugeEimer, hoeheBegrenzen, istHallo, pruefeRahmenNachricht, watchdog,
  SKRIPT_ALLOW, SKRIPT_GRENZEN, SKRIPT_SANDBOX, SKRIPT_WARNUNG, STOPP_TEXT, type SkriptOp, type SkriptThema, type StoppGrund,
} from './skript-rahmen-logik';
import { zerlegeVerweisWert } from './verweis-klick-logik';
import { rufeSkriptBruecke, SkriptBrueckeFehler } from '../api/artefakt-skripte';
import { bekannteTreffer, loeseVerweiseAuf } from '../api/verweise';
import { useVerweisFenster } from '../components/Lesefenster';
import './skript-rahmen.css';

/**
 * P22-T166 (Entwurf 407305f5, GO F1-F9): Artefakt mit Skript - NUR in den Top-Artefakten (ausgeklappter Eintrag).
 *  - Bis zum Klick auf 'Skript starten' (F6, Plan B: Firefox isoliert sandboxed iframes nicht sicher in einem eigenen Prozess) zeigt der
 *    Rahmen die bereinigte Vorschau (AgentRenderingSurface, ohne Skript) und eine kurze Warnung. Je Ausklappen neu: Einklappen entfernt
 *    den Rahmen samt iframe.
 *  - iframe: sandbox="allow-scripts" ohne allow-same-origin, allow (Permissions-Policy) alles 'none', srcdoc mit CSP-Meta zuerst
 *    (skript-rahmen-logik.ts). Kennzeichnung 'Artefakt mit Skript' in der Leiste AUSSERHALB des iframe (nicht faelschbar).
 *  - Bruecke: Helfer schickt 'hallo' (Kanal-ID); nur von iframe.contentWindow angenommen, dann MessageChannel, danach nur der Port.
 *    Anfragen: Rate, parallel, Groesse, Zeitlimit; project setzt der Rahmen; REST /api/main-agent/artefakte/:id/bruecke prueft Schalter,
 *    Katalog, Rechte und Urheber-Klammer. oeffne -> Lesefenster (T165-Logik), gedrosselt.
 *  - Watchdog: 5 s ohne Puls bei sichtbarem Tab -> Stopp mit Hinweis, kein Auto-Neustart. Zweites load (Wegnavigation) -> Stopp.
 *  - Neuer Stand (Live-Vorlage): kein Neuladen; das Skript bekommt 'neuer_stand' (synapse.beiNeuemStand), die Leiste zeigt
 *    'neuer Stand · neu laden'.
 * DEBUG: data-skript-zustand (wartet|laeuft|gestoppt|watchdog|navigation), data-bruecke (verbunden|aus), data-bruecke-ok,
 *   data-bruecke-abgelehnt, data-watchdog; console.debug('[artefakt-skript]', ...).
 */
export interface SkriptRahmenProps {
  artefaktId: string;
  html: string;
  revision: string | number;
  /** Render-Projekt; setzt der Rahmen in jede Anfrage (nie das Skript). */
  projekt: string | null;
  titel?: string | null;
  className?: string;
}

type Phase = { art: 'warte' } | { art: 'laeuft' } | { art: 'gestoppt'; grund: StoppGrund };
interface Start { lauf: number; html: string; revision: string; srcdoc: string; kanal: string; thema: SkriptThema }
interface Zaehler { ok: number; abgelehnt: number; watchdog: number }

const FARB_TOKENS: Record<string, string> = { bg: '--bg', panel: '--panel', text: '--text', muted: '--muted', accent: '--accent', border: '--border' };

function debug(ereignis: string, info: Record<string, unknown>): void {
  console.debug('[artefakt-skript]', { ereignis, ...info });
}

function kanalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export default function SkriptRahmen({ artefaktId, html, revision, projekt, titel, className = '' }: SkriptRahmenProps) {
  const wurzel = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const laufRef = useRef(0);
  const [phase, setPhase] = useState<Phase>({ art: 'warte' });
  const [start, setStart] = useState<Start | null>(null);
  const [hoehe, setHoehe] = useState(240);
  const [verbunden, setVerbunden] = useState(false);
  const [neuerStand, setNeuerStand] = useState(false);
  const [zaehler, setZaehler] = useState<Zaehler>({ ok: 0, abgelehnt: 0, watchdog: 0 });
  const fenster = useVerweisFenster();
  const fensterRef = useRef(fenster);
  fensterRef.current = fenster;
  const projektRef = useRef(projekt);
  projektRef.current = projekt;

  const starte = () => {
    const el = wurzel.current;
    const thema: SkriptThema = el?.closest('[data-theme="light"]') ? 'hell' : 'dunkel';
    const cs = el ? getComputedStyle(el) : null;
    const farben: Record<string, string> = {};
    for (const [name, token] of Object.entries(FARB_TOKENS)) {
      const wert = cs?.getPropertyValue(token).trim();
      if (wert) farben[name] = wert;
    }
    const kanal = kanalId();
    laufRef.current += 1;
    setStart({ lauf: laufRef.current, html, revision: String(revision), srcdoc: baueSrcdoc(html, { helfer: skriptHelfer(kanal), thema, farben }), kanal, thema });
    setNeuerStand(false);
    setVerbunden(false);
    setPhase({ art: 'laeuft' });
    debug('start', { artefaktId, projekt, thema, lauf: laufRef.current });
  };

  // Laufzeit des Rahmens. useLayoutEffect: Listener stehen, bevor das srcdoc-Dokument laedt und der Helfer 'hallo' schickt.
  useLayoutEffect(() => {
    if (phase.art !== 'laeuft' || !start) return undefined;
    const iframe = iframeRef.current;
    if (!iframe) return undefined;
    let beendet = false;
    let ladungen = 0;
    let letzterPuls = Date.now();
    let offen = 0;
    let letztesOeffnen = 0;
    let hoeheBisher = 0;
    const eimer = erzeugeEimer(SKRIPT_GRENZEN.rate_anzahl, SKRIPT_GRENZEN.rate_fenster_ms);
    const oeffneEimer = erzeugeEimer(SKRIPT_GRENZEN.oeffne_max, SKRIPT_GRENZEN.oeffne_fenster_ms);
    const hoeheEimer = erzeugeEimer(SKRIPT_GRENZEN.hoehe_je_s, 1000);
    const abbrueche = new Set<AbortController>();
    const zaehle = (art: keyof Zaehler) => setZaehler((z) => ({ ...z, [art]: z[art] + 1 }));
    const stopp = (grund: StoppGrund) => {
      if (beendet) return;
      beendet = true;
      if (grund === 'watchdog') zaehle('watchdog');
      debug('stopp', { artefaktId, grund });
      setPhase({ art: 'gestoppt', grund });
    };
    const antwort = (id: number, ok: boolean, nutz: unknown) => {
      portRef.current?.postMessage({ synapse: 1, typ: 'antwort', id, ok, ...(ok ? { daten: nutz } : { fehler: nutz }) });
    };
    const ablehnen = (grund: string, id?: number) => {
      zaehle('abgelehnt');
      debug('abgelehnt', { artefaktId, grund, id });
      if (id !== undefined) antwort(id, false, { code: grund, text: 'abgelehnt: ' + grund });
    };

    const oeffne = (verweis: string) => {
      const jetzt = Date.now();
      if (jetzt - letztesOeffnen < SKRIPT_GRENZEN.oeffne_abstand_ms || !oeffneEimer.nehmen(jetzt)) return ablehnen('oeffne_grenze');
      const f = fensterRef.current;
      const project = projektRef.current;
      const ziel = zerlegeVerweisWert(verweis);
      if (!f) return ablehnen('kein_lesefenster');
      if (!project) return ablehnen('projekt_fehlt');
      if (!ziel) return ablehnen('verweis');
      letztesOeffnen = jetzt;
      if (ziel.art) {
        f.oeffne({ project, art: ziel.art, id: ziel.id });
        zaehle('ok');
        debug('oeffne', { artefaktId, project, ziel });
        return undefined;
      }
      const kandidat = { text: ziel.text };
      void loeseVerweiseAuf(project, [kandidat]).then(() => {
        if (beendet) return;
        const treffer = bekannteTreffer(project, kandidat) ?? [];
        if (treffer.length === 1) { f.oeffne({ project, art: treffer[0].art, id: treffer[0].id }); zaehle('ok'); }
        else ablehnen(treffer.length ? 'mehrdeutig' : 'nicht_gefunden');
      }).catch(() => ablehnen('fehler'));
      return undefined;
    };

    const anfrage = async (n: { id: number; op: SkriptOp; daten: Record<string, unknown> }) => {
      if (!eimer.nehmen(Date.now())) return ablehnen('rate', n.id);
      if (offen >= SKRIPT_GRENZEN.parallel) return ablehnen('parallel', n.id);
      const project = projektRef.current;
      if (!project) return ablehnen('projekt_fehlt', n.id);
      offen++;
      const ac = new AbortController();
      abbrueche.add(ac);
      const frist = window.setTimeout(() => ac.abort(), SKRIPT_GRENZEN.zeit_ms);
      const t0 = Date.now();
      try {
        const r = await rufeSkriptBruecke(artefaktId, brueckeKoerper(n.op, n.daten, project), ac.signal);
        if (beendet) return undefined;
        zaehle('ok');
        debug('ok', { artefaktId, op: n.op, ms: Date.now() - t0, debug: r.debug });
        antwort(n.id, true, r.daten);
      } catch (error) {
        if (beendet) return undefined;
        const code = ac.signal.aborted ? 'zeit' : error instanceof SkriptBrueckeFehler ? error.code : 'fehler';
        zaehle('abgelehnt');
        debug('abgelehnt', { artefaktId, op: n.op, code, ms: Date.now() - t0 });
        antwort(n.id, false, { code, text: error instanceof Error ? error.message : String(error) });
      } finally {
        offen--;
        window.clearTimeout(frist);
        abbrueche.delete(ac);
      }
      return undefined;
    };

    const beiNachricht = (ev: MessageEvent) => {
      if (portRef.current || ev.source !== iframe.contentWindow || !istHallo(ev.data, start.kanal)) return;
      window.removeEventListener('message', beiNachricht);
      const kanal = new MessageChannel();
      portRef.current = kanal.port1;
      kanal.port1.onmessage = (e) => {
        if (beendet) return;
        const n = pruefeRahmenNachricht(e.data);
        if (n.typ === 'puls') { letzterPuls = Date.now(); return; }
        if (n.typ === 'hoehe') {
          if (!hoeheEimer.nehmen(Date.now())) return;
          const neu = hoeheBegrenzen(n.px, hoeheBisher);
          if (neu !== null) { hoeheBisher = neu; setHoehe(neu); }
          return;
        }
        if (n.typ === 'oeffne') { oeffne(n.verweis); return; }
        if (n.typ === 'anfrage') { void anfrage(n); return; }
        ablehnen(n.grund, n.id);
      };
      iframe.contentWindow?.postMessage({ synapse: 1, typ: 'port', kanal: start.kanal, projekt: projektRef.current, thema: start.thema }, '*', [kanal.port2]);
      letzterPuls = Date.now();
      setVerbunden(true);
      debug('verbunden', { artefaktId, projekt: projektRef.current });
    };
    const beiLoad = () => {
      ladungen++;
      if (ladungen > 1) stopp('navigation');
    };
    window.addEventListener('message', beiNachricht);
    iframe.addEventListener('load', beiLoad);
    let letzterTakt = Date.now();
    const takt = window.setInterval(() => {
      const jetzt = Date.now();
      const w = watchdog({ letzterPuls, jetzt, sichtbar: document.visibilityState === 'visible', letzterTakt });
      letzterTakt = jetzt;
      if (w === 'reset') letzterPuls = jetzt;
      else if (w === 'stopp') stopp('watchdog');
    }, 1000);
    const beiSichtbarkeit = () => { if (document.visibilityState === 'visible') { letzterTakt = Date.now(); letzterPuls = letzterTakt; } };
    document.addEventListener('visibilitychange', beiSichtbarkeit);
    return () => {
      beendet = true;
      window.removeEventListener('message', beiNachricht);
      iframe.removeEventListener('load', beiLoad);
      window.clearInterval(takt);
      document.removeEventListener('visibilitychange', beiSichtbarkeit);
      abbrueche.forEach((a) => a.abort());
      portRef.current?.close();
      portRef.current = null;
      setVerbunden(false);
    };
  }, [phase, start, artefaktId]);

  // Neuer Stand (Live-Vorlage bzw. neue Revision): kein Neuladen, Ereignis an das Skript + Hinweis in der Leiste.
  useEffect(() => {
    if (phase.art !== 'laeuft' || !start || String(revision) === start.revision) return;
    setNeuerStand(true);
    portRef.current?.postMessage({ synapse: 1, typ: 'neuer_stand', info: { revision: String(revision) } });
    debug('neuer_stand', { artefaktId, revision: String(revision) });
  }, [revision, phase, start, artefaktId]);

  const zustand = phase.art === 'laeuft' ? 'laeuft' : phase.art === 'gestoppt' ? (phase.grund === 'nutzer' ? 'gestoppt' : phase.grund) : 'wartet';
  return (
    <div ref={wurzel} className={'skript-rahmen ' + className} data-artefakt={artefaktId} data-skript-zustand={zustand}
      data-bruecke={verbunden ? 'verbunden' : 'aus'} data-bruecke-ok={zaehler.ok} data-bruecke-abgelehnt={zaehler.abgelehnt} data-watchdog={zaehler.watchdog}>
      <div className="skript-leiste" role="note" aria-label="Artefakt mit Skript">
        <strong>Artefakt mit Skript</strong>
        <span>läuft abgeschottet · nur lesend</span>
        {phase.art === 'laeuft' && neuerStand && <button type="button" className="skript-neuer-stand" onClick={starte}>neuer Stand · neu laden</button>}
        {phase.art === 'laeuft'
          ? <button type="button" className="skript-stopp-knopf" onClick={() => setPhase({ art: 'gestoppt', grund: 'nutzer' })}>Stopp</button>
          : <button type="button" className="skript-start" onClick={starte}>{phase.art === 'gestoppt' ? 'Neu starten' : 'Skript starten'}</button>}
      </div>
      {phase.art === 'warte' && <p className="skript-warnung">{SKRIPT_WARNUNG}</p>}
      {phase.art === 'gestoppt' && <p className="skript-gestoppt" role="status">{STOPP_TEXT[phase.grund]}</p>}
      {phase.art === 'laeuft' && start
        ? <iframe key={start.lauf} ref={iframeRef} className="skript-iframe" sandbox={SKRIPT_SANDBOX} allow={SKRIPT_ALLOW} referrerPolicy="no-referrer"
          srcDoc={start.srcdoc} title={'Artefakt mit Skript: ' + (titel || artefaktId)}
          style={{ height: hoehe, colorScheme: start.thema === 'hell' ? 'light' : 'dark' }} />
        : <AgentRenderingSurface html={html} revision={'skript-vorschau:' + artefaktId + ':' + revision} className="native-html-block" verweisProjekt={projekt}
          skriptHinweis={false} />}
    </div>
  );
}
