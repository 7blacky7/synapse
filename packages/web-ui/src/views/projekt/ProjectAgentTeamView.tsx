import { useEffect, useState } from 'react';

import { AktuelleTaskAbsatz, AgentTaskMarke } from '../../components/AgentTaskMarke';
import { LaufHerkunftMarke } from '../../components/LaufHerkunftMarke';
import { RuntimeAgentenPanel } from '../../components/RuntimeAgentenPanel';
import { PageHeader } from '../../components/gemeinsam/PageHeader';
import { StatusChip } from '../../components/StatusKennzeichnung';
import { useAgentVerbrauch } from '../../components/HauptagentSteuerung';
import { oeffneAusweisVerwaltung } from '../../ausweis-deeplink';
import { herkunftText, loadProjectTeamViewModels } from '../../api/control-plane-adapter';
import type { ProjectTeamAgentViewModel } from '../../control-plane/view-model';
import { agentTon, teamAnmeldungText, teamKontextText, teamSchluessel } from './agententeam-logik';

// P22-T89: Das Team kommt aus GET /api/projects/:name/agenten-team: aktive Identitaeten
// (Ausweis) des Projekts plus Wrapper-Spezialisten; archivierte blendet der Server aus.
export function ProjectAgentTeamView({ project }: { project: string }) {
  const [agents, setAgents] = useState<ProjectTeamAgentViewModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const current = agents.find((agent) => teamSchluessel(agent) === selected) ?? agents[0];
  const verbrauch = useAgentVerbrauch(project);

  useEffect(() => {
    let active = true;
    setAgents([]);
    setSelected('');
    setError('');
    if (!project) return;
    const laden = async () => {
      setLoading(true);
      try {
        const rows = await loadProjectTeamViewModels(project);
        if (!active) return;
        setAgents(rows);
        setError('');
        setSelected((key) => (rows.some((row) => teamSchluessel(row) === key) ? key : rows[0] ? teamSchluessel(rows[0]) : ''));
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (active) setLoading(false);
      }
    };
    void laden();
    const timer = window.setInterval(() => void laden(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [project]);

  return <div className="standard-page">
    <PageHeader eyebrow="PROJEKTGEBUNDENES TEAM" title={'Agententeam · ' + project} description="Hier erscheinen ausschließlich Agenten dieses Projekts. Der globale Hauptagent bleibt in seinem eigenen Chatfenster." action={<StatusChip stand="live" />} />
    <section className="split-surface project-agent-team">
      <div className="entity-list">
        <header><h2>Projekt-Agenten</h2><span>{agents.length}</span></header>
        {agents.map((agent) => <button type="button" className={current && teamSchluessel(current) === teamSchluessel(agent) ? 'entity-row active' : 'entity-row'} key={teamSchluessel(agent)} onClick={() => setSelected(teamSchluessel(agent))}><i className={agentTon(agent)} /><div><strong>{agent.name}<AgentTaskMarke project={project} identityId={agent.identityId} name={agent.agentId || agent.name} /><LaufHerkunftMarke project={project} identityId={agent.identityId} name={agent.agentId || agent.name} /></strong><small>{[agent.rolle, agent.status + (agent.busy ? ' · arbeitet' : '')].filter(Boolean).join(' · ')}</small></div><span>{teamKontextText(agent)}</span></button>)}
        {!agents.length && <p className="empty-state">{loading ? 'lädt …' : error || 'Für dieses Projekt sind keine Agenten registriert.'}</p>}
      </div>
      {current && <div className="entity-detail">
        <div className="detail-status"><i className={agentTon(current)} /><span>{current.status}</span><b>{current.art === 'wrapper' ? 'WRAPPER' : 'AUSWEIS'}</b></div>
        <h2>{current.name}<AgentTaskMarke project={project} identityId={current.identityId} name={current.agentId || current.name} /><LaufHerkunftMarke project={project} identityId={current.identityId} name={current.agentId || current.name} /></h2>
        {current.art !== 'wrapper' && <p><button type="button" onClick={() => oeffneAusweisVerwaltung({ project, agentId: current.agentId || current.name })}>Ausweis und Profil verwalten</button></p>}
        <AktuelleTaskAbsatz project={project} identityId={current.identityId} name={current.agentId || current.name} rueckfall={current.currentTask} />
        <dl>
          <div><dt>Rolle</dt><dd>{current.rolle || '–'}</dd></div>
          <div><dt>Typ</dt><dd>{current.typ || '–'}</dd></div>
          <div><dt>Ausweis</dt><dd>{current.ausweis === 'gueltig' ? 'gültig' : current.ausweis === 'keiner' ? 'kein gültiger Ausweis' : '–'}</dd></div>
          <div><dt>Modell</dt><dd>{current.model || '–'}</dd></div>
          <div><dt>Provider</dt><dd>{current.provider || '–'}</dd></div>
          <div><dt>Ort</dt><dd>{current.herkunft ? herkunftText(current.herkunft) : '–'}</dd></div>
          <div><dt>Gestartet über</dt><dd title={current.startOrt?.quelle || undefined}>{current.startOrt ? current.startOrt.bezeichnung : '–'}</dd></div>
          <div><dt>Letzte Anmeldung</dt><dd>{teamAnmeldungText(current)}</dd></div>
          <div><dt>Kontext</dt><dd>{teamKontextText(current)}</dd></div>
          <div><dt>Tokens ein / aus</dt><dd>{current.tokensIn.toLocaleString('de-DE')} / {current.tokensOut.toLocaleString('de-DE')}</dd></div>
          <div><dt>Channels</dt><dd>{current.channels.length ? current.channels.map((name) => '#' + name).join(', ') : '–'}</dd></div>
          <div><dt>Letzte Aktivität</dt><dd>{current.lastActivity ? new Date(current.lastActivity).toLocaleString('de-DE') : '–'}</dd></div>
          <div><dt>Tokens (Monat, Abo)</dt><dd>{verbrauch ? (verbrauch[current.agentId || current.name] ?? 0).toLocaleString('de-DE') : '–'}</dd></div>
        </dl>
      </div>}
    </section>
    {/* P22-T122: Runtime-Agenten beim Agententeam (nur Schalter runtime_agenten_panel_neu EIN; sonst unter den Channels). */}
    <RuntimeAgentenPanel key={'team:' + project} project={project} ort="team" />
  </div>;
}
