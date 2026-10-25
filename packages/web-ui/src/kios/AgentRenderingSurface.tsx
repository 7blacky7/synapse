import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { sanitizeAgentHtml } from './sanitize';
import { streamAgentHtml, type HtmlStreamHandle } from './fakeStream';
import { useVerweisFenster } from '../components/Lesefenster';
import { ART_LABEL, bekannteTreffer, loeseVerweiseAuf, type VerweisKandidat, type VerweisTreffer } from '../api/verweise';
import { leseArtefaktVerweiseAktiv } from '../api/artefakt-verweise';
import { leseArtefaktSkripteAktiv } from '../api/artefakt-skripte';
import { enthaeltSkript } from './skript-rahmen-logik';
import {
  merkeZustand, stelleZustandHer, verweisProjektVon, verweisWertVon, zerlegeVerweisWert, VERWEIS_SELEKTOR, type ArtefaktZustand,
  leseArtefaktZustand, speichereArtefaktZustand, type ZustandSpeicher,
} from './verweis-klick-logik';
import './kios-integration.css';

interface AgentRenderingSurfaceProps {
  html: string;
  revision: string | number;
  className?: string;
  style?: CSSProperties;
  interactive?: boolean;
  onAction?: (action: string, value?: string) => void;
  /** P22-T165: Projekt fuer Verweise ohne data-synapse-projekt (Render-Projekt bzw. Projekt des Anzeigeorts). */
  verweisProjekt?: string | null;
  /** P22-T165: neue Revision (Vorlagen-Update) ohne Aufbau-Animation sofort tauschen; die Animation nur beim ersten Anzeigen. */
  updateOhneAnimation?: boolean;
  /** P22-T166 (F9): Hinweis 'Skript entfernt' zeigen, wenn das HTML ein Skript hatte (Standard ja; die Vorschau im Skript-Rahmen nein). */
  skriptHinweis?: boolean;
  /** P22-T168: Kontextmenue 'Zitat anfügen' an Verweisen; nur Chat-Nachrichten setzen das (User: Artefakttafel/Top-Artefakte bleiben unveraendert). */
  zitatMenue?: boolean;
  /** P22-T169: Auswahl (Radio/Checkbox/details) je Artefakt und Betrachter ueber das Neuladen merken, z. B. 'artefakt:<id>' (localStorage). */
  zustandSchluessel?: string | null;
}

const SHADOW_BASE = `
  :host { all: initial; display: block; width: 100%; min-height: 100%; }
  * { box-sizing: border-box; }
  /* ACHTUNG: KEIN min-height hier. Die Hoehe des Kastens richtet sich nach
     diesem Inhalt - haette der Inhalt zugleich die Hoehe des Kastens als
     Untergrenze, wuerde der ResizeObserver seine eigene Wirkung messen und
     sich aufschaukeln. Die Mindesthoehe eines kurzen Artefakts regelt :host. */
  .synapse-html-root {
    color: inherit;
    display: flow-root;
    width: 100%;
  }
  /* P22-T165: Verweise sind anklickbar (Schalter artefakt_verweise). */
  [data-synapse-verweis], a[href^="#verweis:"] { cursor: pointer; }
`;

interface VerweisAuswahl { x: number; y: number; project: string; treffer: VerweisTreffer[] }

/** P22-T137: wie die Lesefenster an der Wurzel zeichnen (position:fixed unter transform waere abgeschnitten). */
function auswahlZiel(): Element {
  return document.querySelector('.synapse-control') ?? document.body;
}

/** P22-T169: localStorage des Betrachters; gesperrt (privates Fenster, Richtlinie) -> null. */
function lokalerSpeicher(): ZustandSpeicher | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

function verweisDebug(ergebnis: string, info: Record<string, unknown>): void {
  console.debug('[artefakt-verweis]', { ergebnis, ...info });
}

