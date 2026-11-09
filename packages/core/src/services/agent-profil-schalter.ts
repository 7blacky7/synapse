/**
 * P22-T13 Phase V: Schalter fuer W1b (regel-neue-funktionen-mit-schalter-und-debug).
 *
 * (I) PRODUKT-SCHALTER agent_profil_schalter (PG, Schema 113). Standard AUS = keine Zeile.
 *     Steuert die Verwaltungsfunktionen der Pakete A/B/D/T (PROFIL_PRODUKT_FUNKTIONEN).
 *     Setzen: User (authentifizierter User-Eingang) global/projekt, bestaetigter Koordinator (auch Legacy-Koordinator)
 *     fuer sein eigenes Projekt UND global (P22-T57, wie jev_schalten/ausweis_fristen; Audit gesetzt_von). Vorrang: projekt+funktion > projekt+alle > global+funktion >
 *     global+alle > Standard AUS. Lesefehler (z. B. vor Schema 113) -> AUS mit letzter_fehler.
 *     Gelesen wird NUR in Verwaltungspfaden, nie pro gewoehnlichem Tool-Aufruf. Ausnahme nur ueber den Prozess-Puffer
 *     leseProfilProduktSchalterGepuffert (kernTtlMs), z. B. P22-T199 coedit_ohne_gate je files-Aufruf.
 * (II) INTERNE TEST-OVERRIDES w1b_durchsetzung (Token-Selbstfeldpruefung F3, Neutralisierung der
 *     REST-Vorbelegung, Profil-Gate) und w1b_antwortanpassung (Paket C). Produktionsstandard per
 *     Env SYNAPSE_W1B_DURCHSETZUNG / SYNAPSE_W1B_ANTWORTANPASSUNG ('1' = EIN), Default AUS.
 *     Override nur bei SYNAPSE_INTERN_TOOL=1, modus 'freigegeben', befristet (intern-schalter.ts);
 *     Ablauf/Lesefehler/ohne intern -> Produktionsstandard. Ohne intern KEIN PG-Lesen.
 * AUS = t109-Verhalten. Bedeutung 'freigegeben' (aktiv=true heisst Funktion EIN, keine Pause).
 * (III) P22-T287: Ebenen je Agent (identitaet bzw. agent > typ) UEBER projekt/global, nur fuer die Positivliste
 *     ZIEL_FAEHIGE_FUNKTIONEN und nur bei Produkt-Schalter schalter_identitaet EIN (agent-profil-schalter-ziel.ts).
 *     leseProfilProduktSchalter(funktion, project, ziel): S3 - Ziel NUR ausdruecklich (undefined/null = Projektsicht); Lesestellen, die
 *     fuer den Aufrufer entscheiden, uebergeben zielDesAufrufers(project) (Fremd-Empfaenger-Regel).
 */
import { getPool } from '../db/client.js';
import { SCHALTER_ZIEL_FUNKTION, istZielFaehig, merkeSchalterQuelle, leseZielTreffer, leereZielWertPuffer, type SchalterZiel, type SchalterZielEbene, type SchalterZielTreffer } from './agent-profil-schalter-ziel.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { AUSWEIS_FORMAT } from './agent-ausweis-format.js';

export type W1bSchalterArt = 'durchsetzung' | 'antwortanpassung' | 'anmeldung';
export const W1B_INTERN_SCHALTER = {
  durchsetzung: 'w1b_durchsetzung',
  antwortanpassung: 'w1b_antwortanpassung',
  anmeldung: 'w1b_anmeldung',
} as const satisfies Record<W1bSchalterArt, string>;
const W1B_ENV: Record<W1bSchalterArt, string> = {
  durchsetzung: 'SYNAPSE_W1B_DURCHSETZUNG',
  antwortanpassung: 'SYNAPSE_W1B_ANTWORTANPASSUNG',
  anmeldung: 'SYNAPSE_W1B_ANMELDUNG',
};

export interface W1bSchalterStand {
  art: W1bSchalterArt;
  name: string;
  freigegeben: boolean;
  standard: boolean;
  /** P22-T287 S2: 'produkt-schalter' nur bei leseAntwortanpassungSchalter (Produktquelle profil_antwortanpassung). */
  quelle: 'standard' | 'intern' | 'produkt-schalter';
  bis: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache, damit ein abgelaufener/geloeschter Override sofort wegfaellt). */
