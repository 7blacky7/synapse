/**
 * P22-T156: Ergebnisart eines Tool-Aufrufs fuer das Agentennetzwerk, serverseitig aus tool_calls abgeleitet.
 *
 * WARUM: tool_calls.ok heisst nicht 'erfolgreich'. Handler, die {success:false} liefern statt zu werfen, stehen mit ok=true und
 * error=NULL in der Tabelle (Befund Entwurf 7cf4ac63: in 24 h 69 solcher Zeilen neben 71 ok=false). Die Projektion liest deshalb
 * zusaetzlich den Fehlercode aus dem gespeicherten Ergebnis (nur das Feld error/fehler/status per SQL-Ausschnitt) und den
 * Rueckfrage-Vermerk der Shell. Ins Netz geht NUR die Art und ein normalisierter Code ([a-z0-9_], max. 40 Zeichen), nie Rohtext:
 * Freitext-Fehler enthalten Pfade, Agentennamen und IDs und werden auf feste Codes abgebildet.
 *
 * ARTEN: erfolg | leer (T97, erfolgreich mit 0 Treffern) | falsch_aufgerufen | gesperrt | nicht_gefunden | konflikt | serverfehler |
 * wartet | sonstiges (success:false ohne erkennbaren Code; eigener Zaehler, damit Luecken der Tabelle sichtbar bleiben).
 * Entscheidungen Koordinator (Go zu 7cf4ac63): R1 eigene Art konflikt; R2 sql_fehler aus intern db_lesen = falsch_aufgerufen, andere
 * DB-Ausnahmen serverfehler; R3 shell_anleitung = gesperrt, build_pruefung_eingereiht = erfolg; R8 rueckwirkend ehrlich.
 */

export const NETZ_ERGEBNIS_ARTEN = ['erfolg', 'leer', 'falsch_aufgerufen', 'gesperrt', 'nicht_gefunden', 'konflikt', 'serverfehler', 'wartet', 'sonstiges'] as const;
export type NetzErgebnisArt = typeof NETZ_ERGEBNIS_ARTEN[number];

/** Rohdaten einer tool_calls-Zeile fuer die Klassifikation (serverseitig; die Textfelder verlassen den Server nie). */
export interface NetzErgebnisRoh {
  ok: boolean;
  tool_name?: string | null;
  action?: string | null;
  error?: string | null;
  /** SQL-Ausschnitt: Wert von "error" bzw. "fehler" im gespeicherten Ergebnis (nur bei success:false gelesen). */
  ergebnis_code?: string | null;
  /** SQL-Ausschnitt: Wert von "status" im gespeicherten Ergebnis. */
  ergebnis_status?: string | null;
  /** SQL-Ausschnitt: Anfang von "message" (nur zur Musterzuordnung, wird nie ausgeliefert). */
  ergebnis_meldung?: string | null;
  /** Gespeichertes Ergebnis beginnt mit success:false. */
  erfolg_false?: boolean | null;
  /** Shell-Vermerk {stufe:'rueckfrage', ausgefuehrt:false}. */
  rueckfrage?: boolean | null;
  /** Shell-Antwort {stufe:'anleitung', ausgefuehrt:false} (oft ohne error-Feld; R3: gesperrt). */
  anleitung?: boolean | null;
  /** T97: erfolgreiches Ergebnis mit 0 Treffern. */
  ergebnis_leer?: boolean | null;
}