export default function AgentRenderingSurface({
  html,
  revision,
  className = '',
  style,
  interactive = false,
  onAction,
  verweisProjekt,
  updateOhneAnimation = false,
  skriptHinweis = true,
  zitatMenue = false,
  zustandSchluessel = null,
}: AgentRenderingSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<HtmlStreamHandle | null>(null);
  const actionRef = useRef(onAction);
  const previousRevisionRef = useRef<string | number | null>(null);
  const beobachterRef = useRef<ResizeObserver | null>(null);
  /** Die GEMESSENE Hoehe des Inhalts in Pixeln. 0 = noch nicht gemessen. */
  const [inhaltsHoehe, setInhaltsHoehe] = useState(0);
  const [streaming, setStreaming] = useState(true);
  const [updated, setUpdated] = useState(false);
  actionRef.current = onAction;

  // P22-T165: Schalter artefakt_verweise (gecacht, geteilt). null = noch unbekannt -> wie AUS (Bestand).
  const fenster = useVerweisFenster();
  const aktivRef = useRef<boolean | null>(null);
  const verweisProjektRef = useRef(verweisProjekt);
  verweisProjektRef.current = verweisProjekt;
  const zitatMenueRef = useRef(zitatMenue);
  zitatMenueRef.current = zitatMenue;
  const ohneAnimationRef = useRef(updateOhneAnimation);
  ohneAnimationRef.current = updateOhneAnimation;
  const [auswahl, setAuswahl] = useState<VerweisAuswahl | null>(null);
  const auswahlRef = useRef<HTMLDivElement | null>(null);
  const verweisRef = useRef<(el: Element, event: MouseEvent) => void>(() => undefined);
  const zitatRef = useRef<(el: Element, event: MouseEvent) => void>(() => undefined);
  // P22-T169: gemerkte Auswahl ueber das Neuladen (wie die Zustandsrettung ueber Revisionen nur mit Schalter artefakt_verweise).
  const zustandSchluesselRef = useRef(zustandSchluessel);
  zustandSchluesselRef.current = zustandSchluessel;
  const wiederhergestelltRef = useRef<string | null>(null);
  const ersteAnzeigeFertigRef = useRef(false);
  const stelleGemerktenZustandHerRef = useRef<(wann: string) => void>(() => undefined);
  stelleGemerktenZustandHerRef.current = (wann) => {
    const s = zustandSchluesselRef.current;
    const content = contentRef.current;
    if (!s || !content || aktivRef.current !== true || wiederhergestelltRef.current === s) return;
    wiederhergestelltRef.current = s;
    const z = leseArtefaktZustand(lokalerSpeicher(), s);
    if (!z) return;
    const n = stelleZustandHer(content, z);
    console.debug('[artefakt-verweis] zustand neu geladen', { schluessel: s, wiederhergestellt: n, wann });
  };

  // P22-T166 (F9): Das Skript wird hier weiter entfernt (sanitize.ts); mit Schalter artefakt_skripte (gecacht) ein kleiner Hinweis.
  const hatSkript = skriptHinweis && enthaeltSkript(html);
  const [skripteAktiv, setSkripteAktiv] = useState(false);
  useEffect(() => {
    if (!hatSkript) return undefined;
    let aktiv = true;
    void leseArtefaktSkripteAktiv().then((wert) => { if (aktiv) setSkripteAktiv(wert); });
    return () => { aktiv = false; };
  }, [hatSkript]);

  useEffect(() => {
    let aktiv = true;
    void leseArtefaktVerweiseAktiv().then((wert) => {
      if (!aktiv) return;
      aktivRef.current = wert;
      // P22-T169: kam der Schalter erst nach dem ersten Aufbau, jetzt die gemerkte Auswahl einsetzen.
      if (wert && ersteAnzeigeFertigRef.current) stelleGemerktenZustandHerRef.current('schalter_geladen');
    });
    return () => { aktiv = false; };
  }, []);

  verweisRef.current = (el, event) => {
    const wert = verweisWertVon(el);
    if (!wert || aktivRef.current !== true) return;
    event.preventDefault();
    const ziel = zerlegeVerweisWert(wert);
    const project = verweisProjektVon(el, verweisProjektRef.current);
    const info = { wert, ziel, project };
    if (!ziel) return verweisDebug('ungueltig', info);
    if (!fenster) return verweisDebug('kein_lesefenster', info);
    if (!project) return verweisDebug('projekt_fehlt', info);
    if (ziel.art) {
      fenster.oeffne({ project, art: ziel.art, id: ziel.id });
      return verweisDebug('geoeffnet', info);
    }
    const kandidat = { text: ziel.text };
    const x = event.clientX, y = event.clientY;
    void loeseVerweiseAuf(project, [kandidat]).then(() => {
      const treffer = bekannteTreffer(project, kandidat) ?? [];
      if (treffer.length === 1) { fenster.oeffne({ project, art: treffer[0].art, id: treffer[0].id }); verweisDebug('geoeffnet', { ...info, treffer }); }
      else if (treffer.length > 1) { setAuswahl({ x, y, project, treffer }); verweisDebug('auswahl', { ...info, treffer }); }
      else verweisDebug('nicht_gefunden', info);
    }).catch((error) => verweisDebug('fehler', { ...info, fehler: error instanceof Error ? error.message : String(error) }));
  };

  // P22-T168: Rechtsklick auf einen Verweis in einer Chat-Nachricht (Prop zitatMenue) -> 'Zitat anfügen' im Chatfenster dieses Providers (Schalter chat_zitate,
  // unabhaengig von artefakt_verweise). Shift = Browser-Menue (F4). Titel aus der (gecachten) Aufloesung.
  zitatRef.current = (el, event) => {
    const zitat = fenster?.zitat;
    const wert = verweisWertVon(el);
    if (!zitat || !wert || event.shiftKey) return;
    const ziel = zerlegeVerweisWert(wert);
    const project = verweisProjektVon(el, verweisProjektRef.current);
    if (!ziel || !project) return;
    event.preventDefault();
    event.stopPropagation();
    const pos = { x: event.clientX, y: event.clientY };
    const kandidat: VerweisKandidat = ziel.art
      ? { text: ziel.id, ...(ziel.art === 'event' || ziel.art === 'nachricht' || ziel.art === 'chat' || ziel.art === 'memory' || ziel.art === 'asset' ? { hinweis: ziel.art } : {}) }
      : { text: ziel.text };
    void loeseVerweiseAuf(project, [kandidat]).catch(() => false).then(() => {
      const treffer = (bekannteTreffer(project, kandidat) ?? []).filter((t) => !ziel.art || t.art === ziel.art);
      const vorlagen = treffer.length ? treffer.map((t) => ({ art: t.art, id: t.id, projekt: project, titel: t.titel }))
        : ziel.art ? [{ art: ziel.art, id: ziel.id, projekt: project, titel: '' }] : [];
      verweisDebug(vorlagen.length ? 'zitat_menue' : 'zitat_nicht_gefunden', { wert, ziel, project, treffer: vorlagen.length });
      const erster = vorlagen[0];
      if (erster) zitat.menue(pos, vorlagen, vorlagen.length === 1 ? { oeffnen: () => fenster?.oeffne({ project, art: erster.art, id: erster.id }) } : undefined);
    });
  };

  useEffect(() => {
    if (!auswahl) return undefined;
    const weg = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !auswahlRef.current?.contains(event.target as Node)) setAuswahl(null);
    };
    document.addEventListener('pointerdown', weg, true);
    document.addEventListener('keydown', weg);
    return () => { document.removeEventListener('pointerdown', weg, true); document.removeEventListener('keydown', weg); };
  }, [auswahl]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || contentRef.current) return;

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const baseStyle = document.createElement('style');
    baseStyle.textContent = SHADOW_BASE;
    shadowRoot.appendChild(baseStyle);

    const content = document.createElement('div');
    content.className = 'synapse-html-root';
    shadowRoot.appendChild(content);
    contentRef.current = content;

    // ACHTUNG: DIE HOEHE WIRD GEMESSEN, NICHT GERATEN (Befund 26.08.2026).
    // Vorher bestimmte --block-min-height (Vorgabe 220 px) die Hoehe, und
    // overflow:hidden schnitt alles darueber ab - ohne jeden Hinweis. Ein
    // Schaubild des Nutzers endete mitten im Text. Der Agent KANN die Hoehe
    // nicht kennen: er schickt HTML, wie hoch das im Browser wird, entscheidet
    // der Browser. Also fragen wir den Browser.
    // Die 2-Pixel-Schwelle ist kein Schoenheitsmass, sondern der Schutz gegen
    // eine Endlosschleife aus Messen und Wachsen.
    if (typeof ResizeObserver !== 'undefined') {
      const beobachter = new ResizeObserver(() => {
        const gemessen = Math.ceil(content.scrollHeight);
        setInhaltsHoehe((bisher) => (Math.abs(gemessen - bisher) > 2 ? gemessen : bisher));
      });
      beobachter.observe(content);
      beobachterRef.current = beobachter;
    }

    content.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      // P22-T165: Verweis (data-synapse-verweis / href="#verweis:") -> Lesefenster; nur mit Schalter artefakt_verweise.
      const verweisElement = target?.closest?.(VERWEIS_SELEKTOR);
      if (verweisElement) verweisRef.current(verweisElement, event);
      const actionElement = target?.closest?.('[data-synapse-action],[data-kios-action]');
      if (!actionElement) return;
      const input = content.querySelector('[data-synapse-input],[data-kios-input]') as HTMLInputElement | null;
      const action = actionElement.getAttribute('data-synapse-action')
        ?? actionElement.getAttribute('data-kios-action')
        ?? '';
      actionRef.current?.(action, input?.value?.trim() || undefined);
    });
    // P22-T168: Kontextmenue auf Verweisen (Zitat anfügen) nur in Chat-Nachrichten; sonst bleibt das Browser-Menue.
    content.addEventListener('contextmenu', (event) => {
      if (!zitatMenueRef.current) return;
      const verweisElement = (event.target as Element | null)?.closest?.(VERWEIS_SELEKTOR);
      if (verweisElement) zitatRef.current(verweisElement, event);
    });
    // P22-T169: nur Aenderungen des Betrachters merken (change feuert nicht beim Setzen per Code; details ueber den Klick auf summary).
    const merkeDauerhaft = (wann: string) => {
      const s = zustandSchluesselRef.current;
      if (!s || aktivRef.current !== true) return;
      const ok = speichereArtefaktZustand(lokalerSpeicher(), s, merkeZustand(content));
      console.debug('[artefakt-verweis] zustand gemerkt', { schluessel: s, ok, wann });
    };
    content.addEventListener('change', (event) => {
      const t = event.target as HTMLInputElement | null;
      if (t?.type === 'radio' || t?.type === 'checkbox') merkeDauerhaft('auswahl');
    });
    content.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest?.('summary')) window.setTimeout(() => merkeDauerhaft('details'), 0);
    });

    return () => {
      beobachterRef.current?.disconnect();
      beobachterRef.current = null;
    };
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const isUpdate = previousRevisionRef.current !== null && previousRevisionRef.current !== revision;
    previousRevisionRef.current = revision;
    streamRef.current?.cancel();
    // P22-T165 (Schalter artefakt_verweise): Auswahl/offene details ueber die neue Revision retten; Vorlagen-Updates sofort tauschen.
    const interaktion = isUpdate && aktivRef.current === true;
    const zustand: ArtefaktZustand | null = interaktion ? merkeZustand(content) : null;
    const sofort = interaktion && ohneAnimationRef.current;
    setUpdated(isUpdate);
    setStreaming(!sofort);
    streamRef.current = streamAgentHtml(content, sanitizeAgentHtml(html), {
      speedFactor: isUpdate ? 0.45 : 1,
      sofort,
      onDone: () => {
        ersteAnzeigeFertigRef.current = true;
        // P22-T169: zuerst die gemerkte Auswahl (einmal je Artefakt), danach der juengere Zustand aus der vorigen Revision.
        stelleGemerktenZustandHerRef.current(isUpdate ? 'revision' : 'erstes_anzeigen');
        if (zustand) {
          const wiederhergestellt = stelleZustandHer(content, zustand);
          console.debug('[artefakt-verweis] zustand', { revision, wiederhergestellt, sofort });
        }
        setStreaming(false);
      },
    });

    return () => streamRef.current?.cancel();
  }, [html, revision]);

  // Gemessen: Hoehe = das Groessere aus Agenten-Vorgabe und tatsaechlichem Inhalt.
  //   Die Vorgabe des Agenten bleibt damit UNTERGRENZE, nie Deckel.
  // Nicht gemessen (kein ResizeObserver, Messung noch nicht gelaufen): overflow
  //   auto statt hidden. Scrollen ist unschoen, aber es ist SICHTBAR, dass da
  //   mehr ist. Stilles Abschneiden waere die schlechtere Haelfte.
  const flaechenStil: CSSProperties = inhaltsHoehe > 0
    ? { ...style, height: 'max(var(--block-min-height, 0px), ' + inhaltsHoehe + 'px)', overflow: 'hidden' }
    : { ...style, overflow: 'auto' };

  return (
    <div
      className={'agent-rendering-surface ' + className + (streaming ? ' is-streaming' : '')}
      style={flaechenStil}
      aria-busy={streaming}
    >
      <div ref={hostRef} className="agent-rendering-shadow" />
      <div className="agent-rendering-state" aria-hidden="true">
        {streaming && <span className="is-live">HTML wird aufgebaut <i>▍</i></span>}
        {!streaming && updated && <span>aktualisiert</span>}
        {!streaming && interactive && <span>interaktiv</span>}
        {hatSkript && skripteAktiv && <span className="skript-entfernt" data-skript-entfernt="">Skript entfernt · läuft nur in den Top-Artefakten</span>}
      </div>
      {auswahl && createPortal(
        <div ref={auswahlRef} className="verweis-auswahl artefakt-verweis-auswahl" role="menu" data-artefakt-verweis-auswahl=""
          style={{ position: 'fixed', left: Math.max(8, Math.min(auswahl.x, window.innerWidth - 300)), top: Math.min(auswahl.y + 10, window.innerHeight - 160), zIndex: 1290 }}>
          {auswahl.treffer.map((t) => (
            <button type="button" key={t.art + t.id} role="menuitem"
              onClick={() => { setAuswahl(null); fenster?.oeffne({ project: auswahl.project, art: t.art, id: t.id }); }}>
              <b>{ART_LABEL[t.art]}</b> {t.id.slice(0, 13)} <small>{t.titel}</small>
            </button>
          ))}
        </div>, auswahlZiel())}
    </div>
  );
}
