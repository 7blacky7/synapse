import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ART_LABEL, bekannteTreffer, ladeVerweis, loeseVerweiseAuf,
  type VerweisArt, type VerweisInhalt, type VerweisKandidat, type VerweisTreffer,
} from '../api/verweise';
import { ToolBilder } from './ToolBild';
import { BildGrossansicht } from './BildGrossansicht';
import { BILD_MUSTER } from './bild-logik';
import { zerlegeInline, zerlegeKlartext, type InlineTeil } from './klartext-logik';
import type { ZitatVorlage } from './zitat-logik';
import { kannAnpinnen, useUserEntscheidung } from './UserEntscheidung';
import { useZitatEmpfaengerAuswahl } from './ZitatEmpfaenger';
import type { LesefensterHerkunft, PinEingabe, ZitatHerkunft } from './zitat-logik';
// P22-T150: Bildleiste unter Nachrichten, hier mit angeboten (gleicher Bezug wie KlartextText).
export { NachrichtBilder } from './ToolBild';
import '../verweise.css';

/**
 * P8-T31: gemeinsame Lesekomponente fuer Verweise.
 *  - VerweisFensterProvider: verschiebbare Lesefenster (mehrere moeglich), Klartext statt JSON
 *  - useVerweisFenster().oeffne(...): Fenster oeffnen (auch aus anderen Seiten, z. B. Memories-Reiter)
 *  - VerweisText: Text mit anklickbaren IDs (nur was der Server aufloest)
 *  - KlartextText: Absaetze, Listen, Ueberschriften, Code-Bloecke, Tabellen, fett/kursiv/Inline-Code (klartext-logik.ts)
 */

export interface VerweisZiel {
  project: string;
  art: VerweisArt;
  id: string;
  /** P22-T168 Punkt 8: aus dem Kontextmenue 'User-Entscheidung anpinnen' - Fenster oeffnen und den Editor zeigen. */
  anpinnen?: boolean;
  /** P22-T170: von einer Stelle ohne Chat-/Channel-Bezug geoeffnet (LesefensterOhneHerkunft) - Herkunft 'ohne'. */
  ohneHerkunft?: boolean;
}

interface FensterZustand extends Omit<VerweisZiel, 'anpinnen'> {
  key: string;
  x: number;
  y: number;
  z: number;
  /** Zaehler: jede Erhoehung oeffnet den Editor 'User-Entscheidung anpinnen'. */
  anpinnen?: number;
}

/**
 * P22-T168: Zitat-Anhaenge des Chatfensters, das diesen Provider traegt (nur an DESSEN Empfaenger, kein Rundversand). null = aus
 * (Schalter chat_zitate) bzw. kein Chatfenster. Rechtsklick (mobil langes Druecken) auf einen Verweis -> menue; Knopf im Lesefenster
 * -> anfuegen. Umsetzung: ZitatAnhaenge.tsx (useZitatAnhaenge).
 */
export interface ZitatAnbieter {
  empfaenger: string;
  menue(pos: { x: number; y: number }, vorlagen: ZitatVorlage[], extra?: { oeffnen?: () => void; kopieren?: string; anpinnen?: () => void }): void;
  anfuegen(vorlage: ZitatVorlage, pos?: { x: number; y: number }): void;
  /** P22-T170: Herkunft des Lesefensters (Agenten-Chat, Main-Chat, Channel-Fenster); fehlt = Agenten-Chat. */
  herkunft?: ZitatHerkunft;
  /** P22-T170: gerade angepinnte User-Entscheidung als Kaertchen in den Entwurf DIESES Chats/Channels; false = Entwurf voll. */
  pinAnfuegen?(pin: PinEingabe): boolean;
}

interface FensterKontext {
  oeffne: (ziel: VerweisZiel) => void;
  zitat?: ZitatAnbieter | null;
}

