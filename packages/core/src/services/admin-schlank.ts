/**
 * P23-T10 (User 01.11.2026): ADMIN SCHLANK im admin-Tool (MCP stdio + REST /mcp), Suche in admin-katalog-suche.ts.
 *
 * fuehreAdminSchlankAus(action, args, ausfuehren) legt sich um den unveraenderten Core-Dispatcher (fuehreW1bAdminAus):
 *   - Status-Aktionen (profil_schalter_status, reverse/hex/shell_ausgabe_einstellungen status, runtime_ueberwachung status,
 *     agentennetzwerk status): Katalog nur als Zusammenfassung bzw. Suchtreffer (query, nur_aktiv, nur_abweichend,
 *     fehlend_gegenueber_projekt, voll + limit/offset).
 *   - Setzen-Aktionen (profil_schalter_setzen, reverse/hex/shell_ausgabe setzen|entfernen, runtime_ueberwachung
 *     setzen|entfernen, agentennetzwerk einstellen): NUR die geaenderten Eintraege {name, vorher, nachher, ebene, quelle, revision}.
 *   - Unbekannte Namen (action, profil_funktion): aehnlichste Treffer + Fall-Skill-Hinweis.
 * Der Schreibweg laeuft genau einmal ueber den Dispatcher (Rechte, Pruefungen, Audit unveraendert); scheitert die
 * Nachbearbeitung, kommt die volle Dispatcher-Antwort mit schlank_fehler zurueck. Die REST-Routen der Web-UI rufen den
 * Dispatcher direkt und bleiben vollstaendig. Kein neuer Schalter (User: neues Verhalten direkt als Standard); der
 * bestehende Schalter tool_antworten_schlank (P23-T3) deckt admin nicht ab (nur shell-Rueckfrage/werkzeug_regeln).
 */
import { PROFIL_PRODUKT_FUNKTIONEN, ALT_AUSWEIS_FUNKTIONEN, STANDARD_EIN, leseProfilProduktSchalter, type ProfilProduktFunktion, type ProfilProduktSchalterStand } from './agent-profil-schalter.js';
import { leseUiProduktSchalter } from './agent-profil-admin.js';
import { katalogAntwort, aehnlicheNamen, KATALOG_SKILL, type KatalogEintrag } from './admin-katalog-suche.js';

type Args = Record<string, unknown>;

