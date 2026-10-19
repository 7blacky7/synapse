/**
 * P7-T40: gemeinsamer Onboarding-Ladepfad. Erst vollständig aufbereiten, dann
 * atomar Zustellung beanspruchen. Explizite Anmeldung gehört ihrer eigenen Antwort.
 *
 * W12-B (P22-T25, Vertrag V5 zustellUmfang): Token-Agent mit aktivem Lauf bei wirksamem Ausweis-Kern ->
 * Zustellung JE LAUF statt je Identitaet/Prozess. Anmeldung/Sitzungssignal (explizit) = wie bisher alles, danach
 * ist der Regelstand im Lauf vermerkt. Folgeaufrufe im selben Lauf liefern nur Nichtzugestelltes: Pflichtregeln
 * voll, wenn im Lauf noch keine bzw. eine geaenderte zugestellt wurden (uebrige Regeln dann nur als Namen im
 * regel_verzeichnis), sonst nichts; Profilblock (W12-C) einmal je Lauf. Kern AUS bzw. Legacy-Agent: unveraendert.
 */
import { getOnboardingMemories } from './memory.js';
import { istOnboardingBekannt, registerAgent } from './project-status.js';
import { rolleFuerAgent, rollenQuelleKlartext, baueOnboardingRegelwerk, baueRegelAbrufHinweis } from './agent-rollen.js';
import { w12ZustellKontext, w12ProfilBlock, markiereZugestellt } from './agent-lauf.js';
import { TEXT_NEUINSTANZ } from './agent-profil-vertrag.js';

export async function holeAgentOnboarding(e: {
  project: string; agentId: string; role?: string; serverInstanceId: string;
  explizit?: boolean; vorbereiten?: () => Promise<void>;
}) {
  const { project, agentId } = e;
  const { rolle, quelle } = rolleFuerAgent(agentId, e.role);
  // W12-B: null = Bestandsverhalten (kein Token-Agent mit Lauf, Kern AUS oder Lesefehler).
  const w12 = await w12ZustellKontext(project, agentId, !!e.explizit).catch(() => null);
  const folge = w12 && !e.explizit ? w12 : null;
  if (folge) {
    if (folge.umfang.pflichtregeln === 'keine' && !folge.umfang.profilblock) {
      await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle);
      return null;
    }
  } else if (!e.explizit && await istOnboardingBekannt(project, agentId)) {
    await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle);
    return null;
  }
  await e.vorbereiten?.();
  const core = await import('../index.js');
  if (rolle === 'channelverwalter') await core.ensureChannelverwalterRegel(project);
  const memories = await getOnboardingMemories(project);
  const regelwerk = baueOnboardingRegelwerk(memories, project, rolle);
  if (folge) {
    // Folgeaufruf im Lauf: nur das Delta, keine Uebersichten (Channels/Plaene kommen mit anmelden/index_stats).
    const pflicht = folge.umfang.pflichtregeln === 'voll';
    const profil = folge.umfang.profilblock ? await w12ProfilBlock(folge.identity_id) : null;
    const delta = {
      isFirstVisit: false, message: 'Neuer Lauf: nur noch nicht zugestellte Regeln/Profil (Zustellung je Lauf).',
      project, rolle, rolle_quelle: quelle,
      rules: pflicht ? regelwerk.rules.filter(r => r.vollstaendig) : [],
      ...(folge.umfang.regel_verzeichnis ? { regel_verzeichnis: {
        ...regelwerk.regel_verzeichnis, regeln: regelwerk.rules.filter(r => !r.vollstaendig).map(r => r.name) } } : {}),
      ...(profil ? { profil } : {}),
      neuinstanz_hinweis: TEXT_NEUINSTANZ,
      zustellung: { ...folge.umfang, lauf_id: folge.lauf_id },
    };
    if (!pflicht && !profil) {
      await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle);
      return null;
    }
    const geliefert = await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle, true);
    if (geliefert) {
      await markiereZugestellt(folge.lauf_id, {
        ...(pflicht ? { regeln_stand: folge.regeln_stand } : {}),
        ...(profil ? { profil_revision: profil.profil_revision } : {}),
      }).catch(() => undefined);
    }
    return geliefert ? delta : null;
  }
  const { rules, regel_verzeichnis } = regelwerk;
  const volltext = baueRegelAbrufHinweis(project, rules.filter(r => !r.vollstaendig).length);
  const koordinator = rolle === 'koordinator';
  const channels = await core.baueChannelUebersicht(project, koordinator);
  const jev = await core.baueAbwesenheitsHinweis(project);
  const faelle = await core.erklaerungsFaelleZeile({ project, agent_id: agentId, koordinator });
  const durchsicht = await core.entscheidungsDurchsichtZeile({ project, koordinator });
  const plaene = await core.planUebersicht(project);
  const block = {
    // P10-T78: Begruessung wieder auf allen Strecken (REST verlor sie mit P7-T40; stdio ergaenzt sie in server.ts).
    isFirstVisit: true, message: '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:', project, rolle, rolle_quelle: quelle,
    rolle_hinweis: rollenQuelleKlartext(rolle, quelle, e.role),
    rules, regel_verzeichnis,
    task_suche_hinweis: 'Vor dem Anlegen einer Task zuerst search(tasks), search(plans) oder plan(search, art:tasks|plans) mit alle:true ohne Statusfilter. Pins zählen Thoughts/Dateiversionen; mit_verknuepfungen:true liefert jüngste IDs. aehnlich beim Anlegen ist nur ein Hinweis.',
    ...(volltext ? { volltext_hinweis: volltext } : {}),
    ...(channels ? { channels } : {}),
    ...(jev ? { jev_hinweis: jev } : {}),
    ...(faelle ? { erklaerung_faelle: faelle } : {}),
    ...(durchsicht ? { entscheidungen_durchsicht: durchsicht } : {}),
    ...(plaene.length ? { plaene } : {}),
    // W12-B: nur fuer Token-Agenten mit Lauf bei Kern EIN (sonst Bestandsform unveraendert).
    ...(w12 ? { neuinstanz_hinweis: TEXT_NEUINSTANZ, zustellung: { ...w12.umfang, lauf_id: w12.lauf_id } } : {}),
  };
  const geliefert = await registerAgent(project, agentId, e.serverInstanceId, rolle, quelle, e.explizit);
  if (geliefert && w12) await markiereZugestellt(w12.lauf_id, { regeln_stand: w12.regeln_stand }).catch(() => undefined);
  return geliefert ? block : null;
}
