export { NETZWERK_FUNKTION, NETZWERK_EINSTELLUNGEN, NETZWERK_ADMIN_PARAMETER, leseNetzwerkKonfiguration, fuehreNetzwerkAdminAus, netzwerkEreignis, netzwerkArgumente, netzwerkText } from './services/agentennetzwerk.js';
export type { NetzwerkEinstellung, NetzwerkWerte, NetzwerkEreignis } from './services/agentennetzwerk.js';
export {leseReversePeRessourcenSchalter} from './services/reverse-pe-schalter.js';
export {leiteReverseIntelUm,istReverseIntelZiel,pruefeReverseIntelZiel,bezeugeReverseIntelZiel,reverseIntelVerlauf,REVERSE_INTEL_ZEUGE} from './services/intel-reverse-weiche.js';
export {reverseGlobalSichtbar,reverseEintragSichtbar,leseReverseStand} from './services/reverse-sichtbarkeit.js';
export {leseReverseFehlerlog,loggeReverseFehler,loggeReverseMassnahme,reverseFehlerlogAktiv,reverseFehlerKomponente} from './services/reverse-fehlerlog.js';
export {REVERSE_FEHLERLOG_SCHEMA_SQL} from './db/reverse-fehlerlog-schema.js';
export {leseReverseDateienBelegt,gleicheReverseBelegungAb,reverseBelegungVerlauf,reverseBelegungModus} from './services/reverse-belegung.js';
export type {ReverseBelegungBefund,ReverseBelegungModus} from './services/reverse-belegung.js';
export {REVERSE_BELEGUNG_SCHEMA_SQL} from './db/reverse-belegung-schema.js';
export {REVERSE_AUFTRAEGE_VORGABEN_SCHEMA_SQL} from './db/reverse-auftraege-vorgaben-schema.js';
export {leseReverseEinstellwerte,leseReverseBlockSchalter,leseReverseProduktSchalter,reverseZahl,reverseWert,reverseBigInt,reverseBudget} from './services/reverse-einstellwerte.js';
export type {ReverseEinstellSnapshot} from './services/reverse-einstellwerte.js';
export {uebernehmeEInBloecken} from './services/reverse-e-bloecke.js';
export {reverseManifestVerweis,pruefeReverseManifest,leseReverseManifest} from './services/reverse-manifest.js';
export {REVERSE_EINSTELLKATALOG} from './services/reverse-einstellkatalog.js';
export {leseReverseSiedler3Schalter} from './services/reverse-siedler3-schalter.js';
export {leseReverseFortschrittSchalter,normalisiereReverseFortschritt,speichereReverseFortschritt,reverseFortschrittAnzeige,REVERSE_FORTSCHRITT_PHASEN,REVERSE_FORTSCHRITT_SQL} from './services/reverse-fortschritt.js';
export type {ReverseFortschrittStand} from './services/reverse-fortschritt.js';


/**
 * Synapse Core
 * Gemeinsamer Kern fuer MCP Server und REST API
 *
 * @packageDocumentation
 */

export { fuehreSpecialistIdentitaetsAktion } from './services/specialist-identitaet.js';
export { AGENT_BEZUG_SCHEMA_SQL } from './db/agent-bezug-schema.js';
export { beginneIdentitaetsSitzung, holeIdentitaetsSitzung, listeIdentitaetsSitzungen, beruehreIdentitaetsSitzung, beendeIdentitaetsSitzung } from './services/agent-identitaet-sitzungen.js';
export type { AgentIdentitaetSitzung } from './services/agent-identitaet-sitzungen.js';
// P22-T15: pro Aufruf isolierter Principal, Ziel und Routingmodus.
export { aktuelleAgentAkteurIdentityId, AGENT_BEZUG_MODI, istAgentBezugModus, leseAgentBezugModus, agentPrincipalAusAnmeldung, agentSchluessel, gleicherAgent, mitAgentAufrufKontext, aktuellerAgentAufruf, aktuellerAgentPrincipal, agentBezugFuer, aktuelleAgentIdentityId, loeseAgentZiel } from './services/agent-bezug.js';
export type { AgentBezugModus, AgentBezugStand, LegacyAgentZiel, IdentitaetsAgentZiel, AgentZiel, IdentitaetsAgentPrincipal, AgentPrincipal, AgentAufrufKontext } from './services/agent-bezug.js';

// P22-T10: Gemeinsamer Identitaetskern fuer stdio, REST und Daemonadapter.
export { leseTokenIdentitaetSchalter, stelleAgentTokenAus, meldeAgentMitTokenAn, pruefeAgentToken, widerrufeAgentToken, deaktiviereAgentIdentitaet, hashAgentToken, AgentIdentitaetFehler } from './services/agent-identitaet.js';
export type { TokenIdentitaetSchalter, AgentIdentitaet, AgentTokenAnmeldung, AgentTokenAusgabe, AgentTokenAusstellen, AgentIdentitaetPrincipal } from './services/agent-identitaet.js';
// P18-T28/RV18: gezielter optionaler files(read)-Vergleich.
export {refVergleich,REF_VERGLEICH_PARAMETER} from './services/ref-vergleich.js';
export type {RefVergleichDb,RefVergleichOptionen} from './services/ref-vergleich.js';
export { registriereHinweisQuelle, baueHinweisKontext, haengeAusloeserHinweiseAn, haengeAusloeserTextHinweiseAn, holeAusloeserHinweisMetriken, fuehreHinweisprofilAdminAus } from './services/ausloeser-hinweise.js';
export type { HinweisKontext, AusloeserHinweis, HinweisQuelle, HinweisOptionen, HinweisMetrik } from './services/ausloeser-hinweise.js';
// P13-T32/A14: API-only Ansichtsdienst, RV16 registriert den Reverse-Adapter.
export {AssetAnsichtDienst,projektAnsichtAdapter} from './services/asset-ansicht.js';
export type {AnsichtBereich,AssetAnsichtReferenz,AssetAnsichtQuelle,AssetAnsichtQuellenAdapter,AssetAnsichtLinkRueckfall,AssetAnsichtErgebnis} from './services/asset-ansicht.js';
export {AssetAnsichtFehler,FfmpegAnsichtRenderer,kodiereAnsichtPng,pruefeAnsichtPng} from './services/asset-ansicht-renderer.js';
export type {AssetAnsichtRenderer,AnsichtRenderGrenzen,AnsichtRaster} from './services/asset-ansicht-renderer.js';
// P13-T33/A15: Ansicht-Links (Capability-Tokens mit Timer), Erzeugung nur nach Auth (A16).
export {AnsichtLinkDienst,AnsichtLinkFehler,standardAnsichtLinkDienst,gemeinsamerAnsichtDienst,ladeAnsichtLinkKonfiguration,ansichtClientIp,istOeffentlicherAnsichtPfad,bereinigeAnsichtLinkRetention,ANSICHT_LINK_PFAD,ANSICHT_TOKEN_MUSTER} from './services/asset-ansicht-link.js';
export type {AnsichtLinkKonfiguration,AnsichtLinkArt,AnsichtLinkQuellenDienst,AnsichtLinkEingang,AnsichtLinkErzeugung,AnsichtAbrufMeta,AnsichtAbruf,AnsichtLinkStatus,AnsichtLinkEintrag,AnsichtLinkOptionen} from './services/asset-ansicht-link.js';
export {ASSET_ANSICHT_LINK_SCHEMA_SQL} from './db/asset-ansicht-link-schema.js';
// P18-T26/RV16: Reverse-Retentionhalter (A14) und Bindungsprüfung beim Linkabruf (A15).
export {ReverseAnsichtRetention,standardReverseAnsichtRetention,reverseAnsichtHalter,pruefeReverseAnsichtBindung,REVERSE_ANSICHT_WIDERRUF_GRUENDE} from './services/reverse-ansicht-retention.js';
export type {ReverseAnsichtHalter,ReverseBindungsErgebnis} from './services/reverse-ansicht-retention.js';
export {reverseAnsichtAdapter,holeReverseAnsichtDatei} from './services/reverse-ansicht-adapter.js';
export {fuehreReverseAnsichtAus,setzeReverseAnsichtDienste} from './services/reverse-ansicht-ausgabe.js';
export {REVERSE_ANSICHT_SCHEMA_SQL} from './db/reverse-ansicht-schema.js';
export {maskiereAnsichtLinks,ANSICHT_LINK_TOKEN} from './services/masken-katalog.js';
export {AssetKonfliktKern,holeAssetKonflikt} from './services/asset-konflikte.js';
export {ASSET_KONFLIKT_SCHEMA_SQL} from './db/asset-konflikt-schema.js';
export {assetKonfliktHinweisQuelle,initialisiereAssetKonfliktHinweise} from './services/asset-konflikt-hinweise.js';

export {ReverseEingang,reverseEingang} from './services/reverse-eingang.js';
export type {ReverseAbmeldung} from './services/reverse-eingang.js';
export type {ReverseFundDatei,ReverseGruppenDatei,ReverseMediumVorschlag,ReverseGruppenvorschlag} from './services/reverse-gruppierung.js';
export {reverseGruppieren,reverseOrdnerFingerabdruck,reverseArchivMagic} from './services/reverse-gruppierung.js';
// P18-T40/T42 Teil A: nur Vertrag und Registry-Persistenz; keine Leser-Ausführung/Tool-Aktionen.
export {REVERSE_LESER_SCHNITTSTELLE,REVERSE_LESER_TYPEN,ReverseLeserFehler,pruefeReverseLeserManifest,reverseLeserSchrittBudget,reverseLeserKanonisch,reverseLeserHash,reverseLeserPfad,reverseLeserDezimal} from './services/reverse-leser-vertrag.js';
export type {ReverseLeserManifest,ReverseLeserQuelle,ReverseLeserQuellbeleg,ReverseLeserEingabe,ReverseLeserEreignis,ReverseLeserObjektTyp} from './services/reverse-leser-vertrag.js';
export {registriereReverseLeserEntwurf,leseReverseLeserRevision,listeReverseLeserRevisionen,leseReverseLeserSchalter} from './services/reverse-leser-registry.js';
export type {ReverseLeserDb,ReverseLeserRevision} from './services/reverse-leser-registry.js';
export {leseReverseLeserNachzugSchalter} from './services/reverse-leser-registry.js';
export {reverseLeserEintragAktiv,reverseLeserNachziehen,planeReverseLeserNachzug,reverseLeserNachzugFreigegeben,reverseLeserProjektarbeitVorrang,meldeReverseLeserKandidat} from './services/reverse-leser-nachzug.js';
export {REVERSE_LESER_SCHEMA_SQL} from './db/reverse-leser-schema.js';
export {REVERSE_LESER_RUNTIME_SCHEMA_SQL} from './db/reverse-leser-runtime-schema.js';
export {ReversePolicyFehler,istReversePolicyFehler,sperreReversePolicy,bereiteReversePolicyPin,pruefeReversePolicyAuftrag,halteReversePolicyAuftrag,reversePolicyMinimum} from './services/reverse-analyse-policy.js';
export {LESER_RUNTIME_DATEIEN,LESER_RUNTIME_VERTRAG,pruefeLeserRuntimeImage,pruefeLeserRuntimePin,pruefeLeserRuntimeIndex,pruefeLeserRuntimeQuelle,leserRuntimePin} from './services/reverse-leser-runtime-vertrag.js';
export type {LeserRuntimeImage,LeserRuntimeIndex,LeserRuntimeQuelle,LeserRuntimePin} from './services/reverse-leser-runtime-vertrag.js';
export {LESER_RUNTIME_ACTIONS,LESER_RUNTIME_PARAMETER,LESER_RUNTIME_FELDER,fuehreLeserRuntimeAus} from './services/reverse-leser-runtime-tool.js';
export {leseLeserRuntimeVerwaltung,leseLeserRuntime,leseLeserRuntimeStandard,waehleLeserRuntimePin,pruefeLeserRuntimeBindung,pruefeLeserRuntimeSnapshot,stelleLeserRuntimeBereit,setzeLeserRuntimeStandard} from './services/reverse-leser-runtime.js';
export {LESER_ACTIONS,LESER_PARAMETER,LESER_FELDER,fuehreReverseLeserAus,pruefeReverseLeserVerwalter} from './services/reverse-leser-tool.js';
export {materialisiereReverseLeser,stelleReverseLeserPaketBereit,reverseLeserDateipfad,pruefeReverseLeserDatei,reverseLeserTxBudget} from './services/reverse-leser-materialisierung.js';
export type {ReverseLeserMaterialisierung} from './services/reverse-leser-materialisierung.js';
// P18-T19/RV9: eine Reverse-Definition, der Dispatcher läuft serverseitig.
export { REVERSE_DEFINITION, REVERSE_ACTIONS, REVERSE_FEHLERCODES, REVERSE_NULL_FELDER, REVERSE_AKTIVITAET_DESCRIPTOR, ReverseFehler, baueReverseAntwort, pruefeReversePfad, pruefeReverseBindung, createReverseToolService, fuehreReverseAus, configureReverseRuntime } from './services/reverse-tool.js';
export type { ReverseAction, ReverseFehlercode, ReverseContainerInfo, ReverseAnalyseAnfrage, ReverseRuntime, ReverseToolDependencies } from './services/reverse-tool.js';
// P18-T59: einzelne Reverse-Runtime-Hooks additiv setzen (containerStatus vom RV12-Executor).
export { ergaenzeReverseRuntime } from './services/reverse-tool.js';
// P18-T61/R1-C: E-Ergebnis eines Reverse-Container-Auftrags in die Bibliothek übernehmen.
export { uebernehmeEErgebnis, reverseEGruppe, ReverseEUebernahmeFehler } from './services/reverse-e-uebernahme.js';
export {eMutation,eFachauftrag,eCheckpoint,eArbeitsBeleg,eDateiExists,eRueckhaltBeleg,eAbschluss,eRetentionsJournal} from './services/reverse-e-fortsetzung.js';
export type { ReverseEManifestEintrag, ReverseEUebernahmeOptionen } from './services/reverse-e-uebernahme.js';
// P18-T69: reverse-S3 (Ghidra) -> S2/S3 in die Code-Tabellen; Ressourcenbedarf je Container-Kind.
export { uebernehmeS3Ergebnis, reverseS3AusgabeKey, ReverseS3UebernahmeFehler } from './services/reverse-s3-uebernahme.js';
export type { ReverseS3Ergebnis, ReverseS3UebernahmeOptionen } from './services/reverse-s3-uebernahme.js';
export { reverseResourceNeedRoh, REVERSE_S3_RESOURCE_NEED_STANDARD, reverseStornoAnfordern, reverseStornoAngefordert, REVERSE_STORNO_EVENT, leseReverseAufsicht, REVERSE_HART_PUFFER_MAX_S } from './services/reverse-ausfuehrer.js';
// P18-T49/RV34: Spurtabelle der Disc-Images (identisch zu docker/synapse-reverse/disc.py).
export { REVERSE_SPURTABELLE_VERSION, REVERSE_SPUR_MODI, REVERSE_SPUR_SEKTORGROESSEN, ReverseSpurtabellenFehler, pruefeReverseSpurtabelle, reverseSpurSchritt } from './services/reverse-spurtabelle.js';
export type { ReverseSpurtabelle, ReverseSpurSession, ReverseSpur, ReverseSpurAbschnitt, ReverseSpurIndex, ReverseSubchannel, ReverseSpurModus } from './services/reverse-spurtabelle.js';
export { reverseBisSchichtGrenze, begrenzeReverseSchicht } from './services/reverse-tool.js';
// P18-T64: Ausführer-Registry, Diagnose und Entstörer der Reverse-Aufträge.
export { REVERSE_EXECUTOR_UNTERSTUETZT, meldeReverseAusfuehrer, reverseAusfuehrer, reverseKindAusfuehrbar, zerlegeReverseFehlercode, reverseFehlerDeterministisch } from './services/reverse-ausfuehrer.js';
export type { ReverseAusfuehrerInfo } from './services/reverse-ausfuehrer.js';
export { diagnoseReverse, entstoereReverse, starteReverseEntstoerer, REVERSE_URSACHEN, REVERSE_ENTSTOERBAR } from './services/reverse-entstoerer.js';

