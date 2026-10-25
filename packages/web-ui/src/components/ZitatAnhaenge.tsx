import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { leseChatZitateStand } from '../api/chat-zitate';
import { bekannteTreffer } from '../api/verweise';
import { findeKandidaten, useVerweisFenster, type ZitatAnbieter } from './Lesefenster';
import {
  ZITAT_GRENZEN_STANDARD, anzeigeAusEntwurf, entferneZitat, ersetzeZitatAnmerkung, fuegeZitatHinzu, kuerzeZitatText, leseZitatEntwurf,
  merkeZitatEntwurf, zitatKarte, zitatKopf, zuSendeZitaten, herkunftAusChat, pinVorlage,
  type AnzeigeZitat, type PinEingabe, type SendeZitat, type ZitatAblage, type ZitatAnhang, type ZitatGrenzen, type ZitatVorlage,
} from './zitat-logik';
import '../chat-zitate.css';

/**
 * P22-T168 (Entwurf b75a72bb Fassung 2, GO c32285ce F1-F8): Zitat-Anhaenge eines Chatfensters (Main bzw. EinheitlicherAgentChat).
 * - useZitatAnhaenge({chat, empfaenger, project}): Entwurf NUR fuer den Empfaenger dieses Fensters (Klarstellung 1210, kein
 *   Rundversand). anbieter geht an den VerweisFensterProvider des Fensters: Rechtsklick/langes Druecken auf Verweise (VerweisLink,
 *   AgentRenderingSurface) und der Knopf im Lesefenster landen nur hier. beiKontextmenue am Nachrichten-Wrapper: markierter Text
 *   einer Nachricht -> Zitat 'Ausschnitt' (F4: eigenes Menue mit Kopieren, Shift+Rechtsklick = Browser-Menue; F5: im Shadow-DOM nur
 *   wo der Browser die Markierung meldet, Firefox dort nur Verweise).
 * - oberflaeche: Kontextmenue + Editor (Anmerkung, Speichern/Abbrechen) als Portal; karten: Kaertchen ueber dem Eingabefeld
 *   (Klick = bearbeiten, x = loeschen). Entwurf je Chat in localStorage (F7).
 * - ZitatKarten: Zitate einer Nachricht (aus dem Block bzw. den Verlauf-Anhaengen), Klick oeffnet das Lesefenster.
 * - P22-T170: herkunft (aus dem Schluessel: 'main', 'agent:<id>', 'channel:<projekt>:<name>') fuer das Lesefenster; pinAnfuegen legt
 *   eine gerade angepinnte User-Entscheidung als Kaertchen (Zitat art 'thought') in DIESEN Entwurf - sie geht beim Senden im selben
 *   Block mit. Channel: der Post geht an den ganzen Channel.
 * SCHALTER chat_zitate (api/chat-zitate.ts; AUS = kein Menue, keine Kaertchen, nichts wird mitgeschickt). DEBUG: debug-Attribute
 * data-zitat-schalter / data-zitate-entwurf / data-zitat-herkunft fuer die Wurzel des Fensters; console.debug('[chat-zitat]', ...).
 */

type Pos = { x: number; y: number };
interface Menue { pos: Pos; vorlagen: ZitatVorlage[]; oeffnen?: () => void; kopieren?: string; anpinnen?: () => void }
interface Editor { pos: Pos; vorlage: ZitatVorlage; schluessel: string | null; anmerkung: string; hinweis: string }

function zitatDebug(ergebnis: string, info: Record<string, unknown>): void {
  console.debug('[chat-zitat]', { ergebnis, ...info });
}

function ablage(): ZitatAblage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** Wie die Lesefenster an der Wurzel zeichnen (position:fixed unter transform waere abgeschnitten). */
function portalZiel(): Element {
  return document.querySelector('.synapse-control') ?? document.body;
}

const imFenster = (pos: Pos, breite: number, hoehe: number): Pos => ({
  x: Math.max(8, Math.min(pos.x, window.innerWidth - breite - 8)),
  y: Math.max(8, Math.min(pos.y, window.innerHeight - hoehe - 8)),
});

/** Markierter Text im Wrapper einer Nachricht (auch im offenen Shadow-DOM, wo der Browser ihn meldet). null = keine Markierung. */
function markierterText(event: ReactMouseEvent<HTMLElement>): string | null {
  const pfad = typeof event.nativeEvent.composedPath === 'function' ? event.nativeEvent.composedPath() : [];
  for (const knoten of pfad) {
    const wurzel = knoten as ShadowRoot & { getSelection?: () => Selection | null };
    if (typeof ShadowRoot !== 'undefined' && knoten instanceof ShadowRoot && typeof wurzel.getSelection === 'function') {
      const t = wurzel.getSelection()?.toString() ?? '';
      if (t.trim()) return t;
    }
  }
  const auswahl = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (!auswahl || auswahl.isCollapsed || !auswahl.rangeCount) return null;
  // Nur innerhalb DIESER einen Nachricht.
  if (!event.currentTarget.contains(auswahl.getRangeAt(0).commonAncestorContainer)) return null;
  const t = auswahl.toString();
  return t.trim() ? t : null;
}

