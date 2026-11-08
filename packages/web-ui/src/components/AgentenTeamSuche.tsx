import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProjectTeamAgentViewModel } from '../control-plane/view-model';
import { loadProjectTeamViewModels } from '../api/control-plane-adapter';
import { useAusweisFenster } from './AusweisFenster';
// P22-T289: Schalter web_ui_agentfenster_alle EIN -> Agentenfenster (Knopf „Ausweis“ im Kopf oeffnet dieses Ausweis-Fenster).
import { useAgentFensterOeffnen } from './AgentFenster';
import { agentTon, teamSchluessel } from '../views/projekt/agententeam-logik';
import { AUSWEIS_ERSTELLEN, sortiereTeamSuche } from '../views/projekt/agententeam-suche-logik';
// Grundstil des Suchfelds (position:fixed, Spalte) liegt in seitenleiste-projekt.css (P22-T230); sonst nur ueber die Projektkarte geladen.
import '../seitenleiste-projekt.css';
import '../channel-fenster-p22-t254.css';
import '../agententeam-suche-p22-t270.css';

/*
 * P22-T270 (User thought 9ddef22c + 7b25b0c1): der Knopf Agententeam als Suche, gleiche Bedienung wie ChannelSuche (P22-T254) und die
 * Projektsuche (P22-T230): Feld unter dem Knopf, Escape bzw. Klick daneben schliesst, Treffer oeffnen ein Fenster (AusweisFenster).
 * Erster Eintrag ist IMMER „Ausweis erstellen“ (Anlege-Modus fuer das gewaehlte Projekt), danach die Projektagenten (GET agenten-team).
 * Nur mit Produkt-Schalter web_ui_agententeam_suche (SynapseWorkspace); AUS = bisherige Agententeam-Seite.
 */
export function AgentenTeamSuche({ project, eingeklappt, label = 'Agententeam', glyph = '◉' }: { project: string; eingeklappt: boolean; label?: string; glyph?: string }) {
  const host = useAusweisFenster();
  const agentFenster = useAgentFensterOeffnen();
  const [offen, setOffen] = useState(false), [such, setSuch] = useState(''), [agents, setAgents] = useState<ProjectTeamAgentViewModel[]>([]), [fehler, setFehler] = useState(''), [geladen, setGeladen] = useState(false);
  const knopf = useRef<HTMLButtonElement>(null), feld = useRef<HTMLDivElement>(null), [lage, setLage] = useState<CSSProperties>({});
  useEffect(() => { setAgents([]); setGeladen(false); setFehler(''); }, [project]);
  // Offen schneller nachladen (wie ChannelSuche 6 s), geschlossen nur fuer die Zahl am Knopf.
  useEffect(() => {
    let aktiv = true;
    if (!project) return;
    const laden = async () => {
      try { const rows = await loadProjectTeamViewModels(project); if (aktiv) { setAgents(rows); setFehler(''); setGeladen(true); } }
      catch (e) { if (aktiv) { setFehler(e instanceof Error ? e.message : String(e)); setGeladen(true); } }
    };
    void laden();
    const timer = window.setInterval(() => void laden(), offen ? 6000 : 15000);
    return () => { aktiv = false; window.clearInterval(timer); };
  }, [project, offen]);
  useLayoutEffect(() => {
    if (!offen) return;
    const setzen = () => { const r = knopf.current?.getBoundingClientRect(); if (!r) return; const b = Math.min(380, window.innerWidth - 24); setLage({ left: Math.max(12, Math.min(eingeklappt ? r.right + 8 : r.left, window.innerWidth - b - 12)), top: Math.min(r.bottom + 6, window.innerHeight - 280), width: b, maxHeight: 'min(520px, 70vh)' }); };
    setzen(); window.addEventListener('resize', setzen); return () => window.removeEventListener('resize', setzen);
  }, [offen, eingeklappt]);
  useEffect(() => {
    if (!offen) return;
    const taste = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOffen(false); knopf.current?.focus(); } };
    const ausserhalb = (e: globalThis.PointerEvent) => { const z = e.target as Node; if (!feld.current?.contains(z) && !knopf.current?.contains(z)) setOffen(false); };
    window.addEventListener('keydown', taste); document.addEventListener('pointerdown', ausserhalb);
    return () => { window.removeEventListener('keydown', taste); document.removeEventListener('pointerdown', ausserhalb); };
  }, [offen]);
  const liste = sortiereTeamSuche(agents, such);
  return <><button ref={knopf} type="button" aria-haspopup="dialog" aria-expanded={offen} onClick={() => setOffen((v) => !v)} title={eingeklappt ? 'Agententeam suchen' : undefined} data-agententeam-knopf=""><span>{glyph}</span>{label}{agents.length > 0 && <b>{agents.length}</b>}</button>
    {offen && <div ref={feld} className="seitenleiste-projektsuche channel-suche agententeam-suche" style={lage} role="dialog" aria-label="Agententeam suchen">
      <input autoFocus value={such} onChange={(e) => setSuch(e.target.value)} placeholder="Agenten suchen" aria-label="Agenten suchen" />
      {fehler && <p role="alert">{fehler}</p>}
      <div className="channel-suche-liste">
        <button type="button" className="agententeam-suche-erstellen" onClick={() => { host?.oeffne({ project, modus: 'anlegen' }); setOffen(false); }}>
          <strong><i aria-hidden="true">+</i>{AUSWEIS_ERSTELLEN}</strong><small>Neuer Agent mit Ausweis für {project}</small></button>
        {liste.map((a) => <button type="button" key={teamSchluessel(a)} data-ton={agentTon(a)} onClick={() => { if (agentFenster) agentFenster({ project, name: a.agentId || a.name, anzeige: a.name, identityId: a.identityId, rolle: a.rolle, status: a.status, herkunft: a.herkunft, team: a, quelle: 'agententeam' }); else host?.oeffne({ project, modus: 'anzeigen', agent: a }); setOffen(false); }}>
          <strong><i className={'agententeam-suche-ton ' + agentTon(a)} aria-hidden="true" />{a.name}</strong>{a.busy && <b>arbeitet</b>}
          <small>{[a.rolle, a.typ, a.status, a.art === 'wrapper' ? 'Wrapper' : 'Ausweis'].filter(Boolean).join(' · ')}</small></button>)}
        {!liste.length && !fehler && <p>{!geladen ? 'lädt …' : agents.length ? 'Keine Agenten gefunden.' : 'Für dieses Projekt sind keine Agenten registriert.'}</p>}
      </div>
    </div>}</>;
}
