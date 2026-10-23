/** P18-T86/T88: eine fachliche Quelle für PG, API, Runner-Snapshots und UI.
 * Konzept 63420d70/27a300af, Entscheidungen 61078c02. Aufbewahrung nicht Teil dieses Pakets.
 * BIGINT-Werte werden über JSON ausschließlich als Dezimaltext transportiert.
 * env nennt die frühere Startvariable: nur sichtbarer Migrationsvorschlag, niemals wirksame Quelle. */
export type ReverseEbene = 'global' | 'projekt' | 'eintrag';
export interface ReverseEinstellDefinition {
 typ:'integer'|'bigint'|'enum'; einheit:string; min:string|null; max:string|null; standard:string;
 ebenen:readonly ReverseEbene[]; null_semantik:string; nullwert:string|null; werte:readonly string[]|null; env:string|null;
}
const G=['global'] as const, GE=['global','eintrag'] as const, GP=['global','projekt'] as const;
const I32='2147483647', B64='9223372036854775807', NULL_SEMANTIK='unzulässig; fehlende Zeile erbt';
type Z=number|string;
const zahl=(typ:'integer'|'bigint')=>(einheit:string,min:Z,max:Z,standard:Z,ebenen:readonly ReverseEbene[],nullwert:string|null=null,env:string|null=null):ReverseEinstellDefinition=>
 ({typ,einheit,min:String(min),max:String(max),standard:String(standard),ebenen,null_semantik:NULL_SEMANTIK,nullwert,werte:null,env});
const i=zahl('integer'),b=zahl('bigint');
const auswahl=(einheit:string,werte:readonly string[],standard:string,ebenen:readonly ReverseEbene[],env:string|null=null):ReverseEinstellDefinition=>
 ({typ:'enum',einheit,min:null,max:null,standard,ebenen,null_semantik:NULL_SEMANTIK,nullwert:null,werte,env});
