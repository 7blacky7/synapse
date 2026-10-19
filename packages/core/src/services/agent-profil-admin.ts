/**
 * P22-T13 Paket D: Verwaltungsaktionen fuer Schattenprofile, Typen, Profile, Persona, Produkt-Schalter und
 * Tokenabruf. EIN Dispatcher fuer admin(stdio), admin(REST/MCP) und die REST-Routen der aktiven Web-UI
 * (rest-api/routes/agent-profil.ts): alles geht ueber dieselben Core-Dienste (W1B_DIENSTE) und dieselben Pruefungen.
 *
 * AKTEUR (K10): ausschliesslich aus dem authentifizierten User-Eingang (user-herkunft.ts) oder der Tokenpruefung
 * (Principal). Ein Tool-Argument (agent_id, role, user ...) ist nie ein Nachweis. Verwalten darf nur der User oder
 * ein aktiver Koordinator DESSELBEN Projekts; die Rolle wird in PG gegengeprueft.
 * SCHALTER: jede Funktionsgruppe haengt am Produkt-Schalter (Standard AUS, agent-profil-schalter.ts) und
 * antwortet AUS mit funktion_aus; der Schalter selbst ist immer verwaltbar. Bestehende kontextprofil_* bleiben
 * unveraendert (kontextprofil-admin.ts).
 */
import { getPool } from '../db/client.js';
import {
  W1B_DIENSTE, W12_DIENSTE, W1bNichtUmgesetzt, SCHATTEN_ZUSTAENDE, MAIN_ROLLE, darfProfilAendern, type W1bAkteur, type AusweisAkteur, type Startart, type SchattenZustand, type ProfilInhalt, type TaskBindung,
} from './agent-profil-vertrag.js';
import { rolleFuerAgent } from './agent-rollen.js';
import {
  PROFIL_PRODUKT_FUNKTIONEN, ALT_AUSWEIS_FUNKTIONEN, leseProfilProduktSchalter, setzeProfilProduktSchalter, leseAusweisKern, ausweisSchattenAktiv, type ProfilProduktFunktion,
} from './agent-profil-schalter.js';
import {
  ProfilVerwaltungFehler, aktuellerW1bAkteur, pflichtText, pruefeProfilVerwalter, userAuftragFuer,
} from './agent-profil-verwalter.js';
import { listePersonaVersionen } from './agent-persona.js';
import { rufeWebUiKoordinatorTokenAb } from './agent-token-abruf.js';
import { HAUPTAGENT_ADMIN_ACTIONS, HAUPTAGENT_ADMIN_PARAMETER, istHauptagentAdminAction, fuehreHauptagentAdminAus } from './hauptagent-dienst.js';
import { AUSWEIS_FRIST_NAMEN, leseAusweisFristen, setzeAusweisFristen } from './agent-ausweis-fristen.js';
import { leseFilesPlanAblaufSchalter, setzeFilesPlanAblaufSchalter } from './files-plan-ablauf-schalter.js';
import { listeAusweisVisa, erteileArbeitsfreigabe, entzieheArbeitsfreigabe } from './agent-ausweis-projekte.js';
import { aktuellerAgentAufruf } from './agent-bezug.js';

const W1B_KERN_AKTIONEN = [
  'profil_schalter_status', 'profil_schalter_setzen', 'profil_uebersicht',
  'schattenprofil_liste', 'schattenprofil_korrigieren', 'schattenprofil_bestaetigen', 'schattenprofil_ablehnen',
  'typ_liste', 'typ_anlegen', 'typ_aendern', 'typ_revision_lesen',
  'profil_aendern', 'profil_historie', 'profil_rollback',
  'persona_liste', 'persona_versionen', 'persona_anlegen', 'persona_neue_version', 'persona_zuweisen', 'persona_entfernen',
  'agent_vorbereiten', 'token_abrufen', 'token_loeschen', 'web_ui_koordinator_token',
  'task_bindung_lesen', 'task_bindung_festlegen', 'task_bindung_aendern', 'task_bindung_entblocken',
  // P22-T45: Ausweis-Fristen als Einstellung (modus status|setzen|entfernen).
  'ausweis_fristen',
  // P22-T44: Ausweis fuer mehrere Projekte - Visa/Einwanderungen in DIESEM Projekt sehen, Arbeitsfreigabe erteilen/entziehen.
  'ausweis_visa', 'arbeitsfreigabe_erteilen', 'arbeitsfreigabe_entziehen',
] as const;
/** P22-T36: hauptagent_* additiv im selben admin-Weg; eigene Rechtepruefung (User + Main selbst) in hauptagent-dienst.ts. */
export const W1B_ADMIN_ACTIONS = [...W1B_KERN_AKTIONEN, ...HAUPTAGENT_ADMIN_ACTIONS] as const;
export type W1bAdminAction = typeof W1B_KERN_AKTIONEN[number];