/** Eine Zeile Zweck je Produkt-Schalter (aus den Katalog-Kommentaren in agent-profil-schalter.ts). */
export const PROFIL_SCHALTER_ZWECK: Readonly<Record<string, string>> = {
  cache_waechter: 'Telemetrie des Cache-Waechters, kein automatischer Neustart.',
  runtime_synapse_mods: 'Telemetrie der Synapse-Mods im Runtime-Container.',
  team_ausweis_zeigen: 'User-Sicht der Ausweis-Kennung im Agententeam.',
  asset_tombstone_zustellung: 'PG-Tombstones geloeschter Assets an PCs zustellen.',
  agentennetzwerk: 'Agentennetzwerk (Live-Ansicht der Agenten und Aufrufe) in der Web-UI.',
  netzwerk_datengrundlage: 'Datengrundlage des Agentennetzwerks.',
  profilverwaltung: 'Verwaltung der Agentenprofile (aendern, Historie, Rollback, Lesen).',
  typkatalog: 'Typkatalog der Agentenprofile.',
  persona: 'Persona-Bibliothek fuer Agenten (nur auf User-Wunsch).',
  task_bindung: 'Task-Bindung an Identitaeten oder Teams.',
  agenten_ausweis: 'Agenten-Ausweis (Kern): Anmeldung per Kennung, Schattenprofile, Tokenabruf.',
  mehrprojekt: 'Ausweis fuer mehrere Projekte (Visum, Arbeitsfreigabe).',
  hex_lesen: 'Bytewerkzeug hex: Dateien als Bytes lesen.',
  hex_adressen: 'Bytewerkzeug hex: Adress-/Speichersicht.',
  hex_formate: 'Bytewerkzeug hex: Formatbeschreibungen deuten.',
  hex_entschluesseln: 'Bytewerkzeug hex: Entschluesseln und Analysekette.',
  tool_beschreibungen_kurz: 'Kurze Tool-Beschreibungen in tools/list (Fall-Skills).',
  fall_skill_hinweis: 'Fall-Skill-Hinweis bei Fehlbedienung eines Tools.',
  tool_liste_je_verbindung: 'tools/list je Verbindung zuschneiden.',
  tool_antworten_schlank: 'Schlanke Tool-Antworten (shell-Rueckfrage, werkzeug_regeln einmal je Sitzung).',
  fall_skill_faelle: 'Ungenuegende Fall-Skill-Hinweise als offene Tool-Faelle im Erklaerungs-Topf.',
  shell_fremde_ergebnisse: 'Fremde Shell-Ergebnisse in shell_activity anbieten.',
  verbrauch: 'Verbrauchszaehlung der Abo-CLIs je Agent.',
  runtime_ueberwachung: 'Ueberwachung und Neustart der Runtime-Container durch die API.',
  runtime_tool_ausgabe: 'CLI-Tool-Ausgabelimits und enger Read-Guard in den Runtimes.',
  user_inbox: 'User-Inbox: Nachrichten der Agenten an den User.',
  zeilen_anmerkungen: 'Zeilen- und Quellenanmerkungen an Dateien.',
  hauptagent_cli_modelle: 'Modellwahl des Hauptagenten aus den CLI-Modelllisten.',
  hauptagent_verlauf: 'Gespraechsverlauf des Hauptagenten-Chats serverseitig speichern.',
  runtime_status_stabil: 'Stabile Bewertung des Runtime-Status (haengende Probe kippt den guten Stand nicht).',
  verlauf_token_zaehlung: 'Eigene Token-Zaehlung aus dem Verlauf.',
  verlauf_alle_richtungen: 'Alle Richtungen des Main im Verlauf (Zustellungen, eigene Ausgaben).',
  main_korridor: 'Korridor des Main ueber die API.',
  verlauf_uebergabe: 'Uebergabe aus dem Verlauf beim Wechsel des Main.',
  main_warteschlange: 'Warteschlange des Main-Chats (nur mit hauptagent_verlauf).',
  agenten_entfernung: 'Alte inaktive Agenten weich als entfernt markieren und ausblenden.',
  startkontext: 'Startkontext aus dem Verlauf bei jedem neuen Lauf einspielen.',
  main_lesezugriff: 'Lesezugriff des Main auf alle User-Projekte.',
  agent_verlauf_alle: 'Verlauf jeder aktiven Identitaet speichern.',
  spezialisten_container: 'Spezialisten im Runtime-Container starten.',
  chat_get_eigene: 'chat(get) mit Ausweis nur eigene Nachrichten.',
  agent_anmeldungen: 'Anmelde-Uebersicht je Agent (admin anmeldungen).',
  db_lesen: 'intern db_lesen/db_schema: Produktionsdaten nur lesend.',
  reverse_s3: 'Reverse S2/S3 per Ghidra auf Anforderung.',
  reverse_pe_ressourcen: 'Reverse: PE-Ressourcen ueber E (globale Bibliothek).',
  reverse_verknuepfungen: 'Reverse: Verknuepfungen zwischen Eintraegen.',
  reverse_erkenntnisse: 'Reverse: Erkenntnisse speichern und abfragen.',
  reverse_siedler3: 'Reverse Siedler3 (stillgelegt, Nachfolger reverse leser_liste).',
  reverse_pipeline_halt: 'Reverse: globaler Zulassungsstopp der Pipeline.',
  reverse_fortschritt_live: 'Reverse: Live-Fortschritt laufender Container-Auftraege.',
  reverse_blockuebernahme: 'Reverse: fortsetzbare Blockuebernahme.',
  reverse_asset_registrierung: 'Reverse: globale Asset-Registrierung.',
  reverse_parser_adapter: 'Reverse: eigener Parser-Adapter.',
  reverse_leser: 'Reverse: externe Leser.',
  reverse_leser_nachzug: 'Reverse: Nachzug der externen Leser.',
  reverse_leser_hinweise: 'Reverse: Hinweise der externen Leser.',
  reverse_leser_runtime_verwaltung: 'Reverse: Runtime-Verwaltung der externen Leser.',
  reverse_entstoerer_auto: 'Reverse: automatischer Entstoerer.',
  reverse_wav_pregap: 'Reverse: WAV-Pregap beim Audio-CD-Entpacken.',
  reverse_global_sichtbar: 'Reverse global ohne Bindung sichtbar.',
  reverse_intel_abruf: 'code_intel/asset_intel mit project=rev-...',
  reverse_fehlerlog: 'Zentrales Reverse-Fehlerlog.',
  ausweis_channels: 'Ausweis-Channels still beitreten, nicht verlassbar.',
  kontingent_delegiert: 'Container-Kontingent auch durch Koordinator/Main mit User-Auftrag.',
  plattform_agent_chat: 'Chat mit Plattform-Agenten im Zielprojekt.',
  koordinator_mehrfenster: 'Unabhaengige Koordinator-Dockfenster in der Web-UI.',
  artefakt_dateien: 'Artefakt-Dateien.',
  tool_antwort_ueberlauf: 'MCP-Ueberlauf grosser Tool-Antworten in Artefakt-Dateien.',
  log_strom: 'Benannte Shell-Log-Stroeme.',
  main_agentenverwaltung: 'Main verwaltet Agenten/Koordinatoren in allen User-Projekten.',
  koordinator_projektverwaltung: 'Koordinatoren verwalten jedes Projekt ausser synapse (Projektschalter, Build-Einstellungen, Ausweise).',
  koordinator_heartbeat: 'Heartbeat der Koordinatoren ueber die API.',
  zwangs_pin: 'Zwangs-Pin: Pflicht-Memory an einen Stamm, Schreibsperre bis memory read (nur ueberwachte Claude-CLI-Kontexte).',
  agent_start_ort: 'Startort jedes Agenten in PG.',
  runtime_agenten_uebersicht: 'Uebersicht aller Runtime-Agenten mit Namenssuche.',
  runtime_agenten_steuerung: 'Runtime-Agenten steuern (stop/start/restart/wake).',
  plattform_agent_modellwechsel: 'Modell-/CLI-Wechsel fuer Plattform-Agenten.',
  main_turn_wake_frist: 'Wake-Frist des Main-Turns an die Turn-Frist koppeln.',
  ausweis_zielmodell: 'Angefordertes Zielmodell gewinnt gegen das Aufrufer-Modell.',
  modell_lauf_bindung: 'modell_bestaetigt nach Container-Start an den Lauf binden.',
  wake_echter_absender: 'Echter Absender statt rest-api im wake-Altweg.',
  wake_antwort_identitaet: 'Antwort geweckter Agenten identitaetsadressiert an den Wecker.',
  runtime_agenten_panel_neu: 'Neue Darstellung des Runtime-Agenten-Panels.',
  verlauf_tool_karten: 'Tool-Karten im Chat aus tool_calls.',
  wrapper_status_ursache: 'Wrapper-Anzeigestatus aus belegter Ende-Ursache.',
  agent_chat_einheitlich: 'Einheitliches Chatfenster fuer Plattform-Agenten.',
  agent_kennung_werbung: 'Ausweis-Parameter als agent_kennung bewerben.',
  mod_inbox: 'Mod-Inbox: interaktive Claude-Code-Sitzungen ueber eine Mod wecken.',
  mod_inbox_vorpruefung: 'Vorpruefung der Mod-Inbox (erst bei freier Sitzung einreichen).',
  task_bindung_loesen_bei_done: 'Task-Bindung beim Setzen auf done automatisch loesen.',
  artefakt_bewertung: 'Artefakt-Bewertung (Design-Gedaechtnis).',
  artefakt_bewertung_melden: 'Jede Artefakt-Bewertung per Inbox an den Urheber melden.',
  inbox_quittung: 'Quittung zugestellter Nachrichten durch den Agenten.',
  artefakt_vorlagen: 'Artefakte als Datenvorlagen.',
  artefakt_vorlagen_live: 'Live-Neuzeichnen von Artefakt-Vorlagen.',
  artefakt_ausweis_zeigen: 'artefakt(zeigen) per Ausweis ohne Hauptagenten-Session.',
  artefakt_verweise: 'Anklickbare Verweise im Artefakt.',
  artefakt_skripte: 'Artefakte mit Skript in den Top-Artefakten.',
  verlauf_einbetten: 'Sitzungsverlaeufe je Ausweis zerlegen und einbetten.',
  verlauf_suche: 'search(action:verlauf) ueber eingebettete Verlaeufe.',
  chat_zitate: 'Zitat-Anhaenge im Chat der Web-UI.',
  agent_aktuelle_task: 'Aktuelle Task je Agent neben dem Namen.',
  agent_lauf_herkunft: 'Lauf-Herkunft (api/cli/codex, Modell) je Agent.',
  agent_umbenennung: 'Agenten-Identitaet umbenennen.',
  api_agenten: 'Kostenpflichtige API-Agenten ausser dem Main.',
  wiederkehr_plaene: 'Wiederkehrende Plaene (Rueckstellung, Standard-Plaene).',
  speicher_aehnlichkeit: 'Aehnlichkeitspruefung beim Speichern.',
  speicher_aehnlichkeit_pruefen: 'Modus pruefen_vor_anlegen fuer User-Ideen.',
  task_pins: 'Pins frueherer Agenten in plan(get) und bei der Anmeldung.',
  api_agenten_lauf_intern: 'API-Agenten direkt im synapse-api-Prozess.',
  api_agenten_auswahl: 'Ausdrueckliche Laufwahl CLI/API in der Web-UI.',
  coedit_ohne_gate: 'Co-Edit ohne Ready-Gate.',
  anker_umrechnung: 'Anker-Umrechnung veralteter replace_lines/delete_lines im Plan.',
  web_ui_neue_oberflaeche: 'Web-UI: neue Huelle SynapseWorkspace.',
  seitenleiste_projekt_tasks: 'Web-UI-Seitenleiste: letzte Tasks des aktiven Projekts.',
  web_ui_arbeitsbereich: 'Web-UI: neu geordneter Arbeitsbereich.',
  web_ui_channel_suche: 'Web-UI: Channel-Suche und gemeinsames Channel-Fenster.',
  web_ui_agententeam_suche: 'Web-UI: Agententeam als Suche mit Ausweis-Fenster.',
  web_ui_netzwerk_details: 'Web-UI: Channel-Knoten und Ergebnisdetails im Agentennetzwerk.',
  web_ui_live_artefakte: 'Web-UI: projektuebergreifende Live-Artefaktuebersicht.',
  editor_modul: 'Editor mit Freeze und geprueftem User-Plan.',
  editor_plan_strom: 'Editor: Live-Plan als durchgehender Strom aus PG.',
  editor_syntax: 'Editor: Syntax-Hervorhebung.',
  editor_plan_leinwand: 'Editor-Leinwand: eingeklappter Explorer zeigt die Plaene des Plan-Stroms.',
  netzwerk_visum_sonnen: 'Agentennetzwerk: Visum-Agenten bringen ihre Heimat-Projektsonne mit.',
  datei_vertrag: 'Projektdateien als Artefaktquelle.',
  uebersicht_netzwerk: 'Web-UI-Uebersicht als globales Agentennetzwerk.',
  index_live_vorrang: 'Index: Live-Dateiereignisse vor dem Erstscan.',
  warteschlangen_stau: 'Stau-Waechter der Warteschlangen und Hinweis in Tool-Antworten.',
  warteschlangen_altbestand: 'Altbestand in Warteschlangen ausblenden (admin warteschlangen_aufraeumen).',
  asset_transfer_generisch: 'Projekt-Assets ohne Inspector generisch uebertragen.',
  asset_pc_zustellung: 'Zustellung Share -> Projektordner sichtbar.',
  asset_publish_recovery: 'Verwaiste staged-Publikationssperre automatisch loesen.',
  asset_intern_aufraeumen: 'Reverse-Altbestand im Projekt-.intern aufraeumen.',
  shell_ausgabe_voll: 'Volle Shell-Ausgabe in Teilen und gedeckelte Abrufe.',
  schattenprofile: 'Altschalter, aufgegangen in agenten_ausweis.',
  token_abruf: 'Altschalter, aufgegangen in agenten_ausweis.',
};