// P18-T12/RV2: feste interne Bereiche für Projekt- und Reverse-Abfragen.
export { PROJEKT_BEREICH, REVERSE_BEREICH, ASSET_BEREICH, REVERSE_ASSET_BEREICH } from './services/intel-bereich.js';
export type { CodeBereich, AssetBereich } from './services/intel-bereich.js';

export { mitUserHerkunft, aktuelleUserHerkunft, userHerkunftAusMetadata } from './services/user-herkunft.js';

// P6-T27: optionale Ghost-Schatten, Standardabfragen unveraendert.
export { mitCodeIntelSchatten, schattenCacheStatistik } from './services/code-intel-schatten.js';
// P16-T15: gemeinsame Typprüfung; API registriert nur den Projekt-Workspace als Abhängigkeitsort.
export { registriereTypWorkspacePruefer } from './services/typen-pruefung.js';
export type { TypAuftrag, TypPruefung } from './services/typen-pruefung.js';
// P16-T16 E1: projektweite Build-Pruefung; die rest-api meldet den Pruefcontainer an (registriereBuildPruefer).
export { registriereBuildPruefer, synchronisiereBuildBudget, buildPruefungZustand, wirksamesBuildBudget, BUILD_ACTIONS } from './services/build-pruefung.js';
export type { BuildAuftrag, BuildDatei, BuildDiagnose, BuildLaufErgebnis, BuildProjektLauf, BuildPrueferAnbindung, BuildStand } from './services/build-pruefung.js';
export { BUILD_PRUEFUNG_SCHEMA_SQL } from './db/build-pruefung-schema.js';
export type { RegelVerzeichnis } from './services/agent-rollen.js';
// P18-T11/RV1: gemeinsame Geheimnis-Maskierung für neue API-Verbraucher.
export { MASKEN_KATALOG, maskiereMitKatalog, zaehleMaskenTreffer } from './services/masken-katalog.js';
export type { MaskenBereich, MaskenEintrag, MaskenErsetzer } from './services/masken-katalog.js';
export {privateShellTestDbFreigabe} from './services/shell-db-freigabe.js';
// P10-T33: gemeinsame Shell-Maske, auch fuer Lage-/Audit-Daten.
export {maskiereShellAntwort,maskiereShellDaten,maskiereShellText,ladeShellWerte,mitShellAusgabe,shellSichtUnmaskiert} from './services/shell-maske.js';
export {claimHinweis,projektHinweisOption,projektHauptbranchOption,projektHauptbranchStatus} from './services/hinweis-drossel.js';
export {pruefeGitBranch,pruefeGitBranchName} from './services/git-branch.js';
// P10-T51: gemeinsame Tool-Antwort-Huelle (REST + stdio) und Thought-Suchvorschau.
export { ergaenzeToolHinweise, baueToolErgebnis, kompaktiereToolAntwort, kompaktiereTextErgebnis, toolAntwortKompaktAktiv, TOOL_ANTWORT_NULL_BEHALTEN } from './services/tool-antwort.js';
export type { ToolErgebnisHuelle, ToolErgebnisOptionen } from './services/tool-antwort.js';
export { kuerzeThoughtTreffer, thoughtVorschau, THOUGHT_VORSCHAU_ZEICHEN } from './services/thoughts.js';

export { holeAgentOnboarding } from './services/agent-onboarding.js';
export { searchTasks, searchPlans, suchePlanWissen, suchePlanTool, PLAN_SEARCH_PROPERTIES, taskIndex, taskNachzug, embeddeTaskNach, planSuchIndex, thoughtTaskFilter, taskVerknuepfungen } from './services/plan-suche.js';
export type { PlanSuchOptionen, PlanSuchTreffer, PlanSuchErgebnis, TaskPins, TaskVerknuepfungen } from './services/plan-suche.js';
export { PLAN_TASK_SCHEMA_SQL } from './db/plan-task-schema.js';

export { ermittleProjektAusPfad } from './services/project-registry.js';
export {validateToolDescriptor,registerToolDescriptor,setToolActivation,toolDescriptorHash,TOOL_CONTAINER_LOCK} from './services/tool-descriptor.js';
export type {ToolDescriptor,ToolControlAuthority} from './services/tool-descriptor.js';
export {registerWorkJobClaimGuard} from './services/work-job-guards.js';
export type {WorkJobClaimGuard} from './services/work-job-guards.js';

// P20-T18/R4.3: private Server-Bootgeneration in derselben Registry.
export {createServerExecutorIdentity,serverClaimOwner,startServerExecutor,serverExecutorMayClaim} from './services/server-executor.js';
export type {ServerExecutorIdentity,ServerExecutorFence} from './services/server-executor.js';

export { computeResourceBinding, computePhysicalDeviceKey, parseComputeNodeExtension, computeResourceSnapshot } from './vertrag/compute-ressourcen.js';
export type { ComputeNodeExtension, ComputeResources, ComputeMeasurement, ComputeCapability, ComputeResourceBinding } from './vertrag/compute-ressourcen.js';

export {computePolicyAktiv,leseComputePolicy,setzeComputePolicy,leseComputeProjektPolicy,setzeComputeProjektPolicy,ladeComputePolicySnapshot,pruefeComputeZuteilung,embeddingComputePolicy,computePolicyStatus,ComputePolicyError} from './services/compute-policy.js';
export type {ComputePolicyDb,ComputePolicy,ComputeProjectPolicy,ComputePolicyPatch,ComputeAllocationInput,ComputeAllocationDecision,ComputeRecommendation,ComputePolicySnapshot} from './services/compute-policy.js';

// P20-T16/R4.1: gleicher Heartbeat-/Claim-Kanal für revisionsgefencete Soll-/Istzustände.
export {parseComputeControlCommand,parseComputeControlObservation} from './vertrag/compute-steuerung.js';
export type {ComputeControlCommand,ComputeControlObservation,ComputeControlResponse,ComputeControlAction} from './vertrag/compute-steuerung.js';
export {computeControlEnabled,setComputeNodeControl,computeNodeControlResponse,observeComputeNodeControl} from './services/compute-node-control.js';

// P20-T15/R2.2: ein PG-Admission-Gate und API-only Adapter für PC-Knoten.
export {computeAdmissionAktiv,computeAdmissionDomain,createComputeAdmission,configureLocalComputeAdmission,configureRemoteComputeAdmission,mitComputeAdmissionKontext,mitComputeAdmission,ComputeAdmissionError} from './services/compute-admission.js';
export type {AdmissionIdentity,AdmissionInput,AdmissionLease,AdmissionRemote,AdmissionContext,AdmissionPool} from './services/compute-admission.js';

// Konfiguration
export { loadConfig, getConfig, resetConfig } from './config.js';
export {
  DEFAULT_ASSET_LIMITS,
  DEFAULT_ASSET_MAX_OBJECTS_PER_FILE,
  DEFAULT_ASSET_RESTORE_WINDOW_MS,
  ladeAssetKonfiguration,
  loeseAssetProjektoptionen,
  getAssetKonfiguration,
  resetAssetKonfiguration,
} from './config/asset-konfig.js';
export type {
  AssetSyncRichtung,
  AssetKonfiguration,
  AssetProjektOptionen,
  WirksameAssetProjektoptionen,
} from './config/asset-konfig.js';

// P13-T22/A4: nullable, revisionsgefuehrte Projekt-Assetoptionen.
export { ladeAssetProjektoptionen, setzeAssetProjektoptionen } from './services/asset-projekt-optionen.js';
export type { AssetProjektOptionenEintrag, PersistierteAssetProjektoptionen } from './services/asset-projekt-optionen.js';

// Guide-Content (Tool-Doku, geteilt zwischen REST-API und MCP-Server)
export { GUIDE_OVERVIEW, TOOL_GUIDES } from './guide/index.js';
export type { ToolGuide, ActionGuide } from './guide/index.js';

export { lokalerProjektpfad, pruefeWrapperProzess, stoppeLokalenWrapper, reapLokaleWrapper, registriereWrapperSkript, erwarteteWrapperSkripte } from './services/wrapper-prozess.js';
// P9-T27: Daemon-Job-Vertrag (Shell-/Spezialisten-Jobs des lokalen Daemons ueber die API)
export {
  DAEMON_JOB_WARTE_MAX_S,
  DAEMON_JOB_MAX_JE_ABRUF,
  istGueltigeDaemonId,
  leseProjektListe,
  holeShellJobsFuerDaemon,
  schliesseShellJobFuerDaemon,
  gibShellJobZurueck,
  shellAbbruchWuensche,
  holeSpecialistJobsFuerDaemon,
  schliesseSpecialistJobFuerDaemon,
  gibSpecialistJobZurueck,
  lokalerProjektpfadFuerHost,
  wrapperReapKandidaten,
  markiereWrapperAbgestuerzt,
  schliesseDaemonJobWecker,
} from './services/daemon-jobs-vertrag.js';
export type { ShellDaemonAbruf, SpecialistDaemonJob, WrapperReapKandidat, DaemonAbschlussErgebnis } from './services/daemon-jobs-vertrag.js';
// P9-T27 Welle 2: Shell-Kontext (execShellInProject ohne PG im Daemon), Host-Filter, Wrapper-Stop-Zugriff
export { projekteDesHosts } from './services/daemon-jobs-vertrag.js';
export { ladeShellExecKontextFuerDaemon, speichereShellSicherungFuerDaemon, passwortfreieDbUrl, verworfenHinweis } from './services/shell-exec-kontext.js';
export type { ShellExecKontext, ShellExecKontextDaten, ShellSicherungEingabe, ShellKontextFehler } from './services/shell-exec-kontext.js';
export type { WrapperStopZugriff, WrapperStopOptionen } from './services/wrapper-prozess.js';
// P9-T27 letzter Schritt: Daemon ohne DATABASE_URL (Datei-Sync, Index, project-init, Tray ueber die API)
export { sperreDbZugriff, dbZugriffGesperrt } from './db/client.js';
export { pgWatcherDatenweg } from './watcher/datenweg.js';
export type { WatcherDatenweg, PgFsZeile, PgFsLoeschZeile, PgFsSeiten } from './watcher/datenweg.js';
export { setzeIgnoreRegelQuelle, ladeIgnoreRegelZeilen } from './watcher/ignore.js';
export type { IgnoreRegelZeile } from './watcher/ignore.js';
export { speichereDateiInhalt, indexiereDateiInhalt } from './services/code.js';
export { indexiereExtrahiertesDokument } from './services/documents.js';
export { pgSyncDateiZugriff } from './services/intern-diagnose-daemon.js';
export type { SyncDateiPgZugriff, SyncDateiZeile } from './services/intern-diagnose-daemon.js';
export {
  istSyncPfad,
  registriereProjektFuerHost,
  eigenerProjectInitJob,
  registriereInitProjektFuerDaemon,
  schliesseGeloeschteZeileFuerDaemon,
  protokolliereWatcherEreignisse,
  trayWatcherEreignisse,
  trayDateiVersionen,
} from './services/daemon-sync-vertrag.js';
export type { WatcherEreignisEintrag } from './services/daemon-sync-vertrag.js';
export { getProjectRecordById } from './services/project-record-ids.js';
// P9-T27 Nachbesserung (291473c2 Nr. 1): Spezialisten-Aufraeumschritte projektgebunden
export { entferneAgentAusProjektChannels, meldeAgentImProjektAb, sitzungsProjektDesAgenten, andereProjekteDesAgenten, entferneInboxImProjekt } from './services/spezialisten-projektbindung.js';
export type { ProjektInboxErgebnis } from './services/spezialisten-projektbindung.js';

// PostgreSQL
export { setzeDbProzess, verbindeListenClient, getPool, getHintergrundPool, imHintergrund, istImHintergrund, testDatabaseConnection, closePool, ensureSchema, pruefeSchema, stelleSchemaSicher, schemaModus, leereSchemaWarnung, SCHEMA_KENNUNG } from './db/index.js';
export type { SchemaModus, SchemaPruefung, SchemaStandArt, SchemaSicherErgebnis } from './db/index.js';

// Typen
export { ProjectRestoreService,ProjectRestoreError } from './services/project-restore.js';
export type { RestoreCodeEntry,RestoreJob } from './services/project-restore.js';
// P9-T30: virtuelle API-Projekte nie an einen PC binden + Host-Bindung gezielt loesen.
export { VIRTUELLE_SYSTEMPROJEKTE, VIRTUELLER_HOST, virtuelleProjekte, istVirtuellesProjekt, istVirtuellerRegistryPfad, VirtuellesProjektFehler, pruefeNichtVirtuell } from './services/virtuelle-projekte.js';
// P22-T36: reservierter, unsichtbarer Bereich der Hauptagenten-Identitaet.
export { HAUPTAGENT_PROJEKT, UNSICHTBARE_SYSTEMPROJEKTE, istUnsichtbaresProjekt } from './services/virtuelle-projekte.js';
export { HOST_LOESEN_MODE, HostLoesenFehler, projektHostLoesen, claimHostLoesungen, schliesseHostLoesung } from './services/project-host-loesen.js';
export type { HostLoesenAuftrag } from './services/project-host-loesen.js';
// P9-T31: sicheres Loeschen nur mit rechnergebundenem Loesch-Code (Agent, Tray, Web-UI).
export { LOESCH_TOKEN_SCHEMA_SQL } from './db/loesch-token-schema.js';
export { LoeschTokenFehler, loeschTokenStatus, loeschTokenEinrichten, loeschTokenBestaetigen, pruefeLoeschCode, pruefeLoeschHost, normiereLoeschCode, findeZeitschritt, totpCode, base32Kodieren, base32Dekodieren, zeitschrittVon, LOESCH_TOTP_AUSSTELLER, pruefeLoeschLoginMitSperre, LOESCH_LOGIN_SPERRE_FEHLVERSUCHE, LOESCH_LOGIN_SPERRE_MINUTEN } from './services/loesch-token.js';
export type { LoeschTokenStatus } from './services/loesch-token.js';
export { ProjektLoeschenFehler, projektLoeschenVorschau, projektLoeschenAusfuehren, loeschAuftragStatus, claimOrdnerLoeschungen, schliesseOrdnerLoeschung, istGeschuetztesProjekt, projektCollections, LOESCH_UMFAENGE } from './services/projekt-loeschen.js';
export type { LoeschUmfang, LoeschQdrant, LoeschVorschauEingabe, LoeschAusfuehrenEingabe, OrdnerLoeschJob } from './services/projekt-loeschen.js';
export * from './types/index.js';

// P13-T25/A7: konsistente Manifeste und revisionierte explizite Pfadmutationen.
export { ShareScanner, shareScanner, registriereShareScannerBereich, starteShareScanner } from './services/share-scanner.js';
export type { ShareScanWurzel,ShareScanDatei,ShareScannerHandler,ShareScannerStore,ShareScanCheckpoint } from './services/share-scanner.js';
export { registriereProjektShareScanner } from './services/share-scanner-projekt.js';
export { AssetRetention,starteAssetRetention } from './services/asset-retention.js';
export { AssetManifestKern } from './services/asset-manifest.js';
export type { AssetMutationArt,AssetMutationEingang } from './services/asset-manifest.js';
export type { AssetPfadOperation } from './services/asset-speicher.js';

// P13-T24/A6: ein Upload-/Downloadkern für Projekt und Reverse.
export { AssetUploadKern, AssetUploadFehler } from './services/asset-upload.js';
export type { AssetUploadKontext, AssetUploadEingang, AssetUploadSitzung, AssetUploadErgebnis, AssetUploadDb, AssetUploadFinalisierer, AssetDownloadReferenz, AssetDownloadBeschreibung, AssetDownloadRange } from './services/asset-upload.js';

// P13-T21/A3: serverseitiger Bytezugang, Staging und bestätigte Crash-Recovery.
export { AssetSpeicher, AssetSpeicherFehler, normalisiereSpeicherPfad, erzeugeReverseId } from './services/asset-speicher.js';
export type { AssetAdresse, AssetStaging, AssetOperation, AssetPublishOptionen, AssetRecoveryOptionen, AssetSpeicherLayout, ReverseLayout, ReverseManifestDatei, ReverseManifest, ReversePublishOperation, ReversePublishOptionen } from './services/asset-speicher.js';