/** Nur NEUE Parameternamen; bestehende (project, aktiv, grund, ebene, agent_id) bleiben byte-stabil unveraendert. */
export const W1B_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  profil_funktion: { type: 'string', enum: [...PROFIL_PRODUKT_FUNKTIONEN, ...ALT_AUSWEIS_FUNKTIONEN, 'alle'], description: 'Profilverwaltung: Produkt-Schalter-Funktion (profil_schalter_setzen)' },
  ziel_identity_id: { type: 'string', description: 'Profilverwaltung: Identitaets-ID des Zielprofils' },
  schattenprofil_id: { type: 'string', description: 'Profilverwaltung: ID des Schattenprofils' },
  zustand: { type: 'string', enum: [...SCHATTEN_ZUSTAENDE], description: 'Profilverwaltung: Filter schattenprofil_liste' },
  erwartete_revision: { type: 'number', description: 'Profilverwaltung: erwartete aktuelle Revision (CAS)' },
  ziel_revision: { type: 'number', description: 'Profilverwaltung: profil_rollback Zielrevision' },
  korrektur: { type: 'object', additionalProperties: true, description: 'Profilverwaltung: Korrektur am Schattenprofil' },
  profil_patch: { type: 'object', additionalProperties: true, description: 'Profilverwaltung: profil_aendern Aenderung (keine persona)' },
  typ_id: { type: 'string', description: 'Profilverwaltung: Typ-ID' },
  typ_schluessel: { type: 'string', description: 'Profilverwaltung: typ_anlegen Schluessel' },
  typ_inhalt: { type: 'object', additionalProperties: true, description: 'Profilverwaltung: Typ-Inhalt (typ_anlegen/typ_aendern)' },
  typ_revision: { type: 'number', description: 'Profilverwaltung: typ_revision_lesen Revision (Standard aktuell)' },
  profil_scope: { type: 'string', enum: ['global', 'projekt'], description: 'Profilverwaltung: Katalogebene fuer Typ/Persona (global nur User)' },
  persona_name: { type: 'string', description: 'Persona (nur auf User-Wunsch): Name der Vorlage' },
  persona_inhalt: { type: 'object', additionalProperties: true, description: 'Persona (nur auf User-Wunsch): Inhalt der Vorlage/Version' },
  persona_vorlage_id: { type: 'string', description: 'Persona: Vorlagen-ID' },
  persona_version: { type: 'number', description: 'Persona: zugewiesene Bibliotheksversion' },
  user_auftrag: { type: 'string', description: 'Persona/Profil: dokumentierter User-Auftrag (Wortlaut) fuer Koordinator-Aufrufe' },
  user_zustimmung: { type: 'string', description: 'Schattenprofil: Nachweis der User-Zustimmung bzw. Freigabe zum Alleinbestaetigen' },
  anlass: { type: 'string', description: 'token_abrufen: Anlass des Abrufs (Audit, ohne Tokenwert)' },
  agent_name: { type: 'string', description: 'agent_vorbereiten: Name der neuen Identitaet (oder laufende Legacy-Sitzung -> Uebernahme); alternativ ziel_identity_id fuer Respawn' },
  rolle: { type: 'string', description: 'agent_vorbereiten: Rolle der neuen Identitaet (Standard subagent; koordinator durch User oder Koordinator)' },
  startart: { type: 'string', enum: ['subagent', 'spezialist', 'codex', 'hauptagent', 'sonstiges'], description: 'agent_vorbereiten: Startart fuer die Startkonfiguration' },
  bindung_task_id: { type: 'string', description: 'Task-Bindung: Task-ID (UUID oder P<n>-T<m>)' },
  bindung_art: { type: 'string', enum: ['identitaet', 'team'], description: 'Task-Bindung: Einzelidentitaet oder Team (offen = entblocken)' },
  bindung_identity_ids: { type: 'array', items: { type: 'string' }, description: 'Task-Bindung: Identitaets-IDs (identitaet: genau eine; team: frei gewaehlte, desselben Projekts)' },
  schatten_stunden: { type: 'number', description: 'ausweis_fristen setzen: Schattenfrist in Stunden (1..720, Standard 24)' },
  erstnutzung_minuten: { type: 'number', description: 'ausweis_fristen setzen: Erstnutzungsfrist vorbereiteter Ausweise in Minuten (1..1440, Standard 10)' },
  visum_minuten: { type: 'number', description: 'ausweis_fristen setzen: Visum in Minuten (1..1440, Standard 30; Agenten anderer Projekte lesen hier)' },
  arbeitsfreigabe_stunden: { type: 'number', description: 'ausweis_fristen setzen: Arbeitsfreigabe in Stunden (1..720, Standard 24; arbeitsfreigabe_erteilen)' },
  anmeldung_plaene_minuten: { type: 'number', description: 'ausweis_fristen setzen: Fenster eigener offener files-Plaene in chat(anmelden) in Minuten (1..1440, Standard 30)' },
  files_plan_stunden: { type: 'number', description: 'ausweis_fristen setzen: offene files-Plaene ohne Aktivitaet laufen nach so vielen Stunden ab (1..720, Standard 48; P6-T49)' },
  files_plan_ablauf_aktiv: { type: 'boolean', description: 'ausweis_fristen: Produkt-Schalter Fristablauf offener files-Plaene (Standard EIN; P6-T49). modus setzen: true|false auf ebene; modus entfernen + Parameter vorhanden: Wert dieser ebene entfernen' },
  frist_namen: { type: 'array', items: { type: 'string', enum: [...AUSWEIS_FRIST_NAMEN] }, description: 'ausweis_fristen modus entfernen: Werte dieser ebene entfernen (Rueckfall global bzw. Standard)' },
  ...HAUPTAGENT_ADMIN_PARAMETER,
};

export function istW1bAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (W1B_ADMIN_ACTIONS as readonly string[]).includes(action);
}