/** P22-T168: langes Druecken (Touch) als Kontextmenue, wo der Browser keins meldet (iOS); der folgende Klick entfaellt. */
const LANG_DRUECKEN_MS = 550;
function useLangesDruecken(beiDruck: (pos: { x: number; y: number }) => void) {
  const zeit = useRef<{ id: number; x: number; y: number } | null>(null);
  const ausgeloest = useRef(false);
  const abbrechen = () => { if (zeit.current) { window.clearTimeout(zeit.current.id); zeit.current = null; } };
  return {
    abbrechen,
    /** Langer Druck hat das Menue schon gezeigt (ein folgendes contextmenu zeigt es nicht noch einmal). */
    ausgeloest: () => ausgeloest.current,
    /** Nach einem langen Druck: true, und der Klick entfaellt. */
    verbraucht: () => { const v = ausgeloest.current; ausgeloest.current = false; return v; },
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      ausgeloest.current = false;
      abbrechen();
      if (event.pointerType !== 'touch') return;
      const x = event.clientX, y = event.clientY;
      zeit.current = { x, y, id: window.setTimeout(() => { zeit.current = null; ausgeloest.current = true; beiDruck({ x, y }); }, LANG_DRUECKEN_MS) };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const z = zeit.current;
      if (z && Math.hypot(event.clientX - z.x, event.clientY - z.y) > 10) abbrechen();
    },
    onPointerUp: abbrechen,
    onPointerCancel: abbrechen,
  };
}

const Kontext = createContext<FensterKontext | null>(null);

export function useVerweisFenster(): FensterKontext | null {
  return useContext(Kontext);
}

/**
 * P22-T170: Bereich OHNE Chat-/Channel-Herkunft innerhalb eines Chat-Providers (Dashboard/Top-Artefakte des Main, Projektflaeche im
 * Channel). Lesefenster von hier (und Verweise in ihnen) haben Herkunft 'ohne': Pin nur speichern, Zitat per Empfaengerauswahl.
 * Die Fenster selbst bleiben beim umgebenden Provider (eine Fensterliste, gleiche Stapelung).
 */
export function LesefensterOhneHerkunft({ children }: { children: ReactNode }) {
  const oben = useContext(Kontext);
  const wert = useMemo<FensterKontext | null>(() => (oben ? { oeffne: (ziel) => oben.oeffne({ ...ziel, ohneHerkunft: true }), zitat: null } : null), [oben]);
  return <Kontext.Provider value={wert}>{children}</Kontext.Provider>;
}

// ───────────────────────── Erkennung ─────────────────────────

interface Fund {
  start: number;
  ende: number;
  kandidat: VerweisKandidat;
}