const BEREICH_REGELN: ReadonlyArray<[RegExp, string]> = [
  [/^(web_ui_|seitenleiste_|koordinator_mehrfenster|runtime_agenten_panel)/, 'web_ui'],
  [/^(agentennetzwerk|netzwerk_|uebersicht_netzwerk)/, 'netzwerk'],
  [/^(hauptagent_|main_|startkontext)/, 'main'],
  [/^(tool_|fall_skill_)/, 'tool'],
  [/^api_agent/, 'api'],
  [/^(agenten_ausweis|ausweis_|mehrprojekt|schattenprofile|token_abruf|team_ausweis|agent_kennung)/, 'ausweis'],
  [/^(profilverwaltung|typkatalog|persona)/, 'profil'],
  [/^(mod_inbox|inbox_|user_inbox|wake_|chat_)/, 'nachrichten'],
];

/** Bereich eines Namens: feste Gruppen, sonst erstes Namensglied. */
export function katalogBereich(name: string): string {
  for (const [re, b] of BEREICH_REGELN) if (re.test(name)) return b;
  return name.split('_')[0] || name;
}

const ALLE_FUNKTIONEN: readonly string[] = [...PROFIL_PRODUKT_FUNKTIONEN, ...ALT_AUSWEIS_FUNKTIONEN];