/** Funktionsgruppe je Aktion; null = Schalterverwaltung selbst (immer verwaltbar). */
const GRUPPE: Record<W1bAdminAction, ProfilProduktFunktion | null> = {
  profil_schalter_status: null, profil_schalter_setzen: null,
  profil_uebersicht: 'profilverwaltung', profil_aendern: 'profilverwaltung', profil_historie: 'profilverwaltung', profil_rollback: 'profilverwaltung',
  schattenprofil_liste: 'agenten_ausweis', schattenprofil_korrigieren: 'agenten_ausweis', schattenprofil_bestaetigen: 'agenten_ausweis', schattenprofil_ablehnen: 'agenten_ausweis',
  typ_liste: 'typkatalog', typ_anlegen: 'typkatalog', typ_aendern: 'typkatalog', typ_revision_lesen: 'typkatalog',
  persona_liste: 'persona', persona_versionen: 'persona', persona_anlegen: 'persona', persona_neue_version: 'persona', persona_zuweisen: 'persona', persona_entfernen: 'persona',
  // W12 V7: Ausweis-Aktionen haengen am Ausweis-Kern (leseAusweisKern), nicht mehr am Produkt-Schalter token_abruf.
  agent_vorbereiten: null, token_abrufen: null, token_loeschen: null, web_ui_koordinator_token: null,
  task_bindung_lesen: 'task_bindung', task_bindung_festlegen: 'task_bindung', task_bindung_aendern: 'task_bindung', task_bindung_entblocken: 'task_bindung',
  // P22-T45: Einstellung, kein neuer Schalter (Standardwerte = bisheriges Verhalten).
  ausweis_fristen: null,
  // P22-T44: Verwaltung des eigenen Projekts; ob Visa entstehen, entscheidet der Schalter mehrprojekt der Heimat des Agenten.
  ausweis_visa: null, arbeitsfreigabe_erteilen: null, arbeitsfreigabe_entziehen: null,
};

