/**
 * P22-T68: Datenweg der Ausweis- und Profilverwaltung in der Web-UI. Alles laeuft ueber die vorhandenen REST-Routen
 * /api/projects/:project/agent-profile/* (derselbe Dispatcher wie admin; Rechte und Schalter entscheidet das Backend).
 * Ausweiswerte werden hier nie gespeichert, geloggt oder in Fehlertexte uebernommen.
 */
import { apiFetch } from './auth';

type Roh = Record<string, unknown>;

export class AusweisFehler extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}

const FEHLERTEXT: Record<string, string> = {
  recht_fehlt: 'Dazu fehlt das Recht (nur User und Koordinator dieses Projekts).',
  identitaet_recht_fehlt: 'Dazu fehlt das Recht.',
  eigenprofil_nicht_aenderbar: 'Das eigene Profil darf diese Rolle nicht aendern.',
  main_rahmen_nur_user: 'Der Rahmen des Hauptagenten darf nur der User aendern.',
  funktion_aus: 'Die Funktion ist ausgeschaltet. Den Schalter findest du unten in der Kachel Agenten-Ausweis.',
  profil_revision_veraltet: 'Das Profil wurde zwischenzeitlich geaendert. Bitte neu laden und die Aenderung erneut eintragen.',
  grund_fehlt: 'Ein Grund ist Pflicht.',
  identitaet_unbekannt: 'Die Identitaet gibt es in diesem Projekt nicht.',
  ausweis_fehlt: 'Es gibt keinen Ausweis zum Abrufen oder Loeschen.',
  identitaet_nicht_aktiv: 'Die Identitaet ist deaktiviert. Erst reaktivieren.',
  ausweis_kern_aus: 'Der Ausweis-Kern ist ausgeschaltet.',
  // P22-T173: Umbenennen
  name_belegt: 'Der Name ist schon vergeben (Agent, Sitzung, Archiv oder frueherer Name eines anderen Agenten).',
  name_ungueltig: 'Ungueltiger Name: 2 bis 64 Zeichen aus Buchstaben, Ziffern, Punkt, Minus, Unterstrich; nicht archiv-..., user, koordinator, main.',
  neuer_name_fehlt: 'Bitte einen neuen Namen eintragen.',
  name_unveraendert: 'Der Name ist unveraendert.',
  main_nicht_umbenennbar: 'Der Hauptagent kann nicht umbenannt werden.',
  identitaet_archiviert: 'Die Identitaet ist archiviert. Erst wiederherstellen.',
  name_ist_alias: 'Der Name ist der fruehere Name eines umbenannten Agenten und bleibt ihm vorbehalten.',
  nur_user_oder_koordinator: 'Dazu braucht es eine Web-UI-Sitzung des Users oder den Ausweis eines Koordinators.',
  unauthorized: 'Nicht angemeldet.',
};

function fehlerAus(daten: Roh, status: number): AusweisFehler {
  const roh = daten.error;
  const code = typeof roh === 'string' ? roh : typeof (roh as Roh | undefined)?.code === 'string' ? (roh as Roh).code as string : 'fehler';
  return new AusweisFehler(code, status, (FEHLERTEXT[code] ?? 'Fehler ' + code) + ' (HTTP ' + status + ')');
}

