import React from 'react';
import {
  loadAgentKnowledge,
  loadKnowledgeAgents,
  type AgentKnowledge,
  type WissensArt,
} from '../api/project-detail';
import { KlartextText } from './Lesefenster';
import '../project-detail.css';

// P8-T30 Nachtrag: Agentenwissen je Agent (specialists/:specName/wissen) als Klartext, nur lesend.

type Ansicht = 'gesamt' | WissensArt;

const ANSICHTEN: Array<{ id: Ansicht; label: string }> = [
  { id: 'gesamt', label: 'Gesamt' },
  { id: 'regeln', label: 'Regeln' },
  { id: 'fehler', label: 'Fehler' },
  { id: 'muster', label: 'Muster' },
  { id: 'kontext', label: 'Kontext' },
];

function fehlerText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectAgentKnowledgePanel({ project }: { project: string }) {
  const [agents, setAgents] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState('');
  const [wissen, setWissen] = React.useState<AgentKnowledge | null | undefined>(undefined);
  const [wissenError, setWissenError] = React.useState('');
  const [ansicht, setAnsicht] = React.useState<Ansicht>('gesamt');

  const reload = React.useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError('');
    try {
      setAgents(await loadKnowledgeAgents(project));
    } catch (loadError) {
      setAgents([]);
      setError(fehlerText(loadError));
    } finally {
      setLoading(false);
    }
  }, [project]);

  React.useEffect(() => {
    setAgents([]);
    setSelected('');
    setWissen(undefined);
    void reload();
  }, [reload]);

  React.useEffect(() => {
    if (!selected) { setWissen(undefined); return; }
    let aktiv = true;
    setWissen(undefined);
    setWissenError('');
    setAnsicht('gesamt');
    loadAgentKnowledge(project, selected)
      .then((value) => { if (aktiv) setWissen(value); })
      .catch((loadError) => { if (aktiv) setWissenError(fehlerText(loadError)); });
    return () => { aktiv = false; };
  }, [project, selected]);

  const text = wissen ? (ansicht === 'gesamt' ? wissen.text : wissen.arten.find((art) => art.art === ansicht)?.text ?? '') : '';
  const zustand = loading ? 'lädt …' : error ? 'Fehler' : agents.length + ' Agenten';

  return <div className="project-plan-panel">
    <header><div><span>AGENT MEMORY · {project}</span><h3>Agentenwissen</h3><p>Wissen konkreter Projektagenten (Regeln, Fehler, Muster, Kontext), nur lesend.</p></div><button type="button" onClick={() => void reload()} disabled={loading}>Aktualisieren</button></header>
    <section className="pd-bar"><em>{zustand}</em></section>
    {error && <p className="pd-error">{error}</p>}
    <div className="pd-content">
      <aside>
        {agents.map((agent) => <button type="button" key={agent} className={'pd-task' + (agent === selected ? ' active' : '')} onClick={() => setSelected(agent)}><span className="pd-task-title">{agent}</span></button>)}
        {!agents.length && <p className="pd-note">{loading ? 'Agenten werden geladen …' : error ? '' : 'Keine Agenten in diesem Projekt.'}</p>}
      </aside>
      <main>
        {!selected && <p className="pd-note">Agent wählen, um sein Wissen zu sehen.</p>}
        {selected && wissenError && <p className="pd-error">{wissenError}</p>}
        {selected && !wissenError && wissen === undefined && <p className="pd-note">Wissen wird geladen …</p>}
        {selected && wissen === null && <p className="pd-note">Zu „{selected}“ ist kein Wissen hinterlegt.</p>}
        {wissen && <>
          <span className="pd-eyebrow">{wissen.agent}</span>
          <h4>Wissen von {wissen.agent}</h4>
          <dl className="pd-facts">
            {wissen.meta.map((eintrag) => <div key={eintrag.label}><dt>{eintrag.label}</dt><dd>{eintrag.value}</dd></div>)}
            <div><dt>System-Prompt</dt><dd>{wissen.systemPromptLength ? wissen.systemPromptLength + ' Zeichen' : 'keiner'}</dd></div>
          </dl>
          {wissen.warnings.map((warnung) => <p className="pd-error" key={warnung}>{warnung}</p>)}
          <div className="pd-arten">{ANSICHTEN.map((eintrag) => {
            const zahl = eintrag.id === 'gesamt' ? 0 : wissen.arten.find((art) => art.art === eintrag.id)?.count ?? 0;
            return <button type="button" key={eintrag.id} className={eintrag.id === ansicht ? 'active' : ''} onClick={() => setAnsicht(eintrag.id)}>{eintrag.label}{eintrag.id !== 'gesamt' ? ' (' + zahl + ')' : ''}</button>;
          })}</div>
          <div className="pd-text">{wissen.empty && ansicht === 'gesamt' ? <p className="pd-note">Das Wissen dieses Agenten ist noch leer.</p> : <KlartextText text={text} project={project} />}</div>
        </>}
      </main>
    </div>
  </div>;
}
