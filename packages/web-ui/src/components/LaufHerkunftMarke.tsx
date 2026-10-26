import { useEffect, useState } from 'react';
import { abonniereLaufHerkunft, laufHerkunftBekannt } from '../api/lauf-herkunft';
import { findeLaufHerkunft, laufHerkunftTitel, type LaufHerkunftDaten } from './lauf-herkunft-logik';
import '../lauf-herkunft-marke.css';

/**
 * P22-T178 (User 26.10.2026 ~01:35): Lauf-Herkunft neben dem Agentennamen, z. B. 'claude-t50 · P22-T171 · api · haiku'. Steht an
 * jeder Stelle hinter der AgentTaskMarke (Channel-Leiste, Absender, Agententeam, Runtime-Panel, Koordinator-Dock, Chat-Koepfe,
 * Ausweis-Liste). Daten serverseitig an EINER Stelle (core agent-lauf-herkunft.ts aus dem Wrapper-Status).
 * Schalter agent_lauf_herkunft AUS, Lesefehler oder Herkunft unbekannt: keine Marke (Altverhalten).
 * DEBUG: data-lauf-herkunft (api|cli|codex), data-lauf-herkunft-quelle, Tooltip mit Quelle; console.debug('[lauf-herkunft]').
 */
export function useLaufHerkunft(project: string | null | undefined): LaufHerkunftDaten | null {
  const p = project ?? '';
  const [daten, setDaten] = useState<LaufHerkunftDaten | null>(() => (p ? laufHerkunftBekannt(p) : null));
  useEffect(() => {
    if (!p) { setDaten(null); return undefined; }
    setDaten(laufHerkunftBekannt(p));
    return abonniereLaufHerkunft(p, setDaten);
  }, [p]);
  return daten;
}

export function LaufHerkunftMarke({ project, identityId, name, trenner = ' · ' }: {
  project: string | null | undefined; identityId?: string | null; name?: string | null; trenner?: string;
}) {
  const daten = useLaufHerkunft(project);
  const e = findeLaufHerkunft(daten, { identityId, name });
  if (!e || !e.text) return null;
  return (
    <span className={'lauf-herkunft-marke art-' + e.art} data-lauf-herkunft={e.art} data-lauf-herkunft-quelle={e.quelle} title={laufHerkunftTitel(e)}>
      {trenner && <span className="lauf-herkunft-trenner" aria-hidden="true">{trenner}</span>}
      <span className="lauf-herkunft-text">{e.text}</span>
    </span>
  );
}
