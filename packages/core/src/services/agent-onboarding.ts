/**
 * P7-T40: gemeinsamer Onboarding-Ladepfad. Erst vollständig aufbereiten, dann
 * atomar Zustellung beanspruchen. Explizite Anmeldung gehört ihrer eigenen Antwort.
 */
import { getOnboardingMemories } from './memory.js';
import { istOnboardingBekannt, registerAgent } from './project-status.js';
import { rolleFuerAgent, rollenQuelleKlartext, baueOnboardingRegelwerk, baueRegelAbrufHinweis } from './agent-rollen.js';

export async function holeAgentOnboarding(e: {
  project: string; agentId: string; role?: string; serverInstanceId: string;
  explizit?: boolean; vorbereiten?: () => Promise<void>;
}) {
  const { project, agentId } = e;
  const { rolle, quelle } = rolleFuerAgent(agentId, e.role);
  if (!e.explizit && await istOnboardingBekannt(project, agentId)) {
    await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle);
    return null;
  }
  await e.vorbereiten?.();
  const core = await import('../index.js');
  if (rolle === 'channelverwalter') await core.ensureChannelverwalterRegel(project);
  const memories = await getOnboardingMemories(project);
  const { rules, regel_verzeichnis } = baueOnboardingRegelwerk(memories, project, rolle);
  const volltext = baueRegelAbrufHinweis(project, rules.filter(r => !r.vollstaendig).length);
  const koordinator = rolle === 'koordinator';
  const channels = await core.baueChannelUebersicht(project, koordinator);
  const jev = await core.baueAbwesenheitsHinweis(project);
  const faelle = await core.erklaerungsFaelleZeile({ project, agent_id: agentId, koordinator });
  const durchsicht = await core.entscheidungsDurchsichtZeile({ project, koordinator });
  const plaene = await core.planUebersicht(project);
  const block = {
    isFirstVisit: true, project, rolle, rolle_quelle: quelle,
    rolle_hinweis: rollenQuelleKlartext(rolle, quelle, e.role),
    rules, regel_verzeichnis,
    ...(volltext ? { volltext_hinweis: volltext } : {}),
    ...(channels ? { channels } : {}),
    ...(jev ? { jev_hinweis: jev } : {}),
    ...(faelle ? { erklaerung_faelle: faelle } : {}),
    ...(durchsicht ? { entscheidungen_durchsicht: durchsicht } : {}),
    ...(plaene.length ? { plaene } : {}),
  };
  return await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle, e.explizit) ? block : null;
}
