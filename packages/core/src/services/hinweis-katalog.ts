/**
 * P22-T13 Paket C (K16.3, P7-T46): VOLLSTAENDIGES Hinweisverzeichnis beider Transporte.
 *
 * Rein (keine DB, keine Env, keine Laufzeitimporte), damit Low-Level-Produzenten (hinweis-drossel,
 * ausloeser-hinweise, events, tool-antwort, skill-hook ...) es VOR Suche/Claim ohne Importzyklus nutzen.
 * agent-profil-vertrag.ts re-exportiert HINWEIS_KATALOG/hinweisEintrag/hinweisAbschaltbar unveraendert
 * (kein zweiter Katalog).
 *
 * - Jede Hinweisart hat eine stabile Katalog-ID mit Klasse pflicht|optional. Pflichtklassen kann kein
 *   Profil abschalten (Fehler, Sicherheit, werkzeug_regeln, Status/Kuerzung).
 * - Optionale Arten koennen PFLICHTANTEILE tragen (z. B. WORK_STOP in pending_events). Sie bleiben
 *   sichtbar, auch wenn der optionale Rest abgeschaltet ist (pflichtAnteil()). Inhaltlich klassifiziert,
 *   nicht pauschal entfernt (env_hinweise, fehlermuster).
 * - HINWEIS_PRODUZENTEN ordnet JEDEN Produzenten der REST-Hook-Kette (rest-api/src/routes/mcp.ts) und der
 *   stdio-Kette (mcp-server/src/server.ts) samt Antwortfeld genau einer Katalog-ID zu. Aliase
 *   (claimHinweis.art, Registry-quelle_id 'ausloeser.<id>', Feldnamen) bilden auf diese IDs ab.
 * - Konfiguration je Profil: ProfilInhalt.hinweise['<id>'] (true/false, auch 'ausloeser.<quelle_id>'),
 *   sonst kontext_stufe (normal = Standard, kompakt = nur Arten mit kompakt!==false, minimal = nur
 *   Pflicht/Pflichtanteile). Projektweit wirkt zusaetzlich project(hinweise) (hinweis_optionen) wie bisher
 *   bei claimHinweis-/Registry-Produzenten; Legacy-Hintprofile (kontextprofil_*, ausloeser_hinweis_profile)
 *   bleiben in Kraft. Kombination: eine Art erscheint nur, wenn ALLE zustaendigen Ebenen sie erlauben.
 */
export type HinweisKlasse = 'pflicht' | 'optional';

export interface HinweisKatalogEintrag {
  schluessel: string;
  klasse: HinweisKlasse;
  /** Produzent/Hook (jeder Produzent beider Transporte ist genau einer ID zugeordnet, HINWEIS_PRODUZENTEN) */
  quelle: string;
  zweck: string;
  /** Anteile optionaler Arten, die IMMER sichtbar bleiben (z. B. WORK_STOP in pending_events) */
  pflichtanteile?: readonly string[];
  /** Standard: ausgeliefert */
  standard: boolean;
  /** in kontext_stufe 'kompakt' ausgeliefert (Standard true) */
  kompakt?: boolean;
  /** Antwortfelder ('a.b' = Unterfeld von a) */
  felder?: readonly string[];
  /** bisheriger Claim-/ACK-/Seen-Speicher */
  zustand?: string;
  /** Bindung: Legacy-agent_id und/oder bestaetigte identity_id */
  bindung?: string;
  /** Tools/Aktionen, an denen die Art entsteht ('*' = jede Antwort) */
  tools?: string;
  /** ungefaehre Groesse je Auslieferung */
  groesse?: string;
  /** Konfigurierbarkeit */
  konfiguration?: string;
}

const PROFIL = 'je Profil hinweise.<id> bzw. kontext_stufe (Typ -> Override); nie durch den Agenten selbst';
const BEIDE = 'Legacy agent_id und identity_id (Snapshot nur bei Tokenaufruf)';