const MUSTER: Array<{ re: RegExp; gruppe: number; hinweis?: VerweisKandidat['hinweis']; hexPruefung?: boolean }> = [
  // Bildpfade (relativ oder absolut) und asset_id: nur verlinkt, wenn der Server das Bild im Projekt kennt (P22-T150: bild-logik).
  ...BILD_MUSTER.map((m) => ({ ...m, hinweis: 'asset' as const })),
  { re: /\bEvent\s+#?(\d{1,9})\b/gi, gruppe: 1, hinweis: 'event' },
  { re: /\bChat(?:-Nachricht)?\s+#?(\d{1,9})\b/gi, gruppe: 1, hinweis: 'chat' },
  { re: /\b(?:Channel-)?(?:Nachricht|Message)\s+#?(\d{1,9})\b/gi, gruppe: 1, hinweis: 'nachricht' },
  { re: /(?:^|[\s(])#(\d{3,9})\b/g, gruppe: 1, hinweis: 'nachricht' },
  { re: /\bP\d+-T\d+\b/gi, gruppe: 0 },
  { re: /\bP\d+\b/g, gruppe: 0 },
  { re: /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, gruppe: 0 },
  { re: /\b[0-9a-f]{8,32}\b/gi, gruppe: 0, hexPruefung: true },
  { re: /\b[Mm]emory\s+`?([A-Za-z0-9][A-Za-z0-9._-]{2,120})`?/g, gruppe: 1, hinweis: 'memory' },
  { re: /`([A-Za-z0-9][A-Za-z0-9._-]{2,120})`/g, gruppe: 1, hinweis: 'memory' },
];

/** Findet Kandidaten ohne Ueberlappung (frueheres Muster hat Vorrang). Aufgeloest wird erst durch den Server. */
export function findeKandidaten(text: string): Fund[] {
  const funde: Fund[] = [];
  const belegt = (s: number, e: number) => funde.some((f) => s < f.ende && e > f.start);
  for (const muster of MUSTER) {
    muster.re.lastIndex = 0;
    let treffer: RegExpExecArray | null;
    while ((treffer = muster.re.exec(text)) !== null) {
      const wert = treffer[muster.gruppe];
      if (!wert) continue;
      const start = treffer.index + treffer[0].indexOf(wert);
      const ende = start + wert.length;
      if (belegt(start, ende)) continue;
      if (muster.hexPruefung && !(/\d/.test(wert) && /[a-f]/i.test(wert))) continue;
      funde.push({ start, ende, kandidat: { text: wert, ...(muster.hinweis ? { hinweis: muster.hinweis } : {}) } });
    }
  }
  return funde.sort((a, b) => a.start - b.start);
}

// ───────────────────────── Verlinkter Text ─────────────────────────

function VerweisLink({ project, wert, treffer }: { project: string; wert: string; treffer: VerweisTreffer[] }) {
  const fenster = useVerweisFenster();
  const [auswahl, setAuswahl] = useState(false);
  const [gross, setGross] = useState(false);
  // P22-T168: Rechtsklick (mobil langes Druecken) -> 'Zitat anfügen' im Chatfenster dieses Providers; Shift = Browser-Menue (F4).
  const zitat = fenster?.zitat ?? null;
  const zeigeZitatMenue = (pos: { x: number; y: number }) => {
    if (!zitat || !fenster) return;
    const vorlagen = treffer.map((t): ZitatVorlage => ({ art: t.art, id: t.id, projekt: project, titel: t.titel }));
    zitat.menue(pos, vorlagen, treffer.length === 1 && treffer[0].art !== 'asset' ? {
      oeffnen: () => fenster.oeffne({ project, art: treffer[0].art, id: treffer[0].id }),
      // P22-T168 Punkt 8: Tasks und Plaene - Lesefenster mit offenem Editor 'User-Entscheidung anpinnen' (kein Chat noetig).
      ...(kannAnpinnen(treffer[0].art) ? { anpinnen: () => fenster.oeffne({ project, art: treffer[0].art, id: treffer[0].id, anpinnen: true }) } : {}),
    } : undefined);
  };
  const druck = useLangesDruecken(zeigeZitatMenue);
  if (!fenster) return <>{wert}</>;
  const oeffne = (t: VerweisTreffer) => { setAuswahl(false); fenster.oeffne({ project, art: t.art, id: t.id }); };
  const zitatProps = zitat ? {
    'data-zitierbar': '',
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      druck.abbrechen();
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!druck.ausgeloest()) zeigeZitatMenue({ x: event.clientX, y: event.clientY });
    },
    onPointerDown: druck.onPointerDown, onPointerMove: druck.onPointerMove, onPointerUp: druck.onPointerUp, onPointerCancel: druck.onPointerCancel,
  } : {};
  if (treffer.length === 1 && treffer[0].art === 'asset') {
    // P22-T150: ein Bildpfad oeffnet direkt die Grossansicht; andere Verweise weiter das Lesefenster.
    const t = treffer[0];
    return (
      <>
        <button type="button" className="verweis-link" title={'Bild: ' + t.titel + ' (groß anzeigen)'} {...zitatProps} onClick={() => { if (!druck.verbraucht()) setGross(true); }}>{wert}</button>
        {gross && <BildGrossansicht bilder={[{ mime_type: 'image/*', bytes: 0, project, file_path: t.id }]} onSchliessen={() => setGross(false)} />}
      </>
    );
  }
  if (treffer.length === 1) {
    const t = treffer[0];
    return <button type="button" className="verweis-link" title={ART_LABEL[t.art] + ': ' + t.titel} {...zitatProps} onClick={() => { if (!druck.verbraucht()) oeffne(t); }}>{wert}</button>;
  }
  return (
    <span className="verweis-mehrdeutig">
      <button type="button" className="verweis-link" title={treffer.length + ' Treffer, bitte waehlen'} {...zitatProps} onClick={() => { if (!druck.verbraucht()) setAuswahl((v) => !v); }}>{wert} ▾</button>
      {auswahl && (
        <span className="verweis-auswahl" role="menu">
          {treffer.map((t) => (
            <button type="button" key={t.art + t.id} role="menuitem" onClick={() => oeffne(t)}>
              <b>{ART_LABEL[t.art]}</b> {t.id.slice(0, 13)} <small>{t.titel}</small>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function VerweisText({ project, text }: { project: string; text: string }) {
  const fenster = useVerweisFenster();
  const funde = useMemo(() => (fenster && project ? findeKandidaten(text) : []), [fenster, project, text]);
  const [, neuZeichnen] = useState(0);

  useEffect(() => {
    if (!funde.length) return;
    let aktiv = true;
    loeseVerweiseAuf(project, funde.map((f) => f.kandidat))
      .then((geaendert) => { if (aktiv && geaendert) neuZeichnen((n) => n + 1); })
      .catch(() => undefined);
    return () => { aktiv = false; };
  }, [project, funde]);

  if (!funde.length) return <>{text}</>;
  const teile: ReactNode[] = [];
  let pos = 0;
  funde.forEach((fund, index) => {
    teile.push(text.slice(pos, fund.start));
    const treffer = bekannteTreffer(project, fund.kandidat);
    const wert = text.slice(fund.start, fund.ende);
    teile.push(treffer && treffer.length
      ? <VerweisLink key={index} project={project} wert={wert} treffer={treffer} />
      : wert);
    pos = fund.ende;
  });
  teile.push(text.slice(pos));
  return <>{teile}</>;
}

// ───────────────────────── Klartext ─────────────────────────

export function KlartextText({ text, project }: { text: string; project?: string }) {
  const bloecke = useMemo(() => zerlegeKlartext(text), [text]);
  // P22-T137: Inline-Auszeichnung als React-Elemente (nie innerHTML); Textteile behalten ihre anklickbaren Verweise.
  const verweis = (t: string, key?: number): ReactNode => (project ? <VerweisText key={key} project={project} text={t} /> : t);
  const teil = (t: InlineTeil, key: number): ReactNode => {
    if (t.art === 'text') return verweis(t.text, key);
    if (t.art === 'code') return <code key={key}>{verweis(t.text)}</code>;
    const Tag = t.art === 'fett' ? 'strong' : 'em';
    return <Tag key={key}>{t.teile.map(teil)}</Tag>;
  };
  const inline = (t: string) => <>{zerlegeInline(t).map(teil)}</>;
  if (!bloecke.length) return <p className="klartext-leer">Kein Inhalt.</p>;
  return (
    <div className="klartext">
      {bloecke.map((b, index) => {
        if (b.typ === 'code') return <pre key={index}><code>{b.text}</code></pre>;
        if (b.typ === 'titel') return <h4 key={index}>{inline(b.text)}</h4>;
        if (b.typ === 'tabelle') {
          return (
            <div key={index} className="klartext-tabelle">
              <table>
                <thead><tr>{b.kopf.map((z, n) => <th key={n}>{inline(z)}</th>)}</tr></thead>
                <tbody>{b.zeilen.map((reihe, r) => <tr key={r}>{reihe.map((z, n) => <td key={n}>{inline(z)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
        }
        if (b.typ === 'liste') {
          const Liste = b.geordnet ? 'ol' : 'ul';
          return <Liste key={index}>{b.zeilen.map((z, n) => <li key={n}>{inline(z)}</li>)}</Liste>;
        }
        return <p key={index}>{inline(b.text)}</p>;
      })}
    </div>
  );
}

// ───────────────────────── Fenster ─────────────────────────

function zeitLokal(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE');
}

function LesefensterEinzel({
  fenster, onAktiv, onSchliessen,
}: { fenster: FensterZustand; onAktiv: () => void; onSchliessen: () => void }) {
  const [inhalt, setInhalt] = useState<VerweisInhalt | null>(null);
  const [fehler, setFehler] = useState('');
  const [position, setPosition] = useState({ x: fenster.x, y: fenster.y });
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  // P22-T168/T170: HERKUNFT des Lesefensters = Chat bzw. Channel seines Providers (zitat), ausser es wurde von einer Stelle ohne
  // Chat-Bezug geoeffnet (LesefensterOhneHerkunft). Mit Herkunft haengt 'Zitat anfügen' an genau diesen Chat/Channel an.
  const anbieter = useVerweisFenster()?.zitat ?? null;
  const zitat = fenster.ohneHerkunft ? null : anbieter;
  const herkunft: LesefensterHerkunft = zitat ? zitat.herkunft ?? 'agent' : 'ohne';
  // P22-T168 Punkte 8/9: 'User-Entscheidung anpinnen' (Task/Plan) speichert immer; darunter die angepinnten Entscheidungen.
  // P22-T170: mit Chat-/Channel-Herkunft kommt der Pin zusaetzlich als Kaertchen in DESSEN Entwurf (geht beim Senden mit).
  const entscheidung = useUserEntscheidung({
    project: fenster.project, art: fenster.art, id: fenster.id, anzeigeId: inhalt?.id, titel: inhalt?.titel, anpinnen: fenster.anpinnen,
    ...(zitat?.pinAnfuegen ? {
      nachAnpinnen: (pin: PinEingabe) => (zitat.pinAnfuegen!(pin)
        ? 'Als Kärtchen im Entwurf an ' + zitat.empfaenger + '.'
        : 'Entwurf an ' + zitat.empfaenger + ' ist voll – nur gespeichert.'),
    } : {}),
  });
  // P22-T170: ohne Herkunft 'Zitat anfügen' = Empfaengerauswahl (Agenten des Projekts, Checkboxen) -> Inbox je Empfaenger.
  const auswahl = useZitatEmpfaengerAuswahl({
    project: fenster.project, aktiv: !zitat,
    vorlage: inhalt && fenster.art !== 'asset' ? { art: fenster.art, id: inhalt.id || fenster.id, projekt: fenster.project, titel: inhalt.titel } : null,
  });
  useEffect(() => {
    console.debug('[lesefenster]', { art: fenster.art, id: fenster.id, herkunft, ziel: zitat?.empfaenger ?? null });
  }, [fenster.art, fenster.id, herkunft, zitat?.empfaenger]);

  useEffect(() => {
    let aktiv = true;
    setInhalt(null);
    setFehler('');
    ladeVerweis(fenster.project, fenster.art, fenster.id)
      .then((v) => { if (aktiv) setInhalt(v); })
      .catch((e) => { if (aktiv) setFehler(e instanceof Error ? e.message : String(e)); });
    return () => { aktiv = false; };
  }, [fenster.project, fenster.art, fenster.id]);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    onAktiv();
    drag.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: position.x, oy: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const bewege = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    setPosition({
      x: Math.min(Math.max(0, window.innerWidth - 120), Math.max(0, d.ox + event.clientX - d.sx)),
      y: Math.min(Math.max(0, window.innerHeight - 60), Math.max(0, d.oy + event.clientY - d.sy)),
    });
  };
  const ende = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) drag.current = null;
  };
  // P22-T170: Verweise in einem Fenster ohne Herkunft oeffnen ihrerseits ohne Herkunft (LesefensterOhneHerkunft um den Inhalt).
  const koerper = (
    <>
      {!inhalt && !fehler && <p className="klartext-leer">Lädt …</p>}
      {fehler && <p className="verweis-fehler">{fehler}</p>}
      {inhalt && (
        <>
          <dl className="verweis-meta">
            <div><dt>ID</dt><dd>{inhalt.id}</dd></div>
            {inhalt.meta.map((m) => (
              <div key={m.label}><dt>{m.label}</dt><dd>{/^\d{4}-\d{2}-\d{2}T/.test(m.wert) ? zeitLokal(m.wert) : m.wert}</dd></div>
            ))}
          </dl>
          {entscheidung.bereich}
          {auswahl.bereich}
          {inhalt.art === 'asset'
            ? <ToolBilder bilder={[{ mime_type: 'image/*', bytes: 0, project: fenster.project, file_path: inhalt.id }]} />
            : <KlartextText text={inhalt.text} project={fenster.project} />}
        </>
      )}
    </>
  );

  return (
    <aside className="verweis-fenster" style={{ transform: 'translate(' + position.x + 'px,' + position.y + 'px)', zIndex: fenster.z }} onPointerDown={onAktiv}
      data-lesefenster-herkunft={herkunft} data-lesefenster-ziel={zitat?.empfaenger ?? ''}>
      <div className="verweis-titel" onPointerDown={start} onPointerMove={bewege} onPointerUp={ende} onPointerCancel={ende}>
        <div>
          <small>{ART_LABEL[fenster.art]}</small>
          <strong>{inhalt?.titel || fenster.id}</strong>
        </div>
        {zitat && inhalt && <button type="button" className="verweis-zitat" title={'Als Zitat an die Nachricht an ' + zitat.empfaenger + ' anhängen'}
          onClick={(event) => zitat.anfuegen({ art: fenster.art, id: inhalt.id || fenster.id, projekt: fenster.project, titel: inhalt.titel }, { x: event.clientX - 200, y: event.clientY + 16 })}>Zitat anfügen</button>}
        {inhalt && auswahl.knopf}
        {inhalt && entscheidung.knopf}
        <button type="button" onClick={onSchliessen} aria-label="Fenster schließen">×</button>
      </div>
      <div className="verweis-inhalt">
        {fenster.ohneHerkunft ? <LesefensterOhneHerkunft>{koerper}</LesefensterOhneHerkunft> : koerper}
      </div>
    </aside>
  );
}

/**
 * P22-T137: Lesefenster an der Wurzel zeichnen. Sie sind position:fixed; unter einem Chatfenster mit transform (Koordinator-Fenster
 * in der Seitenleiste) waeren sie sonst relativ zu diesem Fenster positioniert und abgeschnitten - ein Klick auf einen Plan-/
 * Task-Verweis zeigte dann nichts.
 */
function fensterZiel(): Element {
  return document.querySelector('.synapse-control') ?? document.body;
}

export function VerweisFensterProvider({ children, zitat = null }: { children: ReactNode; zitat?: ZitatAnbieter | null }) {
  const [fenster, setFenster] = useState<FensterZustand[]>([]);
  const zaehler = useRef(1);

  const kontext = useMemo<FensterKontext>(() => ({
    oeffne: (ziel) => {
      setFenster((aktuell) => {
        const z = 1300 + zaehler.current++;
        const vorhanden = aktuell.find((f) => f.project === ziel.project && f.art === ziel.art && f.id === ziel.id);
        // P22-T168: anpinnen als Zaehler, damit ein zweites 'User-Entscheidung anpinnen' den Editor im offenen Fenster wieder zeigt.
        const anpinnen = (f?: FensterZustand) => (ziel.anpinnen ? { anpinnen: (f?.anpinnen ?? 0) + 1 } : {});
        // P22-T170: die Herkunft gilt fuer das letzte Oeffnen (Chat bzw. Stelle ohne Chat-Bezug).
        if (vorhanden) return aktuell.map((f) => (f === vorhanden ? { ...f, z, ohneHerkunft: !!ziel.ohneHerkunft, ...anpinnen(f) } : f));
        const versatz = (aktuell.length % 6) * 28;
        const x = Math.max(8, Math.round(window.innerWidth / 2 - 280) + versatz);
        const y = 80 + versatz;
        const { anpinnen: _a, ...basis } = ziel;
        return [...aktuell, { ...basis, key: ziel.art + ':' + ziel.id + ':' + z, x, y, z, ...anpinnen() }];
      });
    },
    // P22-T168: Zitat-Anhaenge des Chatfensters, das diesen Provider traegt.
    zitat,
  }), [zitat]);

  return (
    <Kontext.Provider value={kontext}>
      {children}
      {fenster.length > 0 && createPortal(fenster.map((f) => (
        <LesefensterEinzel
          key={f.key}
          fenster={f}
          onAktiv={() => setFenster((aktuell) => aktuell.map((x) => (x.key === f.key ? { ...x, z: 1300 + zaehler.current++ } : x)))}
          onSchliessen={() => setFenster((aktuell) => aktuell.filter((x) => x.key !== f.key))}
        />
      )), fensterZiel())}
    </Kontext.Provider>
  );
}