function schalterEintrag(s: ProfilProduktSchalterStand): KatalogEintrag {
  const standard = STANDARD_EIN.includes(s.funktion);
  return { name: s.funktion, art: 'schalter', wert: s.aktiv, ebene: s.ebene, quelle: s.quelle, zweck: PROFIL_SCHALTER_ZWECK[s.funktion] ?? null,
    bereich: katalogBereich(s.funktion), standard, abweichend: s.aktiv !== standard, begruendung: s.grund };
}

function schalterNamensKatalog(): KatalogEintrag[] {
  return [...ALLE_FUNKTIONEN, 'alle'].map((n) => ({ name: n, art: 'schalter' as const, wert: null, zweck: PROFIL_SCHALTER_ZWECK[n] ?? null, bereich: katalogBereich(n) }));
}

async function aktiveSchalterIn(project: string): Promise<Set<string>> {
  const st = await Promise.all(ALLE_FUNKTIONEN.map((f) => leseProfilProduktSchalter(f as ProfilProduktFunktion, project)));
  return new Set(st.filter((x) => x.aktiv).map((x) => x.funktion as string));
}

const SKILL_HINWEIS = `Fall-Skill ${KATALOG_SKILL}: skills(action:"get_full", skill_name:"${KATALOG_SKILL}").`;