/** Vollstaendiger Katalog; die ersten vier Eintraege und ihre Schluessel sind seit Phase V stabil. */
export const HINWEIS_KATALOG: readonly HinweisKatalogEintrag[] = [
  { schluessel: 'fehler', klasse: 'pflicht', quelle: 'Fachhandler/Transport (success:false, error, isError)', zweck: 'tatsaechliche Fehler',
    standard: true, felder: ['error'], tools: '*', groesse: 'klein', konfiguration: 'nicht abschaltbar' },
  { schluessel: 'sicherheit', klasse: 'pflicht', quelle: 'Shell-Sicherung (stufe/bestaetigung_id/sperre), Identitaet (identitaet_konflikt/ausweis_konflikt), Profil-Gate',
    zweck: 'Sicherheitsmeldungen', standard: true, tools: 'shell, Tokenaufrufe', groesse: 'klein', konfiguration: 'nicht abschaltbar' },
  { schluessel: 'werkzeug_regeln', klasse: 'pflicht', quelle: 'holeWerkzeugRegeln/WERKZEUG_REGEL_FELD (REST attachWerkzeugRegeln, stdio haengeWerkzeugRegelnAn)',
    zweck: 'verbindliche Werkzeugregeln', standard: true, felder: ['werkzeug_regeln'], zustand: 'keiner (je Aufruf)', bindung: 'ohne agent_id',
    tools: '* (bei:-Marke)', groesse: 'klein-mittel', konfiguration: 'nicht abschaltbar' },
  { schluessel: 'status_kuerzung', klasse: 'pflicht', quelle: 'agent-zuschnitt.ts projiziereToolAntwort (antwort_zuschnitt)',
    zweck: 'Status-, Kuerzungs-, Nachlade- und Berechtigungsinformation', standard: true, felder: ['antwort_zuschnitt'], tools: '*', groesse: 'klein',
    konfiguration: 'nicht abschaltbar' },
  { schluessel: 'pending_events', klasse: 'optional', quelle: 'getPendingEventHints (REST attachRestPendingEventHints, stdio attachResponseHooks)',
    zweck: 'offene Ereignisse (Kurzinbox)', pflichtanteile: ['WORK_STOP', 'TEAM_DISCUSSION', 'CRITICAL_REVIEW'], standard: true, kompakt: true,
    felder: ['pending_events'], zustand: 'kein Claim (lesend; nur event(ack) quittiert)', bindung: BEIDE, tools: '* ausser event/guide', groesse: '<= 3 Zeilen', konfiguration: PROFIL },
  { schluessel: 'event_warning', klasse: 'optional', quelle: 'pruefeEventEskalation (beide Transporte)', zweck: 'Eskalation unquittierter dringender Events',
    pflichtanteile: ['eskalation'], standard: true, kompakt: true, felder: ['event_warning'], zustand: 'RAM-Eskalationszaehler je Prozess', bindung: BEIDE,
    tools: '* ausser event/guide', groesse: '1 Zeile', konfiguration: PROFIL + '; die Eskalation selbst ist Pflichtanteil' },
  { schluessel: 'reservation_hint', klasse: 'optional', quelle: 'getDirectWriteReservationHint (REST attachDirectWriteReservationHint)',
    zweck: 'fremde aktive Reservierung nach direktem Write (blockiert nie; Co-Edit-Konflikte selbst sind fachliche Status-Felder)', standard: true, kompakt: true,
    felder: ['reservation_hint'], zustand: 'kein Claim', bindung: BEIDE, tools: 'files/files_batch direkte Writes', groesse: 'klein', konfiguration: PROFIL },
  { schluessel: 'env_hinweise', klasse: 'optional', quelle: 'env-maske.ts (files/files_batch Schreib-/commit-/restore-Antworten, Handler)',
    zweck: 'ueberschriebene/entfernte .env-Werte (nur Namen); jeder Eintrag ist Pflichtanteil', pflichtanteile: ['ueberschriebener_wert'], standard: true, kompakt: true,
    felder: ['env_hinweise'], zustand: 'kein Claim', bindung: BEIDE, tools: 'files, files_batch', groesse: 'klein', konfiguration: 'inhaltlich immer Pflichtanteil' },
  { schluessel: 'fehlermuster', klasse: 'optional', quelle: 'holeFehlermusterHinweise (REST attachShellJobHints, stdio attachResponseHooks)',
    zweck: 'Fehlermuster/Erklaerungen der eigenen Schreibvorgaenge', pflichtanteile: ['syntaxbefund', 'severity_error'], standard: true, kompakt: true,
    felder: ['fehlermuster'], zustand: 'RAM-Vorrat je Agent + error_pattern_seen (erst bei Auslieferung)', bindung: BEIDE, tools: '*', groesse: 'mittel', konfiguration: PROFIL },
  { schluessel: 'shell_activity', klasse: 'optional', quelle: 'claimShellJobHints in ergaenzeToolHinweise (beide Transporte)', zweck: 'Shell-Aktivitaet anderer (Koordination)',
    standard: true, kompakt: false, felder: ['shell_activity'], zustand: 'shell_job_hint_deliveries', bindung: BEIDE, tools: '*', groesse: '<= 3 Zeilen', konfiguration: PROFIL + '; shell(hide)' },
  { schluessel: 'build_nachlauf', klasse: 'optional', quelle: 'holeBuildNachlaufHinweise in ergaenzeToolHinweise (beide Transporte)',
    zweck: 'Ergebnis der eigenen projektweiten Build-Pruefung nach dem commit (P16-T23 Nachlauf)', standard: true, kompakt: true, felder: ['build_nachlauf'],
    zustand: 'RAM je Prozess (build-pruefung.ts, genau einmal abgeholt)', bindung: BEIDE, tools: '*', groesse: '1-3 Zeilen', konfiguration: PROFIL },
  { schluessel: 'warteschlangen_stau', klasse: 'optional', quelle: 'holeStauHinweise in ergaenzeToolHinweise (beide Transporte), nur Schnappschuss des Stau-Waechters (P27)',
    zweck: 'Info: Warteschlange ohne Fortschritt (neu/andauernd/behoben), nie Blocker oder Fehler', standard: true, kompakt: true, felder: ['warteschlangen_stau'],
    zustand: 'RAM je Prozess (Episode je Agent, TTL; warteschlangen-stau-hinweis.ts)', bindung: BEIDE, tools: '*', groesse: '<= stau_hinweis_max Zeilen',
    konfiguration: PROFIL + '; Produkt-Schalter warteschlangen_stau (Standard AUS)' },
  { schluessel: 'shell_ergebnis_hinweis', klasse: 'optional', quelle: 'ergaenzeShellErgebnisHinweis (shell-Handler) via claimHinweis art shell-ergebnis:<art>',
    zweck: 'Erklaerung zu Test-/Build-Fehlschlag', standard: true, kompakt: true, felder: ['shell_hinweis'], zustand: 'hinweis_gesehen / agent_identitaet_hinweis_gesehen',
    bindung: BEIDE, tools: 'shell exec/get', groesse: 'klein', konfiguration: PROFIL + '; Jev-Schalter erklaerungstopf' },
  { schluessel: 'shell_job_hinweis', klasse: 'optional', quelle: 'drossleShellJobHinweis (shell-Handler) via claimHinweis art job_env', zweck: 'Projekt-DB der Job-Umgebung (job_env)',
    standard: true, kompakt: false, felder: ['job_env'], zustand: 'hinweis_gesehen / agent_identitaet_hinweis_gesehen', bindung: BEIDE, tools: 'shell exec/get/history/get_stream',
    groesse: '1 Zeile', konfiguration: PROFIL + '; detail:full liefert ausdruecklich' },
  { schluessel: 'unread_chat', klasse: 'optional', quelle: 'getUnreadChatHint in ergaenzeToolHinweise (beide Transporte)', zweck: 'ungelesene Chatnachrichten',
    standard: true, kompakt: true, felder: ['unreadChat'], zustand: 'Chat-Lesestand (Hinweis setzt keine Lesemarke)', bindung: BEIDE, tools: '*', groesse: 'klein', konfiguration: PROFIL },
  { schluessel: 'unread_channels', klasse: 'optional', quelle: 'claimUnreadChannelHints in ergaenzeToolHinweise (beide Transporte)', zweck: 'ungelesene Channelnachrichten',
    standard: true, kompakt: false, felder: ['unread_channels'], zustand: 'Channel-Hinweismarke (kein Lesestand)', bindung: BEIDE, tools: '*', groesse: 'klein', konfiguration: PROFIL },
  { schluessel: 'open_plans', klasse: 'optional', quelle: 'claimOpenPlanHints via claimHinweis art open_plans (REST attachShellJobHints, stdio attachResponseHooks)',
    zweck: 'offene files-Plaene', standard: true, kompakt: false, felder: ['open_plans'], zustand: 'hinweis_gesehen / agent_identitaet_hinweis_gesehen (art open_plans)',
    bindung: BEIDE, tools: '* mit project', groesse: 'mittel', konfiguration: PROFIL + '; project(hinweise)' },
  { schluessel: 'plan_hinweise', klasse: 'optional', quelle: 'holeAgentOnboarding (planUebersicht, task_suche_hinweis)', zweck: 'Plan-Uebersicht und Task-Such-Hinweis im Onboarding',
    standard: true, kompakt: false, felder: ['agentOnboarding.plaene', 'agentOnboarding.task_suche_hinweis'], zustand: 'mit Onboarding (agent_onboardings)', bindung: BEIDE,
    tools: 'Onboarding', groesse: 'mittel', konfiguration: PROFIL },
  { schluessel: 'jev_modus', klasse: 'optional', quelle: 'holeJevSitzungsHinweis (REST attachShellJobHints, stdio attachResponseHooks), jev_hinweis im Onboarding',
    zweck: 'Jev-Modus (Jev-Produkt-Schalter bleiben zustaendig; ein Profil schaltet Jev nie ein)', standard: true, kompakt: false,
    felder: ['jev_modus', 'agentOnboarding.jev_hinweis'], zustand: 'RAM je Prozess/Agent', bindung: BEIDE, tools: '* ausser jev', groesse: '1 Zeile', konfiguration: PROFIL },
  { schluessel: 'skill_suggestions', klasse: 'optional', quelle: 'verarbeiteSkillHinweisgeber/holeOffeneSkillVorschlaege (REST attachSkillHinweisgeber, stdio attachResponseHooks); holeChannelSkillVorschlaege/holeChannelSkillsNachBeitritt/holeSprachSkillVorschlaege (Handler)',
    zweck: 'Skill-Vorschlaege inkl. vorgeschalteter Vorschlagssuche', standard: true, kompakt: false, felder: ['skill_suggestions', 'skill_hook_metrics'],
    zustand: 'skill_hook_preparations/deliveries (+agent_identitaet_*)', bindung: BEIDE, tools: 'memory/thought/plan, channel, files, skills; 99%-Kette (P23-T1) an allen Tools', groesse: 'mittel', konfiguration: PROFIL },
  { schluessel: 'tool_guide', klasse: 'optional', quelle: 'buildFirstUseHint/attachToolGuide (stdio server.ts)', zweck: 'First-Use-Guide je Sitzung und Tool',
    standard: true, kompakt: false, felder: ['tool_guide'], zustand: 'RAM firstUseHinted (erst bei Auslieferung markiert)', bindung: BEIDE, tools: '* (erste Nutzung)', groesse: 'mittel',
    konfiguration: PROFIL + '; guide(tool_name) jederzeit' },
  { schluessel: 'onboarding', klasse: 'optional', quelle: 'holeAgentOnboarding (REST attachRestOnboarding, stdio withOnboarding/checkAgentOnboarding), activeAgents, hinweis_agent_id',
    zweck: 'Onboarding-Block (Pflichtregeln bleiben als Pflichtanteil)', pflichtanteile: ['pflichtregeln'], standard: true, kompakt: true,
    felder: ['agentOnboarding', 'activeAgents', 'hinweis_agent_id'], zustand: 'agent_onboardings', bindung: BEIDE, tools: '* (erster Aufruf/Sitzung)', groesse: 'gross',
    konfiguration: PROFIL + '; ausdrueckliche Anforderung (index_stats onboarding, anmelden, register) bleibt vollstaendig' },
  { schluessel: 'ausloeser.format_ohne_leser', klasse: 'optional', quelle: 'reverse-leser-hinweis.ts (gemeinsamer Reverse-Handler, RV19)',
    zweck: 'RV27-Gruppe ohne passenden Leser; Fehler, Unterbrechung und gültige Leertabelle getrennt', standard: true, kompakt: false,
    felder: ['ausloeser_hinweise'], zustand: 'RV19 je Sitzung/Eintrag/Gruppe, Quellschlüssel mit Registryrevision', bindung: BEIDE,
    tools: 'reverse dateien/status/struktur/inspect', groesse: '<= 240 Zeichen', konfiguration: PROFIL + '; global reverse_leser_hinweise Standard AUS; PG leser_hinweis_min_dateien/leser_hinweis_funktionen' },
  { schluessel: 'ausloeser.log_strom_veraltet', klasse: 'optional', quelle: 'shell-log-strom.ts', zweck: 'Koordinatorhinweis fuer veraltete Log-Stroeme', standard: true, kompakt: false, felder: ['ausloeser_hinweise'], tools: '*', konfiguration: PROFIL },
  { schluessel: 'ausloeser', klasse: 'optional', quelle: 'haengeAusloeserHinweiseAn/haengeAusloeserTextHinweiseAn Registry (ausloeser.<quelle_id>)', zweck: 'registrierte Ausloeserhinweise',
    standard: true, kompakt: false, felder: ['ausloeser_hinweise'], zustand: 'ausloeser_hinweis_zustellungen / agent_identitaet_hinweis_zustellungen', bindung: BEIDE,
    tools: '*', groesse: '<= 2 Zeilen', konfiguration: PROFIL + ' (auch einzeln ausloeser.<quelle_id>); kontextprofil_setzen hinweise_aus/hinweise_nur (Legacy)' },
];
/** Jeder Produzent beider Transporte ist einer Katalog-ID zugeordnet (HINWEIS_PRODUZENTEN, K16.3). */
export const HINWEIS_KATALOG_VOLLSTAENDIG = true;