// Asset-Intel (Nicht-Quellcode-Dateien): Inspektion + Speichern (P4-T60 ff., P4-T67)
export * from './asset-intel/index.js';
export {
  speichereAssetErgebnis,
  AssetInspektionsRevisionFehler,
  markiereAssetQuelleFehlt,
  benenneAssetUm,
  aktualisiereVerweisZiel,
  entferneAssetsEndgueltig,
  findeVerschobenesAsset,
  loesePfadAuf,
  normalisiereAssetPfad,
  dateisystemPruefer,
  ASSET_MAX_OBJEKTE_STANDARD,
  ASSET_LOESCHFRIST_TAGE,
} from './services/asset-intel-store.js';
export type {
  AssetAufloesung,
  AufloesungsKontext,
  VerweisAufloesung,
  SpeicherOptionen,
  SpeicherErgebnis,
  QuelleFehltErgebnis,
  EntfernenOptionen,
} from './services/asset-intel-store.js';
// Asset-Intel: Indexierung im lokalen Watcher (P4-T67, Etappe D)
export {
  verarbeiteAssetEreignis,
  verifyAssetsAgainstFilesystem,
  konfiguriereAssetSync,
  assetSyncZaehler,
  setzeAssetSyncZaehlerZurueck,
  assetWegAbgeschaltet,
  setzeAssetWegZurueck,
  warteAufAssetLeerlauf,
  beendeAssetSync,
} from './services/asset-intel-sync.js';
export type { AssetSyncKonfiguration, AssetSyncZaehler, AssetVerifyErgebnis } from './services/asset-intel-sync.js';
export { AssetInspektionsWorker, WORKER_GNADENFRIST_MS } from './asset-intel/worker-runner.js';
export {assetProjektNutztShare,setzeAssetInspektionsModus} from './services/asset-inspektions-projekte.js';
export {starteAssetInspektion,AssetInspektionsDienst} from './services/asset-inspektion.js';
export {starteReversePipeline,ReversePipelineDienst,reverseAnalyseFingerabdruck,maskiereReverseAnalyse} from './services/reverse-pipeline.js';
export {REVERSE_PIPELINE_SCHEMA_SQL} from './db/reverse-pipeline-schema.js';
export {starteApiAuftragsLoop} from './services/api-auftrags-loop.js';
export type { WorkerInspektionsOptionen } from './asset-intel/worker-runner.js';
export { assetArt, assetEndungen, leseDateiKopf, KOPF_BYTES } from './watcher/binary.js';
export type { AssetArt } from './watcher/binary.js';
// Asset-Intel Lesen + Tool asset_intel (P4-T67/T70, Etappe B1)
export {
  holeAssetBaum,
  inspiziereAusDb,
  holeObjekte,
  holeVerweise,
  holeBenutztVon,
  holeFehlende,
  holeGraph,
  holeWurzelnUndWaisen,
  sucheAssets,
  sucheAssetsBatch,
  movePreview,
  assetHealth,
  parseAssetFilter,
  zerlegeSuchanfrage,
  kappeAntwort,
  escapeLike,
  AssetIntelFehler,
  ASSET_ANTWORT_MAX,
  ASSET_DATA_WERT_MAX,
  ASSET_MAX_FILTER,
  ASSET_GRAPH_MAX_TIEFE,
  ASSET_LESE_TIMEOUT_MS,
  ASSET_STATUS,
} from './services/asset-intel-abfragen.js';
export type {
  AssetFilter,
  AssetFilterOp,
  BaumOptionen,
  InspektionsOptionen,
  AssetInspektion,
  ObjektOptionen,
  VerweisOptionen,
  GraphOptionen,
  AssetGraph,
  SuchOptionen,
} from './services/asset-intel-abfragen.js';
export { ASSET_INTEL_DEFINITION, ASSET_INTEL_ACTIONS, fuehreAssetIntelAus } from './services/asset-intel-tool.js';
export {hexTypBreite,deuteHexPrimitive,fuehreHexDeutenAus} from './services/hex-deuten.js';
export {HEX_ANALYSEN_SCHEMA_SQL} from './db/hex-analysen-schema.js';
export {konfiguriereHexWorkIdentitaet,loeseHexWorkIdentitaet,hexWorkStatus} from './services/hex-work-job.js';
export {HEX_DEFINITION, HEX_ACTIONS, fuehreHexAus, hexZeilen} from './services/hex-tool.js';
export {HexFehler, hexGanzzahl, hexAkteur, pruefeHexZugang, pruefeHexRef, oeffneHexQuelle, mitHexQuelle} from './services/hex-quellen.js';
export type {HexRef, HexQuelle, HexQuellenArt} from './services/hex-quellen.js';
export {HEX_EINSTELLUNGEN, HEX_ADMIN_ACTIONS, HEX_ADMIN_PARAMETER, leseHexEinstellungen, fuehreHexAdminAus} from './services/hex-einstellungen.js';
export type {HexStand, HexWert, HexEinstellungName} from './services/hex-einstellungen.js';
export {HEX_SCHEMA_SQL} from './db/hex-schema.js';
export type { AssetIntelAction } from './services/asset-intel-tool.js';
// P13-T34/A16: Parameter ansicht (inline|link|beides) + MCP-Bildblock-Transport (REST + stdio).
export { ANSICHT_MODI, ANSICHT_PARAMETER, ANSICHT_SCHEMA_PROPERTIES, setzeMcpBilder, trenneMcpBilder, haengeMcpBilderAn, hatAnsichtParameter, pruefeAnsichtParameter, setzeAnsichtAusgabeDienste, ergaenzeAnsicht, mitCodeIntelAnsicht } from './services/asset-ansicht-ausgabe.js';
export type { AnsichtModus, McpBild, AnsichtParameterFehler, AnsichtAusgabeDienste, AnsichtKontext } from './services/asset-ansicht-ausgabe.js';
// P20-T14/R2.1: generische PG-Job-Leases, default ohne Ausführungsfreigabe.
export { createWorkJobService, configureWorkJobHooks, WorkJobError, validateWorkReference, validateWorkResources } from './services/work-jobs.js';
export type { WorkJobService, WorkJob, WorkJobInput, WorkIdentity, WorkJobGrant, WorkJobConfig, WorkJobHooks, WorkJobDependencies, WorkResourceNeed, WorkPriority, WorkJobPool, WorkJobClient, WorkNodeAuthority } from './services/work-jobs.js';
// Intern-Tool (P14): Schalter fuer interne Ablaeufe + Tool-Definition/Dispatcher (nur bei SYNAPSE_INTERN_TOOL=1)
export {
  INTERN_SCHALTER,
  InternSchalterFehler,
  setzeSchalter,
  leseSchalter,
  alleSchalter,
  hoechstdauerMs,
  istSchalterName,
  schalterHaeltAn,
  embeddingNachtragAngehalten,
} from './services/intern-schalter.js';
export type { InternSchalterName, InternSchalterStand, SetzeSchalterOptionen } from './services/intern-schalter.js';
// P15-T12: Worker-Steuerung im Prozess-Speicher (pausieren/fortsetzen/durchlauf) fuer das intern-Tool
export {
  registriereWorker,
  workerPausiert,
  meldeWorkerArbeit,
  pausiereWorker,
  setzeWorkerFort,
  loeseWorkerDurchlaufAus,
  workerStatus,
  workerNamen,
  workerPauseMaxMin,
  WorkerSteuerungFehler,
} from './services/worker-steuerung.js';
export type { WorkerDefinition, WorkerPause, WorkerStand, PausiereOptionen } from './services/worker-steuerung.js';
// P15-T12 E2: Befehle an lokale Daemons ueber den API-Long-Poll (nur Speicher)
export {
  DAEMON_BEFEHLE,
  DaemonBrueckeFehler,
  holeDaemonBefehle,
  stelleDaemonBefehleZurueck,
  meldeDaemonAntwort,
  meldeDaemonStatus,
  daemonUebersicht,
  sendeAnDaemon,
  istGueltigerHost,
  vergissDaemons,
} from './services/daemon-bruecke.js';
export type { DaemonBefehl, DaemonBefehlName, DaemonUebersicht } from './services/daemon-bruecke.js';
// P15-T23: Diagnose-Befehle im Daemon (sync_datei, parser_pool)
export { fuehreDiagnoseLokal, syncDateiLokal, DIAGNOSE_DAEMON_BEFEHLE } from './services/intern-diagnose-daemon.js';
export { skillNutzungLokal, parseSkillSessionJsonl } from './services/intern-nutzung-daemon.js';
export type { DiagnoseDaemonKontext } from './services/intern-diagnose-daemon.js';
// P15-T12 E3/E4: Warteschlangen einsehen/umsortieren (Speicher-Register je Prozess + PG in der API)
export {
  registriereWarteschlange,
  holeWarteschlange,
  warteschlangenNamen,
  vergissAlleWarteschlangen,
  seiteAusListe,
} from './services/warteschlangen-register.js';
export type {
  WarteschlangenDefinition,
  WarteschlangenEintrag,
  WarteschlangenFilter,
  WarteschlangenListe,
  VerschiebeAuftrag,
  VerschiebeZiel,
} from './services/warteschlangen-register.js';
export {
  WARTESCHLANGEN_ACTIONS,
  WarteschlangenFehler,
  fuehreWarteschlangeAus,
  fuehreWarteschlangeLokal,
  istWarteschlangenAction,
} from './services/intern-warteschlangen.js';
export {
  WAITS_ACTIONS,
  fuehreWaitsAus,
  istWaitsAction,
  toteWaitsListe,
  toteWaitsSichernUndSchliessen,
} from './services/intern-waits.js';
export type { ToterWait, WaitGeschlossen } from './services/intern-waits.js';
export { assetWarteschlange } from './services/asset-intel-sync.js';
export { embeddingWarteschlangeEintraege } from './embeddings/index.js';
export { listeFaelligeDateien } from './services/code.js';
export {
  INTERN_DEFINITION,
  INTERN_ACTIONS,
  INTERN_TOOL_AUS,
  internToolAktiv,
  fuehreInternAus,
  fuehreWorkerActionAus,
} from './services/intern-tool.js';
export type { InternAction } from './services/intern-tool.js';
export {
  InternOllamaFehler,
  ollamaStatus,
  ollamaEntladen,
  ollamaLaden,
  embeddingMessen,
  geladeneModelle,
  gleichesModell,
  ollamaBasis,
} from './services/intern-ollama.js';
export type { GeladenesModell } from './services/intern-ollama.js';
export { internStatus, dbSitzungen, langsameAufrufe, registriereInternQuelle } from './services/intern-einblick.js';
// Asset-Weiche code_intel <-> asset_intel + Baum-Marker (P4-T67/T70, Etappe C)
export {
  ergaenzeCodeIntelAntwort,
  loeseDateiWelt,
  projektHatAssets,
  vergissAssetStand,
  holeBaumAssets,
  assetMarker,
  assetSammelZeile,
  assetGroesse,
  findeCodeDatei,
  zaehleCodeDateien,
  BAUM_ASSETS_JE_VERZEICHNIS,
  WEICHE_SUCHTREFFER_MAX,
  WEICHE_SUCH_ZEITGRENZE_MS,
} from './services/asset-weiche.js';
export type { AssetKurz, DateiWelt, BaumAsset, BaumAssets } from './services/asset-weiche.js';

// Qdrant
export {
  getQdrantClient,
  testQdrantConnection,
  resetQdrantClient,
  collectionExists,
  ensureCollection,
  deleteCollection,
  ensureAllCollections,
  ensureProjectCollection,
  listCollections,
  getCollectionStats,
  getCollectionVectorSize,
  checkDimensionMatch,
  insertVector,
  insertVectors,
  searchVectors,
  deleteVector,
  deleteVectors,
  deleteByFilter,
  deleteByFilePath,
  deleteByProject,
  getVector,
  getVectors,
  scrollVectors,
} from './qdrant/index.js';

// Embeddings
export {
  getEmbeddingProvider,
  getEmbeddingDimension,
  embed,
  embedBatch,
  mitPraefix,
  aktivePraefixe,
  embeddingModellName,
  embeddingModellKennung,
  // P15-T8: Modellprofile aus PG (Praefixe, num_ctx, Stueckgroesse, Score-Schwellen je Zweck)
  aktivesModellprofil,
  modellprofilStand,
  sichereModellprofil,
  geladenesModellprofil,
  vergissModellprofil,
  scoreSchwelle,
  scoreSchwelleOderHinweis,
  ModellNichtKalibriertError,
  SCORE_ZWECKE,
  zielDimension,
  getEmbeddingQueueStats,
  EmbeddingQueueFullError,
  embedMedia,
  supportsMultimodal,
  resetEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  OpenAICompatibleProvider,
  GoogleEmbeddingProvider,
  CohereEmbeddingProvider,
} from './embeddings/index.js';
// P15-T1: Modellwerte aus Ollama (Digest, Groesse, VRAM, Dimension, Kontext) statt fest verdrahtet
export { ollamaModellInfo, vergissOllamaModellInfo } from './embeddings/ollama-modell-info.js';
export type { OllamaModellInfo } from './embeddings/ollama-modell-info.js';
export type {
  EmbeddingProvider,
  EmbedOptions,
  EmbedPriority,
  EmbeddingQueueStats,
} from './embeddings/index.js';

// FileWatcher
export {
  startFileWatcher,
  readFileWithMetadata,
  isBinaryFile,
  isBinaryExtension,
  isExtractableDocument,
  isMultimodalFile,
  klassifiziereDatei,
  getMediaMimeType,
  getMediaCategory,
  getFileType,
  getFileExtension,
  loadGitignore,
  shouldIgnore,
  createDefaultIgnore,
  getDefaultIgnores,
} from './watcher/index.js';
export type { FileWatcherOptions, FileWatcherInstance } from './watcher/index.js';
export {istGesperrt} from './watcher/ignore.js';

// Chunking
export { chunkText, chunkFile } from './chunking/index.js';
export type { ChunkOptions, TextChunk } from './chunking/index.js';

// Services
export {
  // Project Registry
  registerProject,
  getProjectRoot,
  listeProjekte,
  toRelativePath,
  toAbsolutePath,
  registerVirtualProject,
  setProjectEnabled,
  isProjectEnabled,
  getProjectRegistryRows,
} from './services/project-registry.js';
export type { ProjectRegistryRow, ProjektEintrag } from './services/project-registry.js';

// Symbol umbenennen auf Basis der aufgeloesten Referenzen (Vorschau; die
// Ausfuehrung laeuft ueber den normalen Mehrfach-Schreibweg).
export { planeUmbenennung } from './services/code-rename.js';
export type {
  UmbenennungsPlan,
  UmbenennungsStelle,
  UebersprungeneStelle,
} from './services/code-rename.js';

// Specialist Respawn Trigger (geteilt zwischen stdio MCP + REST API)
export { maybeTriggerRespawn } from './services/specialist-respawn.js';
export type { RespawnDecision } from './services/specialist-respawn.js';

// Agent-ID Resolver (zentrale Fallback-Logik fuer audit-relevante Schreib-Ops)
export { resolveAgentId } from './services/agent-id-resolver.js';