export const REVERSE_EINSTELLKATALOG = {
 // Betrieb / Container / Wiederanlauf
 executor_parallel:i('Jobs',1,16,1,G,null,'SYNAPSE_REVERSE_EXECUTOR_PARALLEL'),
 executor_lease_s:i('s',10,900,300,G,null,'SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS'),
 executor_tick_ms:i('ms',100,3600000,5000,G,null,'SYNAPSE_REVERSE_EXECUTOR_TICK_MS'),
 executor_renew_min_ms:i('ms',100,60000,1000,G),
 retry_max:i('Versuche',1,100,3,G,null,'SYNAPSE_REVERSE_RETRY_MAX'),
 container_tmpfs_mib:i('MiB',16,65536,512,G,null,'SYNAPSE_REVERSE_TMPFS_MB'),
 container_pids:i('Prozesse',16,65536,256,G,null,'SYNAPSE_REVERSE_PIDS'),
 container_idle_ms:i('ms',10000,86400000,300000,G,null,'SYNAPSE_REVERSE_IDLE_MS'),
 container_zeit_zuschlag_s:i('s',1,3600,60,G),
 container_aktivitaet_fenster_s:i('s',1,86400,300,G),
 container_cpu_idle_prozent:i('%',0,100,5,G,'kein CPU-Leerlaufspielraum'),
 container_gpu_idle_prozent:i('%',0,100,100,G,'kein GPU-Leerlaufspielraum'),
 container_messung_max_alter_ms:i('ms',1,3600000,60000,G),
 container_start_timeout_ms:i('ms',1000,3600000,120000,G),
 container_max_starts:i('Starts',1,1000,20,G),
 container_start_fenster_ms:i('ms',1000,86400000,600000,G),
 container_pause_ms:i('ms',1000,86400000,300000,G),
 runner_input_bytes:b('Bytes',1024,16777216,65536,G),
 runner_output_bytes:b('Bytes',65536,1073741824,33554432,G,null,'SYNAPSE_REVERSE_OUTPUT_BYTES'),
 e_cpu:i('vCPU',1,256,2,G),
 e_ram_mib:i('MiB',256,1048576,4096,G),
 s3_cpu:i('vCPU',1,256,2,G),
 s3_ram_mib:i('MiB',256,1048576,4096,G),
 queue_offene_max:i('wartende Aufträge',1,I32,10000,G,null,'SYNAPSE_REVERSE_QUEUE_MAX'),
 entstoerer_intervall_ms:i('ms',1000,86400000,60000,G,null,'SYNAPSE_REVERSE_ENTSTOERER_MS'),
 entstoerer_gnade_s:i('s',0,86400,300,G,'sofort nach eigentlicher Fälligkeit','SYNAPSE_REVERSE_ENTSTOERER_GNADE_S'),
 entstoerer_ohne_ausfuehrer_s:i('s',0,86400,60,G,'sofort','SYNAPSE_REVERSE_ENTSTOERER_KEIN_AUSFUEHRER_S'),
 diagnose_fehler_stunden:i('h',1,87600,24,G,null,'SYNAPSE_REVERSE_DIAGNOSE_FEHLER_STUNDEN'),
 diagnose_seiten_limit:i('Zeilen',1,10000,200,GP),
 diagnose_max_limit:i('Zeilen',1,10000,1000,GP),
 diagnose_verlauf_speicher:i('Maßnahmen',1,10000,50,G),
 diagnose_verlauf_anzeige:i('Maßnahmen',1,10000,20,GP),
 diagnose_meldung_zeichen:i('Zeichen',64,65536,500,G),
 diagnose_log_zeichen:i('Zeichen',64,65536,300,G),
 fortschritt_takt_s:i('s',1,600,10,G),
 fortschritt_haenger_s:i('s',1,86400,180,G),
 fortschritt_datei_zeichen:i('Zeichen',16,4096,200,G),
 // P18-T87: Puffer der harten Executor-Frist (zeitlimit + Puffer, unter der Transportfrist zeitlimit + 60 s) und Nachlauf fuer Manifest/Hashing.
 hart_puffer_s:i('s',1,55,30,G),
 nachlauf_s:i('s',1,86400,300,G),
 status_auftraege_max:i('Aufträge',1,10000,100,GP,null,'SYNAPSE_REVERSE_STATUS_AUFTRAEGE_MAX'),
 container_offen_anzeige:i('Container',1,10000,50,GP),
 // P18-T40: Leserpaket und Magic-Probe; nur PG, kein Env-Fallback.
 leser_paket_bytes:b('Bytes je Leserpaket',1,67108864,16777216,G),
 leser_magic_bytes:b('Bytes je Magic-Probe',1,1048576,65536,GE),
 leser_nachzug_block_zeilen:i('Dateizeilen je Nachzugschritt',1,50000,1000,G),
 // P18-T45: Format-Hinweise; keine Analyse oder Leser-Ausführung.
 leser_hinweis_min_dateien:i('Dateien je RV27-Gruppe',1,1000000,1,GP),
 leser_hinweis_funktionen:i('RV30-Funktionen je Hinweis',0,100,3,GP,'Funktionsliste aus'),
 // E / S3 / Speicher: kein Gesamtdateilimit, nur Schritt-, Block- und Schutzgrenzen.
 // P18-T93: E-AUS hält zu große Batches offen zurück; MAX_RESULTS entfällt.
 // Importer/Speicher lesen PG-Grenzen; der E-AUS-Runner folgt gesondert in Teil B.
 e_schritt_dateien:i('neu bearbeitete Einträge',1,1000000,200000,GE),
 pe_schritt_eintraege:i('PE-Ressourcen je Schritt',1,1000000,5000,GE),
 e_uebernahme_block_zeilen:i('Zeilen pro TX',1,50000,5000,GE),
 s1_materialisierung_block_zeilen:i('Zeilen pro TX',1,50000,5000,GE),
 materialisierung_tx_bytes:b('kanonische Nutzdatenbytes pro TX',65536,67108864,4194304,GE),
 manifest_segment_zeilen:i('Zeilen pro Segment',1,50000,5000,GE),
 manifest_record_bytes:b('Bytes pro Metadatensatz',1024,16777216,65536,GE),
 e_lauf_bytes:b('erzeugte Bytes je Entpackversuch',1,B64,'2000000000',GE,null,'SYNAPSE_REVERSE_MAX_BYTES'),
 e_zeitlimit_s:i('s je Versuch',1,86400,3600,GE,null,'SYNAPSE_REVERSE_ZEITLIMIT_S'),
 s3_lauf_bytes:b('Bytes je S3-Exportversuch',1048576,B64,268435456,GE,null,'SYNAPSE_REVERSE_S3_MAX_BYTES'),
 s3_zeitlimit_s:i('s',60,86400,3600,GE,null,'SYNAPSE_REVERSE_S3_ZEITLIMIT_S'),
 max_datei_bytes:b('Bytes je Ergebnisdatei',1,B64,'4294967296',GE,null,'SYNAPSE_REVERSE_MAX_FILE_BYTES'),
 eintrag_bytes:b('belegte/reservierte Bytes Eintrag',1,B64,'107374182400',GE,null,'SYNAPSE_REVERSE_MAX_PROJECT_BYTES'),
 eintrag_dateien_warnung:i('Dateien',0,I32,500000,GE,'Warnung aus','SYNAPSE_REVERSE_MAX_PROJECT_FILES'),
 pfad_tiefe_max:i('relative Verzeichnisebenen',1,128,32,GE),
 verschachtelung_max:i('Archivschichten',0,32,8,GE,'verschachtelte Entpackung aus; Inhalt als offen/nicht analysiert markieren','SYNAPSE_REVERSE_MAX_VERSCHACHTELUNG'),
 kompressionsfaktor_max:i('Verhältnis',1,1000,200,GE),
 parser_ram_mib:i('MiB',256,65536,2048,GE),
 parser_timeout_ms:i('ms',1,3600000,30000,GE),
 parser_einheit_bytes:b('Bytes',128,B64,16777216,GE),
 parser_qualitaet_milli:i('Punkte',0,1000,800,GE),
 parser_region_min_zeichen:i('Zeichen',1,1048576,128,GE),
 parser_region_luecke_bytes:i('Bytes',0,0,0,GE),
 parser_kandidaten_max:i('Parser',1,70,4,GE),
 s3_pg_budget_bytes:b('Bytes Analysebestand je Eintrag',1,B64,1073741824,GE),
 s3_nachzug_lease_ms:i('ms',1000,3600000,300000,G),
 // P18-T98/T111: gedrosselter Nachzug mit niedrigster Prioritaet (reverse-nachzug-auto.ts); Schalter Standard aus.
 s1_neu_parsen_auto:auswahl('Schalter',['aus','an'],'aus',G),
 s1_neu_parsen_schritt:i('S1-Neu-Parsen-Auftraege offen bzw. je Takt',1,10000,50,G),
 s3_auto:auswahl('Schalter',['aus','an'],'aus',G),
 s3_auto_offen_max:i('offene Auto-S3-Auftraege',1,64,1,G),
 s3_auto_schritt:i('Auto-S3-Einreihungen je Takt',1,64,1,G),
 auto_nachzug_debug:auswahl('Schalter',['aus','an'],'aus',G),
 // Vorrang des Nachzugs: aussetzen erst UEBER diesen Rueckstaenden (0 = nicht pruefen); ein Dauer-Rest blockiert sonst fuer immer.
 nachzug_vorrang_chunks_max:i('offene Code-Chunks (Embedding)',0,I32,1000,G,'nicht pruefen'),
 nachzug_vorrang_parse_max:i('faellige Projektdateien (Parser)',0,I32,100,G,'nicht pruefen'),
 analyse_bis_schicht:auswahl('Schicht',['E','S0','S1','S2','S3'],'S1',GE,'SYNAPSE_REVERSE_BIS_SCHICHT'),
 // Runner-intern / Aufnahme / Übertragung / S1
 guard_intervall_ms:i('ms',10,5000,500,G),
 prozess_stop_gnade_ms:i('ms',0,60000,2000,G,'direkt hart stoppen'),
 prozess_stop_poll_ms:i('ms',1,1000,50,G),
 prozess_wait_ms:i('ms',1,60000,5000,G),
 fortschritt_join_ms:i('ms',1,60000,5000,G),
 cleanup_versuche:i('Versuche',1,100,3,G),
 sandbox_probe_timeout_ms:i('ms',1,60000,1000,G),
 begleitdateien_max:i('Dateien je Verbund',1,10000,64,GE),
 descriptor_bytes:b('Bytes je Kontrolltext',1,67108864,1048576,GE,null,'SYNAPSE_REVERSE_DESCRIPTOR_MAX_BYTES'),
 disc_scan_sektoren:i('Sektoren',16,4096,64,GE),
 disc_sessions_max:i('Sessions',1,99,99,GE),
 disc_abschnitte_max:i('Abschnitte',1,100000,1000,GE),
 disc_lba_vorlauf_max:i('Sektoren',0,10000000,45150,GE,'kein negativer Vorlauf'),
 disc_lba_max:i('Sektoren',1,I32,10000000,GE),
 disc_puffer_sektoren:i('Sektoren',1,8192,256,GE),
 pe_scan_bytes:b('Bytes je Erkennung',1,B64,67108864,GE),
 pe_scan_block_bytes:b('Bytes',4096,67108864,4194304,GE),
 pe_version_tiefe:i('Ebenen',1,128,16,GE),
 pe_warnungen_anzeige:i('Meldungen pro Seite',1,10000,20,GP),
 lese_block_bytes:b('Bytes',4096,67108864,1048576,GE),
 speicher_chunk_bytes:b('Bytes',1,67108864,8388608,G),
 speicher_parallel_transfers:i('Transfers',1,16,2,G),
 speicher_timeout_ms:i('ms',1,3600000,120000,G),
 eingang_scan_ms:i('ms',1000,86400000,60000,G),
 eingang_retry_ms:i('ms',1000,86400000,30000,G),
 eingang_block_dateien:i('Dateien',1,50000,10000,G,null,'SYNAPSE_REVERSE_BATCH_MAX'),
 eingang_stabil_ms:i('ms',0,3600000,2000,G,'sofort bei anderweitig bestätigtem EOF','SYNAPSE_REVERSE_STABIL_MS'),
 eingang_status_limit:i('Zeilen',1,10000,200,G),
 eingang_status_max_limit:i('Zeilen',1,50000,10000,G),
 eingang_loeschverhalten:auswahl('Verhalten',['behalten','mitloeschen'],'behalten',G,'SYNAPSE_REVERSE_LOESCH_VERHALTEN'),
 cursor_zeichen:i('Zeichen',128,65536,2048,G),
 e_metadaten_record_bytes:b('Bytes',1024,16777216,16384,GE),
 pipeline_parallel:i('Worker',1,16,1,G,null,'SYNAPSE_REVERSE_PARALLEL'),
 pipeline_scan_ms:i('ms',1000,86400000,60000,G),
 pipeline_durchlauf_ms:i('ms',1,86400000,48000,G,null,'SYNAPSE_REVERSE_DURCHLAUF_MS'),
 pipeline_discovery_block:i('Jobs',1,50000,100,G,null,'SYNAPSE_REVERSE_DISCOVERY_BATCH'),
 inspektion_datei_bytes:b('Bytes',1,B64,268435456,GE),
 inspektion_read_schritt_bytes:b('Bytes',1,B64,67108864,GE),
 inspektion_hash_schritt_bytes:b('Bytes',1,B64,268435456,GE),
 inspektion_objekte_block:i('Objekte',1,50000,10000,GE),
 inspektion_timeout_ms:i('ms',1,3600000,30000,GE),
 worker_gnade_ms:i('ms',0,60000,5000,G,'kein Zusatz'),
 s1_strings_schritt_bytes:b('Bytes',1,B64,4194304,GE,null,'SYNAPSE_REVERSE_STRINGS_BYTES'),
 s1_strings_min_zeichen:i('Zeichen',1,4096,4,GE,null,'SYNAPSE_REVERSE_STRINGS_MIN'),
 s1_textstueck_bytes:b('Bytes',4,524288,262144,GE),
 analyse_spool_block_bytes:b('Bytes',65536,67108864,8388608,GE,null,'SYNAPSE_REVERSE_CACHE_BYTES'),
 analyse_stichprobe_bytes:b('Bytes',1,67108864,4096,GE),
 packer_entropie_millibit:i('1/1000 Bit pro Byte',0,8000,7200,GE,'jede Entropie>0 verdächtig'),
 // Leser / Analyseabfragen: Paging begrenzt die Antwort, niemals die gespeicherte Menge
 antwort_bytes:b('UTF8-Bytes',1024,16777216,80000,GP,null,'SYNAPSE_REVERSE_ANTWORT_MAX'),
 seiten_limit:i('Zeilen',1,10000,50,GP,null,'SYNAPSE_REVERSE_LIST_LIMIT'),
 max_limit:i('Zeilen',1,10000,200,GP,null,'SYNAPSE_REVERSE_MAX_LIMIT'),
 code_seiten_limit:i('Zeilen',1,10000,200,GP),
 code_such_seiten_limit:i('Zeilen',1,10000,20,GP),
 code_max_limit:i('Zeilen',1,10000,500,GP,null,'SYNAPSE_REVERSE_CODE_MAX_LIMIT'),
 code_match_limit:i('Treffer je Datei',1,10000,20,GP),
 code_match_max:i('Treffer je Datei',1,10000,200,GP),
 code_treffer_zeichen:i('Zeichen',16,65536,200,GP),
 code_treffer_vorlauf_zeichen:i('Zeichen',0,65536,60,GP,'kein Vorlauf'),
 code_name_match_probe:i('Zeilen',1,1000,10,GP),
 code_suffix_vorschlaege:i('Zeilen',1,1000,20,GP),
 code_string_min_zeichen:i('Zeichen',0,4096,4,GP,'keine Mindestauswahl'),
 baum_tiefe:i('Ebenen',0,128,100,GP,'nur Wurzel'),
 asset_seiten_limit:i('Dateien',1,10000,500,GP),
 asset_max_limit:i('Dateien',1,10000,5000,GP),
 asset_objekt_limit:i('Objekte',0,10000,50,GP,'Objektausgabe aus'),
 asset_objekt_max:i('Objekte',1,10000,500,GP),
 asset_verweis_limit:i('Verweise',0,10000,50,GP,'Verweisausgabe aus'),
 asset_verweis_max:i('Verweise',1,10000,500,GP),
 metadaten_anzeige_zeichen:i('Zeichen je Feld',16,65536,300,GP),
 antwort_rekursion_max:i('Ebenen',1,256,50,GP),
 antwort_reserve_bytes:b('Bytes',0,65536,200,GP,'keine Zusatzreserve'),
 max_pfad_zeichen:i('Zeichen',1,65536,4096,GP),
 parameter_text_zeichen:i('Zeichen',1,65536,4096,GP,null,'SYNAPSE_REVERSE_TEXT_MAX'),
 analyse_verweise:i('Datensätze je Abfrageschritt',1,I32,10000,GP),
 analyse_dateien:i('Datensätze je Abfrageschritt',1,I32,30000,GP),
 analyse_funktionen:i('Datensätze je Abfrageschritt',1,I32,50000,GP),
 analyse_kanten:i('Datensätze je Abfrageschritt',1,I32,100000,GP),
 max_ziele:i('Ziele je Abfrageschritt',1,I32,200,GP),
 aufrufer_tiefe:i('Graphstufen',1,128,3,GP),
 aufrufer_max:i('Datensätze je Abfrageschritt',1,I32,100,GP),
 konfidenz_prozent:i('%',1,100,80,GP),
 max_muster_zeichen:i('Zeichen',1,65536,512,GP),
 laufzeit_ms:i('ms je Analyseabfrage',1,3600000,5000,GP),
 erkenntnis_bytes:b('Bytes',1024,16777216,60000,GP),
 erkenntnis_belege:i('Anzahl je Erkenntnis',1,10000,100,GP),
 erkenntnis_aussagen:i('Anzahl je Erkenntnis',1,10000,100,GP),
 ref_marken_max:i('Marken je Anfrage',1,10000,10,GP,null,'SYNAPSE_REF_VERGLEICH_MAX_MARKEN'),
 ref_fenster_zeilen:i('Zeilen',1,100000,200,GP,null,'SYNAPSE_REF_VERGLEICH_FENSTER_ZEILEN'),
 longpoll_max_s:i('s',0,300,50,G,'Longpoll deaktiviert, sofortiger Status'),
 longpoll_takt_ms:i('ms',10,60000,100,G,null,'SYNAPSE_REVERSE_POLL_MS'),
 api_timeout_ms:i('ms',1,3600000,60000,G,null,'SYNAPSE_REVERSE_API_TIMEOUT_MS'),
 api_timeout_zuschlag_ms:i('ms',1,60000,5000,G),
 leser_statement_timeout_ms:i('ms',1,3600000,10000,GP),
 leser_lock_timeout_ms:i('ms',1,3600000,2000,GP),
 leser_idle_tx_timeout_ms:i('ms',1,3600000,10000,GP),
 einstellungen_override_timeout_ms:i('ms',1,60000,2000,G),
 einstellungen_schreiben_timeout_ms:i('ms',1,60000,10000,G),
 einstellungen_schreiben_lock_ms:i('ms',1,60000,2000,G),
 // Vorschau / technische Detailkürzungen
 vorschau_offen_s:i('s',1,86400,300,GP),
 vorschau_offen_max_s:i('s',1,86400,3600,GP),
 vorschau_pixel:i('Pixel',1,268435456,16777216,GP),
 vorschau_bytes:b('Bytes',1,268435456,8388608,GP),
 vorschau_anzahl:i('Bilder',1,100,5,GP),
 vorschau_input_bytes:b('Bytes',1,268435456,67108864,GP),
 vorschau_ram_bytes:b('Bytes',67108864,'17179869184',1073741824,G),
 vorschau_timeout_ms:i('ms',1,3600000,15000,GP),
 vorschau_kante:i('Pixel',1,16384,2048,GP),
 vorschau_frames:i('Frames',1,100,1,GP),
 vorschau_dauer_ms:i('ms',1,60000,12000,GP),
 vorschau_parallel:i('Renderer',1,8,1,G),
 s3_name_zeichen:i('Zeichen',1,65536,512,GE),
 s3_prototyp_zeichen:i('Zeichen',1,65536,2048,GE),
 s3_status_zeichen:i('Zeichen',1,4096,200,GE),
 speicher_pfad_zeichen:i('Zeichen',1,65536,4096,GE),
} as const satisfies Record<string,ReverseEinstellDefinition>;
export type ReverseEinstellSchluessel=keyof typeof REVERSE_EINSTELLKATALOG;
export function reverseEinstellDefinition(name:string):ReverseEinstellDefinition {
 if(!Object.hasOwn(REVERSE_EINSTELLKATALOG,name))throw new Error('reverse_name_ungueltig:'+name);
 return REVERSE_EINSTELLKATALOG[name as ReverseEinstellSchluessel];
}
/** Validiert einen Wert gegen den Katalog: Ganzzahlen als kanonischer Dezimaltext, Auswahlwerte exakt. */
export function reverseEinstellWert(name:string,roh:unknown):string {
 const d=reverseEinstellDefinition(name);
 if(d.typ==='enum'){
  if(typeof roh!=='string'||!d.werte!.includes(roh))throw new Error('reverse_wert_ungueltig:'+name);
  return roh;
 }
 if(typeof roh==='number'&&!Number.isSafeInteger(roh))throw new Error('reverse_wert_ungenau:'+name);
 if(typeof roh!=='string'&&typeof roh!=='number')throw new Error('reverse_wert_ungueltig:'+name);
 const text=String(roh);
 if(!/^(0|[1-9][0-9]*)$/.test(text))throw new Error('reverse_wert_ungueltig:'+name);
 const n=BigInt(text);
 if(n<BigInt(d.min!)||n>BigInt(d.max!))throw new Error('reverse_wert_ausserhalb:'+name);
 return text;
}
/** Früherer Name; nur noch Alias. */
export const reverseGanzzahl=reverseEinstellWert;
/** Expliziter Rand zu APIs, die number erwarten; niemals still runden. */
export function reverseSichereZahl(wert:string,name:string):number {
 const n=BigInt(wert);
 if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('reverse_number_bereich:'+name);
 return Number(n);
}
/** Budget-Rand für number-Verbraucher: Ein Wert über MAX_SAFE_INTEGER wirkt für jeden messbaren Verbrauch (selbst eine
 * sichere number) wie unbegrenzt. Bewusst engere Grenze des Verbrauchers, kein Runden eines Messwerts. */