type Args = Record<string, unknown>;
const s = (a: Args, k: string): string | undefined => { const v = a[k]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
const n = (a: Args, k: string): number | undefined => { const v = a[k]; return typeof v === 'number' && Number.isInteger(v) ? v : undefined; };
const o = (a: Args, k: string): Record<string, unknown> | undefined => { const v = a[k]; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined; };
function pflicht<T>(v: T | undefined, code: string): T { if (v === undefined) throw new ProfilVerwaltungFehler(code); return v; }

async function zielIdentitaet(project: string, id: string | undefined): Promise<string> {
  const ziel = pflicht(id, 'ziel_identity_id_fehlt');
  const r = await getPool().query('SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2', [ziel, project]);
  if (!r.rows[0]) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
  return ziel;
}

function pruefeEigenprofil(akteur: AusweisAkteur, project: string, identityId: string): void {
  if (!darfProfilAendern(akteur, { identity_id: identityId, project })) throw new ProfilVerwaltungFehler('eigenprofil_nicht_aenderbar');
}

async function schattenprofilImProjekt(project: string, id: string | undefined): Promise<string> {
  const sid = pflicht(id, 'schattenprofil_id_fehlt');
  const r = await getPool().query<{ project: string }>('SELECT project FROM agent_schattenprofile WHERE id=$1', [sid]);
  if (r.rows[0]?.project !== project) throw new ProfilVerwaltungFehler('schattenprofil_unbekannt');
  return sid;
}

/** Typ sichtbar fuer das Projekt (global oder dieses Projekt); Schreiben auf globale Typen nur der User. */
async function typZugriff(project: string, typId: string | undefined, schreiben: boolean, akteur: W1bAkteur): Promise<string> {
  const id = pflicht(typId, 'typ_id_fehlt');
  const r = await getPool().query<{ scope: string; project: string | null }>('SELECT scope, project FROM agent_typen WHERE id=$1', [id]);
  const t = r.rows[0];
  if (!t || (t.scope === 'projekt' && t.project !== project)) throw new ProfilVerwaltungFehler('typ_unbekannt');
  if (schreiben && t.scope === 'global') await pruefeProfilVerwalter(akteur, null, { nurUser: true });
  return id;
}

async function vorlageImProjekt(project: string, id: string | undefined): Promise<string> {
  const vid = pflicht(id, 'persona_vorlage_id_fehlt');
  const r = await getPool().query("SELECT 1 FROM agent_persona_vorlagen WHERE id=$1 AND (scope='global' OR project=$2)", [vid, project]);
  if (!r.rows[0]) throw new ProfilVerwaltungFehler('vorlage_unbekannt');
  return vid;
}

/** Task-Bindung: Eingabe validieren; alle Identitaeten muessen zum Projekt gehoeren (K14.2, Team = frei gewaehlt, selbes Projekt). */
async function bindungAus(project: string, a: Args): Promise<TaskBindung> {
  const art = s(a, 'bindung_art');
  const ids = Array.isArray(a.bindung_identity_ids) ? [...new Set((a.bindung_identity_ids as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()))] : [];
  if (art !== 'identitaet' && art !== 'team') throw new ProfilVerwaltungFehler('bindung_ungueltig');
  if (art === 'identitaet' && ids.length !== 1) throw new ProfilVerwaltungFehler('bindung_ungueltig');
  if (!ids.length) throw new ProfilVerwaltungFehler('team_leer');
  const r = await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agent_identitaeten WHERE id=ANY($1::text[]) AND project=$2', [ids, project]);
  if (r.rows[0].n !== ids.length) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
  return art === 'identitaet' ? { art, identity_id: ids[0] } : { art, identity_ids: ids };
}

async function pruefeSchalter(funktion: ProfilProduktFunktion, project: string): Promise<void> {
  if (funktion === 'agenten_ausweis') {
    const k = await leseAusweisKern(project);
    if (!k.aktiv && !(await ausweisSchattenAktiv(project, false))) throw new ProfilVerwaltungFehler('funktion_aus', { funktion, quelle: k.quelle, ...(k.letzter_fehler ? { letzter_fehler: k.letzter_fehler } : {}) });
    return;
  }
  const st = await leseProfilProduktSchalter(funktion, project);
  if (!st.aktiv) throw new ProfilVerwaltungFehler('funktion_aus', { funktion, quelle: st.quelle, ...(st.letzter_fehler ? { letzter_fehler: st.letzter_fehler } : {}) });
}

const AUSWEIS_AKTIONEN = ['agent_vorbereiten', 'token_abrufen', 'token_loeschen'] as const;
type AusweisAktion = typeof AUSWEIS_AKTIONEN[number];
function istAusweisAktion(a: string): a is AusweisAktion { return (AUSWEIS_AKTIONEN as readonly string[]).includes(a); }

/** Koordinator-Vorgabe 27920: Legacy-Koordinator ohne eigenen Ausweis (Erkennung wie P22-T18: Rolle/Namensmuster koordinator). */
function legacyKoordinatorAus(args: Args): AusweisAkteur | null {
  // P22-T44: mit Ausweis in einem fremden Projekt (Visum/Arbeitsfreigabe) gilt der Agent dort nie als Legacy-Koordinator.
  const fremd = aktuellerAgentAufruf()?.fremdprojekt;
  if (fremd && fremd.zugang !== 'frei') return null;
  const agent = s(args, 'agent_id');
  return agent && rolleFuerAgent(agent).rolle === 'koordinator' ? { art: 'legacy_koordinator', agent_id: agent } : null;
}

const AUSWEIS_HINWEIS = 'Ausweis nur direkt anzeigen oder weitergeben; nie in Channel, Thought, Log, URL oder Startrezept ablegen.';

/** W12-A (V2/V4): vorbereiten / abrufen / loeschen. Rechte (User, Koordinator, Legacy-Koordinator) pruefen die Dienste selbst. */
async function fuehreAusweisAktionAus(action: AusweisAktion, args: Args, akteur: W1bAkteur | null): Promise<Record<string, unknown>> {
  const project = pflicht(s(args, 'project'), 'project_fehlt');
  const wer: AusweisAkteur | null = akteur ?? legacyKoordinatorAus(args);
  if (!wer) throw new ProfilVerwaltungFehler('recht_fehlt');
  switch (action) {
    case 'agent_vorbereiten': {
      const r = await W12_DIENSTE.ausweis.agentVorbereiten({
        project, name: s(args, 'agent_name'), identity_id: s(args, 'ziel_identity_id'), rolle: s(args, 'rolle'),
        typ_id: args.typ_id === null ? null : s(args, 'typ_id'), profil: o(args, 'profil_patch') as Partial<ProfilInhalt> | undefined,
        startart: s(args, 'startart') as Startart | undefined, grund: pflichtText(args.grund, 'grund_fehlt'), user_auftrag: s(args, 'user_auftrag'),
      }, wer);
      return { ...r, hinweis: AUSWEIS_HINWEIS };
    }
    case 'token_abrufen': {
      const ziel = pflicht(s(args, 'ziel_identity_id'), 'ziel_identity_id_fehlt');
      const t = await W12_DIENSTE.ausweis.rufeAusweisAb(project, ziel, wer, args.anlass as string);
      return { ziel_identity_id: ziel, ...t, hinweis: AUSWEIS_HINWEIS };
    }
    case 'token_loeschen': {
      const ziel = pflicht(s(args, 'ziel_identity_id'), 'ziel_identity_id_fehlt');
      return { ...(await W12_DIENSTE.ausweis.loescheAusweis(project, ziel, wer, args.grund as string)) };
    }
  }
}

async function ausfuehren(action: Exclude<W1bAdminAction, AusweisAktion>, project: string, a: Args, akteurRoh: AusweisAkteur): Promise<Record<string, unknown>> {
  // P22-T34: der Legacy-Koordinator ohne Ausweis gilt fuer ALLE Aktionen wie Koordinator mit Ausweis (Rechtepruefung in den Diensten bzw.
  // pruefeProfilVerwalter; 'nur User' bleibt: web_ui_koordinator_token, globale Kataloge; globale Produkt-Schalter seit P22-T57 auch Koordinator). Die Dienste pruefen den Akteur zur Laufzeit.
  const akteur = akteurRoh as W1bAkteur;
  switch (action) {
    case 'profil_schalter_status':
      return { project, schalter: await Promise.all([...PROFIL_PRODUKT_FUNKTIONEN, ...ALT_AUSWEIS_FUNKTIONEN].map(f => leseProfilProduktSchalter(f, project))), ausweis_kern: await leseAusweisKern(project) };
    case 'profil_schalter_setzen': {
      const ebene = (s(a, 'ebene') ?? 'projekt') as 'global' | 'projekt';
      const funktion = pflicht(s(a, 'profil_funktion'), 'profil_funktion_fehlt') as ProfilProduktFunktion | 'alle';
      await setzeProfilProduktSchalter(
        { ebene, project: ebene === 'projekt' ? project : null, funktion, aktiv: a.aktiv as boolean, grund: String(a.grund ?? '') },
        akteurRoh.art === 'user' ? { system: 'user' }
          : akteurRoh.art === 'legacy_koordinator' ? { legacy_koordinator: akteurRoh.agent_id, aufruf_project: project }
          : { identity_id: akteurRoh.art === 'identitaet' ? akteurRoh.principal.identity_id : undefined, aufruf_project: project });
      return { project, schalter: await Promise.all([...PROFIL_PRODUKT_FUNKTIONEN, ...ALT_AUSWEIS_FUNKTIONEN].map(f => leseProfilProduktSchalter(f, project))), ausweis_kern: await leseAusweisKern(project) };
    }
    case 'profil_uebersicht': {
      // Tokenfrei: nur Profil-/Teamdaten und ob ein Token abrufbar ist, nie ein Tokenwert.
      const r = await getPool().query(
        `SELECT i.id AS identity_id, i.agent_id, i.name, i.instanz_nr, i.rolle, i.status, i.profil_revision, i.typ_id, i.typ_revision,
           i.zuletzt_aktiv, i.context_epoch,
           EXISTS (SELECT 1 FROM agent_identitaet_tokens t WHERE t.identity_id=i.id AND t.widerrufen_am IS NULL AND t.token_offen IS NOT NULL) AS token_abrufbar,
           (SELECT CASE WHEN t.gueltig_bis IS NULL THEN 'aktiv' WHEN t.gueltig_bis>NOW() THEN 'ausgestellt' ELSE 'verfallen' END
              FROM agent_identitaet_tokens t WHERE t.identity_id=i.id AND t.widerrufen_am IS NULL AND t.token_offen IS NOT NULL LIMIT 1) AS ausweis_zustand,
           z.vorlage_id AS persona_vorlage_id, z.version AS persona_version
         FROM agent_identitaeten i LEFT JOIN agent_persona_zuweisungen z ON z.identity_id=i.id
         WHERE i.project=$1 ORDER BY i.rolle, i.name, i.instanz_nr`, [project]);
      return { project, profile: r.rows };
    }
    case 'schattenprofil_liste': {
      const zustand = s(a, 'zustand');
      if (zustand !== undefined && !(SCHATTEN_ZUSTAENDE as readonly string[]).includes(zustand)) throw new ProfilVerwaltungFehler('zustand_ungueltig');
      return { project, schattenprofile: await W1B_DIENSTE.schatten.listeSchattenprofile(project, akteurRoh, zustand ? { zustand: zustand as SchattenZustand } : undefined) };
    }
    case 'schattenprofil_korrigieren': {
      const id = await schattenprofilImProjekt(project, s(a, 'schattenprofil_id'));
      const schatten = await W1B_DIENSTE.schatten.korrigiereSchattenprofil(id, pflicht(n(a, 'erwartete_revision'), 'erwartete_revision_fehlt'),
        pflicht(o(a, 'korrektur'), 'korrektur_fehlt') as Partial<ProfilInhalt>, akteurRoh, pflichtText(a.grund, 'grund_fehlt'));
      return { schattenprofil: schatten };
    }
    case 'schattenprofil_bestaetigen': {
      const id = await schattenprofilImProjekt(project, s(a, 'schattenprofil_id'));
      const typ = a.typ_id === null ? null : s(a, 'typ_id');
      const erg = await W1B_DIENSTE.schatten.bestaetigeSchattenprofil({
        schattenprofil_id: id, erwartete_revision: pflicht(n(a, 'erwartete_revision'), 'erwartete_revision_fehlt'),
        ...(o(a, 'korrektur') ? { korrektur: o(a, 'korrektur') as Partial<ProfilInhalt> } : {}),
        ...(typ !== undefined ? { typ_id: typ } : {}),
        user_zustimmung: userAuftragFuer(akteurRoh, a.user_zustimmung), grund: pflichtText(a.grund, 'grund_fehlt'),
      }, akteurRoh);
      return { ...erg };
    }
    case 'schattenprofil_ablehnen': {
      const id = await schattenprofilImProjekt(project, s(a, 'schattenprofil_id'));
      return { schattenprofil: await W1B_DIENSTE.schatten.lehneSchattenprofilAb(id, pflicht(n(a, 'erwartete_revision'), 'erwartete_revision_fehlt'), akteurRoh, pflichtText(a.grund, 'grund_fehlt')) };
    }
    case 'typ_liste':
      return { project, typen: await W1B_DIENSTE.typen.listeTypen(project, akteur) };
    case 'typ_anlegen': {
      const scope = (s(a, 'profil_scope') ?? 'projekt') as 'global' | 'projekt';
      if (scope !== 'global' && scope !== 'projekt') throw new ProfilVerwaltungFehler('scope_ungueltig');
      if (scope === 'global') await pruefeProfilVerwalter(akteur, null, { nurUser: true });
      const typ = await W1B_DIENSTE.typen.legeTypAn({
        scope, project: scope === 'projekt' ? project : null, schluessel: pflicht(s(a, 'typ_schluessel'), 'typ_schluessel_fehlt'),
        inhalt: pflicht(o(a, 'typ_inhalt'), 'typ_inhalt_fehlt') as ProfilInhalt, grund: pflichtText(a.grund, 'grund_fehlt'),
      }, akteur);
      return { typ };
    }
    case 'typ_aendern': {
      const id = await typZugriff(project, s(a, 'typ_id'), true, akteur);
      return { typ: await W1B_DIENSTE.typen.aendereTyp(id, pflicht(n(a, 'erwartete_revision'), 'erwartete_revision_fehlt'),
        pflicht(o(a, 'typ_inhalt'), 'typ_inhalt_fehlt') as ProfilInhalt, akteur, pflichtText(a.grund, 'grund_fehlt')) };
    }
    case 'typ_revision_lesen': {
      const id = await typZugriff(project, s(a, 'typ_id'), false, akteur);
      return { revision: await W1B_DIENSTE.typen.leseTypRevision(id, n(a, 'typ_revision')) };
    }
    case 'profil_aendern': {
      const ziel = await zielIdentitaet(project, s(a, 'ziel_identity_id'));
      pruefeEigenprofil(akteur, project, ziel);
      const patch = pflicht(o(a, 'profil_patch'), 'profil_patch_fehlt');
      // K7: Persona nur ueber die Persona-Bibliothek mit User-Auftrag, nie als gewoehnliches Profilfeld.
      if (Object.hasOwn(patch, 'persona')) throw new ProfilVerwaltungFehler('persona_nur_ueber_bibliothek');
      const typ = a.typ_id === null ? null : s(a, 'typ_id');
      const erg = await W1B_DIENSTE.profil.aendereProfil({
        identity_id: ziel, erwartete_revision: pflicht(n(a, 'erwartete_revision'), 'erwartete_revision_fehlt'), patch: patch as Partial<ProfilInhalt>,
        ...(typ !== undefined ? { typ_id: typ } : {}), grund: pflichtText(a.grund, 'grund_fehlt'),
        ...(s(a, 'user_auftrag') ? { user_auftrag: s(a, 'user_auftrag') } : {}),
      }, akteur);
      return { ziel_identity_id: ziel, ...erg };
    }
    case 'profil_historie': {
      const ziel = await zielIdentitaet(project, s(a, 'ziel_identity_id'));
      return { ziel_identity_id: ziel, revisionen: await W1B_DIENSTE.profil.profilHistorie(ziel, akteur) };
    }
    case 'profil_rollback': {
      const ziel = await zielIdentitaet(project, s(a, 'ziel_identity_id'));
      pruefeEigenprofil(akteur, project, ziel);
      const erg = await W1B_DIENSTE.profil.rollbackProfil(ziel, pflicht(n(a, 'ziel_revision'), 'ziel_revision_fehlt'),
        pflicht(n(a, 'erwartete_revision'), 'erwartete_revision_fehlt'), akteur, pflichtText(a.grund, 'grund_fehlt'));
      return { ziel_identity_id: ziel, ...erg };
    }
    case 'persona_liste': {
      const vorlagen = await W1B_DIENSTE.persona.listeVorlagen(project, akteur);
      const ziel = s(a, 'ziel_identity_id');
      return { project, vorlagen, ...(ziel ? { zuweisung: await W1B_DIENSTE.persona.leseZuweisung(await zielIdentitaet(project, ziel)) } : {}) };
    }
    case 'persona_versionen': {
      const id = await vorlageImProjekt(project, s(a, 'persona_vorlage_id'));
      return { vorlage_id: id, versionen: await listePersonaVersionen(id, project, akteur) };
    }
    case 'persona_anlegen': {
      const scope = (s(a, 'profil_scope') ?? 'projekt') as 'global' | 'projekt';
      const version = await W1B_DIENSTE.persona.legeVorlageAn({
        scope, project: scope === 'projekt' ? project : null, name: s(a, 'persona_name') as string, inhalt: o(a, 'persona_inhalt') as Record<string, unknown>,
      }, akteur, a.user_auftrag as string);
      return { version };
    }
    case 'persona_neue_version': {
      const id = await vorlageImProjekt(project, s(a, 'persona_vorlage_id'));
      return { version: await W1B_DIENSTE.persona.neueVersion(id, o(a, 'persona_inhalt') as Record<string, unknown>, akteur, a.user_auftrag as string) };
    }
    case 'persona_zuweisen': {
      const ziel = await zielIdentitaet(project, s(a, 'ziel_identity_id'));
      const id = await vorlageImProjekt(project, s(a, 'persona_vorlage_id'));
      return { zuweisung: await W1B_DIENSTE.persona.weiseZu(ziel, id, pflicht(n(a, 'persona_version'), 'version_ungueltig'), akteur, a.user_auftrag as string) };
    }
    case 'persona_entfernen': {
      const ziel = await zielIdentitaet(project, s(a, 'ziel_identity_id'));
      await W1B_DIENSTE.persona.entferne(ziel, akteur, a.grund as string);
      return { ziel_identity_id: ziel, entfernt: true };
    }
    case 'task_bindung_lesen':
      return { project, task_id: pflicht(s(a, 'bindung_task_id'), 'bindung_task_id_fehlt'), bindung: await W1B_DIENSTE.taskBindung.leseBindung(project, pflicht(s(a, 'bindung_task_id'), 'bindung_task_id_fehlt')) };
    case 'task_bindung_festlegen': {
      const task = pflicht(s(a, 'bindung_task_id'), 'bindung_task_id_fehlt');
      return { project, task_id: task, bindung: await W1B_DIENSTE.taskBindung.legeFest(project, task, await bindungAus(project, a), akteur, s(a, 'grund')) };
    }
    case 'task_bindung_aendern': {
      const task = pflicht(s(a, 'bindung_task_id'), 'bindung_task_id_fehlt');
      return { project, task_id: task, bindung: await W1B_DIENSTE.taskBindung.aendere(project, task, await bindungAus(project, a), akteur, pflichtText(a.grund, 'grund_fehlt')) };
    }
    case 'task_bindung_entblocken': {
      const task = pflicht(s(a, 'bindung_task_id'), 'bindung_task_id_fehlt');
      return { project, task_id: task, bindung: await W1B_DIENSTE.taskBindung.entblocke(project, task, akteur, pflichtText(a.grund, 'grund_fehlt')) };
    }
    case 'ausweis_fristen': {
      // P22-T45: EINE Lesestelle agent-ausweis-fristen.ts. Projekt- UND globale Ebene: User oder Koordinator des aufrufenden Projekts,
      // auch Legacy-Koordinator (Grundsatz 3a, Vorbild jev_schalten); Subagent/Spezialist/Daemon nie. Antwort: wert + quelle je Frist.
      const modus = s(a, 'modus') ?? 'status';
      if (modus !== 'status') {
        if (modus !== 'setzen' && modus !== 'entfernen') throw new ProfilVerwaltungFehler('modus_ungueltig', { erlaubt: ['status', 'setzen', 'entfernen'] });
        const ebene = s(a, 'ebene') ?? 'projekt';
        if (ebene !== 'global' && ebene !== 'projekt') throw new ProfilVerwaltungFehler('ebene_ungueltig');
        const recht = await pruefeProfilVerwalter(akteurRoh, project);
        // P6-T49 Nachtrag 28011: Produkt-Schalter files_plan_ablauf_aktiv im selben Weg; Fristen nur, wenn welche genannt sind
        // (ohne Schalter und ohne Fristen bleibt der bisherige Fehler fristen_fehlen).
        const schalterDa = a.files_plan_ablauf_aktiv !== undefined;
        const fristenDa = modus === 'setzen'
          ? AUSWEIS_FRIST_NAMEN.some((k) => a[k] !== undefined && a[k] !== null)
          : Array.isArray(a.frist_namen) && a.frist_namen.length > 0;
        if (fristenDa || !schalterDa) await setzeAusweisFristen({
          ebene, project: ebene === 'projekt' ? project : null, grund: a.grund,
          ...(modus === 'setzen'
            ? { werte: { schatten_stunden: a.schatten_stunden, erstnutzung_minuten: a.erstnutzung_minuten, visum_minuten: a.visum_minuten, arbeitsfreigabe_stunden: a.arbeitsfreigabe_stunden, anmeldung_plaene_minuten: a.anmeldung_plaene_minuten, files_plan_stunden: a.files_plan_stunden } }
            : { entfernen: a.frist_namen ?? [] }),
        }, { wer: recht.wer, setter_identity_id: recht.actor_identity_id });
        if (schalterDa) await setzeFilesPlanAblaufSchalter({
          ebene, project: ebene === 'projekt' ? project : null, grund: a.grund,
          ...(modus === 'setzen' ? { aktiv: a.files_plan_ablauf_aktiv } : { entfernen: true }),
        }, { wer: recht.wer, setter_identity_id: recht.actor_identity_id });
      }
      return { project, modus, ausweis_fristen: await leseAusweisFristen(project, { frisch: true }), files_plan_ablauf: await leseFilesPlanAblaufSchalter(project) };
    }
    case 'ausweis_visa':
      // P22-T44: Agenten anderer Projekte mit Eintrag hier (Visum/Arbeitsfreigabe/frei), Ablauf, Fristen dieses Projekts.
      return { ...(await listeAusweisVisa(project)) };
    case 'arbeitsfreigabe_erteilen':
    case 'arbeitsfreigabe_entziehen': {
      // P22-T44 (User c4ba1673 Punkt 9d/f): nur User oder Koordinator DIESES Projekts (pruefeProfilVerwalter). Ein Koordinator
      // aus einem anderen Projekt hat hier mit Ausweis kein Recht; im fremden Projekt gilt er nie als Legacy-Koordinator.
      const recht = await pruefeProfilVerwalter(akteurRoh, project);
      return action === 'arbeitsfreigabe_erteilen'
        ? { ...(await erteileArbeitsfreigabe(project, a.ziel_identity_id, a.grund, recht)) }
        : { ...(await entzieheArbeitsfreigabe(project, a.ziel_identity_id, a.grund, recht)) };
    }
    case 'web_ui_koordinator_token': {
      const t = await rufeWebUiKoordinatorTokenAb(project, akteur, s(a, 'ziel_identity_id'));
      return { ...t, hinweis: 'Token des Web-UI-Koordinatorprofils fuer Uebernahme/Weitergabe; nie in Channel, Thought, Log, URL oder Startrezept ablegen.' };
    }
  }
}

const CODE = /^[a-z][a-z0-9_]{2,80}$/;
/** Geheimnisfreie Fehlerantwort: nur Code (und bewusst freigegebene Details), nie Meldungstexte oder DB-Fehler. */
function fehlerAntwort(action: string, e: unknown): Record<string, unknown> {
  if (e instanceof W1bNichtUmgesetzt) return { success: false, action, error: e.code, paket: e.paket, funktion: e.funktion };
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && CODE.test(code)) {
    const d = (e as { details?: unknown }).details;
    const rev = (e as { aktuelle_revision?: unknown }).aktuelle_revision;
    return { success: false, action, error: code,
      ...(d && typeof d === 'object' ? { details: d } : {}), ...(typeof rev === 'number' ? { aktuelle_revision: rev } : {}) };
  }
  return { success: false, action, error: 'w1b_admin_fehler' };
}