export function hinweisEintrag(schluessel: string): HinweisKatalogEintrag | undefined {
  const basis = schluessel.startsWith('ausloeser.') ? 'ausloeser' : schluessel;
  return HINWEIS_KATALOG.find(h => h.schluessel === basis);
}

/** Pflichtklassen (Fehler, Sicherheit, Werkzeugregeln, Status) kann kein Profil abschalten. */
export function hinweisAbschaltbar(schluessel: string): boolean {
  return hinweisEintrag(schluessel)?.klasse === 'optional';
}

export type HinweisFilter = 'vor_suche_claim' | 'pflichtanteil' | 'projektion' | 'pflicht';

/** Ein Produzent eines Transports mit seinem Antwortfeld und der Stelle, an der das Profil entscheidet. */
export interface HinweisProduzent {
  katalog: string;
  transport: 'rest' | 'stdio' | 'beide';
  ort: string;
  feld: string;
  filter: HinweisFilter;
}

/**
 * Produzentenliste beider Transporte (Stand P22-T13). filter: vor_suche_claim = Produzent fragt hinweisAktiv()
 * vor Abfrage/Suche/Claim; pflichtanteil = Produzent liefert bei AUS nur den Pflichtanteil; projektion =
 * Feld wird in projiziereToolAntwort entschieden (ohne Claim oder ausdrueckliche Anforderung); pflicht = nie entfernt.
 */