/** Unbekannte admin-Aktion: aehnlichste Namen + Fall-Skill (statt grossem enum im Schema). */
export async function adminUnbekannteAktion(action: string, bekannte: readonly string[]): Promise<Record<string, unknown>> {
  const katalog: KatalogEintrag[] = [...new Set(bekannte)].map((n) => ({ name: n, art: 'wert' as const, wert: null, bereich: katalogBereich(n) }));
  const aehnlich = action ? await aehnlicheNamen(action, katalog) : [];
  return { success: false, action, error: 'aktion_unbekannt', aehnlich,
    hinweis: `Unbekannte admin-Aktion "${action}".${aehnlich.length ? ' Aehnlich: ' + aehnlich.join(', ') + '.' : ''} Uebersicht: Fall-Skill fall-admin. ${SKILL_HINWEIS}` };
}

const s = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);

interface WertStand { wert: unknown; ebene?: unknown; quelle?: unknown; revision?: unknown }

function diff(namen: string[], vorher: Record<string, WertStand> | null, nachher: Record<string, WertStand>, revision?: unknown): Array<Record<string, unknown>> {
  return [...new Set(namen)].map((n) => {
    const v = vorher?.[n];
    const z = nachher[n];
    const rev = revision ?? z?.revision;
    return { name: n, vorher: v ? v.wert : null, nachher: z ? z.wert : null, ebene: z?.ebene ?? null, quelle: z?.quelle ?? null,
      ...(rev !== undefined && rev !== null ? { revision: rev } : {}),
      ...(v && z && JSON.stringify(v.wert) === JSON.stringify(z.wert) ? { wirksam_unveraendert: true } : {}) };
  });
}

const objektSchluessel = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>) : []);
const textListe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const gleich = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function zahlZweck(einheit: string | undefined, min: unknown, max: unknown, standard: unknown): string {
  return [einheit, min !== undefined && max !== undefined ? `${String(min)}..${String(max)}` : null, standard !== undefined ? `Standard ${JSON.stringify(standard)}` : null]
    .filter(Boolean).join(', ');
}

// -- Katalog-Adapter -----------------------------------------------------------

function reverseKatalog(werte: Record<string, Record<string, unknown>>): KatalogEintrag[] {
  return Object.entries(werte).map(([name, w]) => {
    const auswahl = Array.isArray(w.werte) ? `Auswahl ${(w.werte as unknown[]).join('|')}` : null;
    return { name, art: 'wert' as const, wert: w.wert, ebene: (w.ebene as string | null) ?? null, quelle: (w.quelle as string | null) ?? null,
      zweck: auswahl ? `${auswahl}, Standard ${String(w.standard)}` : zahlZweck(w.einheit as string | undefined, w.min, w.max, w.standard),
      bereich: katalogBereich(name), standard: w.standard, abweichend: String(w.wert) !== String(w.standard) };
  });
}

