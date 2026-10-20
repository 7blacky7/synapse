import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import {
  ART_LABEL, bekannteTreffer, ladeVerweis, loeseVerweiseAuf,
  type VerweisArt, type VerweisInhalt, type VerweisKandidat, type VerweisTreffer,
} from '../api/verweise';
import { ToolBilder } from './ToolBild';
import '../verweise.css';

/**
 * P8-T31: gemeinsame Lesekomponente fuer Verweise.
 *  - VerweisFensterProvider: verschiebbare Lesefenster (mehrere moeglich), Klartext statt JSON
 *  - useVerweisFenster().oeffne(...): Fenster oeffnen (auch aus anderen Seiten, z. B. Memories-Reiter)
 *  - VerweisText: Text mit anklickbaren IDs (nur was der Server aufloest)
 *  - KlartextText: Absaetze, Listen, Ueberschriften, Code-Bloecke
 */

export interface VerweisZiel {
  project: string;
  art: VerweisArt;
  id: string;
}

interface FensterZustand extends VerweisZiel {
  key: string;
  x: number;
  y: number;
  z: number;
}

interface FensterKontext {
  oeffne: (ziel: VerweisZiel) => void;
}

const Kontext = createContext<FensterKontext | null>(null);

export function useVerweisFenster(): FensterKontext | null {
  return useContext(Kontext);
}

// ───────────────────────── Erkennung ─────────────────────────

interface Fund {
  start: number;
  ende: number;
  kandidat: VerweisKandidat;
}

const MUSTER: Array<{ re: RegExp; gruppe: number; hinweis?: VerweisKandidat['hinweis']; hexPruefung?: boolean }> = [
  // Bildpfade (z. B. ui-screenshots/...png): nur verlinkt, wenn der Server das Asset im Projekt kennt.
  { re: /(?:^|[\s(`"'\[])((?:[\w.-]+\/)+[\w.-]+\.(?:png|jpe?g|gif|webp|avif))(?=$|[\s)`"'\].,;:])/gi, gruppe: 1, hinweis: 'asset' },
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
  if (!fenster) return <>{wert}</>;
  const oeffne = (t: VerweisTreffer) => { setAuswahl(false); fenster.oeffne({ project, art: t.art, id: t.id }); };
  if (treffer.length === 1) {
    const t = treffer[0];
    return <button type="button" className="verweis-link" title={ART_LABEL[t.art] + ': ' + t.titel} onClick={() => oeffne(t)}>{wert}</button>;
  }
  return (
    <span className="verweis-mehrdeutig">
      <button type="button" className="verweis-link" title={treffer.length + ' Treffer, bitte waehlen'} onClick={() => setAuswahl((v) => !v)}>{wert} ▾</button>
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

type Block =
  | { typ: 'code'; text: string }
  | { typ: 'liste'; geordnet: boolean; zeilen: string[] }
  | { typ: 'titel'; text: string }
  | { typ: 'absatz'; text: string };

function zerlege(text: string): Block[] {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n');
  const bloecke: Block[] = [];
  let i = 0;
  while (i < zeilen.length) {
    const zeile = zeilen[i];
    if (zeile.trim().startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < zeilen.length && !zeilen[i].trim().startsWith('```')) code.push(zeilen[i++]);
      i += 1;
      bloecke.push({ typ: 'code', text: code.join('\n') });
      continue;
    }
    if (!zeile.trim()) { i += 1; continue; }
    const titel = /^#{1,4}\s+(.+)$/.exec(zeile);
    if (titel) { bloecke.push({ typ: 'titel', text: titel[1] }); i += 1; continue; }
    const liste = /^\s*(?:[-*]|\d+[.)])\s+/;
    if (liste.test(zeile)) {
      const geordnet = /^\s*\d/.test(zeile);
      const eintraege: string[] = [];
      while (i < zeilen.length && liste.test(zeilen[i])) eintraege.push(zeilen[i++].replace(liste, ''));
      bloecke.push({ typ: 'liste', geordnet, zeilen: eintraege });
      continue;
    }
    const absatz: string[] = [];
    while (i < zeilen.length && zeilen[i].trim() && !zeilen[i].trim().startsWith('```') && !liste.test(zeilen[i]) && !/^#{1,4}\s+/.test(zeilen[i])) absatz.push(zeilen[i++]);
    bloecke.push({ typ: 'absatz', text: absatz.join('\n') });
  }
  return bloecke;
}

export function KlartextText({ text, project }: { text: string; project?: string }) {
  const bloecke = useMemo(() => zerlege(text), [text]);
  const inline = (t: string) => (project ? <VerweisText project={project} text={t} /> : <>{t}</>);
  if (!bloecke.length) return <p className="klartext-leer">Kein Inhalt.</p>;
  return (
    <div className="klartext">
      {bloecke.map((b, index) => {
        if (b.typ === 'code') return <pre key={index}><code>{b.text}</code></pre>;
        if (b.typ === 'titel') return <h4 key={index}>{inline(b.text)}</h4>;
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

  return (
    <aside className="verweis-fenster" style={{ transform: 'translate(' + position.x + 'px,' + position.y + 'px)', zIndex: fenster.z }} onPointerDown={onAktiv}>
      <div className="verweis-titel" onPointerDown={start} onPointerMove={bewege} onPointerUp={ende} onPointerCancel={ende}>
        <div>
          <small>{ART_LABEL[fenster.art]}</small>
          <strong>{inhalt?.titel || fenster.id}</strong>
        </div>
        <button type="button" onClick={onSchliessen} aria-label="Fenster schließen">×</button>
      </div>
      <div className="verweis-inhalt">
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
            {inhalt.art === 'asset'
              ? <ToolBilder bilder={[{ mime_type: 'image/*', bytes: 0, project: fenster.project, file_path: inhalt.id }]} />
              : <KlartextText text={inhalt.text} project={fenster.project} />}
          </>
        )}
      </div>
    </aside>
  );
}

export function VerweisFensterProvider({ children }: { children: ReactNode }) {
  const [fenster, setFenster] = useState<FensterZustand[]>([]);
  const zaehler = useRef(1);

  const kontext = useMemo<FensterKontext>(() => ({
    oeffne: (ziel) => {
      setFenster((aktuell) => {
        const z = 1300 + zaehler.current++;
        const vorhanden = aktuell.find((f) => f.project === ziel.project && f.art === ziel.art && f.id === ziel.id);
        if (vorhanden) return aktuell.map((f) => (f === vorhanden ? { ...f, z } : f));
        const versatz = (aktuell.length % 6) * 28;
        const x = Math.max(8, Math.round(window.innerWidth / 2 - 280) + versatz);
        const y = 80 + versatz;
        return [...aktuell, { ...ziel, key: ziel.art + ':' + ziel.id + ':' + z, x, y, z }];
      });
    },
  }), []);

  return (
    <Kontext.Provider value={kontext}>
      {children}
      {fenster.map((f) => (
        <LesefensterEinzel
          key={f.key}
          fenster={f}
          onAktiv={() => setFenster((aktuell) => aktuell.map((x) => (x.key === f.key ? { ...x, z: 1300 + zaehler.current++ } : x)))}
          onSchliessen={() => setFenster((aktuell) => aktuell.filter((x) => x.key !== f.key))}
        />
      ))}
    </Kontext.Provider>
  );
}
