import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EditorGriff } from './syntax';

/*
 * P22-T266: Bearbeiten mit Syntax-Hervorhebung (Schalter editor_syntax EIN). Ersetzt Zeilennummern-<pre> + <textarea> aus P22-T262.
 * Datenvertrag unveraendert: wert = Abbild bzw. Entwurf, onChange schreibt den Entwurf, lesend = Index/Freeze geloest/maskiert.
 * Strg+S laeuft weiter ueber den onKeyDown des Editors (CodeMirror bindet Mod-s nicht, das Ereignis steigt auf).
 * CodeMirror kommt per import('./syntax'); scheitert das Laden, zeigt das Feld den Rueckfall (das bisherige Textfeld).
 * Debug: data-syntax = laedt | <Sprache> | klartext | fehler.
 */
export function CodeFeld({ pfad, wert, lesend, label, onChange, rueckfall }: {
  pfad: string; wert: string; lesend: boolean; label: string; onChange: (wert: string) => void; rueckfall: ReactNode;
}) {
  const ort = useRef<HTMLDivElement>(null), griff = useRef<EditorGriff | null>(null);
  const aenderung = useRef(onChange); aenderung.current = onChange;
  const start = useRef({ wert, lesend }); start.current = { wert, lesend };
  const [stand, setStand] = useState('laedt');
  useEffect(() => {
    let lebt = true;
    setStand('laedt');
    void import('./syntax').then((m) => {
      if (!lebt || !ort.current) return;
      const g = m.erzeugeEditor(ort.current, { wert: start.current.wert, lesend: start.current.lesend, label, onChange: (v) => aenderung.current(v) });
      griff.current = g;
      void m.ladeSprache(pfad).then((s) => {
        if (!lebt) return;
        g.setzeSprache(s);
        setStand(s ? m.sprachName(pfad) ?? 'sprache' : 'klartext');
      });
    }).catch(() => { if (lebt) setStand('fehler'); });
    return () => { lebt = false; griff.current?.zerstoeren(); griff.current = null; };
    // label haengt am Pfad; ein neuer Pfad erzeugt den Editor neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pfad]);
  useEffect(() => { griff.current?.setzeWert(wert); }, [wert]);
  useEffect(() => { griff.current?.setzeLesend(lesend); }, [lesend]);
  if (stand === 'fehler') return <>{rueckfall}</>;
  return <div className="ed-codefeld" ref={ort} data-syntax={stand} aria-busy={stand === 'laedt'} />;
}