async function anfrage(project: string, pfad: string, methode: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: Roh): Promise<Roh> {
  const url = '/api/projects/' + encodeURIComponent(project) + '/agent-profile' + pfad;
  const antwort = await apiFetch(url, body ? { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: methode });
  const daten = await antwort.json().catch(() => ({})) as Roh;
  if (!antwort.ok) throw fehlerAus(daten, antwort.status);
  return daten;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Roh => (v && typeof v === 'object' && !Array.isArray(v) ? v as Roh : {});
const liste = (v: unknown): Roh[] => (Array.isArray(v) ? v.filter((x): x is Roh => !!x && typeof x === 'object') : []);
const textListe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function zeit(v: unknown): string {
  const roh = str(v);
  if (!roh) return '';
  const d = new Date(roh);
  return Number.isNaN(d.getTime()) ? roh : d.toLocaleString('de-DE');
}

export interface IdentitaetZeile {
  identityId: string;
  agentId: string;
  rolle: string;
  status: string;
  profilRevision: number;
  typId: string;
  zuletztAktiv: string;
  tokenAbrufbar: boolean;
  ausweisZustand: string;
  persona: string;
  modellBestaetigt: string;
  modellSelbstauskunft: string;
  laufAktiv: boolean;
}

export async function ladeIdentitaeten(project: string): Promise<IdentitaetZeile[]> {
  const daten = await anfrage(project, '/uebersicht');
  return liste(daten.profile).map((z) => ({
    identityId: str(z.identity_id),
    agentId: str(z.agent_id),
    rolle: str(z.rolle),
    status: str(z.status),
    profilRevision: num(z.profil_revision),
    typId: str(z.typ_id),
    zuletztAktiv: zeit(z.zuletzt_aktiv),
    tokenAbrufbar: z.token_abrufbar === true,
    ausweisZustand: str(z.ausweis_zustand),
    persona: str(z.persona_vorlage_id) ? str(z.persona_vorlage_id) + ' v' + num(z.persona_version) : '',
    modellBestaetigt: str(z.modell_bestaetigt),
    modellSelbstauskunft: str(z.modell_selbstauskunft),
    laufAktiv: z.lauf_aktiv === true,
  }));
}

/** Wrapper-Status je Agent (gewuenschtes/tatsaechliches Modell, Laufzustand); Join ueber agent_id. */
export interface WrapperZeile { model: string; status: string; letzteAktivitaet: string }
export async function ladeWrapperStatus(project: string): Promise<Record<string, WrapperZeile>> {
  const antwort = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/agents');
  const daten = await antwort.json().catch(() => ({})) as Roh;
  if (!antwort.ok) return {};
  const aus: Record<string, WrapperZeile> = {};
  for (const z of liste(daten.agents)) {
    if (str(z.agent_name)) aus[str(z.agent_name)] = { model: str(z.model), status: str(z.status), letzteAktivitaet: zeit(z.last_activity) };
  }
  return aus;
}

export interface ProfilWerte {
  modell: string;
  effort: string;
  kontextStufe: string;
  briefing: string;
  arbeitsweise: string;
  regeln: string[];
  skills: string[];
  channels: string[];
  erlaubteModelle: string[];
  erlaubteRuntimes: string[];
}

export interface IdentitaetDetail {
  identityId: string;
  agentId: string;
  rolle: string;
  status: string;
  profilRevision: number;
  typId: string;
  modellBestaetigt: string;
  modellSelbstauskunft: string;
  erstelltVon: string;
  erstelltAm: string;
  zuletztAktiv: string;
  kontextVorhanden: boolean;
  werte: ProfilWerte;
  startrezept: Roh;
  herkunft: Record<string, string>;
  zuschnitt: Roh;
  lauf: { id: string; epoche: number; seit: string } | null;
  tokens: Array<{ id: string; praefix: string; startArt: string; gueltigBis: string; erstellt: string; zuletztBenutzt: string; widerrufen: string; widerrufGrund: string; abrufbar: boolean }>;
  audit: Array<{ wer: string; wann: string; aktion: string; grund: string }>;
  persona: string;
  tasks: Array<{ taskId: string; art: string }>;
  /** Eigene Hinweis-Einstellungen des Profils (Override) und der Hinweiskatalog. */
  hinweise: Record<string, boolean>;
  hinweisKatalog: HinweisKatalogZeile[];
  /** P22-T173: fruehere Namen (Aliase), neueste zuerst. */
  aliase: Array<{ alterName: string; neuerName: string; umbenanntAm: string; von: string; grund: string }>;
}

export interface HinweisKatalogZeile { schluessel: string; klasse: string; zweck: string; standard: boolean }

export async function ladeDetail(project: string, identityId: string): Promise<IdentitaetDetail> {
  const d = await anfrage(project, '/identitaeten/' + encodeURIComponent(identityId));
  const i = obj(d.identitaet);
  const wirksam = d.wirksam ? obj(d.wirksam) : null;
  const roh = wirksam ? obj(wirksam.werte) : obj(i.profil);
  const startrezept = Object.keys(obj(roh.startrezept)).length ? obj(roh.startrezept) : obj(i.startrezept);
  const lauf = d.lauf ? obj(d.lauf) : null;
  const persona = d.persona ? obj(d.persona) : null;
  return {
    identityId: str(i.identity_id),
    agentId: str(i.agent_id),
    rolle: str(i.rolle),
    status: str(i.status),
    profilRevision: num(i.profil_revision),
    typId: str(i.typ_id),
    modellBestaetigt: str(i.modell_bestaetigt),
    modellSelbstauskunft: str(i.modell_selbstauskunft),
    erstelltVon: str(i.erstellt_von),
    erstelltAm: zeit(i.erstellt_am),
    zuletztAktiv: zeit(i.zuletzt_aktiv),
    kontextVorhanden: i.kontext_vorhanden === true,
    werte: {
      modell: str(roh.modell),
      effort: str(roh.effort),
      kontextStufe: str(roh.kontext_stufe),
      briefing: str(roh.briefing),
      arbeitsweise: str(roh.arbeitsweise),
      regeln: textListe(roh.regeln),
      skills: textListe(roh.skills),
      channels: textListe(roh.channels),
      erlaubteModelle: textListe(startrezept.erlaubte_modelle),
      erlaubteRuntimes: textListe(startrezept.erlaubte_runtimes),
    },
    startrezept,
    herkunft: Object.fromEntries(Object.entries(wirksam ? obj(wirksam.herkunft) : {}).map(([k, v]) => [k, str(v)])),
    // Eigener Zuschnitt des Profils (Override), nicht der vom Typ geerbte: der Editor ersetzt den Zuschnitt als Ganzes.
    zuschnitt: obj(obj(i.profil).zuschnitt),
    lauf: lauf ? { id: str(lauf.id), epoche: num(lauf.context_epoch), seit: zeit(lauf.erstellt_am) } : null,
    tokens: liste(d.tokens).map((t) => ({
      id: str(t.id), praefix: str(t.token_praefix), startArt: str(t.start_art), gueltigBis: zeit(t.gueltig_bis), erstellt: zeit(t.erstellt_am),
      zuletztBenutzt: zeit(t.zuletzt_benutzt), widerrufen: zeit(t.widerrufen_am), widerrufGrund: str(t.widerrufen_grund), abrufbar: t.abrufbar === true,
    })),
    audit: liste(d.audit).map((a) => ({ wer: str(a.wer), wann: zeit(a.wann), aktion: str(a.aktion), grund: str(a.grund) })),
    persona: persona ? str(persona.vorlage_id) + ' v' + num(persona.version) : '',
    tasks: liste(d.gebundene_tasks).map((t) => ({ taskId: str(t.task_id), art: str(t.art) })),
    hinweise: Object.fromEntries(Object.entries(obj(obj(i.profil).hinweise)).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>,
    hinweisKatalog: liste(d.hinweis_katalog).map((h) => ({ schluessel: str(h.schluessel), klasse: str(h.klasse), zweck: str(h.zweck), standard: h.standard === true })),
    aliase: liste(d.aliase).map((a) => ({ alterName: str(a.alter_name), neuerName: str(a.neuer_name), umbenanntAm: zeit(a.umbenannt_am), von: str(a.umbenannt_von), grund: str(a.grund) })),
  };
}

export interface ProfilRevisionZeile { revision: number; wer: string; wann: string; grund: string; userAuftrag: string; typId: string }

export async function ladeHistorie(project: string, identityId: string): Promise<ProfilRevisionZeile[]> {
  const d = await anfrage(project, '/profile/' + encodeURIComponent(identityId) + '/historie');
  return liste(d.revisionen).map((r) => ({
    revision: num(r.revision), wer: str(r.wer), wann: zeit(r.wann), grund: str(r.grund), userAuftrag: str(r.user_auftrag), typId: str(r.typ_id),
  })).sort((a, b) => b.revision - a.revision);
}

/** typId: undefined = Typ unveraendert, null = Typ loesen, sonst neuer Typ (Typkatalog). */
export async function speichereProfil(project: string, identityId: string, erwarteteRevision: number, patch: Roh, grund: string, typId?: string | null): Promise<number> {
  const d = await anfrage(project, '/profile/' + encodeURIComponent(identityId) + '/aendern', 'POST', {
    erwartete_revision: erwarteteRevision, profil_patch: patch, grund, ...(typId !== undefined ? { typ_id: typId } : {}),
  });
  return num(d.profil_revision);
}

export async function rollbackProfil(project: string, identityId: string, zielRevision: number, erwarteteRevision: number, grund: string): Promise<number> {
  const d = await anfrage(project, '/profile/' + encodeURIComponent(identityId) + '/rollback', 'POST', { ziel_revision: zielRevision, erwartete_revision: erwarteteRevision, grund });
  return num(d.profil_revision);
}

export interface TypInhaltStand { typId: string; revision: number; inhalt: Roh }
/** Aktuelle Revision eines Typs (GET typen/:id/revisionen/aktuell). */
export async function ladeTypInhalt(project: string, typId: string): Promise<TypInhaltStand> {
  const d = await anfrage(project, '/typen/' + encodeURIComponent(typId) + '/revisionen/aktuell');
  const r = obj(d.revision);
  return { typId, revision: num(r.revision), inhalt: obj(r.inhalt) };
}

export async function legeTypAn(project: string, eingabe: { scope: 'projekt' | 'global'; schluessel: string; inhalt: Roh; grund: string }): Promise<void> {
  await anfrage(project, '/typen', 'POST', { profil_scope: eingabe.scope, typ_schluessel: eingabe.schluessel, typ_inhalt: eingabe.inhalt, grund: eingabe.grund });
}

export async function aendereTyp(project: string, typId: string, erwarteteRevision: number, inhalt: Roh, grund: string): Promise<void> {
  await anfrage(project, '/typen/' + encodeURIComponent(typId) + '/revisionen', 'POST', { erwartete_revision: erwarteteRevision, typ_inhalt: inhalt, grund });
}

export interface PersonaVersionStand { version: number; inhalt: Roh; userAuftrag: string; wann: string }
export async function ladePersonaVorlagen(project: string): Promise<PersonaVorlageZeile[]> {
  const d = await anfrage(project, '/persona');
  return liste(d.vorlagen).map((v) => ({ id: str(v.id), name: str(v.name), scope: str(v.scope), version: num(v.aktuelle_version), status: str(v.status) }));
}

export async function ladePersonaVersionen(project: string, vorlageId: string): Promise<PersonaVersionStand[]> {
  const d = await anfrage(project, '/persona/' + encodeURIComponent(vorlageId) + '/versionen');
  return liste(d.versionen).map((v) => ({ version: num(v.version), inhalt: obj(v.inhalt), userAuftrag: str(v.user_auftrag), wann: zeit(v.wann) })).sort((a, b) => b.version - a.version);
}

export async function legePersonaAn(project: string, eingabe: { scope: 'projekt' | 'global'; name: string; inhalt: Roh; userAuftrag: string }): Promise<void> {
  await anfrage(project, '/persona', 'POST', {
    profil_scope: eingabe.scope, persona_name: eingabe.name, persona_inhalt: eingabe.inhalt, ...(eingabe.userAuftrag.trim() ? { user_auftrag: eingabe.userAuftrag.trim() } : {}),
  });
}

export async function neuePersonaVersion(project: string, vorlageId: string, inhalt: Roh, userAuftrag: string): Promise<void> {
  await anfrage(project, '/persona/' + encodeURIComponent(vorlageId) + '/versionen', 'POST', {
    persona_inhalt: inhalt, ...(userAuftrag.trim() ? { user_auftrag: userAuftrag.trim() } : {}),
  });
}

export interface TypZeile { id: string; schluessel: string; scope: string; revision: number; status: string }
export async function ladeTypen(project: string): Promise<TypZeile[]> {
  const d = await anfrage(project, '/typen');
  return liste(d.typen).map((t) => ({ id: str(t.id), schluessel: str(t.schluessel), scope: str(t.scope), revision: num(t.aktuelle_revision), status: str(t.status) }));
}

export interface PersonaVorlageZeile { id: string; name: string; scope: string; version: number; status: string }
export interface PersonaStand { vorlagen: PersonaVorlageZeile[]; zuweisung: { vorlageId: string; version: number; gesetztVon: string; gesetztAm: string } | null }
export async function ladePersona(project: string, identityId: string): Promise<PersonaStand> {
  const d = await anfrage(project, '/persona?ziel_identity_id=' + encodeURIComponent(identityId));
  const z = d.zuweisung ? obj(d.zuweisung) : null;
  return {
    vorlagen: liste(d.vorlagen).map((v) => ({ id: str(v.id), name: str(v.name), scope: str(v.scope), version: num(v.aktuelle_version), status: str(v.status) })),
    zuweisung: z ? { vorlageId: str(z.vorlage_id), version: num(z.version), gesetztVon: str(z.gesetzt_von), gesetztAm: zeit(z.gesetzt_am) } : null,
  };
}

export async function weisePersonaZu(project: string, identityId: string, vorlageId: string, version: number, userAuftrag: string): Promise<void> {
  await anfrage(project, '/profile/' + encodeURIComponent(identityId) + '/persona', 'PUT', {
    persona_vorlage_id: vorlageId, persona_version: version, ...(userAuftrag.trim() ? { user_auftrag: userAuftrag.trim() } : {}),
  });
}

export async function entfernePersona(project: string, identityId: string, grund: string): Promise<void> {
  await anfrage(project, '/profile/' + encodeURIComponent(identityId) + '/persona/entfernen', 'POST', { grund });
}

export interface BindungStand { art: 'offen' | 'identitaet' | 'team'; identityIds: string[]; revision: number }
export async function leseBindung(project: string, taskId: string): Promise<BindungStand> {
  const d = await anfrage(project, '/tasks/' + encodeURIComponent(taskId) + '/bindung');
  const b = obj(d.bindung);
  const art = str(b.art);
  const ids = art === 'identitaet' ? [str(b.identity_id)].filter(Boolean) : textListe(b.identity_ids);
  return { art: art === 'identitaet' || art === 'team' ? art : 'offen', identityIds: ids, revision: num(b.revision) };
}

/** Bindet die Task: ohne bestehende Bindung festlegen, sonst aendern (Grund Pflicht). */
export async function setzeBindung(project: string, taskId: string, art: 'identitaet' | 'team', identityIds: string[], grund: string, bestehend: boolean): Promise<void> {
  await anfrage(project, '/tasks/' + encodeURIComponent(taskId) + (bestehend ? '/bindung/aendern' : '/bindung'), bestehend ? 'POST' : 'PUT', {
    bindung_art: art, bindung_identity_ids: identityIds, grund,
  });
}

export async function loeseBindung(project: string, taskId: string, grund: string): Promise<void> {
  await anfrage(project, '/tasks/' + encodeURIComponent(taskId) + '/bindung/entblocken', 'POST', { grund });
}

export async function stelleAus(project: string, eingabe: { name?: string; identityId?: string; rolle?: string; grund: string }): Promise<void> {
  await anfrage(project, '/vorbereiten', 'POST', {
    ...(eingabe.name ? { agent_name: eingabe.name } : {}), ...(eingabe.identityId ? { ziel_identity_id: eingabe.identityId } : {}),
    ...(eingabe.rolle ? { rolle: eingabe.rolle } : {}), grund: eingabe.grund,
  });
}

/** Gibt den Ausweis zurueck; der Aufrufer haelt ihn NUR im Komponenten-State und verwirft ihn zeitnah. */
export async function rufeAusweisAb(project: string, identityId: string): Promise<string> {
  const d = await anfrage(project, '/profile/' + encodeURIComponent(identityId) + '/token?anlass=' + encodeURIComponent('Web-UI User'));
  return str(d.token);
}

export async function loescheAusweis(project: string, identityId: string, grund: string): Promise<void> {
  await anfrage(project, '/profile/' + encodeURIComponent(identityId) + '/token?grund=' + encodeURIComponent(grund), 'DELETE');
}

export async function setzeIdentitaetStatus(project: string, identityId: string, aktiv: boolean, grund: string): Promise<void> {
  await anfrage(project, '/identitaeten/' + encodeURIComponent(identityId) + (aktiv ? '/reaktivieren' : '/deaktivieren'), 'POST', { grund });
}

/** P22-T173: Identitaet umbenennen (Ausweis bleibt, alter Name wird Alias). Gibt den neuen Namen zurueck. */
export async function benenneIdentitaetUm(project: string, identityId: string, neuerName: string, grund: string): Promise<string> {
  const d = await anfrage(project, '/identitaeten/' + encodeURIComponent(identityId) + '/umbenennen', 'POST', { neuer_name: neuerName, grund });
  return str(obj(d.neu).agent_id);
}

export interface SchalterZeile { funktion: string; aktiv: boolean }
export async function ladeSchalter(project: string): Promise<SchalterZeile[]> {
  const d = await anfrage(project, '/schalter');
  return liste(d.schalter).map((s) => ({ funktion: str(s.funktion), aktiv: s.aktiv === true }));
}

export interface ModellOption { wert: string; name: string; runtime: string; efforts: string[] }
/** Modelle beider CLI-Runtimes (GET /api/main-agent/modelle) fuer Modell und Rahmen. */
export async function ladeModellOptionen(): Promise<ModellOption[]> {
  const antwort = await apiFetch('/api/main-agent/modelle');
  const d = await antwort.json().catch(() => ({})) as Roh;
  if (!antwort.ok) return [];
  return liste(d.runtimes).flatMap((r) => liste(r.modelle).map((m) => ({
    wert: str(m.modell) || str(m.id), name: str(m.name) || str(m.id), runtime: str(r.runtime), efforts: textListe(m.effort_stufen),
  }))).filter((m) => m.wert);
}