/** Exakte Codes -> Art. 'erfolg' = bewusst kein Fehler (R3). */
export const NETZ_FEHLERCODE_ART: Readonly<Record<string, NetzErgebnisArt>> = Object.freeze({
  // falsch aufgerufen: der Aufruf selbst ist ungueltig
  unbekannter_parameter: 'falsch_aufgerufen', parameter_erforderlich: 'falsch_aufgerufen', parameter_ungueltig: 'falsch_aufgerufen',
  parameter_fehlt: 'falsch_aufgerufen', invalid_param: 'falsch_aufgerufen', invalid_ops: 'falsch_aufgerufen', too_many_queries: 'falsch_aufgerufen',
  mehrdeutig: 'falsch_aufgerufen', pfad_ungueltig: 'falsch_aufgerufen', ungueltig: 'falsch_aufgerufen', unbekannte_action: 'falsch_aufgerufen',
  action_unbekannt: 'falsch_aufgerufen', identitaet_parameter_ungueltig: 'falsch_aufgerufen', agent_kennung_widerspruch: 'falsch_aufgerufen',
  project_fehlt: 'falsch_aufgerufen', grund_fehlt: 'falsch_aufgerufen', einstellung_fehlt: 'falsch_aufgerufen', einstellung_ungueltig: 'falsch_aufgerufen',
  modus_ungueltig: 'falsch_aufgerufen', erwartete_revision_fehlt: 'falsch_aufgerufen', schatten_nicht_unterstuetzt: 'falsch_aufgerufen',
  // gesperrt: Recht, Schalter, Ausweis, Profil
  recht_fehlt: 'gesperrt', identitaet_recht_fehlt: 'gesperrt', nur_koordinator: 'gesperrt', nicht_erlaubt: 'gesperrt', nicht_berechtigt: 'gesperrt',
  nur_global: 'gesperrt', nur_betroffener: 'gesperrt', main_nur_lesen: 'gesperrt', kein_hauptagent_kontext: 'gesperrt',
  hauptagent_nur_artefakt: 'gesperrt', profil_werkzeug_gesperrt: 'gesperrt', profil_nicht_pruefbar: 'gesperrt', pfad_gesperrt: 'gesperrt',
  shell_sperre: 'gesperrt', shell_anleitung: 'gesperrt', not_allowed_yet: 'gesperrt', cwd_outside_project: 'gesperrt', funktion_aus: 'gesperrt',
  token_identitaet_aus: 'gesperrt', jev_aus: 'gesperrt', db_lesen_aus: 'gesperrt', reverse_nicht_unterstuetzt: 'gesperrt', projekt_inaktiv: 'gesperrt',
  agent_token_fehlt: 'gesperrt', agent_token_ungueltig: 'gesperrt', agent_token_fremdes_projekt: 'gesperrt', ausweis_konflikt: 'gesperrt',
  selbstauskunft_weicht_ab: 'gesperrt', channel_im_ausweis_festgelegt: 'gesperrt', keine_bindung: 'gesperrt', nicht_gebunden: 'gesperrt',
  bindung_ungueltig: 'gesperrt', eigenprofil_nicht_aenderbar: 'gesperrt', identity_id_fehlt: 'gesperrt', unauthorized: 'gesperrt',
  visum_nur_lesen: 'gesperrt', arbeitsfreigabe_fehlt: 'gesperrt',
  // nicht gefunden
  not_found: 'nicht_gefunden', nicht_gefunden: 'nicht_gefunden', nicht_gefunden_text: 'nicht_gefunden', invalid_job_id: 'nicht_gefunden',
  unknown_job: 'nicht_gefunden', identitaet_unbekannt: 'nicht_gefunden', tabelle_unbekannt: 'nicht_gefunden',
  datei_nicht_im_asset_index: 'nicht_gefunden', bestaetigung_unbekannt: 'nicht_gefunden', nicht_im_index: 'nicht_gefunden',
  // konflikt: Zustand passt nicht, Pruefung lehnt Inhalt ab
  plan_failed: 'konflikt', plan_update_failed: 'konflikt', plan_has_failed_ops: 'konflikt', coedit_conflict: 'konflikt',
  coedit_incomplete: 'konflikt', conflict: 'konflikt', stale: 'konflikt', already_committed: 'konflikt', already_finished: 'konflikt',
  cancelled: 'konflikt', commit_failed: 'konflikt', contribution_failed: 'konflikt', nothing_written: 'konflikt', fs_plan_changed: 'konflikt',
  fremder_plan: 'konflikt', bestaetigung_veraltet: 'konflikt', lage_geaendert: 'konflikt', dublette: 'konflikt', bindung_existiert: 'konflikt',
  identitaet_existiert: 'konflikt', name_gehoert_bestehendem_agenten: 'konflikt', plan_offen: 'konflikt', nicht_vorgemerkt: 'konflikt',
  zu_jung: 'konflikt', familie_passt_nicht: 'konflikt', nicht_generisch: 'konflikt', pruef_befunde: 'konflikt', identitaet_konflikt: 'konflikt',
  agent_sitzung_bereits_gebunden: 'konflikt', agent_legacy_zustand_bereits_gebunden: 'konflikt', koordinator_vorhanden: 'konflikt',
  syntaxfehler: 'konflikt', edits_passen_nicht: 'konflikt', wait_fehlt: 'konflikt', platte_weicht_ab: 'konflikt', zustand_passt_nicht: 'konflikt',
  // serverfehler (auch Zeitueberschreitung und DB-Ausnahmen)
  sql_fehler: 'serverfehler', interner_fehler: 'serverfehler', exec_exception: 'serverfehler', workspace_exec_failed: 'serverfehler',
  daemon_restart: 'serverfehler', identitaet_speicher_fehler: 'serverfehler', koordinator_liste_fehlgeschlagen: 'serverfehler',
  netzwerk_einstellungen_fehler: 'serverfehler', agent_anmeldung_fehlgeschlagen: 'serverfehler', fremdprojekt_nicht_pruefbar: 'serverfehler',
  timeout: 'serverfehler', zeitueberschreitung: 'serverfehler', datenbankfehler: 'serverfehler', ausnahme: 'serverfehler',
  nicht_implementiert: 'serverfehler',
  // wartet auf Bestaetigung bzw. Beitraege
  shell_rueckfrage: 'wartet', waiting_for_contributors: 'wartet', demaskieren_rueckfrage: 'wartet', waiting: 'wartet',
  // kein Fehler (R3)
  build_pruefung_eingereiht: 'erfolg',
});