async function runtimeKatalog(einst: Record<string, Record<string, unknown>>): Promise<KatalogEintrag[]> {
  const { RUNTIME_UEBERWACHUNG_EINSTELLUNGEN } = await import('./runtime-ueberwachung.js');
  const defs = RUNTIME_UEBERWACHUNG_EINSTELLUNGEN as unknown as Record<string, Record<string, unknown>>;
  return Object.entries(einst).map(([name, w]) => {
    const d = defs[name] ?? {};
    const zweck = d.art === 'bool' ? `an/aus, Standard ${String(d.standard)}`
      : d.art === 'liste' ? `Liste aus ${(d.erlaubt as string[] | undefined)?.join('|') ?? ''}`
      : d.art === 'map' ? `Name -> Zahl ${String(d.min)}..${String(d.max)}`
      : zahlZweck(undefined, d.min, d.max, d.standard);
    return { name, art: 'wert' as const, wert: w.wert, ebene: w.quelle === 'einstellung' ? 'global' : null, quelle: (w.quelle as string | undefined) ?? null,
      zweck, bereich: katalogBereich(name), standard: d.standard, abweichend: !gleich(w.wert, d.standard), begruendung: null };
  });
}

/** hex/shell_ausgabe: {wert, quelle standard|global|projekt, standard}. */
function stufenKatalog(werte: Record<string, Record<string, unknown>>): KatalogEintrag[] {
  return Object.entries(werte).map(([name, w]) => ({
    name, art: 'wert' as const, wert: w.wert, ebene: w.quelle === 'standard' ? null : (w.quelle as string | undefined) ?? null, quelle: (w.quelle as string | undefined) ?? null,
    zweck: zahlZweck(undefined, undefined, undefined, w.standard), bereich: katalogBereich(name), standard: w.standard, abweichend: !gleich(w.wert, w.standard),
  }));
}

async function netzwerkKatalog(einst: Record<string, Record<string, unknown>>): Promise<KatalogEintrag[]> {
  const { NETZWERK_EINSTELLUNGEN } = await import('./agentennetzwerk.js');
  const defs = NETZWERK_EINSTELLUNGEN as unknown as Record<string, { standard: number }>;
  return Object.entries(einst).map(([name, w]) => ({
    name, art: 'wert' as const, wert: w.wert, ebene: w.quelle === 'einstellung' ? 'global' : null, quelle: (w.quelle as string | undefined) ?? null,
    zweck: zahlZweck((w.einheit as string | undefined) || undefined, w.min, w.max, defs[name]?.standard), bereich: katalogBereich(name),
    standard: defs[name]?.standard, abweichend: defs[name] ? w.wert !== defs[name].standard : false,
  }));
}

const alsWerte = (v: unknown): Record<string, Record<string, unknown>> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, Record<string, unknown>> : {});

/** Stufenwerte (hex/shell) als WertStand mit ebene aus der Quelle. */
function stufenStand(werte: Record<string, Record<string, unknown>>): Record<string, WertStand> {
  return Object.fromEntries(Object.entries(werte).map(([n, w]) => [n, { wert: w.wert, quelle: w.quelle, ebene: w.quelle === 'standard' ? null : w.quelle }]));
}

// -- Wrapper -------------------------------------------------------------------

export const ADMIN_KATALOG_AKTIONEN = ['profil_schalter_status', 'profil_schalter_setzen', 'reverse_einstellungen', 'runtime_ueberwachung',
  'hex_einstellungen', 'shell_ausgabe_einstellungen', 'agentennetzwerk'] as const;

/**
 * Legt sich um den Dispatcher: liest bei Setzen-Aktionen den Stand vorher, ruft ausfuehren() GENAU EINMAL und formt die
 * Antwort schlank. Andere Aktionen: unveraendert durchgereicht.
 */
export async function fuehreAdminSchlankAus(action: string, args: Args, ausfuehren: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (!(ADMIN_KATALOG_AKTIONEN as readonly string[]).includes(action)) return ausfuehren();
  const project = s(args, 'project');

  // Vorab: unbekannte profil_funktion -> aehnliche Treffer, ohne den Dispatcher zu rufen.
  if (action === 'profil_schalter_setzen') {
    const f = s(args, 'profil_funktion');
    if (f && f !== 'alle' && !ALLE_FUNKTIONEN.includes(f)) {
      const aehnlich = await aehnlicheNamen(f, schalterNamensKatalog());
      return { success: false, action, error: 'profil_funktion_unbekannt', profil_funktion: f, aehnlich,
        hinweis: `Unbekannter Produkt-Schalter "${f}".${aehnlich.length ? ' Aehnlich: ' + aehnlich.join(', ') + '.' : ''} Suchen: admin(profil_schalter_status, query). ${SKILL_HINWEIS}` };
    }
  }

  // Stand vorher (nur Setzen-Aktionen; Lesefehler -> ohne vorher).
  let vorher: Record<string, WertStand> | null = null;
  try { vorher = await leseVorher(action, args, project); } catch { vorher = null; }

  const res = await ausfuehren();
  if (!res || res.success !== true) return res;
  try {
    return await formeSchlank(action, args, project, vorher, res);
  } catch (e) {
    return { ...res, schlank_fehler: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) };
  }
}

