import type { ProjectTeamAgentViewModel } from '../../control-plane/view-model';

import { ANMELDE_ANLASS } from './agententeam-konstanten';

export function agentTon(agent: ProjectTeamAgentViewModel) {
  if (agent.status === 'running' || agent.status === 'angemeldet') return 'ready';
  if (agent.status === 'idle') return 'warning';
  return 'offline';
}

export function teamSchluessel(agent: ProjectTeamAgentViewModel): string {
  return agent.key || agent.name;
}

export function teamKontextText(agent: ProjectTeamAgentViewModel): string {
  return agent.contextQuelle === '' ? '–' : agent.contextPercent + ' %';
}

export function teamAnmeldungText(agent: ProjectTeamAgentViewModel): string {
  if (agent.letzteAnmeldung) return new Date(agent.letzteAnmeldung).toLocaleString('de-DE') + (agent.anmeldungAnlass ? ' · ' + (ANMELDE_ANLASS[agent.anmeldungAnlass] ?? agent.anmeldungAnlass) : '');
  return agent.anmeldungAus ? 'Anmelde-Übersicht ist ausgeschaltet' : '–';
}