export interface ZitatAnhaengeStand {
  aktiv: boolean;
  anbieter: ZitatAnbieter | null;
  entwuerfe: ZitatAnhang[];
  /** Body-Feld 'zitate' der Senderoute (leer bei Schalter AUS). */
  sendeZitate: SendeZitat[];
  anzeige: AnzeigeZitat[];
  leeren: () => void;
  beiKontextmenue: (event: ReactMouseEvent<HTMLElement>, nachricht: string, project: string) => void;
  oberflaeche: ReactNode;
  karten: ReactNode;
  debug: Record<string, string | number>;
}

export function useZitatAnhaenge({ chat, empfaenger, project }: { chat: string; empfaenger: string; project: string | null }): ZitatAnhaengeStand {
  const [aktiv, setAktiv] = useState(false);
  const [geprueft, setGeprueft] = useState(false);
  const [grenzen, setGrenzen] = useState<ZitatGrenzen>(ZITAT_GRENZEN_STANDARD);
  const [entwuerfe, setEntwuerfe] = useState<ZitatAnhang[]>(() => leseZitatEntwurf(ablage(), chat));
  const [menue, setMenue] = useState<Menue | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const chatRef = useRef(chat);
  const menueRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const herkunft = herkunftAusChat(chat);
  // P22-T170: pinAnfuegen kann direkt nach dem Speichern eines Pins laufen (vor dem naechsten Rendern).
  const entwuerfeRef = useRef(entwuerfe);
  entwuerfeRef.current = entwuerfe;

  useEffect(() => {
    let gueltig = true;
    setGeprueft(false);
    void leseChatZitateStand(project).then((s) => {
      if (!gueltig) return;
      setAktiv(s.aktiv);
      setGeprueft(true);
      if (s.grenzen) setGrenzen(s.grenzen);
    });
    return () => { gueltig = false; };
  }, [project]);

  // Anderer Empfaenger (Fenster wiederverwendet): dessen Entwurf laden, nie den des vorigen mitnehmen.
  useEffect(() => {
    if (chatRef.current === chat) return;
    chatRef.current = chat;
    setEntwuerfe(leseZitatEntwurf(ablage(), chat));
    setMenue(null);
    setEditor(null);
  }, [chat]);

  const setze = useCallback((liste: ZitatAnhang[]) => {
    merkeZitatEntwurf(ablage(), chatRef.current, liste);
    setEntwuerfe(liste);
  }, []);

  const anfuegen = useCallback((vorlage: ZitatVorlage, pos?: Pos) => {
    setMenue(null);
    setEditor({ pos: pos ?? { x: window.innerWidth / 2 - 180, y: 120 }, vorlage, schluessel: null, anmerkung: '', hinweis: '' });
    zitatDebug('editor', { chat: chatRef.current, art: vorlage.art, id: vorlage.id });
  }, []);

  const pinAnfuegen = useCallback((pin: PinEingabe) => {
    const r = fuegeZitatHinzu(entwuerfeRef.current, pinVorlage(pin, grenzen.ausschnitt_max), '', grenzen.max_anzahl);
    if (r.voll) { zitatDebug('pin_voll', { chat: chatRef.current, herkunft, thought: pin.thoughtId }); return false; }
    entwuerfeRef.current = r.liste;
    setze(r.liste);
    zitatDebug('pin_angefuegt', { chat: chatRef.current, herkunft, thought: pin.thoughtId, anzahl: r.liste.length });
    return true;
  }, [grenzen.ausschnitt_max, grenzen.max_anzahl, herkunft, setze]);

  const anbieter = useMemo<ZitatAnbieter | null>(() => (aktiv ? {
    empfaenger,
    menue: (pos, vorlagen, extra) => {
      if (!vorlagen.length) return;
      setEditor(null);
      setMenue({ pos, vorlagen, ...(extra?.oeffnen ? { oeffnen: extra.oeffnen } : {}), ...(extra?.kopieren ? { kopieren: extra.kopieren } : {}),
        ...(extra?.anpinnen ? { anpinnen: extra.anpinnen } : {}) });
      zitatDebug('menue', { chat: chatRef.current, vorlagen: vorlagen.map((v) => zitatKopf(v)) });
    },
    anfuegen,
    herkunft,
    pinAnfuegen,
  } : null), [aktiv, empfaenger, anfuegen, herkunft, pinAnfuegen]);

  useEffect(() => {
    if (!menue) return undefined;
    const weg = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menueRef.current?.contains(event.target as Node)) setMenue(null);
    };
    document.addEventListener('pointerdown', weg, true);
    document.addEventListener('keydown', weg);
    return () => { document.removeEventListener('pointerdown', weg, true); document.removeEventListener('keydown', weg); };
  }, [menue]);

  useEffect(() => { if (editor) editorRef.current?.focus(); }, [editor?.vorlage, editor?.schluessel]);

  const beiKontextmenue = useCallback((event: ReactMouseEvent<HTMLElement>, nachricht: string, verweisProjekt: string) => {
    if (!anbieter || event.shiftKey || event.defaultPrevented) return;
    const roh = markierterText(event);
    if (!roh) return;
    event.preventDefault();
    const { text: ausschnitt, gekuerzt } = kuerzeZitatText(roh, grenzen.ausschnitt_max);
    // Genau ein aufgeloester Verweis in der Markierung -> Bezug auf ihn, sonst reiner Ausschnitt.
    const funde = verweisProjekt ? findeKandidaten(ausschnitt).flatMap((f) => {
      const t = bekannteTreffer(verweisProjekt, f.kandidat);
      return t && t.length === 1 ? [t[0]] : [];
    }) : [];
    const bezug = funde.length === 1 && funde[0].art !== 'asset' ? funde[0] : null;
    const vorlage: ZitatVorlage = bezug
      ? { art: bezug.art, id: bezug.id, projekt: verweisProjekt, titel: bezug.titel, ausschnitt, quelle: nachricht }
      : { art: 'ausschnitt', id: null, projekt: verweisProjekt || project || 'synapse', titel: '', ausschnitt, quelle: nachricht };
    setEditor(null);
    setMenue({ pos: { x: event.clientX, y: event.clientY }, vorlagen: [vorlage], kopieren: roh });
    zitatDebug('menue_markierung', { chat: chatRef.current, nachricht, zeichen: ausschnitt.length, gekuerzt, bezug: bezug ? bezug.id : null });
  }, [anbieter, grenzen.ausschnitt_max, project]);

  const speichern = () => {
    if (!editor) return;
    const anmerkung = editor.anmerkung;
    if (anmerkung.trim().length > grenzen.anmerkung_max) { setEditor({ ...editor, hinweis: 'Höchstens ' + grenzen.anmerkung_max + ' Zeichen.' }); return; }
    if (editor.schluessel) {
      setze(ersetzeZitatAnmerkung(entwuerfe, editor.schluessel, anmerkung));
      zitatDebug('bearbeitet', { chat: chatRef.current, schluessel: editor.schluessel });
    } else {
      const r = fuegeZitatHinzu(entwuerfe, editor.vorlage, anmerkung, grenzen.max_anzahl);
      if (r.voll) { setEditor({ ...editor, hinweis: 'Höchstens ' + grenzen.max_anzahl + ' Zitate je Nachricht.' }); return; }
      setze(r.liste);
      zitatDebug('angefuegt', { chat: chatRef.current, art: editor.vorlage.art, id: editor.vorlage.id, anzahl: r.liste.length });
    }
    setEditor(null);
  };
  const beiTaste = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setEditor(null); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); speichern(); }
  };

  const leeren = useCallback(() => { setze([]); }, [setze]);

  const oberflaeche = aktiv && (menue || editor) ? createPortal(<>
    {menue && (() => {
      const p = imFenster(menue.pos, 260, 40 + 36 * (menue.vorlagen.length + 2));
      return <div ref={menueRef} className="zitat-menue" role="menu" data-zitat-menue="" style={{ left: p.x, top: p.y }}>
        {menue.vorlagen.map((v, i) => (
          <button type="button" role="menuitem" key={i} onClick={() => anfuegen(v, menue.pos)}>
            Zitat anfügen{menue.vorlagen.length > 1 ? <small>{zitatKopf(v)}{v.titel ? ' · ' + v.titel : ''}</small> : null}
          </button>
        ))}
        {/* P22-T168 Punkt 8: Task/Plan - Lesefenster mit Editor 'User-Entscheidung anpinnen' (thought als User, ohne Chat-Nachricht). */}
        {menue.anpinnen && <button type="button" role="menuitem" onClick={() => { const a = menue.anpinnen!; setMenue(null); a(); }}>User-Entscheidung anpinnen</button>}
        {menue.oeffnen && <button type="button" role="menuitem" onClick={() => { const o = menue.oeffnen!; setMenue(null); o(); }}>Öffnen</button>}
        {menue.kopieren && <button type="button" role="menuitem" onClick={() => {
          const t = menue.kopieren!;
          setMenue(null);
          void navigator.clipboard?.writeText(t).catch(() => undefined);
        }}>Kopieren</button>}
      </div>;
    })()}
    {editor && (() => {
      const p = imFenster(editor.pos, 380, 300);
      return <div className="zitat-editor" role="dialog" aria-label={'Zitat für ' + empfaenger} data-zitat-editor="" style={{ left: p.x, top: p.y }}>
        <header>
          <small>Zitat an {empfaenger}</small>
          <strong>{zitatKopf(editor.vorlage)}</strong>
          {editor.vorlage.titel && <span>{editor.vorlage.titel}</span>}
        </header>
        {editor.vorlage.ausschnitt && <blockquote>{editor.vorlage.ausschnitt}</blockquote>}
        <textarea ref={editorRef} rows={4} value={editor.anmerkung} placeholder="Deine Anmerkung zu diesem Zitat …"
          onChange={(event) => setEditor({ ...editor, anmerkung: event.target.value, hinweis: '' })} onKeyDown={beiTaste} />
        <footer>
          <span className={editor.hinweis ? 'zitat-hinweis' : ''}>{editor.hinweis || editor.anmerkung.trim().length + ' / ' + grenzen.anmerkung_max + ' · Strg+Enter speichert'}</span>
          <button type="button" onClick={() => setEditor(null)}>Abbrechen</button>
          <button type="button" className="zitat-speichern" onClick={speichern}>Speichern</button>
        </footer>
      </div>;
    })()}
  </>, portalZiel()) : null;

  const karten = aktiv && entwuerfe.length ? <div className="zitat-entwuerfe" data-zitate-entwurf={entwuerfe.length}>
    {entwuerfe.map((z) => {
      const k = zitatKarte(z);
      return <article key={z.schluessel} className={'zitat-karte' + (z.pin ? ' ist-pin' : '')} data-zitat={z.schluessel} {...(z.pin ? { 'data-zitat-pin': z.id ?? '' } : {})}>
        <button type="button" className="zitat-karte-inhalt" title="Anmerkung bearbeiten"
          onClick={(event) => { setMenue(null); setEditor({ pos: { x: event.clientX, y: Math.max(8, event.clientY - 300) }, vorlage: z, schluessel: z.schluessel, anmerkung: z.anmerkung, hinweis: '' }); }}>
          {z.pin
            ? <><b>Angepinnte User-Entscheidung</b><span>{'an ' + z.pin + (k.titel ? ' · ' + k.titel : '')}</span>{k.anmerkung && <small>{k.anmerkung}</small>}</>
            : <><b>{k.kopf}</b>{k.titel && <span>{k.titel}</span>}{k.anmerkung && <small>{k.anmerkung}</small>}</>}
        </button>
        <button type="button" className="zitat-karte-weg" aria-label="Zitat entfernen" title="Zitat entfernen"
          onClick={() => { setze(entferneZitat(entwuerfe, z.schluessel)); zitatDebug('entfernt', { chat: chatRef.current, schluessel: z.schluessel }); }}>×</button>
      </article>;
    })}
  </div> : null;

  return {
    aktiv,
    anbieter,
    entwuerfe,
    sendeZitate: aktiv ? zuSendeZitaten(entwuerfe) : [],
    anzeige: aktiv ? anzeigeAusEntwurf(entwuerfe) : [],
    leeren,
    beiKontextmenue,
    oberflaeche,
    karten,
    debug: { 'data-zitat-schalter': geprueft ? (aktiv ? 'ein' : 'aus') : '?', 'data-zitate-entwurf': aktiv ? entwuerfe.length : 0, 'data-zitat-herkunft': herkunft },
  };
}

/** Zitate einer Nachricht (gesendet oder empfangen); Klick auf ein Zitat mit ID oeffnet das Lesefenster. */
export function ZitatKarten({ zitate, project }: { zitate: AnzeigeZitat[]; project: string }) {
  const fenster = useVerweisFenster();
  if (!zitate.length) return null;
  return <div className="zitat-karten-nachricht" data-zitate={zitate.length}>
    {zitate.map((z, i) => {
      const art = z.art === 'ausschnitt' ? null : z.art;
      const oeffnen = fenster && z.id && art ? () => fenster.oeffne({ project: z.projekt || project, art, id: z.id! }) : null;
      return <article key={i} className="zitat-karte-nachricht">
        <header>
          {oeffnen ? <button type="button" className="verweis-link" onClick={oeffnen}>{zitatKopf(z)}</button> : <b>{zitatKopf(z)}</b>}
          {z.titel && <span>{z.titel}</span>}
          {z.quelle && <small>aus {z.quelle}</small>}
        </header>
        {z.ausschnitt && <blockquote>{z.ausschnitt}</blockquote>}
        {z.anmerkung && <p>{z.anmerkung}</p>}
      </article>;
    })}
  </div>;
}
