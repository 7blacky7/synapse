import { createContext, Fragment, useContext, useEffect, useState } from 'react';
import type { Token } from './syntax';
import '../../editor-syntax-p22-t266.css';

/*
 * P22-T266: Syntax-Hervorhebung der Nur-Lese-Ansichten im Editor (Plan-Schatten, „Committet · aus PG“, Drei-Wege, Verlauf, Pins).
 * SyntaxAn = Produkt-Schalter editor_syntax (ProjektEditor liest ihn, Standard AUS). AUS: alles bleibt Klartext wie bisher.
 * CodeMirror kommt nur per dynamischem import('./syntax'); bis die Sprache geladen ist bzw. bei unbekannter Sprache, Ladefehler oder
 * sehr grossen Texten bleibt der Klartext stehen (kein Flackern, kein Fehler).
 */
export const SyntaxAn = createContext(false);

export function useZeilenTokens(pfad: string, text: string | null): Token[][] | null {
  const an = useContext(SyntaxAn);
  const [tokens, setTokens] = useState<{ text: string; zeilen: Token[][] } | null>(null);
  useEffect(() => {
    let lebt = true;
    if (!an || text === null || !pfad) { setTokens(null); return; }
    void import('./syntax').then(async (m) => {
      const s = await m.ladeSprache(pfad);
      if (!lebt) return;
      const z = s ? m.zeilenTokens(text, s) : null;
      setTokens(z ? { text, zeilen: z } : null);
    }).catch(() => { if (lebt) setTokens(null); });
    return () => { lebt = false; };
  }, [an, pfad, text]);
  // Nur Token zum aktuellen Text zeigen (sonst kurz alter Stand bei Live-Abgleich).
  return tokens && tokens.text === text ? tokens.zeilen : null;
}

/** Inhalt EINER Zeile: Token-Spans oder der Rohtext (roh auch fuer leere Zeilen, z. B. ' '). */
export function ZeilenInhalt({ tokens, roh }: { tokens: Token[] | undefined; roh: string }) {
  if (!tokens || !tokens.length) return <>{roh}</>;
  return <>{tokens.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : <Fragment key={i}>{t.text}</Fragment>))}</>;
}

/** Ganzer Text fuer ein <pre> (Zeilen mit \n verbunden), z. B. Schatten und Pins. */
export function HervorgehobenerText({ pfad, text }: { pfad: string; text: string }) {
  const zeilen = useZeilenTokens(pfad, text);
  if (!zeilen) return <>{text}</>;
  return <>{zeilen.map((z, i) => <Fragment key={i}>{i > 0 ? '\n' : ''}<ZeilenInhalt tokens={z} roh="" /></Fragment>)}</>;
}