export { mitAgentToolAufruf, bereiteAgentToolAufrufVor, ergaenzeAgentTokenParameter, beworbeneAgentTools, AGENT_TOKEN_PARAMETER } from './services/agent-token-tools.js';
export type { AgentToolKontext, AgentToolAufrufOptionen, BestaetigterAufrufKontext } from './services/agent-token-tools.js';
// P22-T13 Phase V: W1b-Vertrag, Gate-Kern, Selbstfelder, Schalter, Tokentresor, Schema 113.
export { gateToolListe, bestaetigterAufrufKontext } from './services/agent-token-tools.js';
export * from './services/agent-profil-vertrag.js';
export * from './services/tool-gate.js';
export * from './services/agent-selbstfelder.js';
export * from './services/agent-profil-schalter.js';
// P23-T5: Fall-Skills (kurze Tool-Beschreibungen, Fall-Skill-Hinweis bei Fehlbedienung je Weg).
export * from './services/fall-skills.js';
// P23-T3: schlanke Tool-Antworten (Produkt-Schalter tool_antworten_schlank, Standard AUS).
export * from './services/tool-antworten-schlank.js';
// P22-T56: tools/list je Verbindung (Ausweis / Legacy / gemeinsam), Schalter tool_liste_je_verbindung.
export * from './services/tool-liste-verbindung.js';
export * from './services/tool-beschreibungen-kurz.js';
export { PAKET_A_DIENSTE, ProfilDienstFehler, pruefeProfilInhalt, leseWirksamenTypInhalt } from './services/agent-profil-dienst-a.js';
export * from './services/agent-token-tresor.js';
// P22-T13 Paket C: vollstaendiger Hinweiskatalog (Katalognamen zusaetzlich ueber agent-profil-vertrag),
// requestweiter Zuschnitt-Snapshot, Profilresolver und gemeinsame Antwortpipeline REST+stdio.
export { HINWEIS_PRODUZENTEN, PFLICHT_EVENT_TYPEN, pflichtAnteil, istPflichtFehlermuster, katalogIdFuerClaimArt, standardFuerStufe } from './services/hinweis-katalog.js';
export type { HinweisProduzent, HinweisFilter, HinweisStufe } from './services/hinweis-katalog.js';
export { hinweisAktiv, claimArtAktiv, aktuellerZuschnittSnapshot, holeZuschnittMetriken, hinweisBudgetMs, _zuschnittMetrikenZuruecksetzen } from './services/agent-zuschnitt-kontext.js';
export type { ZuschnittSnapshot, ZuschnittStufe, ZuschnittMessung, ZuschnittLimitAnpassung } from './services/agent-zuschnitt-kontext.js';
export { leseWirksamesProfil, bereiteZuschnittSnapshotVor, wendeProfilLimitsAn, projiziereToolAntwort, projiziereTextAntwort, projiziereAgentAntwort, zuschnittDiagnose, ZuschnittFehler, wirksamerZuschnittResolver } from './services/agent-zuschnitt.js';
// P22-T13 Paket D: Persona-Bibliothek, Tokenabruf, Verwaltungs-Dispatcher (admin + REST).
export { ProfilVerwaltungFehler, aktuellerW1bAkteur, pruefeProfilVerwalter, USER_AUFTRAG_STANDARD } from './services/agent-profil-verwalter.js';
export { personaDienst, listePersonaVorlagen, listePersonaVersionen, legePersonaVorlageAn, legePersonaVersionAn, weisePersonaZu, entfernePersona, lesePersonaZuweisung } from './services/agent-persona.js';
export { tokenAbrufDienst, rufeProfilTokenAb, rufeAusweisAb, loescheAusweis, rufeWebUiKoordinatorTokenAb } from './services/agent-token-abruf.js';
export { agentVorbereiten, ausweisFuerStart } from './services/agent-ausweis-dienst.js';
// P22-T36 (W2-P1): Hauptagent-Identitaet, Produkt-Schalter hauptagent, Rechte-Rahmen, generische Runtime-Auftraege.
export {
  HAUPTAGENT_FUNKTION, HAUPTAGENT_AGENT_ID, HAUPTAGENT_ROLLE, AUFTRAG_ARTEN, MAIN_SYNAPSE_MAPPING, HAUPTAGENT_ADMIN_ACTIONS, HAUPTAGENT_ADMIN_PARAMETER,
  leseHauptagentSchalter, setzeHauptagentSchalter, stelleMainIdentitaetSicher, hauptagentIdentitaetsId, hauptagentStatus,
  legeRuntimeAuftragAn, brecheRuntimeAuftragAb, listeRuntimeAuftraege, istHauptagentAdminAction, fuehreHauptagentAdminAus,
} from './services/hauptagent-dienst.js';
export type { HauptagentSchalterStand, MainIdentitaetErgebnis, AuftragEingabe, AuftragArt } from './services/hauptagent-dienst.js';
// P22-T7 (W2d): Heartbeat des Hauptagenten (Einstellung im Startrezept, nur User) + Verbrauch je Agent/Projekt/Monat (Schema 119).
export {
  HEARTBEAT_TAKT_MIN_MS, HEARTBEAT_STANDARD, hauptagentHeartbeatAusStartrezept, leseHauptagentHeartbeat, setzeHauptagentHeartbeat,
} from './services/hauptagent-dienst.js';
export type { HauptagentHeartbeatEinstellung } from './services/hauptagent-dienst.js';
export {
  VERBRAUCH_FUNKTION, VERBRAUCH_ZUGAENGE, VERBRAUCH_QUELLEN, leseVerbrauchSchalter, setzeVerbrauchSchalter, bucheAgentVerbrauch, leseAgentVerbrauch,
} from './services/agent-verbrauch.js';
export type { VerbrauchSchalterStand, VerbrauchBuchung, VerbrauchBuchungsErgebnis, VerbrauchZugang, VerbrauchQuelle } from './services/agent-verbrauch.js';
export { AGENT_VERBRAUCH_SCHEMA_SQL } from './db/agent-verbrauch-schema.js';
// P22-T8: kostenpflichtiger API-Agent (Schalter hauptagent Funktion api, globales Budget, Reservierung, Kosten), Schema 120.
export {
  HAUPTAGENT_API_FUNKTION, API_ANBIETER, API_ZEITRAEUME, API_EINSTELLUNG_NAMEN, API_EINSTELLUNG_STANDARD, API_AGENT_ADMIN_ACTIONS, API_AGENT_ADMIN_PARAMETER,
  leseApiFunktion, leseApiSchalter, setzeApiSchalter, leseApiEinstellungen, setzeApiEinstellungen, leseApiModelle, leseApiBudget, setzeApiBudget,
  entferneApiBudget, apiZeitraumBeginn, reserviereApiAufruf, schliesseApiAufrufAb, apiKostenAusUsage, apiKostenUebersicht, apiRahmenFuerAgent,
  apiAgentStatus, istApiAgentAdminAction, fuehreApiAgentAdminAus,
} from './services/api-agent-dienst.js';
export type {
  ApiZeitraum, ApiFunktionStand, ApiSchalterStand, ApiEinstellungName, ApiEinstellungen, ApiModellPreis, ApiBudgetStand, ApiReservierungEingabe,
  ApiReservierung, ApiUsage, ApiAbschlussEingabe, ApiAbschluss, ApiAgentAdminAction,
} from './services/api-agent-dienst.js';
export { AGENT_API_BUDGET_SCHEMA_SQL } from './db/agent-api-budget-schema.js';
// P22-T58 (W2e): Ueberwachung/Neustart der Runtime-Container durch die API (Schalter runtime_ueberwachung), Schema 122.
export {
  RUNTIME_UEBERWACHUNG_FUNKTION, UEBERWACHTE_RUNTIMES, RUNTIME_UEBERWACHUNG_EINSTELLUNGEN, RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN,
  RUNTIME_UEBERWACHUNG_ADMIN_ACTIONS, RUNTIME_UEBERWACHUNG_ADMIN_PARAMETER, RUNTIME_UEBERWACHUNG_MODI,
  leseRuntimeUeberwachungSchalter, setzeRuntimeUeberwachungSchalter, leseRuntimeUeberwachungEinstellungen, leseRuntimeUeberwachungWerte, setzeRuntimeUeberwachungEinstellungen,
  leseRuntimeStatusStabil,
  leseUeberwachungStaende, leseUeberwachungEreignisse, markiereRuntimeAngehalten, bewerteRuntime, fuehreUeberwachungsTaktAus,
  letzterUeberwachungsTakt, registriereUeberwachungsDienste, leseRuntimeUeberwachung, ueberwachungKurz, istRuntimeUeberwachungAdminAction,
  fuehreRuntimeUeberwachungAdminAus, registriereFreeAusfuehrer, fuehreCliUpdatesAus, leseUmzuege, meldeRuntimeKontingent, resetZeitMs,
} from './services/runtime-ueberwachung.js';
export type {
  UeberwachteRuntime, RuntimeUeberwachungSchalter, RuntimeUeberwachungEinstellungName, RuntimeUeberwachungWerte, RuntimeUeberwachungEinstellungen,
  UeberwachungZustand, Massnahme as UeberwachungMassnahme, UeberwachungStand, UeberwachungEreignis, ContainerBeobachtung, RuntimeBeobachtung,
  Entscheidung as UeberwachungEntscheidung, UeberwachungsDienste, TaktBericht as UeberwachungTaktBericht, FreeAusfuehrer, KettenRuntime, KettenSchritt,
} from './services/runtime-ueberwachung.js';
export { RUNTIME_UEBERWACHUNG_SCHEMA_SQL } from './db/runtime-ueberwachung-schema.js';
export { AGENT_RUNTIME_AUFTRAEGE_SCHEMA_SQL } from './db/agent-runtime-auftraege-schema.js';
// P22-T5 (W2b): Runtime-Daemon-Zugang (Service-Token je Runtime, Hostbindung wie Tray), Projekte des Container-Hosts.
export {
  RUNTIME_DAEMON_SCOPE_PRAEFIX, RUNTIME_PROJEKTE_WURZEL, runtimeDaemonScope, runtimeAusScope, runtimeProjektPfad, loeseRuntimeDaemonZugang,
  projekteDerRuntime, listeRuntimeProjekte, runtimeDaemonZugangStatus, bindeRuntimeDaemonZugang, widerrufeRuntimeDaemonZugang,
  verwerfeRuntimeDaemonToken, wrapperRuntime, projekteMitRuntimeAgenten,
} from './services/runtime-daemon-zugang.js';
export type { RuntimeDaemonBindung, RuntimeProjekt, RuntimeDaemonZugangStatus } from './services/runtime-daemon-zugang.js';
// P22-T6 (W2c): dauerhafter Main-Lauf im Container (Spawn/Wake ueber specialist_jobs mit target_runtime) + Ausfuehrung der Runtime-Auftraege.
export {
  MainLaufFehler, leseMainLaufOptionen, istMainLaufRuntime, HAUPTAGENT_EXPERTISE, HAUPTAGENT_AUFGABE, hauptagentContainerPfad,
  leseMainLauf, runtimeDaemonAngemeldet, werkzeugErgebnis, stelleMainLaufSicher, sendeMainTurn, heartbeatBeimSpawnFuerZiel,
  modellPasstZuRuntime, fuehreRuntimeWechselAus, beendeMainLauf, MAIN_STOP_FRIST_MS, MAIN_VERWAIST_MS,
} from './services/hauptagent-lauf.js';
// P22-T62: Modellwahl des Hauptagenten aus den CLI-Listen (Schalter hauptagent_cli_modelle).
export {
  HAUPTAGENT_CLI_MODELLE_FUNKTION, CLI_MODELL_RUNTIMES, CODEX_MODELL_PRAEFIX, CODEX_CLI_STANDARD, leseCliModelleSchalter,
  registriereCliModellKatalog, leseCliKatalog, synapseModellId, codexSlugAus, pruefeModellFuerRuntime, waehleKleinstesModell,
  standardModellFuerRuntime, leseUserModellWahl,
  // P22-T65: Effort-Stufe je Modell
  pruefeEffortFuerModell, leseEffortWahl, effortFuerStart, loeseClaudeKurznamenAuf, modellFamilie as katalogModellFamilie, FAMILIEN_ORDNUNG,
} from './services/hauptagent-modelle.js';
export type { CliModellRuntime, CliKatalog, KatalogModell, ModellPruefung, StandardModellWahl, CliModelleSchalter } from './services/hauptagent-modelle.js';
// P22-T63: Gespraechsverlauf des Hauptagenten-Chats je Main-Identitaet (Schalter hauptagent_verlauf, Standard EIN).
export {
  HAUPTAGENT_VERLAUF_FUNKTION, VERLAUF_DROSSEL_MS, VERLAUF_SEITE_STANDARD, leseVerlaufSchalter, setzeVerlaufSchalter, geraetAusUserAgent,
  legeVerlaufTurnAn, neuerAntwortStand, wendeStromEreignisAn, starteVerlaufAntwort, leseVerlauf, leereVerlauf, verlaufStatus, kontextAusGemessen, tatsaechlichesMainModell,
} from './services/hauptagent-verlauf.js';
export type {
  VerlaufSchalter, VerlaufWerkzeug, VerlaufWerkzeuge, VerlaufAnhang, VerlaufEintrag, VerlaufNichtVerfuegbar, VerlaufTurnEingabe, VerlaufTurn,
  VerlaufAntwortStand, VerlaufAntwortSchreiber, VerlaufAbfrage, VerlaufAntwort, VerlaufStatus, VerlaufRolle, VerlaufRichtung, VerlaufWeg,
  VerlaufGemessen, VerlaufKontext, VerlaufZug,
} from './services/hauptagent-verlauf.js';
export { HAUPTAGENT_VERLAUF_SCHEMA_SQL } from './db/hauptagent-verlauf-schema.js';
export { rendereToolBild, type ToolBildEingabe, type ToolBildErgebnis, type ToolBildDienste } from './services/hauptagent-bilder.js';
export { werkzeugBilder, ohneBilddaten, bildVerweisAusAufruf } from './services/werkzeug-bilder.js';
export type { VerlaufBild } from './services/hauptagent-verlauf.js';
export type { VerlaufZugKontext } from './services/hauptagent-verlauf.js';
export {
  schreibeZustellVerlauf, aktuellerMainLauf, aktuellesMainModell, importiereSitzungsEintraege, pruefeMainKorridor, erzeugeVerlaufUebergabe,
  zugewieseneMainRuntime, MAIN_HANDOFF_TEXT, mainStartkontext, leseVerlaufFuer, AGENT_VERLAUF_ALLE_FUNKTION,
} from './services/hauptagent-verlauf.js';
// P22-T82: Spezialisten im Runtime-Container (ort container, Kontingent je Projekt, Schema 127).
export {
  SPEZIALISTEN_CONTAINER_FUNKTION, SPAWN_ORTE, leseSpawnOrt, runtimeFuerModell, leseContainerKontingent, belegteContainerAgenten,
  spawneImContainer, spawneBatchImContainer, containerStatus, CONTAINER_ADMIN_ACTIONS, CONTAINER_ADMIN_PARAMETER, istContainerAdminAction,
  fuehreContainerAdminAus,
} from './services/agent-container.js';
export type { SpawnOrt, ContainerKontingent, ContainerSpawnEingabe } from './services/agent-container.js';
export { AGENT_CONTAINER_SCHEMA_SQL } from './db/agent-container-schema.js';
// P22-T113: Startort jedes Agenten (Schalter agent_start_ort, Schema 149).
export { AGENT_START_ORT_SCHEMA_SQL } from './db/agent-start-ort-schema.js';
export { AGENT_START_ORT_FUNKTION, START_ORTE, START_ORT_ARTEN, merkeStartOrt, merkeStartOrtAusJob, leseStartOrt, zustellWegFuer, startOrtSchalterAktiv, startOrtAnzeige } from './services/agent-start-ort.js';
export type { StartOrt, StartOrtArt, StartOrtAnzeige, StartOrtEingabe, StartOrtStand, StartOrtZustellweg } from './services/agent-start-ort.js';
export { fuehreStartOrtZustellungenAus, letzterStartOrtZustellStand, leseStartOrtZustellWerte } from './services/agent-startort-zustellung.js';
export type { StartOrtZustellStand, StartOrtZustellAgent } from './services/agent-startort-zustellung.js';
export { fuehreIdentitaetsZustellungAus } from './services/hauptagent-zustellung.js';
// P22-T79: Sonderstellung des Main (Lesezugriff auf alle User-Projekte, Lenkhinweise, Schalter Standard EIN).
export {
  leseMainSchalter, mainIdentitaetDesAusweises, istMainPrincipal, sichtbareUserProjekte, mainHinweisText, mainNurLesenAblehnung,
  mainProjektUnbekannt, mainKommunikationErlaubt, MAIN_LESEZUGRIFF_FUNKTION, STARTKONTEXT_SCHALTER, MAIN_DATEN_TOOLS, MAIN_HINWEIS_FELD,
} from './services/hauptagent-sonderstellung.js';
// P22-T78 F1: generischer Baustein Uebergabe/Startkontext je Identitaet (Nachweis je Lauf, Schema 128).
export {
  baueUebergabeText, baueStartkontext, startkontextFuer, bucheStartkontextAufLauf, autonomieHinweis, letzterStartkontextStand, STARTKONTEXT_FUNKTION,
} from './services/agent-verlauf.js';
export type { UebergabeTeile, StartkontextNachweis } from './services/agent-verlauf.js';
export { AGENT_STARTKONTEXT_SCHEMA_SQL } from './db/agent-startkontext-schema.js';
export type { MainSchalter, MainSchalterFunktion } from './services/hauptagent-sonderstellung.js';
export { istSammlungFehlt } from './services/thoughts.js';
export type { SitzungsEintragEingabe } from './services/hauptagent-verlauf.js';
export { VERLAUF_STUFE2_FUNKTIONEN, leseVerlaufStufe2Schalter } from './services/verlauf-tokens.js';
// P22-T63 Stufe 2 B: eigene Token-Zaehlung aus dem Verlauf (Schalter verlauf_token_zaehlung, Standard AUS).
export {
  VERLAUF_TOKEN_FUNKTION, ANTHROPIC_START_FAKTOR, ABWEICHUNG_BEFUND_PROZENT, leseTokenZaehlSchalter, modellFamilie, zaehleTokens, zaehltextEintrag,
  ausgabetextEintrag, leseKalibrierung, kalibriere, laufSumme, setzeGrundlast,
} from './services/verlauf-tokens.js';
export type { ModellFamilie, ZaehlVerfahren, TokenZaehlung, TokenZaehlSchalter, Kalibrierung } from './services/verlauf-tokens.js';
export type { MainLaufOptionen, MainLaufStand, MainStartEingabe, MainTurnErgebnis, RuntimeWechselDienste, MainStopErgebnis } from './services/hauptagent-lauf.js';
// P22-T73: Warteschlange des Main-Chats (Schalter main_warteschlange, Verlauf-Status 'wartet').
export {
  MAIN_WARTESCHLANGE_FUNKTION, NICHT_ERREICHT_CODES, leseWarteschlangeSchalter, setzeWarteschlangeSchalter, warteschlangeAktiv,
  mainWechselOffen, stelleInWarteschlange, fuehreMainWarteschlangeAus, schliesseEinwurfAb, warteschlangeStatus, buendelText,
} from './services/hauptagent-warteschlange.js';
export type { WarteEintrag, WarteschlangeDienste, WarteschlangeErgebnis, WarteschlangeStatus } from './services/hauptagent-warteschlange.js';
export {
  AUSFUEHRBARE_AUFTRAG_ARTEN, AUFTRAG_LEASE_MS, RuntimeAuftragFehler, claimeRuntimeAuftraege, meldeRuntimeAuftrag, meldeAuftragFortschritt,
} from './services/runtime-auftraege-ausfuehrung.js';
export type { AusfuehrbareAuftragArt, AuftragFuerDaemon, AuftragMeldung } from './services/runtime-auftraege-ausfuehrung.js';
export { SPECIALIST_ZIEL_RUNTIMES } from './services/specialist-queue.js';
// P22-T6: Nachrichten-Zustellung an Agenten im Runtime-Container ueber den Container-Daemon (Schema 123).
export { ZUSTELL_WEGE, leseZustellOptionen, sammleZustellungen, fuehreZustellungAus } from './services/hauptagent-zustellung.js';
export type { ZustellWeg, ZustellOptionen, Zustellung, ZustellErgebnis } from './services/hauptagent-zustellung.js';
export { AGENT_ZUSTELLUNGEN_SCHEMA_SQL } from './db/agent-zustellungen-schema.js';
export type { SpecialistZielRuntime } from './services/specialist-queue.js';
// P22-T45: Ausweis-Fristen als Einstellung (EINE Lesestelle), Schema 117.
export {
  AUSWEIS_FRIST_NAMEN, AUSWEIS_FRIST_DEFINITIONEN, AusweisFristenFehler, leseAusweisFristen, setzeAusweisFristen, leereAusweisFristenCache,
  schattenFristMs, erstnutzungFristMs,
} from './services/agent-ausweis-fristen.js';
export type { AusweisFristName, AusweisFristQuelle, AusweisFristWert, AusweisFristenStand } from './services/agent-ausweis-fristen.js';
export { AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL } from './db/agent-ausweis-fristen-schema.js';
// P22-T44: Ausweis fuer mehrere Projekte (Heimat, Visum, Arbeitsfreigabe), Schema 118, Produkt-Schalter mehrprojekt.
export {
  MEHRPROJEKT_FUNKTION, AUSWEIS_HINWEIS_FELD, AusweisProjektFehler, leseMehrprojektSchalter, leereMehrprojektCache, VISUM_ZUSCHNITT, visumErlaubt,
  visumAblehnung, sichereFremdprojektZugang, ausweisProjekteHinweis, ausweisProjekteTexte, haengeAusweisHinweiseAn, ausweisProjekteStatus,
  listeAusweisVisa, erteileArbeitsfreigabe, entzieheArbeitsfreigabe, offeneVisa,
} from './services/agent-ausweis-projekte.js';
export type { MehrprojektStand, FremdZugang, FremdprojektStand } from './services/agent-ausweis-projekte.js';
export { AGENT_AUSWEIS_PROJEKTE_SCHEMA_SQL } from './db/agent-ausweis-projekte-schema.js';
export type { ProfilTokenAbruf, WebUiKoordinatorToken } from './services/agent-token-abruf.js';
export { W1B_ADMIN_ACTIONS, W1B_ADMIN_PARAMETER, istW1bAdminAction, fuehreW1bAdminAus, w1bFehlerStatus } from './services/agent-profil-admin.js';
export type { W1bAdminAction } from './services/agent-profil-admin.js';
export { AGENT_PROFIL_SCHEMA_SQL } from './db/agent-profil-schema.js';
// Paket B: Anmeldung/Koordinatorliste/Fortsetzung; registerChatAgent = Legacy-Register + additives Schattenprofil (nur bei EIN).
export {
  registerChatAgent, ANMELDUNGS_DIENSTE, AnmeldungsFehler, anmeldungEnvAktiv, schattenprofileAktiv, leereAnmeldungGateCache,
  herkunftsortAusKopf, merkeHerkunftsort, legeErstenKoordinatorAusgabe, waehleRegisterWeg, nachLegacyAnmeldung,
  fortsetzungFuerAntwort, koordinatorListeAntwort, initialisiereW1bAnmeldungHinweise, registriereW1bAnmeldungHinweise,
  entregistriereW1bAnmeldungHinweise, SCHATTEN_KOORDINATOR_QUELLE, TOKEN_BEREIT_QUELLE, SCHATTEN_ABRUF_TEXT,
} from './services/agent-anmeldung.js';
export type { ErsterKoordinatorAusgabe, LegacyAnmeldung } from './services/agent-anmeldung.js';