/** Freitext -> normalisierter Code (Reihenfolge = Vorrang). Der Text selbst wird nie ausgeliefert. */
const FREITEXT_MUSTER: ReadonlyArray<readonly [RegExp, string]> = [
  [/unbekannter_parameter/, 'unbekannter_parameter'],
  [/Syntaxfehler/i, 'syntaxfehler'],
  [/Edits? passen nicht|Suchtext/i, 'edits_passen_nicht'],
  [/Kein (verbundener )?aktiver Wait/i, 'wait_fehlt'],
  [/weicht von PostgreSQL ab/i, 'platte_weicht_ab'],
  [/ist nicht offen|nicht abbrechbar|gehoert zu k|ausserhalb des .*Scope|passt nicht zu dir/i, 'zustand_passt_nicht'],
  [/duplicate key|violates|invalid input syntax/i, 'datenbankfehler'],
  [/ist erforderlich|sind erforderlich|erforderlich \(|braucht |muss mindestens|darf nicht leer|Genau .* angeben/i, 'parameter_erforderlich'],
  [/^(Error: )?Unbekannte \w+ action|Kein Guide fuer/i, 'action_unbekannt'],
  [/nicht unterst(ue|ü)tzt/i, 'schatten_nicht_unterstuetzt'],
  [/nicht berechtigt|nicht erlaubt|nur (der )?koordinator/i, 'nicht_berechtigt'],
  [/unauthorized/i, 'unauthorized'],
  [/nicht im Index|nicht im Asset-Index/i, 'nicht_im_index'],
  [/nicht gefunden|not found|existiert nicht|unbekannte(r|s)? (Datei|ID|Plan|Task)/i, 'nicht_gefunden_text'],
  [/aborted|timeout|zeitlimit|ETIMEDOUT|Zeitueberschreitung/i, 'zeitueberschreitung'],
  [/noch nicht implementiert/i, 'nicht_implementiert'],
  [/ENOENT|ECONNREFUSED|Unprocessable|Internal Server|exception/i, 'ausnahme'],
];

const CODE_FORM = /^[a-z][a-z0-9_]{1,39}$/;
/** Nur ein Code in fester Form, sonst null (Freitext, Pfade, Namen fallen hier heraus). */
export function netzFehlerCode(wert: unknown): string | null {
  if (typeof wert !== 'string') return null;
  const t = wert.trim();
  if (CODE_FORM.test(t)) return t;
  // 'unbekannter_parameter: paths' (alter stdio-Weg) -> Praefix vor dem Doppelpunkt
  const praefix = /^([a-z][a-z0-9_]{1,39}):\s/.exec(t);
  return praefix ? praefix[1] : null;
}
function jsonFehler(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const m = /"(?:error|fehler)"\s*:\s*"([^"]{1,120})"/.exec(text);
  return m ? m[1] : null;
}
function ausMuster(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !text) return null;
  for (const [muster, code] of FREITEXT_MUSTER) if (muster.test(text)) return code;
  return null;
}
const kurz = (tool: string | null | undefined) => String(tool ?? '').split('__').pop() ?? '';