/** HTTP-Status fuer die REST-Routen; der Fehlercode bleibt der Vertrag. */
export function w1bFehlerStatus(code: string): number {
  if (code === 'recht_fehlt' || code === 'eigenprofil_nicht_aenderbar' || code === 'main_rahmen_nur_user') return 403;
  if (code === 'w1b_nicht_umgesetzt') return 501;
  if (code === 'w1b_admin_fehler' || code === 'verwaltung_speicher_fehler' || code === 'ausweis_fristen_speicher_fehler' || code === 'files_plan_ablauf_speicher_fehler' || code === 'ausweis_projekt_speicher_fehler') return 500;
  if (/_unbekannt$|_nicht_gefunden$/.test(code) || code === 'keine_zuweisung' || code === 'ausweis_fehlt') return 404;
  if (code === 'ausweis_kern_aus' || code === 'agent_bezug_modus_nicht_beide' || code === 'identitaet_existiert' || code === 'ausweis_existiert') return 409;
  if (code === 'funktion_aus' || code === 'konflikt' || /_veraltet$|_belegt$|_archiviert$|^token_/.test(code) || code === 'identitaet_nicht_aktiv') return 409;
  return 400;
}

const EIGENPROFIL_AKTIONEN: readonly string[] = ['profil_aendern', 'profil_rollback', 'profil_historie'];
/**
 * P22-T53 (User 58c38995): Eigenprofil vor der Verwalterpruefung. Aendern/Rollback des eigenen Profils durch eine Rolle ausser
 * koordinator/main -> eigenprofil_nicht_aenderbar (statt recht_fehlt). true = Eigenprofil des Main-Agenten: keine Verwalterpruefung,
 * der Dienst prueft Rolle main/aktiv in PG und den Rahmen (main_rahmen_nur_user).
 */