// PA-1: unbekannte Tool-Parameter melden statt still verwerfen.
// Liegt in core, weil BEIDE Strecken (stdio-MCP und REST) dieselbe Pruefung brauchen —
// zwei Kopien waeren genau die Doppelpflege, gegen die der Fix gebaut wurde.
export { pruefeUnbekannteParameter, baueErlaubteParameter } from './services/unbekannte-parameter.js';
export type { ParameterBefund } from './services/unbekannte-parameter.js';

// Tool-Call Activity-Log (zentraler Audit-Store fuer shell(action:"activity"))
export { logToolCall, isMutationAction, queryToolCalls, expireOldToolCalls } from './services/tool-call-log.js';
export { schwaerzeToolDaten, schwaerzeToolText, schwaerzeToolLogText, toolArgsVorschau, istToolLogGeheimSchluessel } from './services/tool-args-schwaerzen.js';
export type { ToolCallLogEntry, ToolCallRow, ActivityFilters, ActivityDetail } from './services/tool-call-log.js';
export {erfasseToolAktivitaet,letzteToolAktivitaet,bereinigeToolAktivitaet,toolAktivitaetRetentionTage} from './services/tool-aktivitaet.js';
export type {ToolAktivitaetDb,ToolAktivitaetDescriptor,ToolAktivitaetKontext,ToolAktivitaetEintrag,ToolAktivitaetZeile,ToolAktivitaetFenster} from './services/tool-aktivitaet.js';

// Model-Registry Service (DB-Loader fuer Spezialisten-Modelle)
export {
  getModel,
  listAliases as listModelAliases,
  listModels,
  listProviders,
  invalidateCache as invalidateModelCache,
  getProviderCredential,
  setProviderCredential,
} from './services/model-registry.js';
export type { ModelEntry as DbModelEntry, Provider as ModelProvider } from './services/model-registry.js';

// Kontext-Korridor (Schwellen fuer Warnung/Handoff/Rotation, alle Stufen der Kette)
export {
  berechneKontextSchwellen,
  fallbackKorridor,
  KORRIDOR_200K,
  KORRIDOR_1M,
  ROTATION_PROZENT,
  HANDOFF_VORLAUF_TOKENS,
} from './services/kontext-korridor.js';
export type { KorridorWerte, KontextSchwellen } from './services/kontext-korridor.js';
export { pruefeRespawnKorridor } from './services/specialist-respawn.js';
export { setzeCliKontextQuelle, cliKontextFenster } from './services/cli-kontext.js';
export type { CliKontextQuelle } from './services/cli-kontext.js';
export {
  AGENT_ENTFERNUNG_FUNKTION, AGENT_ENTFERNUNG_ADMIN_ACTIONS, AGENT_ENTFERNUNG_ADMIN_PARAMETER, AGENT_ENTFERNUNG_MODI, istAgentEntfernungAdminAction, fuehreAgentEntfernungAdminAus,
  leseEntfernungSchalter, leseEntfernungSchwelle, entfernungFilterAktiv, leereEntfernungCache, legacyNichtEntfernt, identitaetNichtEntfernt, markiereRueckkehr,
  ermittleEntfernungKandidaten, fuehreEntfernungAus, stelleEntfernteWiederHer, setzeEntfernungSchwelle, leseEntfernungStatus, bestaetigungFuer,
  ladeEntferntMengen, schluesselEntfernt, ohneEntfernte, markiereEntfernteProfile, archivNameFuer, archivVerweise, archivUrsprung,
} from './services/agent-entfernung.js';
export type { EntfernungKandidat, EntfernungAusnahme, EntfernungErmittlung, EntfernungSchalter, EntfernungSchwelle, ArchivVerweis } from './services/agent-entfernung.js';
export { AGENT_ENTFERNUNG_SCHEMA_SQL, AGENT_UMBENENNUNG_SCHEMA_SQL } from './db/agent-entfernung-schema.js';
// P22-T87 S1: Anmelde-Uebersicht je Agent (admin anmeldungen, Schalter agent_anmeldungen).
export {
  AGENT_ANMELDUNGEN_FUNKTION, AGENT_ANMELDUNGEN_ADMIN_ACTIONS, AGENT_ANMELDUNGEN_ADMIN_PARAMETER, ANMELDUNG_WEGE,
  istAgentAnmeldungenAdminAction, fuehreAgentAnmeldungenAdminAus, leseAnmeldungen, leseAnmeldungenSchalter,
} from './services/agent-anmeldungen.js';
export type { AnmeldungWeg, AnmeldungKontext, AnmeldungenAbfrage, AnmeldungenSchalter } from './services/agent-anmeldungen.js';
export type { KorridorPruefung } from './services/specialist-respawn.js';

// shell(exec): Warten bei neuer Channel-Nachricht unterbrechen (Task b5b5304a)
export {
  warteAufChannelNachricht, pruefeUnterbrechung, leseChannelNotify, istChannelMitglied,
  unterbrechungsMeldung, SHELL_UNTERBRECHUNG_HINWEIS, CHANNEL_NOTIFY_KANAL,
} from './services/shell-channel-unterbrechung.js';
export type { ChannelUnterbrechung } from './services/shell-channel-unterbrechung.js';

// Kurz-IDs fuer Plaene und Tasks (P<n>, P<n>-T<m>) + Befuellungs-Logik fuer scripts/plaene-kurz-ids.mjs
export {
  planNummer, taskNummer, planKurzId, taskKurzId, waehleAktiven, ergaenzeTaskKurzIds, planeKurzIds,
} from './services/plan-kurz-ids.js';
export type { KurzIdZeile, KurzIdAenderung } from './services/plan-kurz-ids.js';
export type { PlanRef, PlanListenEintrag, VerschiebeErgebnis } from './services/plans.js';

// Selbstzuweisung: plan(passende_tasks) / plan(uebernehmen) (Aufgabe C)
export { passendeTasks, uebernehmeTask, meldeTaskAb, passtZuProfil, ladeAgentProfil } from './services/plan-zuweisung.js';
export type { AgentProfil } from './services/plan-zuweisung.js';

// Selbstauskunft fuer Spezialisten: specialist(action:'selbst')
export { selbstAuskunft } from './services/specialist-selbst.js';
export { listWrapperStatusFuerAgent } from './services/wrapper-status.js';

// Effort-Stufen fuer claude --effort (Spezialisten)
export { EFFORT_STUFEN, istEffortStufe, pruefeEffort, waehleEffort } from './services/effort.js';
export type { EffortStufe } from './services/effort.js';

// Modell-Empfehlung je Plan-Task per Jev (plan action 'empfehlen', EXPERIMENTELL)
export { empfehleFuerPlan, loeseKandidatenAuf, baueAuswahl, pruefeLage, filtereNachLage, frageTeil, JEV_STANDARD_URL, JEV_STANDARD_MODELL, EINZIGE_OPTION } from './services/jev-empfehlung.js';
export type { EmpfehlenOptionen, EmpfehlenErgebnis, JevEmpfehlung, JevDeps, JevKontext, JevLage, ModellAuswahl } from './services/jev-empfehlung.js';
// Tasks per Jev dem passenden Plan zuordnen (plan action 'einordnen')
export { ordneTasksEin, EINORDNEN_MAX_TASKS, EINORDNEN_BLOCK } from './services/plan-einordnen.js';
export type { EinordnenOptionen, EinordnenDeps, EinordnenZeile, EinordnenErgebnis } from './services/plan-einordnen.js';
export { JEV_KATALOG, JEV_GRUPPEN, JEV_STANDARD_KANDIDATEN } from './services/jev-criteria.js';
export { MODELLWAHL_CRITERIA, KATALOG_QUELLE as JEV_KATALOG_QUELLE, KATALOG_STAND as JEV_KATALOG_STAND } from './services/jev-criteria-katalog.js';
export type { JevKandidat, JevOption, JevFamilie } from './services/jev-criteria.js';

// Model-Cutoffs (Wissensstand je Modell, Tabelle model_cutoffs)
export {
  resolveCutoff,
  normalisiereModell,
  invalidateCutoffCache,
  MODEL_CUTOFF_SEED,
} from './services/model-cutoffs.js';
export { pruefeShellText, ladeShellSicherungsKatalog, seedShellSicherung, zaehleShellSicherungsBestand } from './services/shell-sicherung.js';
export type { ShellSicherungsKatalog, ShellTextErgebnis, ShellSicherungsRegel, ShellAntwortEintrag } from './services/shell-sicherung.js';
export { ermittleShellLage } from './services/shell-lage.js';
export type { ShellLage, ShellLageKontext } from './services/shell-lage.js';
export { probeShellLage, shellLageProbeProgramm } from './services/shell-lage-probe.js';
export type { ShellProbeAnfrage, ShellProbeAntwort } from './services/shell-lage-probe.js';
export { waehleShellStart } from './services/shell-start.js';
export {SHELL_SICHERUNGS_PARAMETER,shellSicherungsParameter,shellSicherungsAntwortAus}from'./services/shell-sicherungs-vertrag.js';
export {pruefeShellStart,regelVersion}from'./services/shell-start-sicherung.js';
export type{ShellBestaetigung,ShellSicherungsAntwort}from'./services/shell-start-sicherung.js';
export type{SicherungsShell}from'./services/shell-sicherung-parser.js';
export {holeShellStartKatalog,beginneShellSicherungsJob,beendeShellSicherungsJob}from'./services/shell-sicherungs-lauf.js';
// P10-T73: Rueckfrage-Stufe (fluechtig) + Liste bestaetigt demaskierter Jobs mit Nachmaskier-Worker.
export {stelleShellRueckfrage,loeseShellRueckfrageEin,leseShellBestaetigung,offeneShellRueckfragen,leereShellRueckfragen,
  aktuelleShellDemaskierung,mitShellDemaskierung,shellDemaskierFristStunden,isShellDemaskierung,shellRueckfrageFristMs,befehlHash as shellBefehlHash}from'./services/shell-rueckfrage.js';