export async function leseW1bSchalter(art: W1bSchalterArt): Promise<W1bSchalterStand> {
  const standard = process.env[W1B_ENV[art]] === '1';
  const basis: W1bSchalterStand = { art, name: W1B_INTERN_SCHALTER[art], freigegeben: standard, standard,
    quelle: 'standard', bis: null, letzter_fehler: null };
  if (!internToolAktiv()) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: `SELECT aktiv, bis FROM intern_schalter
        WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
      values: [W1B_INTERN_SCHALTER[art]],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    return z ? { ...basis, freigegeben: z.aktiv, quelle: 'intern', bis: z.bis?.toISOString() ?? null } : basis;
  } catch {
    return { ...basis, letzter_fehler: 'schalter_nicht_erreichbar' };
  }
}

/** P22-T287 S2: Produkt-Schalter der Antwortanpassung nach Profil (ziel-faehig). */
export const PROFIL_ANTWORTANPASSUNG_FUNKTION = 'profil_antwortanpassung' as const;

/**
 * P22-T287 S2 (Konzept ebe24645): EINE Lesestelle fuer die Antwortanpassung (P22-T13 Paket C). Reihenfolge: intern-Override
 * w1b_antwortanpassung (befristet, nur SYNAPSE_INTERN_TOOL=1) > Produkt-Schalter profil_antwortanpassung (identitaet > typ > projekt >
 * global; Ziel wird ausdruecklich uebergeben, kein Aufrufkontext) > Env SYNAPSE_W1B_ANTWORTANPASSUNG > AUS. project null -> wie bisher
 * nur Env/intern. Lesefehler des Produkt-Schalters -> Env-Standard, Debug in produkt.letzter_fehler. Gepuffert je Prozess (kernTtlMs).
 */
export async function leseAntwortanpassungSchalter(project: string | null, ziel: SchalterZiel | null):
  Promise<W1bSchalterStand & { produkt?: ProfilProduktSchalterStand }> {
  const basis = await leseW1bSchalter('antwortanpassung');
  if (basis.quelle === 'intern' || !project) return basis;
  const produkt = await leseProduktGepuffert(PROFIL_ANTWORTANPASSUNG_FUNKTION, project, ziel);
  if (produkt.quelle === 'produkt-schalter' && !produkt.letzter_fehler) return { ...basis, freigegeben: produkt.aktiv, quelle: 'produkt-schalter', produkt };
  return { ...basis, produkt };
}

export const PROFIL_PRODUKT_FUNKTIONEN = [
  // P22-T194: nur Telemetrie, Standard AUS und nur ausdrücklich; kein automatischer Neustart.
  'cache_waechter', 'runtime_synapse_mods',
  // P22-T257: User-Sicht der Ausweis-Kennung im Agententeam, Standard AUS.
  'team_ausweis_zeigen',
  // P22-T252: PG-Tombstones an PCs zustellen, Standard AUS.
  'asset_tombstone_zustellung',
  'agentennetzwerk', 'netzwerk_datengrundlage',
  'profilverwaltung', 'typkatalog', 'persona', 'task_bindung', 'agenten_ausweis',
  // P22-T44: Ausweis fuer mehrere Projekte (Visum/Arbeitsfreigabe), Standard AUS; wirkt nach dem Stand der Heimat (agent-ausweis-projekte.ts).
  'mehrprojekt',
  // P21-T3/T13: Bytewerkzeug, Standard AUS, nur ausdruecklich freigeben.
  'hex_lesen', 'hex_adressen', 'hex_formate', 'hex_entschluesseln',
  // P23-T5: Fall-Skills (fall-skills.ts) - kurze Tool-Beschreibungen in tools/list und Fall-Skill-Hinweis bei Fehlbedienung.
  // Standard AUS bis User-Freigabe; wie mehrprojekt NICHT ueber 'alle' schaltbar (nur ausdruecklich).
  'tool_beschreibungen_kurz', 'fall_skill_hinweis',
  // P22-T56: tools/list je Verbindung (tool-liste-verbindung.ts), Standard AUS; nur ausdruecklich schaltbar.
  'tool_liste_je_verbindung',
  // P23-T3: schlanke Tool-Antworten (tool-antworten-schlank.ts), Standard AUS bis User-Freigabe, nur ausdruecklich.
  'tool_antworten_schlank',
  // P23-T7: ungenuegende Fall-Skill-Hinweise als offene Tool-Faelle im Erklaerungs-Topf (fall-skills.ts), Standard AUS, nur ausdruecklich.
  'fall_skill_faelle',
  // P23-T3 Punkt 6: fremde Shell-Ergebnisse anbieten (shell-hints.ts), Standard AUS, nur ausdruecklich.
  'shell_fremde_ergebnisse',
  // P22-T7: Verbrauchszaehlung der Abo-CLIs je Agent (agent-verbrauch.ts), Standard AUS, nur ausdruecklich.
  'verbrauch',
  // P22-T58: Ueberwachung/Neustart der Runtime-Container durch die API (runtime-ueberwachung.ts), Standard AUS, nur ausdruecklich.
  'runtime_ueberwachung',
  // P22-T190: CLI-Tool-Ausgabelimits + enger Read-Guard, je Projekt/global, Std AUS.
  'runtime_tool_ausgabe', 'user_inbox', 'zeilen_anmerkungen',
  // P22-T62: Modellwahl des Hauptagenten aus den CLI-Listen (hauptagent-modelle.ts), Standard AUS, nur ausdruecklich.
  'hauptagent_cli_modelle',
  // P22-T63: Gespraechsverlauf des Hauptagenten-Chats serverseitig (hauptagent-verlauf.ts), STANDARD EIN (STANDARD_EIN), nur ausdruecklich.
  'hauptagent_verlauf',
  // P22-T64: stabile Bewertung des Runtime-Status (ein haengender Probe-Lauf wirft den guten Stand nicht um), Standard AUS, nur ausdruecklich.
  'runtime_status_stabil',
  // P22-T63 Stufe 2 B: eigene Token-Zaehlung aus dem Verlauf (verlauf-tokens.ts), Standard AUS, nur ausdruecklich.
  'verlauf_token_zaehlung',
  // P22-T63 Stufe 2 A: alle Richtungen des Main im Verlauf (Zustellungen, eigene Ausgaben), Standard AUS, nur ausdruecklich.
  'verlauf_alle_richtungen',
  // P22-T63 Stufe 2 C/D: Korridor des Main ueber die API und Uebergabe aus dem Verlauf beim Wechsel, Standard AUS, nur ausdruecklich.
  'main_korridor', 'verlauf_uebergabe',
  // P22-T73: Warteschlange des Main-Chats (hauptagent-warteschlange.ts), Standard AUS, nur ausdruecklich; wirkt nur mit hauptagent_verlauf.
  'main_warteschlange',
  // P22-T80: alte Agenten (> Schwelle Tage inaktiv) weich als entfernt markieren und aus Listen ausblenden (agent-entfernung.ts), Standard AUS, nur ausdruecklich.
  'agenten_entfernung',
  // P22-T78/T79: Startkontext aus dem Verlauf bei jedem neuen Lauf zwingend einspielen (agent-verlauf.ts, alle Identitaeten) und
  // Lesezugriff des Main auf alle User-Projekte (hauptagent-sonderstellung.ts), STANDARD EIN (STANDARD_EIN), nur ausdruecklich.
  'startkontext', 'main_lesezugriff',
  // P22-T81: Verlauf JEDER aktiven Identitaet (Koordinatoren, Spezialisten PC/Container) in hauptagent_verlauf, STANDARD EIN, nur ausdruecklich.
  'agent_verlauf_alle',
  // P22-T82: Spezialisten im Runtime-Container (specialist spawn ort:'container'), je Projekt, Standard AUS, nur ausdruecklich.
  'spezialisten_container',
  // P22-T86: chat(get) mit Ausweis nur Nachrichten an die eigene Identitaet/den eigenen Namen (chat-ausweis-lesen.ts), STANDARD EIN, nur ausdruecklich.
  'chat_get_eigene',
  // P22-T87 S1: Anmelde-Uebersicht je Agent (admin anmeldungen, agent-anmeldungen.ts), Standard AUS bis Abnahme, nur ausdruecklich.
  'agent_anmeldungen',
  // P22-T98: intern db_lesen/db_schema (intern-db-lesen.ts), Produktionsdaten nur lesend, Standard AUS, nur ausdruecklich.
  'db_lesen',
  // P18-T69/E5: Reverse S2/S3 per Ghidra (reverse-pipeline.ts, reverse-s3-uebernahme.ts), nur auf Anforderung, Standard AUS, nur ausdruecklich.
  'reverse_s3',
  // P18-T76: PE resources through E; global library, standard AUS, explicit opt-in.
  'reverse_pe_ressourcen',
  'reverse_verknuepfungen', 'reverse_erkenntnisse',
  'reverse_siedler3',
  // P18-T97: globaler Zulassungsstopp, Standard AUS; EIN lässt Altaufträge drainen.
  'reverse_pipeline_halt',
  // P18-T85: Live-Fortschritt laufender Reverse-Container-Auftraege (reverse-fortschritt.ts), global, Standard AUS bis Abnahme, nur ausdruecklich.
  'reverse_fortschritt_live',
  // P18-T86/T88: fortsetzbare Blockübernahme; explizit global, Standard AUS.
  'reverse_blockuebernahme',
  // P18-T94: globale Asset-Registrierung, Standard AUS, nur ausdrücklich.
  'reverse_asset_registrierung',
  // P18-T95: eigener Reverse-Adapter, global und Standard AUS.
  'reverse_parser_adapter',
  // P18-T40: externe Leser, global, Standard AUS; keine implizite Sammelfreigabe.
  'reverse_leser',
  'reverse_leser_nachzug',
  'reverse_leser_hinweise',
  'reverse_leser_runtime_verwaltung',
  // P18-T86: automatischer Reverse-Entstoerer (bisher Env SYNAPSE_REVERSE_ENTSTOERER, STANDARD EIN wie bisher) und WAV-Pregap
  // beim Audio-CD-Entpacken (bisher Env SYNAPSE_REVERSE_WAV_PREGAP, Standard AUS); beide global, nur ausdruecklich.
  'reverse_entstoerer_auto', 'reverse_wav_pregap',
  // P18-T109: Reverse global ohne Bindung sichtbar, code_intel/asset_intel mit project=rev-…, zentrales Reverse-Fehlerlog;
  // alle global, Standard AUS, nur ausdruecklich.
  'reverse_global_sichtbar', 'reverse_intel_abruf', 'reverse_fehlerlog',
  // P22-T105: Ausweis-Channels still beitreten (auch im laufenden Lauf) und nicht verlassbar (ausweis-channels.ts), je Projekt,
  // Standard AUS bis Abnahme, nur ausdruecklich.
  'ausweis_channels',
  // P22-T109: Container-Kontingent duerfen auch Koordinator (eigenes Projekt) und Main setzen, wenn der User es entschieden hat
  // (Pflicht user_auftrag mit User-Zitat; agent-container.ts), je Projekt/global, Standard AUS, nur ausdruecklich.
  'kontingent_delegiert',
  // P22-T112: Chat mit Plattform-Agenten, im Zielprojekt, Standard AUS und nur ausdruecklich freigeben.
  'plattform_agent_chat',
  // P22-T189: unabhaengige Koordinator-Dockfenster, Standard AUS, nur ausdruecklich.
  'koordinator_mehrfenster',
  // P22-T191: Artefakt-Dateien und MCP-Ueberlauf, Standard AUS, nur ausdruecklich.
  'artefakt_dateien', 'tool_antwort_ueberlauf',
  // P22-T227: benannte Shell-Log-Stroeme, projektbezogen, Standard AUS.
  'log_strom',
  // P22-T79 (Befund d93b8a2e): Main verwaltet Agenten/Koordinatoren in allen User-Projekten (Positivliste in
  // hauptagent-sonderstellung.ts, keine Projektarbeit), global, Standard AUS bis Abnahme, nur ausdruecklich.
  'main_agentenverwaltung',
  // P22-T107: Heartbeat der Koordinatoren ueber die API (koordinator-heartbeat.ts), je Projekt/global, Standard AUS, nur ausdruecklich.
  'koordinator_heartbeat',
  // P22-T113: Startort jedes Agenten in PG (agent-start-ort.ts), je Projekt/global, Standard AUS, nur ausdruecklich.
  'agent_start_ort',
  // P22-T116: Uebersicht aller Runtime-Agenten + Namenssuche in Identitaets-Wrapper-Status (runtime-agenten-uebersicht.ts), Standard AUS, nur ausdruecklich.
  'runtime_agenten_uebersicht',
  // P22-T116 Stufe 2: Runtime-Agenten steuern (stop/start/restart/wake) und Prozesse signalisieren (runtime-agenten-steuerung.ts), Standard AUS, nur ausdruecklich.
  'runtime_agenten_steuerung',
  // P22-T117: Modell-/CLI-Wechsel fuer Plattform-Agenten + Modell im Ausweis (plattform-agent-modellwechsel.ts), Standard AUS, nur ausdruecklich.
  'plattform_agent_modellwechsel',
  // P22-T114: Wake-Frist des Main-Turns an die Turn-Frist koppeln statt fester 30 s im Daemon (hauptagent-lauf.ts), Standard AUS, nur ausdruecklich.
  'main_turn_wake_frist',
  // P22-T119: angefordertes Zielmodell (spawn, runtime_modellwechsel) gewinnt gegen das Aufrufer-Modell (agent-token-tools.ts), Standard AUS.
  'ausweis_zielmodell',
  // P22-T119: modell_bestaetigt nach fachlich bestaetigtem Container-Start an den Lauf binden (plattform-agent-modellwechsel.ts), Standard AUS.
  'modell_lauf_bindung',
  // P22-T326: Modellwechsel ohne Startrezept (Rezept aus der Identitaet), externen Lauf nur mit Bestaetigung abloesen, Rueckfall auf das
  // bisherige Rezept (plattform-agent-modellwechsel.ts); je Projekt/global, Standard AUS, nur ausdruecklich. AUS = Bestand.
  'modellwechsel_rezept_erzeugen',
  // P22-T119: echter Absender statt 'rest-api' im REST-MCP-wake-Altweg (routes/mcp.ts, routes/specialists.ts), Standard AUS.
  'wake_echter_absender',
  // P22-T120: Antwort geweckter Agenten identitaetsadressiert an den Wecker, projektuebergreifend lesbar (wake-rueckadresse.ts, inbox.ts), Standard AUS.
  'wake_antwort_identitaet',
  // P22-T122: neue Darstellung des Runtime-Agenten-Panels (helles Design, Modellauswahl, Ort beim Agententeam; web-ui), Standard AUS.
  'runtime_agenten_panel_neu',
  // P22-T123: Tool-Karten im Chat aus tool_calls je Identitaet (verlauf-tool-karten.ts), Standard AUS, nur ausdruecklich.
  'verlauf_tool_karten',
  // P22-T125: Wrapper-Anzeigestatus aus belegter Ende-Ursache, beendet_* an Laufgeneration gebunden, 'du selbst' in der
  // Runtime-Uebersicht (runtime-agenten-uebersicht.ts). DB-Status bleibt unveraendert. Standard AUS, nur ausdruecklich.
  'wrapper_status_ursache',
  // P22-T124: einheitliches Chatfenster wie der Main-Chat fuer Plattform-Agenten (web-ui EinheitlicherAgentChat), je Projekt der
  // Zielidentitaet, Standard AUS, nur ausdruecklich.
  'agent_chat_einheitlich',
  // P22-T131: Ausweis-Parameter als agent_kennung bewerben (token bleibt angenommener Alias; agent-token-tools.ts), Standard AUS, nur ausdruecklich.
  'agent_kennung_werbung',
  // P22-T134: Mod-Inbox - interaktive Claude-Code-Sitzungen ohne Wrapper ueber eine Mod am lokalen Daemon wecken (mod-inbox.ts),
  // je Projekt/global, Standard AUS, nur ausdruecklich.
  'mod_inbox',
  // P22-T212: Vorpruefung der Mod-Inbox - die Mod reicht erst bei freier Sitzung ein und verwirft vorher quittierte Nachrichten
  // (mod-inbox.ts pruefeModInboxErledigt), je Projekt/global, Standard AUS, nur ausdruecklich.
  'mod_inbox_vorpruefung',
  // P22-T139: Task-Bindung beim Setzen auf done automatisch loesen (agent-profil-vertrag.ts loeseBindungBeiErledigt, Audit 'Task erledigt'),
  // je Projekt/global, Standard AUS, nur ausdruecklich.
  'task_bindung_loesen_bei_done',
  // P22-T141: Artefakt-Bewertung (Design-Gedaechtnis, artefakt-bewertung.ts) und Meldung jeder Bewertung an den Urheber per Inbox;
  // beide global, Standard AUS, nur ausdruecklich.
  'artefakt_bewertung', 'artefakt_bewertung_melden',
  // P22-T144: Quittung zugestellter Nachrichten durch den Agenten (Quittungs-ID, chat quittieren, Erinnerung nach Neuanmeldung;
  // inbox-quittung.ts), je Projekt/global, Standard AUS, nur ausdruecklich.
  'inbox_quittung',
  // P22-T154: Artefakte als Datenvorlagen (artefakt-vorlagen.ts): Vorlage + Quellen, Live-Neuzeichnen, artefakt(zeigen) per Ausweis
  // ohne Hauptagenten-Session; alle global, Standard AUS, nur ausdruecklich.
  'artefakt_vorlagen', 'artefakt_vorlagen_live', 'artefakt_ausweis_zeigen',
  // P22-T165: Verweise im Artefakt anklickbar (data-synapse-verweis -> Lesefenster der Web-UI) und Radio-/details-Zustand ueber
  // Live-Updates; global, Standard AUS, nur ausdruecklich.
  'artefakt_verweise',
  // P22-T166: Artefakte mit Skript NUR in den Top-Artefakten (iframe sandbox=allow-scripts + nur lesende Daten-Bruecke,
  // artefakt-skript-bruecke.ts); global, Standard AUS, nur ausdruecklich.
  'artefakt_skripte',
  // P22-T157: Sitzungsverlaeufe je Ausweis zerlegen/einbetten (niedrigste Prioritaet) und search(action:'verlauf') (verlauf-einbetten.ts);
  // beide global, Standard AUS, nur ausdruecklich.
  'verlauf_einbetten', 'verlauf_suche',
  // P22-T168: Zitat-Anhaenge im Chat der Web-UI (chat-zitate.ts): Verweise/Ausschnitte mit Anmerkung nur an den Empfaenger der
  // Nachricht; je Projekt des Empfaengers (Main: global), Standard AUS, nur ausdruecklich.
  'chat_zitate',
  // P22-T172: aktuelle Task je Agent neben dem Namen in der Web-UI (agent-aktuelle-task.ts), je Projekt/global, Standard AUS, nur ausdruecklich.
  'agent_aktuelle_task',
  // P22-T178: Lauf-Herkunft je Agent neben dem Namen (api/cli/codex + Modell, agent-lauf-herkunft.ts), je Projekt/global, Standard AUS,
  // nur ausdruecklich.
  'agent_lauf_herkunft',
  // P22-T173: Agenten-Identitaet umbenennen (admin identitaet_umbenennen, agent-umbenennung.ts; alter Name wird Alias), je Projekt/global,
  // Standard AUS, nur ausdruecklich.
  'agent_umbenennung',
  // P22-T179: kostenpflichtige API-Agenten ausser dem Main (Arbeitsagent, Koordinator) mit Freigabe je Identitaet
  // (api-agent-freigabe.ts), je Projekt/global, Standard AUS, nur ausdruecklich.
  'api_agenten',
  // P3-T16: wiederkehrende Plaene (plan-wiederkehr.ts, standard-plaene.ts): automatische Rueckstellung nach einem Durchlauf,
  // plan(durchlauf_abschliessen), plan(standard_plaene); je Projekt/global, Standard AUS, nur ausdruecklich.
  'wiederkehr_plaene',
  // P10-T88 N2: Aehnlichkeitspruefung beim Speichern (speicher-aehnlichkeit.ts): aehnlich-Liste bzw. Modus pruefen_vor_anlegen fuer
  // User-Ideen; je Projekt/global, Standard AUS, nur ausdruecklich.
  'speicher_aehnlichkeit', 'speicher_aehnlichkeit_pruefen',
  // P10-T88 N1: Pins (Thoughts/Dateiversionen frueherer Agenten) in plan(get, task_id) und gebundenen Tasks bei chat(anmelden)
  // (task-pins.ts); je Projekt/global, Standard AUS, nur ausdruecklich.
  'task_pins',
  // P22-T183: API-Agenten laufen direkt IM synapse-api-Prozess (Lauf-Verwaltung api-agent-lauf-dienst.ts, rest-api api-agent-lauf.ts);
  // je Projekt/global, Standard AUS, nur ausdruecklich.
  'api_agenten_lauf_intern',
  // P22-T202: ausdrueckliche Laufwahl CLI/API in der Web-UI, Standard AUS.
  'api_agenten_auswahl',
  // P22-T278: DeepSeek-API direkt als eigener Anbieter (api-deepseek.ts); je Projekt/global, Standard AUS, nur ausdruecklich.
  'api_deepseek_direkt',
  // P22-T286: API-Laufzeiten schreiben ihren Turn zusaetzlich in hauptagent_verlauf (api-agent-lauf.ts, agent-verlauf.ts);
  // je Projekt/global, Standard AUS bis Abnahme, nur ausdruecklich. AUS = Bestand.
  'api_verlauf_hauptverlauf',
  // P22-T287 Paket 0: Werkzeugergebnisse im API-Lauf je Aufruf auf einen Anteil des Modellfensters kuerzen (api-tool-ausgabe.ts,
  // Regel codexToolAusgabe, Werte runtime_tool_ausgabe je Identitaet); je Projekt/global/Ziel, Standard AUS, nur ausdruecklich. AUS = ungekuerzt.
  'api_tool_ausgabe',
  // P22-T310: Seitengroesse fuer MCP-Antworten ALLER Agenten aus dem Modellfenster (api-tool-ausgabe.ts
  // leseToolAusgabeSeitenGrenze/begrenzeAntwortFuerAgent, mcp.ts fuehreToolsCallAus); je Projekt/global, ziel-faehig,
  // Standard AUS, nur ausdruecklich. AUS = Bestand (unveraendert).
  'tool_ausgabe_seiten',
  // P22-T311: Mechanik 'Standard EIN in aktiven Projekten' (leseProfilProduktSchalter standardAktivesProjekt, Katalog
  // schalterKatalog) und Notfall-Recht ohne Ausweis auf Ebene projekt/global; je Projekt/global, Standard AUS bis Abnahme, nur ausdruecklich.
  'schalter_standard_aktive_projekte',
  // P22-T199: Co-Edit ohne Ready-Gate (coedit-methode.ts; EIN = neue Methode, AUS = Ready-Gate wie bisher); je Projekt/global,
  // Standard AUS, nur ausdruecklich. Gelesen je files-Aufruf ueber leseProfilProduktSchalterGepuffert.
  'coedit_ohne_gate',
  // P22-T217: Anker-Umrechnung veralteter replace_lines/delete_lines im Plan (anker-umrechnung.ts); je Projekt/global,
  // Standard AUS, nur ausdruecklich. Gelesen je files-plan mit Kandidaten-Op ueber leseProfilProduktSchalterGepuffert.
  'anker_umrechnung',
  // P22-T222: Web-UI zeigt die neue Huelle SynapseWorkspace aus den P26-Modulen statt SynapseWorkspaceMock (web-ui App.tsx);
  // je Projekt/global, Standard AUS, nur ausdruecklich. AUS/Lesefehler = alte Oberflaeche.
  'web_ui_neue_oberflaeche',
  // P22-T230: Web-UI-Seitenleiste 'Aktives Projekt': Unterzeile = letzte 3 aktiv bearbeitete Tasks, Klick oeffnet die bestehende
  // Projektsuche (ProjectSelector) als Feld an der Karte; je Projekt/global, Standard AUS, nur ausdruecklich. AUS = bisherige Karte.
  'seitenleiste_projekt_tasks',
  // P22-T253: neu geordneter Arbeitsbereich, Standard AUS.
  'web_ui_arbeitsbereich',
  // P22-T254: Channel-Suche und gemeinsames Channel-Fenster, Standard AUS.
  'web_ui_channel_suche',
  // P22-T270: Agententeam als Suche (erster Eintrag „Ausweis erstellen“) + Ausweis-Fenster mit Bearbeiten und Channel-Zuweisung
  // (web-ui AgentenTeamSuche/AusweisFenster); je Projekt/global, Standard AUS, nur ausdruecklich. AUS = bisherige Agententeam-Seite.
  'web_ui_agententeam_suche',
  // P22-T280: Hauptagent- und Koordinatorfenster ueber dem HUD (gemeinsamer Fensterstapel + Portal, web-ui agentfenster-stapel.ts);
  // je Projekt/global, Standard AUS, nur ausdruecklich. AUS = Fenster bleiben im Hauptbereich wie bisher.
  'web_ui_agentfenster',
  // P22-T289: Klick auf einen Agenten im Channel (Mitglied, Absender) bzw. in der Agententeam-Suche oeffnet das gemeinsame
  // Agentenfenster (web-ui AgentFenster.tsx, Stapel agentfenster-stapel.ts); je Projekt/global, Standard AUS, nur ausdruecklich.
  // AUS = bisherige Wege (Channel: ChannelAgentFensterWeiche, Agententeam: Ausweis-Fenster).
  'web_ui_agentfenster_alle',
  // P22-T255: Channel-Knoten und Ergebnisdetails im Agentennetzwerk.
  'web_ui_netzwerk_details',
  // P22-T164: projektübergreifende Live-Artefaktübersicht, Standard AUS.
  'web_ui_live_artefakte',
  // P22-T256: Editor mit Freeze und geprüftem User-Plan, Standard AUS.
  'editor_modul',
  // P22-T263: Editor-Live-Plan als durchgehender Strom aus PG (editor-plan-strom.ts; wirkt nur mit editor_modul); je Projekt/global,
  // Standard AUS, nur ausdruecklich. AUS = Live-Plaene je Datei mit Nachleuchten wie P22-T262.
  'editor_plan_strom',
  // P22-T266: Syntax-Hervorhebung im Editor (CodeMirror 6, lazy; web-ui components/editor/syntax.ts); je Projekt/global, Standard AUS,
  // nur ausdruecklich. AUS = Textfeld und Klartext wie P22-T262.
  'editor_syntax',
  // P22-T263 Leinwand (User 01.11.2026, thought ad8d1f41): Explorer im Editor einklappbar; eingeklappt zeigt die Mitte die Plaene des
  // Plan-Stroms mit ihren Aenderungen vollstaendig (editor-plan-strom.ts leseEditorPlanAenderungen, web-ui editor/PlanLeinwand.tsx);
  // wirkt nur mit editor_modul UND editor_plan_strom; je Projekt/global, Standard AUS, nur ausdruecklich. AUS = Editor wie bisher.
  'editor_plan_leinwand',
  // P22-T229: Agentennetzwerk - Visum-Agenten bringen ihre Heimat-Projektsonne mit, Impulse laufen zur Sonne des Zielprojekts, fremde Sonne
  // blendet nach Zugangsende aus (web-ui netzwerk/sonnen.ts, core agentennetzwerk.ts visum_sonnen); je Projekt/global, Standard AUS, nur ausdruecklich.
  'netzwerk_visum_sonnen',
  // P22-T226: Projektdateien als Artefaktquelle; projekt/global, Standard AUS.
  'datei_vertrag',
  // P22-T196: Web-UI-Uebersicht als globales Agentennetzwerk (kompakte Leiste + alle Projekte mit Aktivitaet als Sonnen);
  // global/projekt, Standard AUS, nur ausdruecklich. AUS/Lesefehler = bisherige Uebersicht (OverviewView.tsx).
  'uebersicht_netzwerk',
  // P27-T9: Live-Dateiereignisse vor Erstscan, global, Standard EIN.
  'index_live_vorrang',
  // P27-T2/T3: Stau-Waechter der Warteschlangen + Hinweis warteschlangen_stau in Tool-Antworten (warteschlangen-waechter.ts),
  // global, Standard AUS, nur ausdruecklich.
  'warteschlangen_stau',
  // P27-T11: Altbestand in Warteschlangen ausblenden statt loeschen (warteschlangen-altbestand.ts, admin warteschlangen_aufraeumen);
  // global, Standard AUS, nur ausdruecklich. AUS = ausfuehren abgewiesen, Verlaufslisten unveraendert.
  'warteschlangen_altbestand',
  // P22-T238: Projekt-Assets ohne Inspector generisch auf den Share uebertragen (asset-transfer-generisch.ts);
  // je Projekt/global, Standard AUS, nur ausdruecklich. AUS/Lesefehler = nur Formate mit Inspector.
  'asset_transfer_generisch',
  // P22-T271: asset_index_wirklichkeit (P22-T236) entfernt - 'Index = Wirklichkeit' gilt immer; alte PG-Zeilen werden ignoriert.
  // P22-T237: Zustellung Share -> Projektordner sichtbar (asset-pc-zustellung.ts: Daemon-Stand, Asset-Sync AUS, Status-Route,
  // User-Upload in den Share); je Projekt/global, Standard AUS, nur ausdruecklich. AUS/Lesefehler = Altverhalten.
  'asset_pc_zustellung',
  // P22-T206: verwaiste staged-Publikationssperre nur mit Besitzernachweis automatisch loesen (asset-sperren-recovery.ts);
  // je Projekt/global, Standard AUS, nur ausdruecklich. AUS = nur pruefen/anzeigen.
  'asset_publish_recovery',
  // P22-T241: Reverse-Altbestand im Projekt-.intern aufraeumen (asset-intern-inventar.ts; Inventar immer lesbar); je Projekt/global,
  // Standard AUS, nur ausdruecklich. AUS = nur Vorschau.
  'asset_intern_aufraeumen',
  // P22-T243 (+P22-T208): volle Shell-Ausgabe in Teilen (auch ueber 1 MB, auch laufend) und gedeckelte Abrufe mit Hinweis
  // (shell-ausgabe.ts); je Projekt/global, Standard AUS, nur ausdruecklich. AUS = Altverhalten (output 1 MB).
  'shell_ausgabe_voll',
  // P22-T277: Koordinatoren verwalten jedes Projekt ausser synapse (Projektschalter, build_einstellungen, Ausweise; Positivliste in
  // koordinator-projektverwaltung.ts); global, Standard AUS, nur ausdruecklich. AUS = Bestand.
  'koordinator_projektverwaltung',
  // P10-T90: Zwangs-Pin - Pflicht-Memory an einen Stamm; schreibende files-Ops darunter fuer ueberwachte Claude-CLI-Kontexte gesperrt bis
  // memory read im Lauf + Kontext (zwangs-pin.ts, admin zwangs_pins); je Projekt/global, Standard AUS, nur ausdruecklich.
  'zwangs_pin',
  // P22-T287: Produkt-Schalter je Agent (Ebenen identitaet/agent/typ ueber projekt/global, agent-profil-schalter-ziel.ts); je Projekt/global,
  // Standard AUS, nur ausdruecklich. AUS = Zielregeln werden ignoriert, Setzen auf Zielebenen antwortet funktion_aus.
  'schalter_identitaet',
  // P22-T287 (User-Korrektur 27f9c071): Agenten nach alter Methode OHNE Ausweis setzen Regeln der Ebene agent (Name/Muster; nur Projekt
  // der Anfrage, Grund Pflicht, Audit herkunft ohne_ausweis; agent-profil-schalter-ziel.ts); je Projekt/global, Standard AUS, nur ausdruecklich.
  'schalter_setzen_ohne_ausweis',
  // P22-T287 S2: Produktquelle fuer w1b_antwortanpassung (leseAntwortanpassungSchalter; Hinweise/Kontextstufe aus dem Agentenprofil,
  // P22-T13 Paket C); ziel-faehig (identitaet > typ > projekt > global), Standard AUS, nur ausdruecklich. intern-Override behaelt Vorrang.
  'profil_antwortanpassung',
  // P22-T287 S2: kontextprofil_* mit ziel identity:<id> schreiben ins Agentenprofil (kontextprofil-bruecke.ts, profil_aendern-Weg) statt
  // coming_soon; je Projekt/global, Standard AUS, nur ausdruecklich. AUS = Altverhalten.
  'kontextprofil_bruecke',
] as const;
/** Funktionen, die 'alle' bewusst NICHT einschliesst (nur ausdruecklich schaltbar). */
export const NUR_AUSDRUECKLICH: readonly string[] = ['modellwechsel_rezept_erzeugen', 'schalter_identitaet', 'api_tool_ausgabe', 'tool_ausgabe_seiten', 'schalter_standard_aktive_projekte', 'schalter_setzen_ohne_ausweis', 'profil_antwortanpassung', 'kontextprofil_bruecke', 'web_ui_agentfenster', 'web_ui_agentfenster_alle', 'zwangs_pin', 'koordinator_projektverwaltung', 'web_ui_agententeam_suche', 'editor_modul', 'editor_plan_strom', 'editor_plan_leinwand', 'editor_syntax', 'web_ui_live_artefakte', 'asset_tombstone_zustellung', 'web_ui_netzwerk_details', 'web_ui_channel_suche', 'web_ui_arbeitsbereich', 'team_ausweis_zeigen', 'shell_ausgabe_voll', 'warteschlangen_stau', 'warteschlangen_altbestand', 'asset_intern_aufraeumen', 'asset_publish_recovery', 'asset_pc_zustellung', 'asset_transfer_generisch', 'index_live_vorrang', 'log_strom', 'uebersicht_netzwerk', 'netzwerk_visum_sonnen', 'api_agenten_auswahl', 'api_deepseek_direkt', 'coedit_ohne_gate', 'anker_umrechnung', 'web_ui_neue_oberflaeche', 'seitenleiste_projekt_tasks', 'cache_waechter', 'runtime_synapse_mods', 'artefakt_dateien', 'tool_antwort_ueberlauf', 'runtime_tool_ausgabe', 'user_inbox', 'zeilen_anmerkungen', 'koordinator_mehrfenster', 'reverse_pipeline_halt', 'agentennetzwerk', 'netzwerk_datengrundlage', 'db_lesen', 'hex_adressen', 'hex_entschluesseln', 'hex_formate', 'hex_lesen', 'mehrprojekt', 'tool_beschreibungen_kurz', 'fall_skill_hinweis', 'tool_liste_je_verbindung', 'tool_antworten_schlank', 'fall_skill_faelle', 'shell_fremde_ergebnisse', 'verbrauch', 'runtime_ueberwachung', 'hauptagent_cli_modelle', 'hauptagent_verlauf', 'runtime_status_stabil', 'verlauf_token_zaehlung', 'verlauf_alle_richtungen', 'main_korridor', 'verlauf_uebergabe', 'main_warteschlange', 'agenten_entfernung', 'startkontext', 'main_lesezugriff', 'agent_verlauf_alle', 'spezialisten_container', 'chat_get_eigene', 'agent_anmeldungen', 'reverse_s3', 'reverse_siedler3', 'reverse_pe_ressourcen', 'reverse_verknuepfungen', 'reverse_erkenntnisse', 'reverse_fortschritt_live', 'reverse_blockuebernahme', 'reverse_asset_registrierung', 'reverse_parser_adapter', 'reverse_leser', 'reverse_leser_nachzug', 'reverse_leser_hinweise', 'reverse_leser_runtime_verwaltung', 'reverse_entstoerer_auto', 'reverse_wav_pregap', 'reverse_global_sichtbar', 'reverse_intel_abruf', 'reverse_fehlerlog', 'ausweis_channels', 'kontingent_delegiert', 'plattform_agent_chat', 'main_agentenverwaltung', 'koordinator_heartbeat', 'agent_start_ort', 'runtime_agenten_uebersicht', 'runtime_agenten_steuerung', 'plattform_agent_modellwechsel', 'main_turn_wake_frist', 'ausweis_zielmodell', 'modell_lauf_bindung', 'wake_echter_absender', 'wake_antwort_identitaet', 'runtime_agenten_panel_neu', 'verlauf_tool_karten', 'agent_kennung_werbung', 'wrapper_status_ursache', 'agent_chat_einheitlich', 'mod_inbox', 'mod_inbox_vorpruefung', 'task_bindung_loesen_bei_done', 'artefakt_bewertung', 'artefakt_bewertung_melden', 'inbox_quittung', 'datei_vertrag', 'artefakt_vorlagen', 'artefakt_vorlagen_live', 'artefakt_ausweis_zeigen', 'artefakt_verweise', 'artefakt_skripte', 'verlauf_einbetten', 'verlauf_suche', 'chat_zitate', 'agent_aktuelle_task', 'agent_lauf_herkunft', 'agent_umbenennung', 'api_agenten', 'wiederkehr_plaene', 'speicher_aehnlichkeit', 'speicher_aehnlichkeit_pruefen', 'task_pins', 'api_agenten_lauf_intern', 'api_verlauf_hauptverlauf'];
/**
 * P22-T63: Funktionen mit Standard EIN (keine Zeile = EIN, Lesefehler = EIN mit letzter_fehler). Bisher nur hauptagent_verlauf:
 * reine Speicherung/Anzeige des eigenen Chats; AUS stellt das Altverhalten (Verlauf nur im Browser-Tab) her.
 */
// P22-T78/T79: startkontext (Zustellung des eigenen Verlaufs je neuem Lauf) und main_lesezugriff (nur lesen, User-Grundsatz) ebenso.
// P22-T81: agent_verlauf_alle (reine Speicherung des eigenen Verlaufs jeder Identitaet) ebenso.
// P22-T86: chat_get_eigene (Fehlerkorrektur, schraenkt die Sicht von chat get mit Ausweis ein) ebenso.
export const STANDARD_EIN: readonly string[] = ['index_live_vorrang', 'hauptagent_verlauf', 'startkontext', 'main_lesezugriff', 'agent_verlauf_alle', 'chat_get_eigene', 'reverse_entstoerer_auto'];
/**
 * W12 V7: 'schattenprofile' und 'token_abruf' sind im Produkt-Schalter 'agenten_ausweis' aufgegangen. Die alten Namen
 * bleiben nur LESBAR/setzbar (Altschalter-Rueckfall des Ausweis-Kerns, bestehende Zeilen), sind aber nicht mehr im Katalog.
 */
export const ALT_AUSWEIS_FUNKTIONEN = ['schattenprofile', 'token_abruf'] as const;
export type ProfilProduktFunktion = typeof PROFIL_PRODUKT_FUNKTIONEN[number] | typeof ALT_AUSWEIS_FUNKTIONEN[number];

// ---------------------------------------------------------------------------------------------
// W12 S1 (Vertrag P22-T23, V7): Ausweis-Kern. Die SIGNATUR ist verbindlich und der einzige Lesepunkt fuer
// Ausweis-Pfade. P22-T28: EIN Produkt-Schalter 'agenten_ausweis' ersetzt token_identitaet + w1b_anmeldung +
// schattenprofile + token_abruf. Reihenfolge der Quellen:
//   Vorrang intern-Override 'agenten_ausweis' (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter
//   'agenten_ausweis' (projekt > global; PG = Quelle fuer alle Prozesse) > Altschalter > AUS.
//   Immer: agent_bezug_modus muss 'beide' sein, sonst wirksam AUS (letzter_fehler agent_bezug_modus_nicht_beide).
//   Dazwischen: Env SYNAPSE_AGENTEN_AUSWEIS=1 (Produktionsstandard, quelle 'standard') und die Altschalter
//   (Env/intern token_identitaet + w1b_anmeldung + Produkt-Schalter schattenprofile) als Rueckfall. Einschalten des Produkt-
//   Schalters ist nur bei agent_bezug_modus 'beide' moeglich (Fehler agent_bezug_modus_nicht_beide).
// PG = Quelle: der Stand wird je Prozess kurz gepuffert (Env SYNAPSE_W1B_GATE_TTL_MS, Standard 5000, 0 = aus). Das Schreiben
//   eines Produkt-Schalters leert den Puffer im SCHREIBENDEN Prozess sofort, andere Prozesse sehen es nach ihrer TTL.
// Befund B4: profilverwaltung AUS sperrt nur die VERWALTUNG (profil_aendern, Typen, Rollback ...). Ein bereits gesetzter
//   Zuschnitt (Werkzeugsperren im Profil) bleibt wirksam, solange w1b_durchsetzung EIN ist; er wird nicht zurueckgenommen.
//   Zum Zuruecknehmen vorher per profil_aendern/profil_rollback aendern oder w1b_durchsetzung AUS schalten.
// Alle Ausweis-Lesestellen (Identitaet, Tool-Gate, tools/list, Daemon-Start, Hinweis-Registry, Schatten-Dienste) lesen nur hier.
// ---------------------------------------------------------------------------------------------
export const AUSWEIS_KERN_FUNKTION = 'agenten_ausweis' as const;
export type AusweisKernQuelle = 'standard' | 'intern' | 'produkt-schalter' | 'altschalter';
export interface AusweisKernStand {
  aktiv: boolean;
  project: string | null;
  quelle: AusweisKernQuelle;
  agent_bezug_modus: 'alt' | 'beide' | 'neu' | null;
  letzter_fehler: string | null;
}

const KERN_PUFFER = new Map<string, { bis: number; stand: ProfilProduktSchalterStand }>();
/** Puffer verwerfen (Tests; automatisch nach jedem Schreiben eines Produkt-Schalters im eigenen Prozess). */
export function leereAusweisKernCache(): void { KERN_PUFFER.clear(); ZIEL_IRGENDWO.clear(); leereZielWertPuffer(); }
/**
 * P22-T287 S3b (N1): Gibt es im Projekt irgendeine wirksame Zielregel (aktiv=true) fuer die Funktion? Fuer Schutzpfade, die fuer die
 * Sache entscheiden (z. B. Pflicht-Tags eines Zwangs-Pins) und nicht fuer den Schreiber. Nur bei schalter_identitaet EIN; gepuffert
 * (kernTtlMs, geleert mit leereAusweisKernCache); Lesefehler -> false.
 */
const ZIEL_IRGENDWO = new Map<string, { bis: number; wert: boolean }>();
export async function zielRegelIrgendwoAktiv(funktion: ProfilProduktFunktion, project: string | null): Promise<boolean> {
  if (!project || !istZielFaehig(funktion)) return false;
  if (!(await leseProduktGepuffert(SCHALTER_ZIEL_FUNKTION, project, null)).aktiv) return false;
  const ttl = kernTtlMs();
  const k = funktion + '\u0000' + project;
  const jetzt = Date.now();
  const c = ttl > 0 ? ZIEL_IRGENDWO.get(k) : undefined;
  if (c && c.bis > jetzt) return c.wert;
  try {
    const r = await getPool().query('SELECT 1 FROM agent_profil_schalter_ziel WHERE funktion=$1 AND project=$2 AND aktiv LIMIT 1', [funktion, project]);
    const wert = r.rows.length > 0;
    if (ttl > 0) ZIEL_IRGENDWO.set(k, { bis: jetzt + ttl, wert });
    return wert;
  } catch { return false; }
}
/** P22-T287 S3 (P5): Puffer-Messung je Prozess (alle gepufferten Produkt-Schalter-Lesungen). */
const PUFFER_ZAEHLER = { treffer: 0, fehlgriffe: 0 };
export function produktPufferDiagnose(): { treffer: number; fehlgriffe: number } { return { ...PUFFER_ZAEHLER }; }
/** Puffer-TTL je Prozess (Env SYNAPSE_W1B_GATE_TTL_MS, Standard 5000, 0 = aus); auch fuer die Ausweis-Fristen (P22-T45). */
export function kernTtlMs(): number {
  const roh = process.env.SYNAPSE_W1B_GATE_TTL_MS;
  if (roh === undefined || roh.trim() === '') return 5_000;
  const n = Number(roh);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5_000;
}
async function leseProduktGepuffert(funktion: ProfilProduktFunktion, project: string | null, ziel?: SchalterZiel | null): Promise<ProfilProduktSchalterStand> {
  const ttl = kernTtlMs();
  // P22-T287 S3: Ziel nur ausdruecklich (kein Aufrufkontext); mit Ziel gehoert es in den Schluessel. S3b (H4): nur bei ziel-faehiger
  // Funktion UND schalter_identitaet EIN - sonst Puffer je Projekt wie vor T287.
  let z = ziel ?? null;
  if (z && (!project || funktion === SCHALTER_ZIEL_FUNKTION || !istZielFaehig(funktion)
    || !(await leseProduktGepuffert(SCHALTER_ZIEL_FUNKTION, project, null)).aktiv)) z = null;
  const schluessel = funktion + '\u0000' + (project ?? '') + (z ? '\u0000' + (z.identity_id ?? '') + '\u0000' + (z.agent_id ?? '') : '');
  const jetzt = Date.now();
  const c = ttl > 0 ? KERN_PUFFER.get(schluessel) : undefined;
  if (c && c.bis > jetzt) {
    PUFFER_ZAEHLER.treffer++;
    // S3b (N2): Debug-Quelle auch beim Puffertreffer (der Stand traegt ziel_ebene/ziel des Treffers).
    if (c.stand.ziel_ebene && c.stand.ziel && project) await merkeSchalterQuelle(funktion, project, { ebene: c.stand.ziel_ebene, ziel: c.stand.ziel, aktiv: c.stand.aktiv });
    return c.stand;
  }
  PUFFER_ZAEHLER.fehlgriffe++;
  const stand = await leseProfilProduktSchalter(funktion, project, z);
  if (ttl > 0 && !stand.letzter_fehler) KERN_PUFFER.set(schluessel, { bis: jetzt + ttl, stand });
  return stand;
}
/** P22-T199: Produkt-Schalter je Prozess gepuffert (kernTtlMs, wie der Ausweis-Kern) fuer Lesestellen je Tool-Aufruf. */
export function leseProfilProduktSchalterGepuffert(funktion: ProfilProduktFunktion, project: string | null, ziel?: SchalterZiel | null): Promise<ProfilProduktSchalterStand> {
  return leseProduktGepuffert(funktion, project, ziel);
}
/**
 * P22-T287 S4b: Zielstufe fuer Lesestellen mit EIGENER Aufloesung (leseMainSchalter, leseVerlaufStufe2Schalter, ausweis_channels):
 * NUR der Treffer einer Regel je Agent fuer das ausdrueckliche Ziel (gestartete bzw. empfangende Identitaet), sonst null = Bestand der
 * Lesestelle. Ohne Ziel/Projekt, nicht ziel-faehig oder schalter_identitaet AUS -> null ohne weitere Abfrage. Gepuffert wie
 * leseProfilProduktSchalterGepuffert (Ziel im Schluessel nur bei EIN, H4). Keine eigene Rangfolge: Treffer = ziel_ebene des Stands.
 */
export async function zielTrefferFuer(funktion: ProfilProduktFunktion, ziel: (SchalterZiel & { project?: string | null }) | null | undefined): Promise<ProfilProduktSchalterStand | null> {
  const project = ziel?.project ?? null;
  if (!ziel || !project || !istZielFaehig(funktion)) return null;
  if (!(await leseProduktGepuffert(SCHALTER_ZIEL_FUNKTION, project, null)).aktiv) return null;
  const s = await leseProduktGepuffert(funktion, project, { identity_id: ziel.identity_id ?? null, agent_id: ziel.agent_id ?? null });
  return s.ziel_ebene && !s.letzter_fehler ? s : null;
}

interface KernRoh { aktiv: boolean; quelle: AusweisKernQuelle; fehler: string | null }
async function ausweisKernRoh(p: string | null): Promise<KernRoh> {
  let fehler: string | null = null;
  // 1. intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet; Ablauf/Lesefehler -> Produktionsstandard)
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean }>({
        text: `SELECT aktiv FROM intern_schalter
          WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [AUSWEIS_KERN_FUNKTION],
        query_timeout: 2000,
      } as import('pg').QueryConfig & { query_timeout: number });
      if (r.rows[0]) return { aktiv: r.rows[0].aktiv, quelle: 'intern', fehler };
    } catch { fehler = 'schalter_nicht_erreichbar'; }
  }
  // 2. Produkt-Schalter (projekt > global; PG = Quelle fuer alle Prozesse)
  const prod = await leseProduktGepuffert(AUSWEIS_KERN_FUNKTION, p);
  if (prod.letzter_fehler) fehler = fehler ?? prod.letzter_fehler;
  // P22-T311: Standard EIN im aktiven Projekt (Mechanik schalter_standard_aktive_projekte) gilt wie ein gesetzter Produkt-Schalter.
  else if (prod.quelle === 'produkt-schalter' || prod.wert_quelle === 'standard_aktives_projekt') return { aktiv: prod.aktiv, quelle: 'produkt-schalter', fehler };
  // 3. Produktionsstandard per Env
  if (process.env.SYNAPSE_AGENTEN_AUSWEIS === '1') return { aktiv: true, quelle: 'standard', fehler };
  // 4. Altschalter (Rueckfall)
  const { leseTokenIdentitaetSchalter } = await import('./agent-identitaet.js');
  const alt = (await leseTokenIdentitaetSchalter()).freigegeben && (await leseW1bSchalter('anmeldung')).freigegeben
    && (p === null || (await leseProduktGepuffert('schattenprofile', p)).aktiv);
  return { aktiv: alt, quelle: alt ? 'altschalter' : 'standard', fehler };
}