function eigenprofilOhneVerwalter(action: string, args: Args, wer: AusweisAkteur, project: string): boolean {
  if (!EIGENPROFIL_AKTIONEN.includes(action) || wer.art !== 'identitaet') return false;
  const p = wer.principal;
  if (p.project !== project || s(args, 'ziel_identity_id') !== p.identity_id) return false;
  if (action !== 'profil_historie' && !darfProfilAendern(wer, { identity_id: p.identity_id, project })) throw new ProfilVerwaltungFehler('eigenprofil_nicht_aenderbar');
  return p.rolle === MAIN_ROLLE;
}

export async function fuehreW1bAdminAus(action: string, args: Args, opt: { akteur?: W1bAkteur | null } = {}): Promise<Record<string, unknown>> {
  const akteur = opt.akteur !== undefined ? opt.akteur : aktuellerW1bAkteur();
  // P22-T36: Hauptagent-Verwaltung (User + Main selbst; Koordinatoren nur Kommunikation) – eigener Rechtepfad.
  if (istHauptagentAdminAction(action)) return fuehreHauptagentAdminAus(action, args, akteur);
  if (istAusweisAktion(action)) {
    // Auch der Legacy-Koordinator ohne Ausweis darf vorbereiten/abrufen/loeschen (Vorgabe 27920).
    try {
      return { success: true, action, ...(await fuehreAusweisAktionAus(action, args, akteur)) };
    } catch (e) {
      return fehlerAntwort(action, e);
    }
  }
  // P22-T34 (User 19.10., memory entscheidung-agenten-ausweis-2026-10-19 Punkt 3a): EINE Stelle fuer die Akteur-Ermittlung. Ohne Ausweis und ohne
  // User-Eingang gilt der Legacy-Koordinator (Rolle/Namensmuster, Name gehoert keiner Token-Identitaet) fuer ALLE Aktionen wie ein Koordinator.
  const wer: AusweisAkteur | null = akteur ?? legacyKoordinatorAus(args);
  if (!wer) {
    return { success: false, action, error: 'recht_fehlt',
      message: 'Profilverwaltung nur durch den User (authentifizierter User-Eingang), einen Koordinator mit persoenlichem Ausweis oder einen Legacy-Koordinator ohne Ausweis.' };
  }
  try {
    if (!istW1bAdminAction(action)) throw new ProfilVerwaltungFehler('aktion_unbekannt');
    const project = pflicht(s(args, 'project'), 'project_fehlt');
    if (!eigenprofilOhneVerwalter(action, args, wer, project)) await pruefeProfilVerwalter(wer, project);
    const gruppe = GRUPPE[action as W1bAdminAction];
    if (gruppe) await pruefeSchalter(gruppe, project);
    return { success: true, action, ...(await ausfuehren(action as Exclude<W1bAdminAction, AusweisAktion>, project, args, wer)) };
  } catch (e) {
    return fehlerAntwort(action, e);
  }
}