export type{ShellBestaetigungEingabe,ShellDemaskierung,ShellRueckfrageBindung}from'./services/shell-rueckfrage.js';
// P23-T9: Rueckfrage-Aufruf zur bestaetigung_id gespeichert, Bestaetigung nur per ID + Grund.
export {mitShellAufrufPerId,kurzerBestaetigungsAufruf,gemerkteShellAufrufe,leereGemerkteShellAufrufe}from'./services/shell-aufruf-per-id.js';
export {maskiereFaelligeShellJobs,entferneVerworfeneShellRueckfragen,shellNachmaskierLauf,trageShellDemaskierungEin}from'./services/shell-demaskierung.js';
export {shellRohAusgabe}from'./services/shell-exec.js';
export {dbZielAusUrl,gleichesDbZiel} from './services/shell-db-zuordnung.js';

// Shell-Exec (gemeinsam fuer MCP-Tool + REST /api/shell)
export {
  execShellInProject,
  getShellStream,
  isProjectActive,
} from './services/shell-exec.js';
export type { ShellExecArgs, ShellGetStreamArgs } from './services/shell-exec.js';
export {
  baueJobUmgebung,
  ergaenzeJobPfad,
  vergissJobUmgebungCache,
  SYNAPSE_DB_HINWEIS,
} from './services/shell-job-umgebung.js';
export type { JobUmgebung, JobUmgebungInfo, BaueJobUmgebungOptionen } from './services/shell-job-umgebung.js';

// Migrations
export { migrateToRelativePaths } from './migrations/migrate-to-relative-paths.js';

// Embedding-Backlog (EMBED-1): Nachzug fuer nebenlaeufig angestossene Embeddings
export {
  embeddeOffeneEintraege,
  zaehleOffeneEmbeddings,
  /** @deprecated statischer Text; getEmbeddingPendingHint(project) nutzen */
  EMBED_PENDING_HINT,
  getEmbeddingPendingHint,
} from './services/embed-backlog.js';
export type { BacklogErgebnis } from './services/embed-backlog.js';

// GPU-2: verteilte Code-Chunk Pull-Claims (API und lokaler Unraid-Fallback).
export {
  claimEmbeddingChunks,
  completeEmbeddingClaim,
  completeEmbeddingClaims,
  validateEmbeddingVector,
} from './services/embedding-claims.js';
export type {
  EmbeddingChunkClaim,
  CompleteEmbeddingClaimInput,
  CompleteEmbeddingClaimResult,
  ClaimOptions,
} from './services/embedding-claims.js';
export { deterministicChunkPointId, embeddingContentHash } from './services/embedding-chunk-id.js';

export {
  // Code
  indexFile,
  updateFile,
  removeFile,
  reconcileOrphans,
  renameCodeFile,
  verifyProjectAgainstFilesystem,
  handleFileEvent,
  searchCode,
  searchCodeBatch,
  getProjectStats,
  searchFilesByPath,
  backfillCodeFiles,
  parseUnparsedFiles,
  projekteMitBacklog,
  linkCrossFileReferences,
  getEmbeddingPending,
  embeddingPendingHint,
  /** @deprecated statischer Text; embeddingPendingHint(project, file) nutzen */
  EMBEDDING_PENDING_HINT,
  resetProjectEmbeddings,
  resetProjectParse,
  reparseProject,
  // Media
  indexMediaFile,
  indexMediaDirectory,
  removeMediaFile,
  searchMedia,
  // Thoughts
  addThought,
  addThoughtsBatch,

  updateThought,
  getThoughts,
  searchThoughts,
  deleteThought,
  deleteThoughts,
  getThoughtsBySource,
  getThoughtsByTag,
  getThoughtsByIds,
  // Plans
  createPlan,
  getPlan,
  updatePlan,
  addTasksBatch,
  deleteTasks,
  listPlans,
  aktivierePlan,
  aendereTasks,
  getAllePlaene,
  findeTaskInPlan,
  resolveProjectTaskId,
  verschiebeTasks,
  planUebersicht,
  listPlansDetail,
  zurueckstellePlan,
  zurueckstelleTask,
  filtereWiedervorlageTasks,
  filtereNachTaskIds,
  planRefFuerTaskIds,
  taskSchlaeft,
  taskBis,
  planKontext,
  planRefVon,
  hinweisPlaene,
  planIndex,

  addTask,
  updateTask,
  deletePlan,
  // Docs
  cacheDoc,
  searchDocs,
  getDocsForFramework,
  clearDocsForFramework,
  searchDocsWithFallback,
  listCachedFrameworks,
  // Tech Detection
  detectTechnologies,
  // Context7
  getContext7Client,
  Context7Client,
  // Docs Indexer
  indexFrameworkDocs,
  indexProjectTechnologies,
  isFrameworkCached,
  cacheSearchResults,
  // Memory
  writeMemory,
  updateMemory,
  getMemoryByName,
  getMemoriesByNames,
  listMemories,
  searchMemories,
  deleteMemory,
  deleteMemories,
  deleteProjectMemories,
  readMemoryWithRelatedCode,
  findMemoriesForPath,
  getRulesForNewAgent,
  getOnboardingMemories,
  // Documents
  extractDocument,
  extractPDF,
  extractWord,
  extractExcel,
  indexDocument,
  searchDocuments,
  removeDocument,
  // Global Search
  globalSearch,
  listSearchableProjects,
  // Proposals
  createProposal,
  updateProposal,
  getProposal,
  getProposalsByIds,
  listProposals,
  updateProposalStatus,
  deleteProposal,
  deleteProposals,
  searchProposals,
  // Code Intelligence (PG-only)
  getProjectTree,
  getFunctions,
  getVariables,
  getSymbols,
  getReferences,
  getStatements,
  getCallEdges,
  getExecutionFlow,
  getEntrypoints,
  fullTextSearchCode,
  getFileContent,
  applyContentRange,
  // Code Write
  replaceLines,
  insertAfterLine,
  deleteLines,
  searchReplace,
  searchReplaceBatch,
  searchReplaceEindeutig,
  findeTreffer,
  trefferFehlerMeldung,
  contentHash,
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  snapshotFileVersion,
  getFileContentFromPg,
  // Backup
  dumpCollectionToFile,
  readBackupFile,
  getBackupDir,
  getBackupStats,
  backupProject,
  // Ignore-Regeln
  listeIgnoreRegeln,
  fuegeIgnoreRegelnHinzu,
  blendeVoruebergehendEin,
  loeseDauerInSekunden,
  entferneIgnoreRegel,
  schalteIgnoreRegel,
  pruefeIgnorePfad,
  markiereIgnorierteDateien,
  markiereEinzelneDateiIgnoriert,
  pruefeUndBereiteSchreibenVor,
  // Chat
  registerAgentsBatch,
  unregisterAgent as unregisterChatAgent,
  unregisterAgentsBatch,
  getAgentSession,
  listActiveAgents,
  expireIdleAgentSessions,
  sendMessage as sendChatMessage,
  getMessages as getChatMessages,
  getUnreadChatHint,
  // P15-T32: Sitzungs-Signal (admin index_stats sitzung, Spezialisten-Spawn)
  SITZUNGS_ARTEN,
  SITZUNG_PARAMETER,
  pruefeSitzungsArt,
  beginneSitzung,
  wendeSitzungsSignalAn,
  // Agent-Rollen (Regel-Sichtbarkeit — geteilt von MCP-Server und REST-API)
  erlaubteRollen,
  regelSichtbarFuer,
  baueOnboardingRegeln,
  baueOnboardingRegelwerk,
  baueRegelAbrufHinweis,
  rolleFuerAgent,
  rollenQuelleKlartext,
  tagVerdacht,
  // Tech-Docs
  addTechDoc,
  searchTechDocs,
  getDocsForFile,
  getFileSteckbrief,
  deleteTechDoc,
  updateTechDoc,
  // Events
  emitEvent,
  acknowledgeEvent,
  getPendingEvents,
  getPendingEventHints,
  getUnackedCount,
  // Channels
  createChannel,
  deleteChannel,
  joinChannel,
  leaveChannel,
  leaveChannels,
  removeAgentFromAllChannels,

  postChannelMessage,
  getChannelMessages,
  getChannelMembers,
  listChannels,
  getNewMessagesForAgent,
  ensureGeneralChannel,
  recordChannelRead,
  claimUnreadChannelHints,
  markChannelRead,
  NAVIGATIONSSCHWELLE,
  // Inbox
  postToInbox,
  checkInbox,
  getNewInboxMessages,
  getInboxHistory,
  removeInboxForAgent,
  // Error Patterns
  addErrorPattern,
  listErrorPatterns,
  deleteErrorPattern,
  checkErrorPatterns,
  getModelTier,
  deriveModelScope,
  // Shell-Queue
  enqueueShellJob,
  claimPendingShellJob,
  expirePendingShellJobs,
  completeShellJob,
  waitForShellJob,
  getShellJobs,
  getShellJobById,
  getShellJobLogLines,
  searchShellJobLog,
  insertCompletedShellJob,
  cancelShellJob,
  hideShellJobHints,
  HINWEIS_SCHUTZ_MS,
  reapOrphanedRunningJobs,
  aktuellerDateistand,
  claimShellJobHints,
  markShellJobSeenForToolCall,
  pruneShellJobNotices,
  // P23-T3 Punkt 6b: gleicher beendeter Lauf eines anderen Agenten (Schalter shell_fremde_ergebnisse).
  fremderLaufFeld,
  CANCEL_PROTECTED_MS,
  EXPIRE_PENDING_AFTER_SEC,
  DETACH_AFTER_MS,
  HARD_LIMIT_MS,
  // Specialist-Queue
  enqueueSpecialistJob,
  claimPendingSpecialistJob,
  completeSpecialistJob,
  waitForSpecialistJob,
  expirePendingSpecialistJobs,
  // Werkzeug-gebundene Regeln (2.2) — Regel haengt an der Handlung, nicht an der Rolle
  holeWerkzeugRegeln,
  baueWerkzeugMarken,
  WERKZEUG_REGEL_FELD,

} from './services/index.js';
export {listeEigeneLaufendeShellJobs} from './services/shell-queue.js';
export type {
  EnqueueArgs,
  ShellJobRow,
  ShellJobCompletion,
  ShellJobResult,
} from './services/shell-queue.js';
export type {
  SpecialistAction,
  SpecialistJobRow,
  SpecialistJobCompletion,
  SpecialistJobResult,
} from './services/specialist-queue.js';

export type { FunctionInfo, VariableInfo, SymbolInfo, ReferenceInfo, ReferencesResult, FullTextSearchResult, FileContentResult, FileContentOptions, TreeOptions, StatementInfo, CallEdgeInfo, CallEdgesResult, ExecutionFlowResult, EntrypointInfo } from './services/code-intel.js';
export { CodeIntelAmbiguousFilePathError } from './services/code-intel.js';
// P13-T19/A1: gemeinsame Feldnamen/Parser für P13, P18 und P20.
export * from './vertrag/api-vertrag.js';
// P10-T65: serverseitige Zuordnung, dieselben Metadaten im Shell-Jobvertrag.
export {holeShellDbFreigabe} from './services/shell-db-freigabe.js';
export type {ShellDbFreigabe,ShellDbZiel} from './services/shell-db-zuordnung.js';
export type { BatchEdit, BatchResult, BatchFehlschlag } from './services/code-write.js';
// P15-T17: Einzelschreibweg (E-a) - Optionen und Ergebnis von createFileInPg/updateFileInPg
export type { EinzelSchreibOptionen, SchreibErgebnis } from './services/code-write.js';
export { getParserGesundheitDatei, getParserGesundheitUebersicht, backfillParserCoverage, schreibeParserCoverage } from './services/parser-health.js';
export type { ParserGesundheitDatei, ParserGesundheitUebersicht, ParserBefundGesamt, ParserUebersichtDatei } from './services/parser-health.js';

// File-Versionierung (Schritt 1)
export {
  listFileVersions,
  listFileHistory,
  getFileVersion,
  restoreFileVersion,
  listBatchVersions,
  restoreBatch,
  restoreBatchVorschau,
  versionsDiff,
} from './services/file-versions.js';
export type { FileVersionMeta, FileVersionFull, VersionDiff } from './services/file-versions.js';

// Wrapper-Status (PG Source-of-Truth fuer laufende Spezialisten)
export {
  upsertWrapperStatus,
  getWrapperStatus,
  listWrapperStatus,
  removeWrapperStatus,
} from './services/wrapper-status.js';
export { setzeHeartbeatKonfiguration, setzeHeartbeatBeimSpawn, steuereHeartbeat } from './services/wrapper-status.js';
// Thought-Kurz-IDs + PG als Quelle der Wahrheit (P10-T28)
export { holeThoughtsMitProblemen, aendereThoughtPerId, loescheThoughtsPerId } from './services/thoughts.js';
export type { ThoughtIdProblem, LoeschErgebnis } from './services/thoughts.js';
export { loeseThoughtIdsAuf, pruefeIdEingabe } from './services/thought-ids.js';
// Drift-Schutz fuer update: Anker pruefen (P7-T11 a), geteilt mit file-batch
export { leseUpdateAnker, hatUpdateAnker, pruefeUpdateAnker } from './services/update-anker.js';
export type { UpdateAnker } from './services/update-anker.js';
// Spawn-Eingaben in Worker-Form (P7-T9)
export { normalisiereSpawnEintrag, normalisiereSpawnBatch, baueSpawnJobArgs, pruefeSpawnEffort, SPAWN_BATCH_MAX } from './services/specialist-spawn-args.js';
export type { SpawnArgs, SpawnOptionen } from './services/specialist-spawn-args.js';
// Proposals: PG als Quelle der Wahrheit + Praefix-IDs (P10-T29)
export { holeProposalsMitProblemen, aendereProposalPerId, setzeProposalStatusPerId, loescheProposalsPerId } from './services/proposals.js';
export type { ProposalLoeschErgebnis } from './services/proposals.js';
export type { ProposalIdProblem } from './services/proposal-ids.js';
// specialist(status): Namensfilter + Leichen kenntlich machen (P7-T10)
export { waehleSpezialisten, parseNamen, veraltetSchwelleMs, beschrifteZeile, kennzeichnung, ausblendHinweis } from './services/spezialisten-status-filter.js';