export async function leseAusweisKern(project?: string | null): Promise<AusweisKernStand> {
  const p = project ?? null;
  const basis: AusweisKernStand = { aktiv: false, project: p, quelle: 'standard', agent_bezug_modus: null, letzter_fehler: null };
  try {
    // Dynamisch: agent-bezug/agent-identitaet importieren (indirekt) diese Datei.
    const { leseAgentBezugModus } = await import('./agent-bezug.js');
    const modus = (await leseAgentBezugModus()).modus as AusweisKernStand['agent_bezug_modus'];
    const roh = await ausweisKernRoh(p);
    const stand: AusweisKernStand = { ...basis, agent_bezug_modus: modus, quelle: roh.quelle, letzter_fehler: roh.fehler };
    if (!roh.aktiv) return stand;
    if (modus !== 'beide') return { ...stand, letzter_fehler: 'agent_bezug_modus_nicht_beide' };
    return { ...stand, aktiv: true };
  } catch {
    return { ...basis, letzter_fehler: 'ausweis_kern_nicht_lesbar' };
  }
}

/**
 * Wie leseAusweisKern, aber ohne bekanntes Projekt (Aufruf nur mit Ausweis): ist der Kern global/ohne Projekt AUS, wird das
 * Projekt aus dem Ausweis ermittelt und dessen Projekt-Stand gelesen. Der Ausweiswert geht nur als Abfrageparameter in PG.
 */