export const HINWEIS_PRODUZENTEN: readonly HinweisProduzent[] = [
  { katalog: 'tool_guide', transport: 'stdio', ort: 'server.ts buildFirstUseHint/attachToolGuide (firstUseHinted)', feld: 'tool_guide', filter: 'vor_suche_claim' },
  { katalog: 'werkzeug_regeln', transport: 'stdio', ort: 'server.ts haengeWerkzeugRegelnAn', feld: 'werkzeug_regeln', filter: 'pflicht' },
  { katalog: 'werkzeug_regeln', transport: 'rest', ort: 'mcp.ts attachWerkzeugRegeln', feld: 'werkzeug_regeln', filter: 'pflicht' },
  { katalog: 'ausloeser.log_strom_veraltet', transport: 'beide', ort: 'shell-log-strom.ts initialisiereLogStromHinweise', feld: 'ausloeser_hinweise', filter: 'vor_suche_claim' },
  { katalog: 'ausloeser', transport: 'stdio', ort: 'server.ts haengeAusloeserTextHinweiseAn', feld: 'ausloeser_hinweise', filter: 'vor_suche_claim' },
  { katalog: 'ausloeser', transport: 'rest', ort: 'mcp.ts attachWerkzeugRegeln -> haengeAusloeserHinweiseAn', feld: 'ausloeser_hinweise', filter: 'vor_suche_claim' },
  { katalog: 'unread_chat', transport: 'beide', ort: 'tool-antwort.ts ergaenzeToolHinweise -> getUnreadChatHint', feld: 'unreadChat', filter: 'vor_suche_claim' },
  { katalog: 'shell_activity', transport: 'beide', ort: 'tool-antwort.ts ergaenzeToolHinweise -> claimShellJobHints', feld: 'shell_activity', filter: 'vor_suche_claim' },
  { katalog: 'build_nachlauf', transport: 'beide', ort: 'tool-antwort.ts ergaenzeToolHinweise -> holeBuildNachlaufHinweise', feld: 'build_nachlauf', filter: 'vor_suche_claim' },
  { katalog: 'warteschlangen_stau', transport: 'beide', ort: 'tool-antwort.ts ergaenzeToolHinweise -> holeStauHinweise (Schnappschuss)', feld: 'warteschlangen_stau', filter: 'vor_suche_claim' },
  { katalog: 'unread_channels', transport: 'beide', ort: 'tool-antwort.ts ergaenzeToolHinweise -> claimUnreadChannelHints', feld: 'unread_channels', filter: 'vor_suche_claim' },
  { katalog: 'pending_events', transport: 'stdio', ort: 'server.ts attachResponseHooks -> getPendingEventHints', feld: 'pending_events', filter: 'pflichtanteil' },
  { katalog: 'pending_events', transport: 'rest', ort: 'mcp.ts attachRestPendingEventHints -> getPendingEventHints', feld: 'pending_events', filter: 'pflichtanteil' },
  { katalog: 'event_warning', transport: 'stdio', ort: 'server.ts attachResponseHooks -> pruefeEventEskalation', feld: 'event_warning', filter: 'pflichtanteil' },
  { katalog: 'event_warning', transport: 'rest', ort: 'mcp.ts attachRestPendingEventHints -> pruefeEventEskalation', feld: 'event_warning', filter: 'pflichtanteil' },
  { katalog: 'open_plans', transport: 'stdio', ort: 'server.ts attachResponseHooks -> claimOpenPlanHints (claimHinweis open_plans)', feld: 'open_plans', filter: 'vor_suche_claim' },
  { katalog: 'open_plans', transport: 'rest', ort: 'mcp.ts attachShellJobHints -> claimOpenPlanHints (claimHinweis open_plans)', feld: 'open_plans', filter: 'vor_suche_claim' },
  { katalog: 'jev_modus', transport: 'stdio', ort: 'server.ts attachResponseHooks -> holeJevSitzungsHinweis', feld: 'jev_modus', filter: 'vor_suche_claim' },
  { katalog: 'jev_modus', transport: 'rest', ort: 'mcp.ts attachShellJobHints -> holeJevSitzungsHinweis', feld: 'jev_modus', filter: 'vor_suche_claim' },
  { katalog: 'fehlermuster', transport: 'stdio', ort: 'server.ts attachResponseHooks -> holeFehlermusterHinweise', feld: 'fehlermuster', filter: 'pflichtanteil' },
  { katalog: 'fehlermuster', transport: 'rest', ort: 'mcp.ts attachShellJobHints -> holeFehlermusterHinweise', feld: 'fehlermuster', filter: 'pflichtanteil' },
  { katalog: 'skill_suggestions', transport: 'stdio', ort: 'server.ts attachResponseHooks -> verarbeiteSkillHinweisgeber/holeOffeneSkillVorschlaege', feld: 'skill_suggestions', filter: 'vor_suche_claim' },
  { katalog: 'skill_suggestions', transport: 'rest', ort: 'mcp.ts attachSkillHinweisgeber -> verarbeiteSkillHinweisgeber/holeOffeneSkillVorschlaege', feld: 'skill_suggestions', filter: 'vor_suche_claim' },
  { katalog: 'skill_suggestions', transport: 'beide', ort: 'Handler channel/files -> holeChannelSkillVorschlaege/holeChannelSkillsNachBeitritt/holeSprachSkillVorschlaege', feld: 'skill_suggestions', filter: 'vor_suche_claim' },
  { katalog: 'skill_suggestions', transport: 'beide', ort: 'skill_hook_metrics (Telemetrie; baueToolErgebnis entfernt sie aus der Antwort)', feld: 'skill_hook_metrics', filter: 'projektion' },
  { katalog: 'onboarding', transport: 'stdio', ort: 'server.ts withOnboarding -> checkAgentOnboarding', feld: 'agentOnboarding', filter: 'projektion' },
  { katalog: 'onboarding', transport: 'stdio', ort: 'server.ts withOnboarding -> listAgents', feld: 'activeAgents', filter: 'projektion' },
  { katalog: 'onboarding', transport: 'rest', ort: 'mcp.ts attachRestOnboarding -> holeAgentOnboarding', feld: 'agentOnboarding', filter: 'projektion' },
  { katalog: 'onboarding', transport: 'rest', ort: 'mcp.ts attachRestOnboarding (ohne agent_id)', feld: 'hinweis_agent_id', filter: 'projektion' },
  { katalog: 'plan_hinweise', transport: 'beide', ort: 'holeAgentOnboarding planUebersicht/task_suche_hinweis', feld: 'agentOnboarding.plaene', filter: 'projektion' },
  { katalog: 'jev_modus', transport: 'beide', ort: 'holeAgentOnboarding baueAbwesenheitsHinweis', feld: 'agentOnboarding.jev_hinweis', filter: 'projektion' },
  { katalog: 'reservation_hint', transport: 'rest', ort: 'mcp.ts attachDirectWriteReservationHint -> getDirectWriteReservationHint', feld: 'reservation_hint', filter: 'vor_suche_claim' },
  { katalog: 'shell_ergebnis_hinweis', transport: 'beide', ort: 'shell-Handler ergaenzeShellErgebnisHinweis (claimHinweis shell-ergebnis:*)', feld: 'shell_hinweis', filter: 'vor_suche_claim' },
  { katalog: 'shell_job_hinweis', transport: 'beide', ort: 'shell-Handler drossleShellJobHinweis (claimHinweis job_env)', feld: 'job_env', filter: 'vor_suche_claim' },
  { katalog: 'env_hinweise', transport: 'beide', ort: 'files-Handler env-maske.ts (Schreiben/commit/restore)', feld: 'env_hinweise', filter: 'pflichtanteil' },
  { katalog: 'status_kuerzung', transport: 'beide', ort: 'agent-zuschnitt.ts projiziereToolAntwort', feld: 'antwort_zuschnitt', filter: 'pflicht' },
  { katalog: 'fehler', transport: 'beide', ort: 'Transporthuelle/Fachhandler', feld: 'error', filter: 'pflicht' },
  { katalog: 'sicherheit', transport: 'beide', ort: 'Shell-Sicherung/Identitaet/Profil-Gate', feld: 'stufe', filter: 'pflicht' },
];