function artVon(code: string, tool: string, action: string): NetzErgebnisArt | null {
  // R2: falsches SQL des Agenten in intern db_lesen ist ein falscher Aufruf, kein Serverfehler.
  if (code === 'sql_fehler' && tool === 'intern' && action === 'db_lesen') return 'falsch_aufgerufen';
  return NETZ_FEHLERCODE_ART[code] ?? null;
}

/** P22-T156: Ergebnisart und normalisierter Code einer tool_calls-Zeile. fehler_code ist null bei erfolg/leer. */
export function netzwerkErgebnis(r: NetzErgebnisRoh): { ergebnis_art: NetzErgebnisArt; fehler_code: string | null } {
  const tool = kurz(r.tool_name), action = String(r.action ?? '');
  const fehlgeschlagen = !r.ok || r.erfolg_false === true || r.rueckfrage === true;
  if (!fehlgeschlagen) return { ergebnis_art: r.ergebnis_leer ? 'leer' : 'erfolg', fehler_code: null };
  // 1) feste Codes: Ergebnisfeld error/fehler, Status (nur bekannte), Fehlerspalte, JSON in der Fehlerspalte (stdio-Weg)
  const kandidaten = [netzFehlerCode(r.ergebnis_code), netzFehlerCode(r.ergebnis_status), netzFehlerCode(r.error), netzFehlerCode(jsonFehler(r.error))];
  for (const c of kandidaten) {
    if (!c) continue;
    const art = artVon(c, tool, action);
    if (art === 'erfolg') return { ergebnis_art: 'erfolg', fehler_code: null };
    if (art) return { ergebnis_art: art, fehler_code: c };
  }
  if (r.rueckfrage) return { ergebnis_art: 'wartet', fehler_code: 'shell_rueckfrage' };
  if (r.anleitung) return { ergebnis_art: 'gesperrt', fehler_code: 'shell_anleitung' };
  // 2) Freitext auf feste Codes abbilden (Ergebnisfeld, Fehlerspalte, Meldung)
  for (const text of [r.ergebnis_code, r.error, r.ergebnis_meldung]) {
    const c = ausMuster(text);
    if (c) return { ergebnis_art: artVon(c, tool, action) ?? 'sonstiges', fehler_code: c };
  }
  // 3) unbekannter Code bleibt sichtbar (sonstiges), geworfene Ausnahme ohne Muster = serverfehler
  // Status-Werte (done, rejected ...) sind keine Fehlercodes; nur Ergebnisfeld und Fehlerspalte zaehlen hier.
  const unbekannt = [kandidaten[0], kandidaten[2], kandidaten[3]].find((c): c is string => !!c && c !== 'error');
  if (unbekannt) return { ergebnis_art: 'sonstiges', fehler_code: unbekannt };
  if (!r.ok && r.error) return { ergebnis_art: 'serverfehler', fehler_code: 'ausnahme' };
  return { ergebnis_art: 'sonstiges', fehler_code: 'ohne_code' };
}