export async function leseAusweisKernFuerToken(token: string | undefined, project?: string | null): Promise<AusweisKernStand> {
  const k = await leseAusweisKern(project ?? null);
  if (k.aktiv || project || typeof token !== 'string' || !AUSWEIS_FORMAT.test(token)) return k;
  const eigenes = await ausweisProjekt(token);
  return eigenes ? await leseAusweisKern(eigenes) : k;
}

/**
 * P22-T43 (D9): Projekt eines gueltigen (nicht widerrufenen) Ausweises; ungueltiges Format, unbekannt oder Lesefehler -> null.
 * Nur lesend; der Ausweiswert geht nur als Abfrageparameter in PG. Aendert keinen Schalter.
 */
export async function ausweisProjekt(token: string | undefined): Promise<string | null> {
  if (typeof token !== 'string' || !AUSWEIS_FORMAT.test(token)) return null;
  try {
    const r = await getPool().query<{ project: string }>({
      text: `SELECT i.project FROM agent_identitaet_tokens t JOIN agent_identitaeten i ON i.id = t.identity_id
        WHERE t.token_offen = $1 AND t.widerrufen_am IS NULL LIMIT 1`,
      values: [token],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    return r.rows[0]?.project ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Lesestellen der BESTANDSPFADE (Identitaet, Tool-Gate, tools/list, Daemon-Start, Anmeldung, Schatten-Dienste).
// Wirksam = Ausweis-Kern (Produkt-Schalter agenten_ausweis / intern / Env, nur bei agent_bezug_modus 'beide')
// ODER der alte Einzelschalter als Produktionsstandard/Test-Override (Env/intern token_identitaet, w1b_anmeldung,
// Produkt-Schalter schattenprofile) in jedem Modus. So bleibt das Verhalten der Vorstufe (t110) bei allen alten
// Schaltern unveraendert; der neue EINE Schalter schaltet alles zusammen, aber nur bei 'beide'.
// ---------------------------------------------------------------------------------------------
async function leseAltTokenIdentitaet(): Promise<boolean> {
  const { leseTokenIdentitaetSchalter } = await import('./agent-identitaet.js');
  return (await leseTokenIdentitaetSchalter()).freigegeben;
}
/** Token-Identitaet (Ausweispruefung, token-Parameter, Daemon-Start). */
export async function ausweisTokenAktiv(project?: string | null, token?: string): Promise<boolean> {
  if ((await leseAusweisKernFuerToken(token, project ?? null)).aktiv) return true;
  return leseAltTokenIdentitaet();
}
/** Anmeldung (koordinator_liste, Herkunftsort, Hinweisquellen, Schattenprofil bei Legacy-Anmeldung braucht zusaetzlich ausweisSchattenAktiv). */
export async function ausweisAnmeldungAktiv(project?: string | null): Promise<boolean> {
  if ((await leseAusweisKern(project ?? null)).aktiv) return true;
  return (await leseW1bSchalter('anmeldung')).freigegeben && await leseAltTokenIdentitaet();
}
/**
 * P22-T55: Ausweis-Kern IRGENDWO wirksam (global oder in mindestens einem Projekt) bzw. alter Einzelschalter. Nur fuer die
 * Werbung in tools/list ohne Projekt (token-Parameter, chat anmelden/identitaet). Lesefehler -> wie bisher (nur global/alt).
 */
export async function ausweisIrgendwoAktiv(): Promise<boolean> {
  if ((await leseAusweisKern(null)).aktiv) return true;
  try {
    const r = await getPool().query<{ project: string }>({
      text: `SELECT DISTINCT project FROM agent_profil_schalter
        WHERE ebene = 'projekt' AND aktiv AND project IS NOT NULL AND funktion = ANY($1::text[]) LIMIT 50`,
      values: [[AUSWEIS_KERN_FUNKTION, 'alle']],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    for (const z of r.rows) if ((await leseAusweisKern(z.project)).aktiv) return true;
  } catch { /* Lesefehler: Werbung wie bisher */ }
  // Altschalter bewusst NICHT hier: die bisherigen Lesestellen (ausweisTokenAktiv/ausweisAnmeldungAktiv) bleiben fuer sie zustaendig.
  return false;
}
/** Schattenprofile des Projekts (Kern oder alt: Anmeldung EIN + Produkt-Schalter schattenprofile). Lesefehler = AUS. */
export async function ausweisSchattenAktiv(project: string, mitAnmeldung = true): Promise<boolean> {
  if ((await leseAusweisKern(project)).aktiv) return true;
  // mitAnmeldung=false: Schatten-DIENSTE (Anlage/Verwaltung) wie bisher nur am Produkt-Schalter; true: Anmeldungs-Gate zusaetzlich.
  if (mitAnmeldung && !(await ausweisAnmeldungAktiv(null))) return false;
  const s = await leseProduktGepuffert('schattenprofile', project);
  return s.aktiv && !s.letzter_fehler;
}

export interface ProfilProduktSchalterStand {
  stillgelegt?: boolean; historischer_wert?: boolean; nachfolger?: string;
  funktion: ProfilProduktFunktion;
  project: string | null;
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter';
  ebene: 'global' | 'projekt' | null;
  /**
   * P22-T287: Treffer einer Agent-Regel. ebene bleibt 'projekt' (die Regel gehoert zum Projekt, Vertrag der Verbraucher unveraendert);
   * ziel_ebene identitaet|agent|typ und ziel (identity_id, agent_id/Muster, typ_id) nennen die Herkunft. ziel_fehler = Zielregeln nicht lesbar.
   */
  ziel_ebene?: SchalterZielEbene;
  ziel?: string;
  ziel_muster?: boolean;
  ziel_fehler?: string;
  /** P22-T311 Debug: Herkunft des wirksamen Werts (quelle bleibt standard|produkt-schalter). */
  wert_quelle?: SchalterWertQuelle;
  /** P22-T311 Debug: Stand der Regel 'Standard EIN in aktiven Projekten' (nur wenn keine Zeile gilt). */
  standard_aktive_projekte?: { mechanik: boolean; projekt_aktiv: boolean | null; freigegeben: boolean; fehler?: string };
  regel_funktion: ProfilProduktFunktion | 'alle' | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

export class ProfilSchalterFehler extends Error {
  constructor(public readonly code: string) { super(code); }
}

interface SchalterZeile {
  ebene: 'global' | 'projekt'; project: string | null; funktion: string; aktiv: boolean;
  grund: string | null; gesetzt_von: string; gesetzt_am: Date;
}

function istFunktion(f: string): f is ProfilProduktFunktion {
  return (PROFIL_PRODUKT_FUNKTIONEN as readonly string[]).includes(f) || (ALT_AUSWEIS_FUNKTIONEN as readonly string[]).includes(f);
}

import {leseReversePipelineHalt,setzeReversePipelineHalt} from './reverse-pipeline-halt.js';

/**
 * P22-T287: Zielstufe vor projekt/global. Nur Positivliste, nur bei schalter_identitaet EIN; Lesefehler -> keine Zielregel
 * (projekt/global wie bisher) mit fehler fuer das Debugfeld ziel_fehler.
 */
async function zielStufe(funktion: string, project: string | null, ziel: SchalterZiel | null | undefined): Promise<{ treffer: SchalterZielTreffer | null; fehler: string | null }> {
  if (!project || !ziel || !istZielFaehig(funktion)) return { treffer: null, fehler: null };
  try {
    if (!(await leseProduktGepuffert(SCHALTER_ZIEL_FUNKTION, project, null)).aktiv) return { treffer: null, fehler: null };
    const treffer = await leseZielTreffer(funktion, project, ziel);
    if (treffer) await merkeSchalterQuelle(funktion, project, treffer);
    return { treffer, fehler: null };
  } catch {
    return { treffer: null, fehler: 'schalter_ziel_nicht_lesbar' };
  }
}

// ---------------------------------------------------------------------------------------------
// P22-T311 (User-Grundsatz 08.11.2026, memory grundsatz-schalter-standard-ein-aktive-projekte): in AKTIVEN Projekten
// (projects.enabled: Web-UI-Liste bool_or(enabled), Tray setProjectEnabled) gilt fuer FREIGEGEBENE Schalter Standard EIN, wenn
// keine Zeile (projekt/global/'alle') und keine Zielregel greift. Ausdruecklich gesetzte Werte gewinnen weiter, auch AUS.
// Mechanik hinter schalter_standard_aktive_projekte (Standard AUS bis Abnahme). Eine Lesestelle, keine Kopie je Projekt.
// ---------------------------------------------------------------------------------------------
export const SCHALTER_STANDARD_FUNKTION = 'schalter_standard_aktive_projekte' as const;
export type SchalterWertQuelle = 'identitaet' | 'agent' | 'typ' | 'projekt' | 'global' | 'standard_aktives_projekt' | 'standard';
/** Ausnahmen laut User (Standard bleibt AUS, auch in aktiven Projekten), mit Grund. */
export const STANDARD_AKTIVE_PROJEKTE_AUSNAHMEN: Readonly<Record<string, string>> = {
  reverse_pipeline_halt: 'Notbremse', coedit_ohne_gate: 'Sicherung weg', api_agenten: 'Kosten', api_agenten_lauf_intern: 'Kosten',
  api_deepseek_direkt: 'Kosten', persona: 'nur auf User-Wunsch', koordinator_projektverwaltung: 'Rechte ueber Projektgrenzen',
  asset_intern_aufraeumen: 'loescht', artefakt_bewertung_melden: 'Spam', reverse_siedler3: 'Altschalter', schattenprofile: 'Altschalter',
  token_abruf: 'Altschalter',
  // Befund 08.11.2026 (thought 08c5c214, Koordinator): setzen ein neues Tool-Schema bzw. Verhalten bei den Agenten voraus, loeschen
  // lokal oder erzeugen Last ueber alle aktiven Projekte -> nur ausdruecklich je Projekt/global.
  inbox_quittung: 'braucht chat-Parameter quittung (alte Clients: quittung_fehlt)',
  runtime_tool_ausgabe: 'Read-Guard verlangt Claude Code >= 2.1.295 im Container',
  runtime_synapse_mods: 'verwaltete Container-Mods fuer alle Container-Agenten', cache_waechter: 'Container-Mod (Messung) ab naechstem CLI-Start',
  mod_inbox: 'weckt interaktive Claude-Code-Sitzungen ueber eine installierte Mod', mod_inbox_vorpruefung: 'wirkt nur mit mod_inbox',
  asset_tombstone_zustellung: 'Tombstones an PCs = lokales Loeschen', asset_pc_zustellung: 'schreibt Share-Dateien in Projektordner',
  asset_transfer_generisch: 'Transferlast aller Projekt-Assets ohne Inspector', anker_umrechnung: 'rechnet Plan-Zeilenangaben still um',
  // Koordinator 08.11.2026: agenten_ausweis, mehrprojekt, main_agentenverwaltung, kontingent_delegiert sind KEINE Ausnahme (User will
  // Ausweis und Visum in allen Projekten; Kontingent kostet nur mit container_agenten_max > 0 und User-Auftrag).
};
/** Noch nicht abgenommen: mit der Freigabe (Zeile entfernen) automatisch EIN in aktiven Projekten. */
export const NICHT_FREIGEGEBEN: readonly string[] = ['modellwechsel_rezept_erzeugen', 'schalter_identitaet', 'profil_antwortanpassung', 'kontextprofil_bruecke',
  'tool_liste_je_verbindung', 'tool_ausgabe_seiten', 'api_tool_ausgabe', SCHALTER_STANDARD_FUNKTION];
export interface SchalterKatalogEintrag { funktion: string; freigegeben: boolean; standard_aktive_projekte: boolean; ausnahme_grund: string | null }
/** P22-T311 Katalogfeld je Schalter: freigegeben + Standard in aktiven Projekten. reverse_* bleiben wie sie sind (global). */
export function schalterKatalogEintrag(funktion: string): SchalterKatalogEintrag {
  // Gegenpruefung P22-T311: die Mechanik selbst nie ueber ihren eigenen Standard (auch nach Freigabe), sonst liest
  // standardAktivesProjekt die Mechanik ueber leseProfilProduktSchalter -> standardAktivesProjekt ... ohne Ende.
  const ausnahme = funktion === SCHALTER_STANDARD_FUNKTION ? 'Mechanik selbst, nur ausdruecklich'
    : STANDARD_AKTIVE_PROJEKTE_AUSNAHMEN[funktion] ?? (funktion.startsWith('reverse_') ? 'globaler Reverse-Schalter bleibt wie er ist' : null);
  const freigegeben = !NICHT_FREIGEGEBEN.includes(funktion);
  return { funktion, freigegeben, standard_aktive_projekte: freigegeben && ausnahme === null && !STANDARD_EIN.includes(funktion as ProfilProduktFunktion), ausnahme_grund: ausnahme };
}
export function schalterKatalog(): SchalterKatalogEintrag[] {
  return (PROFIL_PRODUKT_FUNKTIONEN as readonly string[]).map(schalterKatalogEintrag);
}
const PROJEKT_AKTIV_PUFFER = new Map<string, { bis: number; aktiv: boolean }>();
const PROJEKT_AKTIV_TTL_MS = 30_000;
export function leereProjektAktivPuffer(): void { PROJEKT_AKTIV_PUFFER.clear(); }
/** Aktives Projekt = COALESCE(bool_or(projects.enabled), false) (wie isProjectEnabled), 30 s gepuffert. Lesefehler -> null. */
export async function projektAktivFuerSchalter(project: string): Promise<boolean | null> {
  const c = PROJEKT_AKTIV_PUFFER.get(project);
  if (c && c.bis > Date.now()) return c.aktiv;
  try {
    const r = await getPool().query<{ aktiv: boolean }>({
      text: 'SELECT COALESCE(bool_or(enabled), false) AS aktiv FROM projects WHERE name = $1', values: [project], query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const aktiv = r.rows[0]?.aktiv === true;
    PROJEKT_AKTIV_PUFFER.set(project, { bis: Date.now() + PROJEKT_AKTIV_TTL_MS, aktiv });
    return aktiv;
  } catch {
    return null;
  }
}
/** Ohne Zeile: Standard aktives Projekt (Mechanik EIN, freigegeben, Projekt aktiv) oder Standard. Wirft nie. */
async function standardAktivesProjekt(basis: ProfilProduktSchalterStand): Promise<ProfilProduktSchalterStand> {
  const k = schalterKatalogEintrag(basis.funktion);
  if (!basis.project || !k.standard_aktive_projekte) return { ...basis, wert_quelle: 'standard' };
  try {
    const mechanik = (await leseProduktGepuffert(SCHALTER_STANDARD_FUNKTION, basis.project, null)).aktiv === true;
    if (!mechanik) return { ...basis, wert_quelle: 'standard', standard_aktive_projekte: { mechanik, projekt_aktiv: null, freigegeben: true } };
    const aktiv = await projektAktivFuerSchalter(basis.project);
    const debug = { mechanik, projekt_aktiv: aktiv, freigegeben: true, ...(aktiv === null ? { fehler: 'projektstatus_nicht_lesbar' } : {}) };
    return aktiv === true ? { ...basis, aktiv: true, wert_quelle: 'standard_aktives_projekt', standard_aktive_projekte: debug }
      : { ...basis, wert_quelle: 'standard', standard_aktive_projekte: debug };
  } catch {
    return { ...basis, wert_quelle: 'standard', standard_aktive_projekte: { mechanik: false, projekt_aktiv: null, freigegeben: true, fehler: 'mechanik_nicht_lesbar' } };
  }
}
/** P22-T311: Schalter-Historie (projekt + global) fuer Web-UI/Debug aus agent_profil_schalter_ziel_verlauf (ziel '-'). Lesefehler -> []. */
export async function leseSchalterVerlauf(project: string | null, limit = 50): Promise<Array<Record<string, unknown>>> {
  try {
    const r = await getPool().query({
      text: `SELECT ebene, NULLIF(project, '') AS project, funktion, alt, neu, grund, gesetzt_von, herkunft, setter_agent_id, setter_identity_id, wann
        FROM agent_profil_schalter_ziel_verlauf
        WHERE ziel = '-' AND ebene IN ('projekt','global') AND (ebene = 'global' OR project = $1)
        ORDER BY wann DESC LIMIT $2`,
      values: [project ?? '', Math.max(1, Math.min(500, Math.floor(limit)))], query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    return r.rows.map((z: Record<string, unknown>) => ({ ...z, wann: z.wann instanceof Date ? z.wann.toISOString() : z.wann }));
  } catch {
    return [];
  }
}

/**
 * EINE Lesestelle fuer Produkt-Schalter. ziel (P22-T287 S3): nur ausdruecklich - Objekt = fuer genau diesen Agenten (Aufrufer ueber
 * zielDesAufrufers, anderer Agent ueber dessen identity_id), undefined/null = ohne Agent-Ebenen (Projektsicht).
 */
export async function leseProfilProduktSchalter(
  funktion: ProfilProduktFunktion, project?: string | null, ziel?: SchalterZiel | null,
): Promise<ProfilProduktSchalterStand> {
  if(funktion==='reverse_pipeline_halt')return leseReversePipelineHalt(getPool());
  if(funktion==='reverse_pe_ressourcen'||funktion==='reverse_siedler3'||funktion==='reverse_fortschritt_live'||funktion==='reverse_blockuebernahme'||funktion==='reverse_asset_registrierung'||funktion==='reverse_parser_adapter'||funktion==='reverse_leser'||funktion==='reverse_leser_nachzug'||funktion==='reverse_leser_runtime_verwaltung'||funktion==='reverse_leser_hinweise'||funktion==='reverse_entstoerer_auto'||funktion==='reverse_wav_pregap'||funktion==='reverse_global_sichtbar'||funktion==='reverse_intel_abruf'||funktion==='reverse_fehlerlog')project=null; // global library, same value in every project
  const basis: ProfilProduktSchalterStand = { funktion, project: project ?? null, aktiv: STANDARD_EIN.includes(funktion), quelle: 'standard',
    ebene: null, regel_funktion: null, gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null };
  if (!istFunktion(funktion)) return { ...basis, letzter_fehler: 'funktion_unbekannt' };
  // P22-T287: identitaet bzw. agent > typ > projekt > global > Standard.
  const zs = await zielStufe(funktion, project ?? null, ziel);
  if (zs.treffer) {
    const t = zs.treffer;
    return { ...basis, aktiv: t.aktiv, quelle: 'produkt-schalter', ebene: 'projekt', ziel_ebene: t.ebene, ziel: t.ziel, ...(t.muster ? { ziel_muster: true } : {}),
      regel_funktion: funktion, gesetzt_von: t.gesetzt_von, gesetzt_am: t.gesetzt_am, grund: t.grund, wert_quelle: t.ebene };
  }
  if (zs.fehler) basis.ziel_fehler = zs.fehler;
  try {
    const r = await getPool().query<SchalterZeile>({
      text: `SELECT ebene, project, funktion, aktiv, grund, gesetzt_von, gesetzt_am FROM agent_profil_schalter
        WHERE funktion = ANY($1::text[]) AND (ebene = 'global' OR (ebene = 'projekt' AND project = $2))`,
      // P22-T44: 'alle' schliesst 'mehrprojekt' bewusst NICHT ein (nur ausdruecklich schaltbar, Standard AUS bleibt AUS).
      values: [NUR_AUSDRUECKLICH.includes(funktion) ? [funktion] : [funktion, 'alle'], project ?? null],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const rang = (z: SchalterZeile) => (z.ebene === 'projekt' ? 2 : 0) + (z.funktion === funktion ? 1 : 0);
    const z = [...r.rows].sort((a, b) => rang(b) - rang(a))[0];
    // P22-T311: ohne Zeile ggf. Standard EIN im aktiven Projekt (sonst Standard wie bisher).
    if (!z) return funktion==='reverse_siedler3'?{...basis,aktiv:false,stillgelegt:true,nachfolger:'reverse leser_liste'}:await standardAktivesProjekt(basis);
    return { ...basis, aktiv: funktion==='reverse_siedler3'?false:z.aktiv, quelle: 'produkt-schalter', ebene: z.ebene,
      ...(funktion==='reverse_siedler3'?{stillgelegt:true,historischer_wert:z.aktiv,nachfolger:'reverse leser_liste'}:{}),
      regel_funktion: z.funktion as ProfilProduktFunktion | 'alle', gesetzt_von: z.gesetzt_von,
      gesetzt_am: z.gesetzt_am.toISOString(), grund: z.grund, wert_quelle: z.ebene };
  } catch {
    return { ...basis, letzter_fehler: 'produkt_schalter_nicht_lesbar' };
  }
}

/** Akteur kommt ausschliesslich aus authentifiziertem Transport bzw. Tokenpruefung, nie aus Tool-Argumenten. */
export interface ProfilSchalterAkteur {
  system?: 'user';
  identity_id?: string;
  /** P22-T34: Legacy-Koordinator ohne Ausweis (agent_id); Audit 'legacy:<id>'. */
  legacy_koordinator?: string;
  /**
   * P22-T57: Projekt des Aufrufs (authentifiziert, nicht aus ebene/project des Schalters). Bei ebene global prueft es den
   * Koordinator: mit Ausweis muss er aktiver Koordinator DIESES Projekts sein, als Legacy-Koordinator ist es Pflicht.
   */
  aufruf_project?: string | null;
  /**
   * P22-T311 Notfall-Recht (User 'immer nur mit grund'): Agent OHNE Ausweis (alte Anmeldung, agent_id) setzt projekt (eigenes/fremdes)
   * oder global; nur mit schalter_setzen_ohne_ausweis + schalter_standard_aktive_projekte EIN, Grund >= 10 Zeichen; Audit 'ohne_ausweis:<id>'.
   */
  ohne_ausweis?: string;
}

/**
 * P22-T29 (Befund 26cf1837 B1): Prozess-lokale Puffer (z. B. Anmelde-Gate-Cache) melden sich hier an und werden
 * nach jedem erfolgreichen Schreiben eines Produkt-Schalters im SCHREIBENDEN Prozess verworfen. Andere Prozesse
 * sehen die Aenderung nach ihrer eigenen TTL. Reine Fehlerkorrektur, kein Schalter. Hook-Fehler werden verschluckt.
 */
const schalterGeschriebenHooks = new Set<() => void>();
export function registriereSchalterGeschrieben(hook: () => void): void { schalterGeschriebenHooks.add(hook); }
/** P22-T287: nach dem Schreiben eines Ziel-Schalters (agent-profil-schalter-ziel.ts) dieselben Puffer verwerfen. */
export function meldeSchalterGeschrieben(): void {
  for (const hook of schalterGeschriebenHooks) { try { hook(); } catch { /* Puffer-Invalidierung darf das Schreiben nie scheitern lassen */ } }
}

export async function setzeProfilProduktSchalter(
  e: { ebene: 'global' | 'projekt'; project?: string | null; funktion: ProfilProduktFunktion | 'alle'; aktiv: boolean; grund: string },
  akteur: ProfilSchalterAkteur,
): Promise<ProfilProduktSchalterStand> {
  if (e.funktion !== 'alle' && !istFunktion(e.funktion)) throw new ProfilSchalterFehler('funktion_unbekannt');
  if (e.ebene !== 'global' && e.ebene !== 'projekt') throw new ProfilSchalterFehler('ebene_ungueltig');
  if((e.funktion==='reverse_pe_ressourcen'||e.funktion==='reverse_siedler3'||e.funktion==='reverse_fortschritt_live'||e.funktion==='reverse_blockuebernahme'||e.funktion==='reverse_asset_registrierung'||e.funktion==='reverse_parser_adapter'||e.funktion==='reverse_leser'||e.funktion==='reverse_leser_nachzug'||e.funktion==='reverse_leser_hinweise'||e.funktion==='reverse_leser_runtime_verwaltung'||e.funktion==='reverse_global_sichtbar'||e.funktion==='reverse_intel_abruf'||e.funktion==='reverse_fehlerlog')&&e.ebene!=='global')throw new ProfilSchalterFehler('nur_global');
  if(e.funktion==='reverse_pipeline_halt'&&e.ebene!=='global')throw new ProfilSchalterFehler('nur_global');
  const project = e.ebene === 'projekt' ? (e.project ?? '').trim() : null;
  if (e.ebene === 'projekt' && !project) throw new ProfilSchalterFehler('project_fehlt');
  if (typeof e.grund !== 'string' || e.grund.trim().length < 5) throw new ProfilSchalterFehler('grund_fehlt');
  if (typeof e.aktiv !== 'boolean') throw new ProfilSchalterFehler('aktiv_fehlt');
  // W12 V7: der Ausweis-Kern darf nur bei agent_bezug_modus 'beide' eingeschaltet werden.
  // P22-T31: 'alle' mit aktiv:true schaltet den Ausweis-Kern mit ein und unterliegt derselben Modus-Pruefung.
  if ((e.funktion === AUSWEIS_KERN_FUNKTION || e.funktion === 'alle') && e.aktiv) {
    const { leseAgentBezugModus } = await import('./agent-bezug.js');
    if ((await leseAgentBezugModus()).modus !== 'beide') throw new ProfilSchalterFehler('agent_bezug_modus_nicht_beide');
  }
  let wer: string;
  let setter: string | null = null;
  // P22-T311: Herkunft und agent_id des Setzenden fuer den Schalter-Verlauf (Web-UI-Historie).
  let herkunft: 'user' | 'ausweis' | 'legacy_koordinator' | 'ohne_ausweis' = 'user';
  let setterAgent: string | null = null;
  // P22-T57 (User 20.10.2026): Koordinator setzt auch global, gleiche Pruefung wie auf Projektebene. Projektebene: das
  // Schalter-Projekt; global: das Projekt des Aufrufs (ohne Angabe beim Ausweis dessen eigenes Projekt).
  const aufruf = typeof akteur.aufruf_project === 'string' && akteur.aufruf_project.trim() ? akteur.aufruf_project.trim() : null;
  const rechtProjekt = e.ebene === 'projekt' ? project : aufruf;
  if (akteur.system === 'user') {
    wer = 'user';
  } else if (akteur.identity_id) {
    // P22-T277: Koordinator eines anderen Projekts setzt Schalter von B nur auf Projektebene und nur mit Freigabe der Ausweis-Grenze
    // (Aufrufkontext koordinator_verwaltung === B, B nicht ausgenommen); global bleibt wie bisher.
    const fremdVerwaltung = e.ebene === 'projekt' && !!rechtProjekt
      && (await import('./agent-bezug.js')).aktuellerAgentAufruf()?.koordinator_verwaltung === rechtProjekt
      && !(await import('./koordinator-projektverwaltung.js')).istKoordinatorVerwaltungAusgenommen(rechtProjekt);
    const r = await getPool().query(
      "SELECT 1 FROM agent_identitaeten WHERE id=$1 AND ($2::text IS NULL OR project=$2 OR $3::boolean) AND status='aktiv' AND rolle='koordinator'",
      [akteur.identity_id, rechtProjekt, fremdVerwaltung]);
    if (!r.rows.length) throw new ProfilSchalterFehler('recht_fehlt');
    wer = akteur.identity_id;
    setter = akteur.identity_id;
    herkunft = 'ausweis';
  } else if (akteur.legacy_koordinator && rechtProjekt) {
    // P22-T34: Legacy-Koordinator (Rolle/Namensmuster koordinator, Name gehoert keiner Token-Identitaet) wie Koordinator mit Ausweis.
    const agent = akteur.legacy_koordinator.trim();
    const { rolleFuerAgent } = await import('./agent-rollen.js');
    if (!agent || rolleFuerAgent(agent).rolle !== 'koordinator') throw new ProfilSchalterFehler('recht_fehlt');
    const eigene = await getPool().query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [rechtProjekt, agent]);
    if (eigene.rows.length) throw new ProfilSchalterFehler('recht_fehlt');
    wer = 'legacy:' + agent;
    herkunft = 'legacy_koordinator';
    setterAgent = agent;
  } else if (akteur.ohne_ausweis && rechtProjekt) {
    // P22-T311 Notfall-Recht: nur mit Pflichtgrund, beiden Schaltern im Rechte-Projekt, Name ohne Ausweis-Identitaet, nicht 'alle'.
    const agent = akteur.ohne_ausweis.trim();
    if (!agent || e.funktion === 'alle') throw new ProfilSchalterFehler('recht_fehlt');
    if (e.grund.trim().length < 10) throw new ProfilSchalterFehler('grund_fehlt');
    const [mech, darf] = await Promise.all([leseProfilProduktSchalter(SCHALTER_STANDARD_FUNKTION, rechtProjekt),
      leseProfilProduktSchalter('schalter_setzen_ohne_ausweis', rechtProjekt)]);
    if (!mech.aktiv || !darf.aktiv) throw new ProfilSchalterFehler('ohne_ausweis_aus');
    // Nachzug (Koordinator 08.11.2026): ein frueherer Name (Alias, agent_namens_aliase P22-T173) einer aktiven Ausweis-Identitaet
    // zaehlt wie ihr Name. Lesefehler (Tabelle fehlt) -> Abbruch des Setzens, nie stillschweigend durchlassen.
    const ausweis = await getPool().query(
      `SELECT 1 FROM agent_identitaeten WHERE agent_id=$1 AND status='aktiv'
       UNION ALL SELECT 1 FROM agent_namens_aliase a JOIN agent_identitaeten i ON i.id::text = a.identity_id
        WHERE a.alter_name=$1 AND i.status='aktiv' LIMIT 1`, [agent]);
    if (ausweis.rows.length) throw new ProfilSchalterFehler('recht_fehlt');
    wer = 'ohne_ausweis:' + agent;
    herkunft = 'ohne_ausweis';
    setterAgent = agent;
  } else {
    throw new ProfilSchalterFehler('recht_fehlt');
  }
  const altWert = e.funktion === 'reverse_pipeline_halt' ? null : (await getPool().query<{ aktiv: boolean }>(
    "SELECT aktiv FROM agent_profil_schalter WHERE ebene=$1 AND COALESCE(project,'')=COALESCE($2,'') AND funktion=$3",
    [e.ebene, project, e.funktion]).catch(() => ({ rows: [] as Array<{ aktiv: boolean }> }))).rows[0]?.aktiv ?? null;
  if(e.funktion==='reverse_siedler3')throw new ProfilSchalterFehler('funktion_stillgelegt');
  if(e.funktion==='reverse_pipeline_halt')await setzeReversePipelineHalt(getPool(),e.aktiv,e.grund.trim(),wer,setter);
  else await getPool().query(
    `INSERT INTO agent_profil_schalter (ebene, project, funktion, aktiv, grund, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (ebene, (COALESCE(project, '')), funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
       gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=EXCLUDED.setter_identity_id, gesetzt_am=EXCLUDED.gesetzt_am`,
    [e.ebene, project, e.funktion, e.aktiv, e.grund.trim(), wer, setter]);
  // P22-T311: jede Aenderung projekt/global in den vorhandenen Schalter-Verlauf (Schema 182, ziel '-'); Fehler bricht das Setzen nie ab.
  await getPool().query(
    `INSERT INTO agent_profil_schalter_ziel_verlauf (ebene, project, ziel, funktion, alt, neu, grund, gesetzt_von, setter_identity_id, herkunft, setter_agent_id)
     VALUES ($1, COALESCE($2,''), '-', $3, $4, $5, $6, $7, $8, $9, $10)`,
    [e.ebene, project, e.funktion, altWert, e.aktiv, e.grund.trim(), wer, setter, herkunft, setterAgent]).catch(() => undefined);
  for (const hook of schalterGeschriebenHooks) { try { hook(); } catch { /* Puffer-Invalidierung darf das Schreiben nie scheitern lassen */ } }
  return leseProfilProduktSchalter(e.funktion === 'alle' ? 'profilverwaltung' : e.funktion, project);
}
// Eigener Prozess: Kern-Puffer nach jedem Schreiben verwerfen (nach der Hook-Menge definiert, daher am Dateiende).
registriereSchalterGeschrieben(leereAusweisKernCache);