function istSetzen(action: string, args: Args): boolean {
  switch (action) {
    case 'profil_schalter_setzen': return true;
    case 'reverse_einstellungen': case 'hex_einstellungen': case 'shell_ausgabe_einstellungen': return args.modus === 'setzen' || args.modus === 'entfernen';
    case 'runtime_ueberwachung': return args.ueberwachung_modus === 'setzen' || args.ueberwachung_modus === 'entfernen';
    case 'agentennetzwerk': return args.netzwerk_modus === 'einstellen';
    default: return false;
  }
}

async function leseVorher(action: string, args: Args, project: string | undefined): Promise<Record<string, WertStand> | null> {
  if (!istSetzen(action, args) || !project) return null;
  switch (action) {
    case 'profil_schalter_setzen': {
      const f = s(args, 'profil_funktion');
      if (!f) return null;
      const namen = f === 'alle' ? ALLE_FUNKTIONEN : [f];
      const st = await Promise.all(namen.map((n) => leseUiProduktSchalter(n as ProfilProduktFunktion, project)));
      return Object.fromEntries(st.map((x) => [x.funktion as string, { wert: x.aktiv, ebene: x.ebene, quelle: x.quelle, revision: x.gesetzt_am }]));
    }
    case 'reverse_einstellungen': {
      const { leseReverseEinstellwerte } = await import('./reverse-einstellwerte.js');
      const st = await leseReverseEinstellwerte({ project, eintrag_id: s(args, 'reverse_id') ?? null });
      return Object.fromEntries(Object.entries(st.werte).map(([n, w]) => [n, { wert: w.wert, ebene: w.ebene, quelle: w.quelle }]));
    }
    case 'hex_einstellungen': {
      const { leseHexEinstellungen } = await import('./hex-einstellungen.js');
      return stufenStand((await leseHexEinstellungen(project)).werte as unknown as Record<string, Record<string, unknown>>);
    }
    case 'shell_ausgabe_einstellungen': {
      const { leseShellAusgabeEinstellungen } = await import('./shell-ausgabe.js');
      return stufenStand((await leseShellAusgabeEinstellungen(project)).einstellungen as unknown as Record<string, Record<string, unknown>>);
    }
    case 'runtime_ueberwachung': {
      const { leseRuntimeUeberwachungEinstellungen } = await import('./runtime-ueberwachung.js');
      const e = await leseRuntimeUeberwachungEinstellungen() as unknown as Record<string, Record<string, unknown>>;
      return Object.fromEntries(Object.entries(e).map(([n, w]) => [n, { wert: w.wert, quelle: w.quelle, ebene: w.quelle === 'einstellung' ? 'global' : null, revision: w.gesetzt_am }]));
    }
    case 'agentennetzwerk': {
      const { leseNetzwerkKonfiguration } = await import('./agentennetzwerk.js');
      const k = await leseNetzwerkKonfiguration(project);
      return Object.fromEntries(Object.entries(k.einstellungen).map(([n, w]) => [n, { wert: w.wert, quelle: w.quelle, ebene: w.quelle === 'einstellung' ? 'global' : null }]));
    }
    default: return null;
  }
}