// JEV-10: Jev entscheidet Rueckfragen, wenn der User weg ist (P7-T28)
export { holeJevModusHinweis, holeJevSitzungsHinweis, leereJevModusCache, JEV_MODUS_ZEILE } from './services/jev-modus-hinweis.js';
export {
  entscheideRueckfrage,
  setzeAbwesenheit,
  leseAbwesenheit,
  holeEntscheidungsProtokoll,
  ueberstimmeEntscheidung,
  hinweisText as jevEntscheidetHinweis,
  baueAbwesenheitsHinweis,
  ERLAUBTE_KATEGORIEN,
  VERBOTENE_KATEGORIEN,
  STANDARD_ENTSCHEIDUNG_TOR,
  STANDARD_MAX_RUNDEN,
  WEITERE_KEY,
  STANDARD_RATE_PRO_STUNDE,
} from './services/jev-entscheidung.js';
// P15-T33 E0.5: Jev-Schalter, gemeinsamer Jev-Client, Kosten/Budget, Steuerung am admin-Tool
export {
  JEV_FUNKTIONEN, JEV_ALLE, JevSchalterFehler, jevWirksam, jevEntscheidungsHinweiseAn, filtereJevTool, jevToolSperre,
  setzeJevSchalter, jevSchalterListe, leereJevSchalterCache,
} from './services/jev-schalter.js';
export type { JevFunktion, JevWirkung, JevSchalterZeile, SetzeJevSchalterOptionen } from './services/jev-schalter.js';
export { rufeJev, jevKonfig } from './services/jev-client.js';
export type { JevAnfrage, JevErgebnis, JevAntwortDaten, JevKonfig } from './services/jev-client.js';
export {
  bucheJevAufruf, jevKostenAusUsage, jevPreisJeMio, jevBudgetStand, jevBudgetPause, reserviereJevBudget, bucheJevBudget,
  setzeJevBudget, setzeJevBudgetZurueck, jevKostenUebersicht, holeJevKontostand,
} from './services/jev-kosten.js';
export type { JevBudgetStand, JevKostenUebersicht, JevAufrufBuchung, JevUsdQuelle } from './services/jev-kosten.js';
export { JEV_ADMIN_ACTIONS, JEV_ADMIN_BESCHREIBUNG, JEV_ADMIN_PARAMETER, istJevAdminAction, fuehreJevAdminAus } from './services/jev-admin.js';
export { KONTEXTPROFIL_ADMIN_ACTIONS, KONTEXTPROFIL_ADMIN_PARAMETER, istKontextprofilAdminAction, fuehreKontextprofilAdminAus } from './services/kontextprofil-admin.js';
export { JEV_SPRACHEN, JevOptionenFehler, leseJevOptionen, setzeJevOptionen, wirksameJevSprache } from './services/jev-optionen.js';
export type { JevSprache, JevOptionen, JevErklaerungSprachen } from './services/jev-optionen.js';
// P15-T33 E1: Erklaerungs-Topf (Jev waehlt, Claude erklaert)
export {
  ERKLAERUNG_ACTIONS, ERKLAERUNG_PARAMETER, ERKLAERUNG_STATUS, meldeFehlerfall, verarbeiteFehlerfall, baueSchatten, jevZustand,
  JEV_KEINE, JEV_KEINE_TEXTE, baueJevFrage, kriteriumText, waehleErklaerung, ladeKandidaten, pruefeGenerik, legeErklaerungAb, pruefeFall, verwerfeFall,
  listeOffeneFaelle, holeFall, listeErklaerungen, bewerteErklaerung, erklaerungenTagespruefung, fuehreErklaerungsActionAus,
  istErklaerungsAction, familieVon, schluesselVon, schwaerzeGeheimnisse,
  // P15-T33 E2: Startbestand, persistente Warteschlange, Onboarding-Zeile
  ladeErklaerungstopfSeed, erklaerungstopfSeedPfad, pruefeSeedEintrag, erklaerungstopfStatus, holeErklaerungsEreignisseNach,
  erklaerungsFaelleZeile,
} from './services/erklaerungen.js';
export type { Erklaerung, ErklaerungTexte, Schatten, Fehlerereignis, FallPruefung, JevVersuch } from './services/erklaerungen.js';
// P15 E1: Entscheidungs-Topf fuer Jev (Praezedenz, Sicherheit S2, Durchsicht, Seed, Thought-Spiegel)
export {
  TOPF_STATUS, TOPF_HERKUNFT, STANDARD_TOPF_KANDIDATEN, STANDARD_TOPF_TOR, STANDARD_IRREVERSIBEL_SCHWELLE, SICHERHEIT_MUSTER, IRREVERSIBEL_FRAGE,
  scanneSicherheitText, leseAufbereitung, schreibeTopfEintrag, legeEntscheidungAb, bereiteEntscheidungAuf, listeEntscheidungstopf, zaehleTopf,
  entscheidungstopfStatus, spiegeleThoughtInTopf, seedDateiPfad, ladeEntscheidungstopfSeed, topfDokText, topfKriterium, topfPraezedenzState,
  holeTopfKandidaten, ergaenzeTopfEmbeddings,
} from './services/entscheidungstopf.js';
export type { TopfEintrag, TopfAufbereitung, TopfEmbedFn, TopfDeps, TopfKandidat, TopfStatus } from './services/entscheidungstopf.js';
export { durchsichtEntscheidung, entscheidungsDurchsichtZeile, fuehreJevTopfActionAus, istJevTopfAction, JEV_TOPF_ACTIONS, JEV_TOPF_BESCHREIBUNG, JEV_TOPF_PARAMETER } from './services/jev-entscheidung.js';
export type { DurchsichtOptionen } from './services/jev-entscheidung.js';

// Agenten-Wissen in der Datenbank (API-Bruecke Schritt 4). Additiv — der
// Dateiweg in packages/agents/src/skills.ts bleibt unveraendert bestehen.
export {
  leseAgentWissen,
  leseWissensArt,
  agentIstBekannt,
  setzeWissen,
  haengeWissenAn,
  entferneWissenZeilen,
  legeAgentWissenAn,
  loescheAgentWissen,
  listeWissensAgenten,
  normalisiereArt,
  erlaubteArten,
  PROMPT_ARTEN,
  ALLE_ARTEN,
} from './services/agent-wissen.js';
export type {
  WissensArt,
  WissensForm,
  WissensEintrag,
  ArtSicht,
  AgentMetaDaten,
  AgentWissen,
} from './services/agent-wissen.js';
export {
  serialisiereAgentMeta,
  leseAgentMetaYaml,
  yamlSkalar,
} from './services/agent-meta-yaml.js';
export type { AgentMetaFelder } from './services/agent-meta-yaml.js';
export type { WrapperStatusRow, HeartbeatKonfiguration, HeartbeatUebersicht } from './services/wrapper-status.js';

// Skills (EXPERIMENTAL — Qdrant Skill-DB access)
export { mitFileTaskWarnung, ordneFileTasksZu } from './services/file-task-zuordnung.js';
export type { FileTaskZuordnung } from './services/file-task-zuordnung.js';
export { searchSkills, listSkills, getSkillSection, getSkillFull } from './services/skills.js';
// P12-T13 Teil 2: Skills PG-first schreiben
export {
  speichereSkillSection,
  loescheSkillSection,
  loescheSkill,
  ersetzeSkill,
  embeddeSkillSectionNach,
} from './services/skills.js';
export type { SkillSectionEingabe, SkillSchreibErgebnis, SkillSicht, SkillScope } from './services/skills.js';

// Free-Model-Pool: Katalog externer API-Modelle (vor allem kostenloser).
// Die Modelllisten kommen live von den Anbietern; gepflegt wird nur die Endpunkt-Registry.
export {
  PROVIDER_REGISTRY,
  getPoolSnapshot,
  getPoolProviders,
  getPoolModel,
  loeseAliasAuf,
  listeAliase,
  getAufrufZiel,
  searchPool,
  probeProvider,
  markiereFehlschlag,
  markiereErfolg,
  markiereAnbieterZugang,
  uebernimmFreigabe,
  setzeModellFreigabe,
  listeSperren,
  loescheSperren,
  invalidiereCredentialCache,
} from './services/free-model-pool.js';
export {
  classifyFailure,
  lohntWeiterenVersuch,
  istVermittlerFehler,
  leseWartezeit,
} from './services/free-model-pool-errors.js';
export type { FailureReason, ClassifiedFailure, FailureInput } from './services/free-model-pool-errors.js';
export {
  speichereArtefakt,
  aktualisiereArtefaktPfade,
  pruefeArtefaktEingabe,
  listeArtefakte,
  ladeArtefakt,
  ARTEFAKT_HTML_MAX,
} from './services/artefakt.js';
export { herkunftAusDaemonId, ermittleAgentHerkunft, onlineKoordinatoren } from './services/agent-herkunft.js';
export type { AgentHerkunft, HerkunftsArt, OnlineKoordinator } from './services/agent-herkunft.js';
export type { ArtefaktEingabe, ArtefaktZeile, ArtefaktUebersicht } from './services/artefakt.js';
export {
  setzeFreigabe,
  setzeDatenverwendung,
  leseProtokoll,
  listeCredentials,
  speichereCredential,
  leseCredentialGeheimnis,
} from './services/free-model-pool-store.js';
export type { CredentialZeile } from './services/free-model-pool-store.js';
export { getModelsDev, findeModel, listeProviderIds } from './services/models-dev.js';
export type { ModelsDevModel, ModelsDevProvider, ModelsDevRegistry } from './services/models-dev.js';
export type {
  AufrufZiel,
  PoolModel,
  PoolSnapshot,
  PoolFilter,
  PoolSuchergebnis,
  ProviderEntry,
  ProviderStatus,
  CostClass,
  Reachability,
  FreeType,
  WireFormat,
  AuthScheme,
} from './services/free-model-pool.js';
export type { SkillSearchHit, SkillListEntry, SkillSection } from './services/skills.js';

// Daemon-Heartbeat (Auto-Routing shell ↔ workspace)
export {
  upsertDaemonHeartbeat,
  isDaemonAliveForProject,
  getDaemonHeartbeat,
  clearDaemonHeartbeat,
} from './services/daemon-heartbeat.js';
export type { DaemonHeartbeatRow } from './services/daemon-heartbeat.js';

// Project-Init-Queue (Self-Service Project-Bootstrap fuer Web-KIs)
export {
  isValidProjectName,
  enqueueProjectInitJob,
  claimPendingProjectInitJob,
  completeProjectInitJob,
  expirePendingProjectInitJobs,
  waitForProjectInitJob,
  getProjectInitJob,
} from './services/project-init-queue.js';
export type { ProjectInitJobRow, ProjectInitStatus, ProjectInitCompletion } from './services/project-init-queue.js';

// Projekt-DB auf der Unraid-Projekt-Instanz (5433) beim Self-Service-Init
export {
  legeProjektDbAn,
  leseProjektDbInfo,
  leseProjektDbZugang,
  projektDbKurzinfo,
  ladeProjektDbKonfig,
  pruefeProjektDbZiel,
  leiteDbNamenAb,
  rollenNameFuer,
  bauPruefSql,
  bauRolleSql,
  bauAnlageSql,
  bauNachpruefSql,
  bauRueckbauSql,
  projektDbDsn,
  envHatDatabaseUrl,
  schreibeProjektDbEnv,
  ProjektDbSchutzFehler,
  PROJEKT_DB_MEMORY_NAME,
  uebernehmeProjektDb,
} from './services/projekt-db.js';
export type { ProjektDbUebernahme, ProjektDbUebernahmeEingabe, UebernehmeProjektDbOptionen, ProjektDbVerbindungsPruefer } from './services/projekt-db.js';
export type {
  ProjektDbErgebnis,
  ProjektDbAnlage,
  ProjektDbZugang,
  ProjektDbStatus,
  ProjektDbZiel,
  ProjektDbKonfig,
  PsqlAusfuehrer,
  LegeProjektDbAnOptionen,
} from './services/projekt-db.js';

// Serverseitige Skill-Hooks (HOOK-3/HOOK-4)
export {
  holeSprachSkillVorschlaege,
  waehleSprachSkills,
  holeChannelSkillVorschlaege,
  holeOffeneSkillVorschlaege,
  bereiteChannelSkillVorschlaegeVor,
  bereiteSkillVorschlaegeVor,
  holeChannelSkillsNachBeitritt,
  holeSkillsFuerQuellen,
  aktiveProjektAgenten,
  verarbeiteSkillHinweisgeber,
  // P23-T8: Hinweisgeber + Abruf je Aufruf (Namenstreffer nur mit Bezug), Kettenquellen
  holeSkillVorschlaegeFuerAufruf,
  KETTEN_QUELLEN,
  sammleSkillQuellen,
  baueChannelSkillSuchtext,
  waehleChannelSkillTreffer,
  // P23-T1: 99%-Kette (Vorgabe, Skill-Abruf) und gemeinsamer Schreibweg des Vorrats
  KETTEN_SCORE,
  legeSkillKandidatenAb,
  bereiteVerknuepfteSkillsVor,
  bereiteVorgabeSkillsVor,
  istNamentlichGenannt,
} from './services/skill-hook.js';
export type { SkillKandidat, SkillQuellenTyp } from './services/skill-hook.js';
// P23-T1: Sinnpruefung semantischer Skill-Vorschlaege (Jev-Funktion skill_rerank, Standard AUS)
export { pruefeSkillTrefferSinn, bestehtSinnpruefung, sinnpruefungsZusatz } from './services/skill-rerank.js';
export type { SkillSinnKandidat, SkillSinnErgebnis } from './services/skill-rerank.js';
export { istSkillNameImText, findeSkillsNachName } from './services/skills.js';
export type {
  SkillVorschlag,
  SkillHookMetriken,
  SkillHookErgebnis,
  ChannelSkillNachricht,
} from './services/skill-hook.js';

// Multi-File Edit-Plans (Schritt 2)
export {
  planBatch,
  commitBatch,
  cancelBatch,
  getBatchPlan,
  addCoeditContribution,
  markCoeditReady,
  markCoeditNoChanges,
  getSharedPlanStatus,
  buildPlanStatusResponse,
  buildCompactPlanStatusResponse,
  buildCompactSharedPlanStatusResponse,
  replanBatch,
  failedOpsOf,
  PlanBatchOpsFailedError,
  planFailureResponse,
  buildCancelResponse,
  nichtsGeschriebenBefund,
  opZumNeuPlanen,
  pollPlanStatus,
  getPlanOpsVollstaendig,
  opIndicesLesen,
  planSchattenDiff,
  buildPlanStatusResponseMitDiff,
  schreibeCommitDiffs,
  pruefeGespeichertenPlan,
  befundeQuittierenLesen,
} from './services/file-batch.js';
export type { PlanDiff, PlanDiffDatei } from './services/file-batch.js';
export { dateiDiff, aenderungsBereiche, diffText } from './services/file-diff.js';
export { claimOpenPlanHints } from './services/plan-hints.js';
// P6-T49: offene files-Plaene laufen nach Frist files_plan_stunden ohne Aktivitaet ab (REST-Worker files_plan_ablauf).
export { laufeFilesPlaeneAb, FILES_PLAN_ABLAUF_AKTEUR } from './services/file-plan-ablauf.js';
export type { FilesPlanAblaufErgebnis, FilesPlanAblaufEintrag } from './services/file-plan-ablauf.js';
export type { CancelBatchOptionen } from './services/file-batch.js';
export { FILES_PLAN_ABLAUF_SCHALTER, FilesPlanAblaufSchalterFehler, leseFilesPlanAblaufSchalter, setzeFilesPlanAblaufSchalter } from './services/files-plan-ablauf-schalter.js';
export type { FilesPlanAblaufSchalterStand, FilesPlanAblaufQuelle } from './services/files-plan-ablauf-schalter.js';
export type { OpenPlanHints, OpenPlanHintEntry } from './services/plan-hints.js';
export type {
  FileBatchOp,
  FileBatchOpAction,
  OpPreview,
  FileBatchPlanRow,
  FileBatchStatus,
  PlanBatchResult,
  CoeditWaitGroup,
  CoeditWaitStatus,
  CoeditAddResult,
  CoeditLifecycleResult,
  SharedPlanStatusResult,
  PlanStatusAnsicht,
  CommitBatchResult,
  CommitConflictDetail,
  CoeditConflictDetail,
  FailedPlanOp,
  SharedPlanRef,
  CancelBatchResult,
  WithdrawalRecord,
} from './services/file-batch.js';