export function reverseBudgetZahl(wert:string):number {
 const n=BigInt(wert);
 return n>BigInt(Number.MAX_SAFE_INTEGER)?Number.MAX_SAFE_INTEGER:Number(n);
}
export const REVERSE_EINSTELL_PAARE = [
 ['seiten_limit','max_limit'],['code_seiten_limit','code_max_limit'],
 ['code_such_seiten_limit','code_max_limit'],['code_match_limit','code_match_max'],
 ['asset_seiten_limit','asset_max_limit'],['asset_objekt_limit','asset_objekt_max'],
 ['asset_verweis_limit','asset_verweis_max'],['vorschau_offen_s','vorschau_offen_max_s'],
 ['max_datei_bytes','eintrag_bytes'],['manifest_record_bytes','materialisierung_tx_bytes'],
 ['e_metadaten_record_bytes','manifest_record_bytes'],['diagnose_verlauf_anzeige','diagnose_verlauf_speicher'],
 ['leser_statement_timeout_ms','leser_idle_tx_timeout_ms'],['code_treffer_vorlauf_zeichen','code_treffer_zeichen'],
 ['diagnose_seiten_limit','diagnose_max_limit'],['eingang_status_limit','eingang_status_max_limit'],
] as const;
type Term=readonly [ReverseEinstellSchluessel,bigint];
/** Lineare Querbedingung: Summe(links) <= Summe(rechts) bzw. < bei strikt. Eine Quelle für API und DB-Trigger. */
export interface ReverseEinstellRegel {name:string;links:readonly Term[];rechts:readonly Term[];strikt:boolean}
export const REVERSE_EINSTELL_REGELN:readonly ReverseEinstellRegel[] = [
 ...REVERSE_EINSTELL_PAARE.map(([klein,gross])=>({name:klein+'>'+gross,links:[[klein,1n]] as const,rechts:[[gross,1n]] as const,strikt:false})),
 {name:'renew_lease',links:[['executor_renew_min_ms',2n]],rechts:[['executor_lease_s',1000n]],strikt:true},
 {name:'fortschritt',links:[['fortschritt_takt_s',2n]],rechts:[['fortschritt_haenger_s',1n]],strikt:false},
 {name:'longpoll',links:[['longpoll_max_s',1000n],['api_timeout_zuschlag_ms',1n]],rechts:[['api_timeout_ms',1n]],strikt:false},
];
export function pruefeReverseEinstellKonsistenz(werte:Record<ReverseEinstellSchluessel,string>):void {
 const summe=(t:readonly Term[])=>t.reduce((s,[n,f])=>s+BigInt(werte[n])*f,0n);
 for(const r of REVERSE_EINSTELL_REGELN){
  const l=summe(r.links),g=summe(r.rechts);
  if(r.strikt?l>=g:l>g)throw new Error('reverse_einstellungen_widerspruch:'+r.name);
 }
}