async function formeSchlank(action: string, args: Args, project: string | undefined, vorher: Record<string, WertStand> | null, res: Record<string, unknown>): Promise<Record<string, unknown>> {
  const setzen = istSetzen(action, args);
  switch (action) {
    case 'profil_schalter_status': {
      if (!Array.isArray(res.schalter)) return res;
      const { schalter, ausweis_kern, ...rest } = res;
      const k = ausweis_kern as Record<string, unknown> | undefined;
      return { ...rest,
        ...(k ? { ausweis_kern: { aktiv: k.aktiv, quelle: k.quelle, ...(k.letzter_fehler ? { letzter_fehler: k.letzter_fehler } : {}) } } : {}),
        ...(await katalogAntwort('profil_schalter', (schalter as ProfilProduktSchalterStand[]).map(schalterEintrag), args, { fehlendIn: aktiveSchalterIn })) };
    }
    case 'profil_schalter_setzen': {
      if (!Array.isArray(res.schalter)) return res;
      const f = s(args, 'profil_funktion') ?? '';
      const nach: Record<string, WertStand> = Object.fromEntries((res.schalter as ProfilProduktSchalterStand[]).map((x) => [x.funktion as string, { wert: x.aktiv, ebene: x.ebene, quelle: x.quelle, revision: x.gesetzt_am }]));
      const namen = f === 'alle' ? ALLE_FUNKTIONEN.filter((n) => !vorher || !gleich(vorher[n], nach[n])) : [f];
      const geaendert = diff([...namen], vorher, nach);
      const unveraendert = geaendert.some((g) => g.wirksam_unveraendert);
      return { success: true, action, project: res.project ?? project ?? null, ebene: s(args, 'ebene') ?? 'projekt', geaendert,
        ...(unveraendert ? { hinweis: 'Wirksamer Stand unveraendert (z. B. Projektregel ueberdeckt globale Regel, oder Wert war schon gesetzt).' } : {}),
        ...(f === 'alle' && !geaendert.length ? { hinweis: 'Kein wirksamer Stand geaendert.' } : {}) };
    }
    case 'reverse_einstellungen': {
      const werte = alsWerte(res.werte);
      if (setzen) {
        const namen = args.modus === 'setzen' ? objektSchluessel(args.reverse_werte) : textListe(args.reverse_namen);
        const nach: Record<string, WertStand> = Object.fromEntries(Object.entries(werte).map(([n, w]) => [n, { wert: w.wert, ebene: w.ebene, quelle: w.quelle }]));
        return { success: true, action, modus: res.modus, project: res.project, reverse_id: res.reverse_id ?? null, revision: res.revision,
          geaendert: diff(namen, vorher, nach, res.revision), ...(res.letzter_fehler ? { letzter_fehler: res.letzter_fehler } : {}) };
      }
      const { werte: _w, ...rest } = res;
      return { ...rest, einstellungen: await katalogAntwort('reverse_einstellungen', reverseKatalog(werte), args) };
    }
    case 'runtime_ueberwachung': {
      const einst = alsWerte(res.einstellungen);
      if (setzen) {
        const namen = args.ueberwachung_modus === 'setzen' ? objektSchluessel(args.ueberwachung_werte) : textListe(args.ueberwachung_namen);
        const nach: Record<string, WertStand> = Object.fromEntries(Object.entries(einst).map(([n, w]) => [n, { wert: w.wert, quelle: w.quelle, ebene: w.quelle === 'einstellung' ? 'global' : null, revision: w.gesetzt_am }]));
        return { success: true, action, modus: res.modus, geaendert: diff(namen, vorher, nach) };
      }
      if (args.ueberwachung_modus !== undefined && args.ueberwachung_modus !== 'status') return res;
      const { einstellungen: _e, ...rest } = res;
      return { ...rest, einstellungen: await katalogAntwort('runtime_ueberwachung', await runtimeKatalog(einst), args) };
    }
    case 'hex_einstellungen':
    case 'shell_ausgabe_einstellungen': {
      const quelle = alsWerte(action === 'hex_einstellungen' ? res.werte : res.einstellungen);
      if (setzen) {
        const namen = args.modus === 'setzen'
          ? objektSchluessel(action === 'hex_einstellungen' ? args.hex_werte : args.shell_ausgabe_werte)
          : textListe(action === 'hex_einstellungen' ? args.hex_namen : args.shell_ausgabe_namen);
        return { success: true, action, modus: res.modus, project: res.project ?? project ?? null, geaendert: diff(namen, vorher, stufenStand(quelle)),
          ...(res.letzter_fehler ? { letzter_fehler: res.letzter_fehler } : {}) };
      }
      const { werte: _w, einstellungen: _e, ...rest } = res;
      return { ...rest, einstellungen: await katalogAntwort(action, stufenKatalog(quelle), args) };
    }
    case 'agentennetzwerk': {
      const einst = alsWerte(res.einstellungen);
      if (setzen) {
        const nach: Record<string, WertStand> = Object.fromEntries(Object.entries(einst).map(([n, w]) => [n, { wert: w.wert, quelle: w.quelle, ebene: w.quelle === 'einstellung' ? 'global' : null }]));
        return { success: true, action, geaendert: diff(objektSchluessel(args.netzwerk_werte), vorher, nach) };
      }
      const { werte: _w, einstellungen: _e, ...rest } = res;
      return { ...rest, einstellungen: await katalogAntwort('agentennetzwerk', await netzwerkKatalog(einst), args) };
    }
    default:
      return res;
  }
}