// Kooperative Dateireservierungen (Co-Edit CE-1)
export {
  addFileReservations,
  releaseFileReservations,
  updateFileReservations,
  listFileReservations,
  normalizeReservationFilePaths,
  findForeignActiveReservationPrimaries,
  getDirectWriteReservationHint,
  getReservationTtlConfig,
  refreshReservationTtlsForFiles,
  renewFileReservationTtls,
  releaseStaleFileReservations,
  reservationTtlHint,
} from './services/file-reservations.js';
// P15-T36: Projekt-Pfade (eine Normalisierung + Sperre fuer files/files_batch, Plaene, Co-Edit, Reservierungen)
export {
  normalisiereProjektPfad,
  normalisiereOps,
  pruefeSchreibZiel,
  pruefeFilesPfadArgs,
  liegtImProjekt,
  PfadUngueltig,
  PfadGesperrt,
} from './services/projekt-pfad.js';
export type { PfadFehlerGrund, PfadFehlerAntwort } from './services/projekt-pfad.js';
// P15-T36 Teil 2: .env-Werte in allen Ausgaben maskieren (NAME=[WERT]), Platzhalter beim Schreiben = unveraendert
export {
  ENV_PLATZHALTER,
  istEnvDatei,
  istMcpJsonDatei,
  istMaskierteDatei,
  maskiereMcpJson,
  maskiereDatei,
  entmaskiereMcpJson,
  entmaskiereSensibleDatei,
  mcpJsonHinweise,
  mcpJsonSicht,
  maskiereMcpJsonDiffText,
  maskiereEnv,
  envSicht,
  entmaskiereEnv,
  envHinweise,
  maskiereEnvDiffText,
  maskiereEnvDiff,
  maskiereEnvOp,
  EnvSchreibweg,
  envHinweiseFuerBatch,
  schwaerzeEnvWerteInAntwort,
} from './services/env-maske.js';
export type {
  FileReservation,
  ReservationMutationResult,
  ReservationUpdateResult,
  AlreadyReleasedReservation,
  ForeignActiveReservationPrimary,
  DirectWriteReservationHint,
  ReservationTtlConfig,
} from './services/file-reservations.js';
export type { BackupEntry } from './services/backup.js';
export type { ChatMessage, AgentSession } from './services/chat.js';
export type { AgentEvent, EventAck, EventType, EventPriority } from './services/events.js';
export { pruefeEventEskalation } from './services/events.js';
export type { TechDoc, TechDocType, TechDocResult } from './services/tech-docs.js';
export type { ErrorPattern, ErrorPatternWarning } from './services/error-patterns.js';
// P15-T17 E0: Fehlermuster-Treffer an den Agenten ausliefern (Nachlieferung)
export { holeFehlermusterHinweise, verfolgeFehlermusterPruefung, vormerkenBefunde } from './services/fehlermuster-auslieferung.js';
// P15-T37: code_check - eine Definition + ein Dispatcher fuer stdio und REST; Musterpflege mit Selbsttest/Dubletten.
export { CODE_CHECK_DEFINITION, CODE_CHECK_ACTIONS, fuehreCodeCheckAus, kompaktesMuster } from './services/code-check-tool.js';
export { legeMusterAn, aendereMuster, findeDubletten, findeAehnliche, normalisiereErkennung, normalisiereGeltung, normalisiereVerweise } from './services/fehlermuster-pflege.js';
export type { MusterFelder, PflegeErgebnis, DublettenTreffer, AehnlichTreffer } from './services/fehlermuster-pflege.js';
// P15-T17: Pruefkern (Signatur-Muster, Syntax-Schnittstelle fuer P16-T4)
export {
  pruefeSignaturen,
  pruefeSyntaxEinzelweg,
  registriereSyntaxPruefer,
  hatSyntaxPruefer,
  geaenderteZeilen,
  ladeSignaturMuster,
  SyntaxfehlerAbgelehnt,
  QUITTIER_HINWEIS,
} from './services/fehlermuster-pruefung.js';
export type { FehlerBefund, SyntaxPruefer, SyntaxMeldung, SyntaxErgebnis } from './services/fehlermuster-pruefung.js';
// P16-T4: Syntaxpruefer Stufe 1 (TS/JS, JSON, CSS ...) im eigenen Worker-Pool
export {
  registriereStandardSyntaxPruefer,
  syntaxPoolZustand,
  beendeSyntaxPool,
  SyntaxWorkerPool,
  SyntaxPrueferTimeout,
  SyntaxPoolNichtVerfuegbar,
  PRUEFER_KATALOG,
} from './services/syntax-pruefer/index.js';
export type { PrueferDefinition } from './services/syntax-pruefer/index.js';
export type { FehlermusterHinweis, FehlermusterAuslieferung } from './services/fehlermuster-auslieferung.js';
export type { Memory, MemoryWithRelatedCode, RelatedMemoryResult, RelatedCodeResult } from './services/memory.js';
export type { DetectedTechnology } from './services/tech-detection.js';
export type { Context7Doc } from './services/context7.js';
export type { IndexedDoc } from './services/docs-indexer.js';
// P12-T17: Context7-Automatik, Kontingent und inhaltsbasierte Tech-Erkennung
export {
  initContext7Automatik,
  context7AutomatikTick,
  stosseContext7An,
  erkenneTechnologienAusPg,
  merkeContext7Abfrage,
} from './services/context7-automatik.js';
export { context7Kontingent, kontingentKonfig, reserviereContext7Aufruf } from './services/context7-kontingent.js';
export type { Context7Kontingent, Context7Stufe, Context7Aufrufart } from './services/context7-kontingent.js';
export { detectTechnologiesAusInhalten, ERKENNUNGS_DATEINAMEN, MANIFEST_DATEINAMEN } from './services/tech-detection.js';
export type { ManifestInhalt, ImportQuelle } from './services/tech-detection.js';
export { Context7Fehler } from './services/context7.js';
export type { Context7Bibliothek } from './services/context7.js';
export type { ExtractedDocument, DocumentSearchResult } from './services/documents.js';
export type {
  GlobalSearchOptions,
  GlobalSearchResult,
  GlobalSearchItem,
  GlobalSearchMetadata,
  CodeSearchMetadata,
  ThoughtSearchMetadata,
  MemorySearchMetadata,
  SearchType,
} from './services/global-search.js';
// Parser Worker-Threads Pool
export { getParserPool, resetParserPool, ParserWorkerPool, getParserActivity } from './parser/worker-pool.js';
export type { ParseArgs, ParserAktivitaet } from './parser/worker-pool.js';

export type { ProjectStatus } from './services/project-status.js';
export { getProjectStatus, setProjectStatus, isProjectInitialized, updateLastAccess, clearProjectStatus, isAgentKnown, registerAgent, setzeOnboardingRuhe, baueChannelUebersicht } from './services/project-status.js';
export { holeChannelTeilnehmer } from './services/project-status.js';
export { holeSichtungsstand, setzeSichtung, archiviereChannel, archiviereNachrichten } from './services/channels.js';
export { ensureChannelverwalterRegel, CHANNELVERWALTER_REGEL_NAME } from './services/channelverwalter-regel.js';
export type { SichtungsEintrag } from './services/channels.js';
export type { ChannelUebersicht, ChannelUebersichtEintrag, ChannelTeilnehmer } from './services/project-status.js';

// Setup-Phase (SETUP-1: PG Source-of-Truth, status.json nur noch Cache/Fallback)
export type { SetupPhase } from './services/project-setup-status.js';
export { getSetupPhase, setSetupPhase, ermittleProjektStatus } from './services/project-setup-status.js';
export { backfillSetupPhaseFromStatusFiles } from './migrations/backfill-setup-phase.js';
/**
 * Ermittelt das Text-Feld fuer Re-Embedding anhand des Collection-Suffixes
 */
function getEmbeddingTextField(
  collectionName: string,
  payload: Record<string, unknown>
): string {
  if (collectionName.endsWith('_thoughts')) {
    return (payload.content as string) || '';
  }
  if (collectionName.endsWith('_memories')) {
    return (payload.content as string) || '';
  }
  if (collectionName.endsWith('_plans')) {
    const name = (payload.name as string) || '';
    const desc = (payload.description as string) || '';
    const goals = (payload.goals as string[]) || [];
    return `${name} ${desc} ${goals.join(' ')}`.trim();
  }
  if (collectionName.endsWith('_proposals')) {
    return (payload.description as string) || '';
  }
  return JSON.stringify(payload);
}

/**
 * Migriert eine einzelne Collection bei Dimensions-Mismatch
 * 1. Payloads sichern (JSONL)  2. Collection loeschen  3. Neu erstellen  4. Re-embedden
 */
async function migrateCollection(
  collectionName: string,
  newDim: number
): Promise<{ migrated: number; failed: number }> {
  const { scrollVectors } = await import('./qdrant/operations.js');
  const { deleteCollection, ensureCollection } = await import('./qdrant/collections.js');
  const { insertVector } = await import('./qdrant/operations.js');
  const { embed } = await import('./embeddings/index.js');
  const { dumpCollectionToFile, getBackupDir } = await import('./services/backup.js');
  const path = await import('path');

  let migrated = 0;
  let failed = 0;

  let points: Array<{ id: string; payload: Record<string, unknown> }> = [];
  try {
    points = await scrollVectors<Record<string, unknown>>(collectionName, {}, 10000);
  } catch {
    console.error(`[Synapse Migration] Konnte "${collectionName}" nicht lesen`);
    return { migrated: 0, failed: 0 };
  }

  if (points.length === 0) {
    await deleteCollection(collectionName);
    await ensureCollection(collectionName, newDim);
    return { migrated: 0, failed: 0 };
  }

  // JSONL-Backup schreiben (Sicherheitsnetz)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = getBackupDir();
  const backupPath = path.join(backupDir, `${collectionName}_${timestamp}.jsonl`);
  await dumpCollectionToFile(collectionName, backupPath);

  await deleteCollection(collectionName);
  await ensureCollection(collectionName, newDim);

  console.error(`[Synapse Migration] Re-embedde ${points.length} Eintraege fuer "${collectionName}"...`);

  for (const point of points) {
    try {
      const text = getEmbeddingTextField(collectionName, point.payload);
      if (!text) { failed++; continue; }
      const vector = await embed(text, { priority: 'background' });
      await insertVector(collectionName, vector, point.payload, point.id);
      migrated++;
      if (migrated % 25 === 0) {
        console.error(`[Synapse Migration] "${collectionName}": ${migrated}/${points.length}`);
      }
    } catch (error) {
      failed++;
      console.error(`[Synapse Migration] Fehler bei ${point.id}: ${error}`);
    }
  }

  console.error(`[Synapse Migration] "${collectionName}": ${migrated} migriert, ${failed} fehlgeschlagen`);
  return { migrated, failed };
}

/**
 * Initialisiert Synapse Core
 * Testet Verbindungen (PostgreSQL, Qdrant, Embeddings), erstellt Collections
 *
 * @param projectName - Projekt-Name (Pflicht). Erstellt Per-Projekt Collections
 *   und migriert bei Dimensions-Mismatch automatisch mit Backup.
 */
export async function initSynapse(
  projectName: string,
  optionen: { schema?: 'ausfuehren' | 'pruefen' | 'aus' } = {},
): Promise<boolean> {
  console.error(`[Synapse] Initialisiere Projekt "${projectName}"...`);

  // 0. Embedding-Provider resetten damit aktuelle Config geladen wird
  const { resetEmbeddingProvider } = await import('./embeddings/index.js');
  resetEmbeddingProvider();

  // 1. PostgreSQL testen + Schema sicherstellen
  // P7-T14: ensureSchema sperrt alle Produktions-Tabellen ~2,3 s — nur der API-Start fuehrt es aus
  // (schema:'ausfuehren'); alle anderen Aufrufer pruefen nur (Standard) bzw. legen bei LEERER DB einmal an.
  const { testDatabaseConnection, stelleSchemaSicher } = await import('./db/index.js');
  const dbOk = await testDatabaseConnection();
  if (dbOk) {
    await stelleSchemaSicher(optionen.schema ?? 'pruefen');
  } else {
    console.error('[Synapse] PostgreSQL nicht erreichbar - fahre ohne DB fort');
  }

  // 2. Qdrant testen
  const { testQdrantConnection } = await import('./qdrant/client.js');
  const qdrantOk = await testQdrantConnection();
  if (!qdrantOk) {
    console.error('[Synapse] Qdrant nicht erreichbar - Abbruch');
    return false;
  }

  // 3. Embedding Provider testen
  const { getEmbeddingProvider, getEmbeddingDimension } = await import('./embeddings/index.js');
  try {
    await getEmbeddingProvider();
  } catch (error) {
    console.error('[Synapse] Kein Embedding Provider verfuegbar:', error);
    return false;
  }

  const currentDim = await getEmbeddingDimension();

  // 4. Per-Projekt Collections pruefen und bei Mismatch migrieren
  const {
    getCollectionVectorSize,
    collectionExists: colExists,
    deleteCollection: delCol,
    ensureCollection: ensCol,
    ensureAllCollections,
    ensureProjectCollections,
  } = await import('./qdrant/collections.js');

  const { COLLECTIONS } = await import('./types/index.js');

  // Alle Per-Projekt Collections dieses Projekts
  const projectCollections = [
    COLLECTIONS.projectMemories(projectName),
    COLLECTIONS.projectThoughts(projectName),
    COLLECTIONS.projectPlans(projectName),
    COLLECTIONS.projectProposals(projectName),
    COLLECTIONS.projectCode(projectName),
    COLLECTIONS.projectMedia(projectName),
    COLLECTIONS.projectDocs(projectName),
  ];

  let totalMigrated = 0;
  let totalFailed = 0;

  for (const colName of projectCollections) {
    if (!(await colExists(colName))) continue;

    const colDim = await getCollectionVectorSize(colName);
    if (colDim === null) continue;

    // P12-T11/T12 (Befund 1dbb8308): die automatische Migration liest hoechstens 10000 Punkte,
    // LOESCHT danach die Collection und behandelt nur DIESES Projekt; Code-Collections werden
    // sofort geloescht. Ein Dimensionswechsel fuehrt deshalb nur noch zu einer Meldung - das
    // Neu-Einbetten macht das Re-Embedding-Werkzeug (neue Collections, Nachzug, Umschalten).
    // Altes Verhalten nur ausdruecklich: SYNAPSE_START_MIGRATION=1.
    if (colDim !== currentDim && process.env.SYNAPSE_START_MIGRATION !== '1') {
      console.error(
        `[Synapse] ⚠️ DIMENSIONS-MISMATCH: "${colName}" hat ${colDim}d, Modell liefert ${currentDim}d. ` +
        `NICHTS geloescht oder migriert - Schreiben in diese Collection schlaegt fehl, bis sie mit dem ` +
        `Re-Embedding-Werkzeug neu aufgebaut ist (SYNAPSE_START_MIGRATION=1 = alte Automatik).`
      );
      continue;
    }
    if (colDim !== currentDim) {
      // Code-Collections: einfach loeschen (Filewatcher re-indexiert)
      if (colName.endsWith('_code')) {
        console.error(
          `[Synapse] Code-Collection "${colName}" hat ${colDim}d, Modell liefert ${currentDim}d. ` +
          `Loesche und erstelle neu.`
        );
        await delCol(colName);
        await ensCol(colName, currentDim);
      } else {
        // Daten-Collections: mit Backup migrieren
        console.error(
          `[Synapse] Dimensions-Mismatch: "${colName}" hat ${colDim}d, Modell liefert ${currentDim}d. Migriere...`
        );
        const result = await migrateCollection(colName, currentDim);
        totalMigrated += result.migrated;
        totalFailed += result.failed;
      }
    }
  }

  if (totalMigrated > 0 || totalFailed > 0) {
    console.error(
      `[Synapse] Migration: ${totalMigrated} migriert, ${totalFailed} fehlgeschlagen`
    );
  }

  // 5. Globale + Projekt-Collections sicherstellen
  await ensureAllCollections();
  await ensureProjectCollections(projectName);

  // 6. code_files Backfill (einmalig: Qdrant → PostgreSQL)
  if (dbOk) {
    try {
      const { backfillCodeFiles } = await import('./services/code.js');
      await backfillCodeFiles(projectName);
    } catch (err) {
      console.warn(`[Synapse] code_files Backfill fehlgeschlagen: ${err}`);
    }
  }

  // 7. Ungeparste Dateien nachparsen (content vorhanden, parsed_at IS NULL)
  if (dbOk) {
    try {
      const { parseUnparsedFiles } = await import('./services/code.js');
      await parseUnparsedFiles(projectName);
    } catch (err) {
      console.warn(`[Synapse] parseUnparsedFiles fehlgeschlagen: ${err}`);
    }
  }

  console.error(`[Synapse] Projekt "${projectName}" bereit`);
  return true;
}