/** claimHinweis.art -> Katalog-ID (bestehende Arten behalten ihren Speicher, keine neue Identitaet). */
export function katalogIdFuerClaimArt(art: string): string | undefined {
  if (art.startsWith('shell-ergebnis:')) return 'shell_ergebnis_hinweis';
  if (art === 'job_env') return 'shell_job_hinweis';
  if (art === 'open_plans') return 'open_plans';
  return undefined;
}

/** Event-Arten, die auch bei abgeschalteten pending_events sichtbar bleiben (Stop/Sicherheit/Review). */
export const PFLICHT_EVENT_TYPEN: readonly string[] = ['WORK_STOP', 'TEAM_DISCUSSION', 'CRITICAL_REVIEW'];

/** Pflichtanteil von fehlermuster: sichere Befunde mit severity error und alle Syntaxbefunde. */
export function istPflichtFehlermuster(t: { severity?: string; quelle?: string }): boolean {
  return t.severity === 'error' || t.quelle === 'syntax';
}

const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Inhaltliche Klassifikation: was von einer abgeschalteten optionalen Art sichtbar bleiben MUSS.
 * undefined = kein Pflichtanteil (Feld entfaellt). Nie Mutation des Eingangswerts.
 */
export function pflichtAnteil(schluessel: string, wert: unknown): unknown {
  switch (schluessel) {
    case 'event_warning':
    case 'env_hinweise':
      return wert;
    case 'pending_events': {
      if (!Array.isArray(wert)) return undefined;
      const rest = wert.filter(e => istObjekt(e) && typeof e.event_type === 'string' && PFLICHT_EVENT_TYPEN.includes(e.event_type));
      return rest.length ? rest : undefined;
    }
    case 'fehlermuster': {
      if (!istObjekt(wert) || !Array.isArray(wert.treffer)) return undefined;
      const treffer = wert.treffer.filter(t => istObjekt(t) && istPflichtFehlermuster(t as { severity?: string; quelle?: string }));
      return treffer.length ? { ...wert, anzahl: treffer.length, treffer, nur_pflichtanteil: true } : undefined;
    }
    case 'onboarding': {
      if (!istObjekt(wert) || !Array.isArray(wert.rules)) return undefined;
      const rules = wert.rules.filter(r => istObjekt(r) && r.vollstaendig === true && typeof r.content === 'string');
      if (!rules.length) return undefined;
      return { isFirstVisit: wert.isFirstVisit, project: wert.project, rolle: wert.rolle, rules, nur_pflichtregeln: true,
        nachladen: 'admin(action:"index_stats", project, sitzung:"fortsetzung", onboarding:true) liefert das vollstaendige Onboarding' };
    }
    default:
      return undefined;
  }
}

export type HinweisStufe = 'normal' | 'kompakt' | 'minimal';

/** Standard einer Art fuer eine kontext_stufe (ohne ausdrueckliche Profilangabe). */
export function standardFuerStufe(e: HinweisKatalogEintrag, stufe: HinweisStufe | null | undefined): boolean {
  if (e.klasse === 'pflicht') return true;
  if (!stufe || stufe === 'normal') return e.standard;
  if (stufe === 'minimal') return false;
  return e.standard && e.kompakt !== false;
}
