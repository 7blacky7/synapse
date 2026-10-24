/**
 * P22-T24 (W12-A, Vertrag 27acb98b V2/V4): Weg B und Daemon-Start des Agenten-Ausweises.
 * - agentVorbereiten (admin agent_vorbereiten / REST POST .../agent-profile/vorbereiten): Identitaet + Profil
 *   (Typ/Regeln/Rolle, Revision 1) + Ausweis 'ausgestellt' mit Erstnutzungsfrist in EINER Transaktion; die erste
 *   Anmeldung bzw. der erste Toolaufruf mit dem Ausweis ist die Bestaetigung (agent-identitaet.ts). Name mit laufender
 *   Legacy-Sitzung im Projekt -> Uebernahme: sofort 'aktiv'. Mit identity_id: Respawn - der vorhandene gueltige Ausweis
 *   wird geliefert, nie ein zweiter ausgestellt (verfallener/geloeschter -> neu mit Frist).
 *   Ausgabe enthaelt die Startkonfiguration (Startsatz mit Ausweis, erste Aktion chat(anmelden, token)).
 * - ausweisFuerStart (Daemon agent_start): vorhandener gueltiger Ausweis -> genau dieser, keine Start-Rotation;
 *   keiner/verfallen -> neu mit Erstnutzungsfrist. Legt NIE eine Identitaet an.
 * Rechte (V4 + Koordinator-Vorgabe 27920): User und Koordinator desselben Projekts, auch Legacy-Koordinator,
 * auch fuer Rolle/Name 'koordinator' (User-Grundsatz 'User und Koordinator jederzeit', P22-T34). Der Ausweis-Kern muss EIN sein (ausser ausweisFuerStart,
 * dessen Aufrufer den Altschalter token_identitaet prueft).
 */
import { getPool } from '../db/client.js';
// P22-T131: Schalter agent_kennung_werbung fuer die Startkonfiguration.
import { leseAgentKennungWerbung } from './agent-kennung-texte.js';
import {
  W1B_DIENSTE, baueStartkonfiguration,
  type AgentVorbereitenAusgabe, type AgentVorbereitenEingabe, type AusweisAbruf, type AusweisAkteur, type AusweisWeg, type ProfilInhalt,
} from './agent-profil-vertrag.js';
import { stelleAgentTokenAus, stelleOderHoleAusweisTx, type AgentIdentitaetPrincipal } from './agent-identitaet.js';
import { USER_AUFTRAG_STANDARD, ProfilVerwaltungFehler, pflichtText, profilTransaktion } from './agent-profil-verwalter.js';
import {
  identitaetAudit, pruefeProfilInhalt, schreibeProfilRevision, sichtbarerTyp, spaltenAusInhalt,
} from './agent-profil-dienst-a.js';
import { ausweisAbrufAus, ausweisAkteurKennung, pruefeAusweisAkteur, pruefeAusweisKernEin } from './agent-token-abruf.js';

function principalFuer(akteur: AusweisAkteur): AgentIdentitaetPrincipal {
  if (akteur.art === 'user') return { system: 'user' };
  if (akteur.art === 'daemon') return { system: 'daemon' };
  if (akteur.art === 'legacy_koordinator') return { legacy_koordinator: akteur.agent_id.trim() };
  return { identity_id: akteur.principal.identity_id };
}

export async function agentVorbereiten(e: AgentVorbereitenEingabe, akteur: AusweisAkteur): Promise<AgentVorbereitenAusgabe> {
  const project = pflichtText(e?.project, 'project_fehlt', 1, 256);
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  const identityId = typeof e.identity_id === 'string' ? e.identity_id.trim() : '';
  if (!!name === !!identityId) throw new ProfilVerwaltungFehler('name_ungueltig', { grund: 'genau eines von agent_name/ziel_identity_id angeben' });
  await pruefeAusweisKernEin(project);
  if (e.profil !== undefined) pruefeProfilInhalt(e.profil);
  const db = getPool();
  const v = await pruefeAusweisAkteur(akteur, project, db);
  const istUser = akteur.art === 'user';
  const principal = principalFuer(akteur);
  const userAuftrag = typeof e.user_auftrag === 'string' && e.user_auftrag.trim() ? e.user_auftrag.trim() : (istUser ? USER_AUFTRAG_STANDARD : null);

  // ---- Respawn: vorhandene Identitaet ----------------------------------------------------------
  if (identityId) {
    const z = await db.query<{ id: string; name: string; status: string; profil_revision: number }>(
      'SELECT id, name, status, profil_revision FROM agent_identitaeten WHERE id=$1 AND project=$2', [identityId, project]);
    const i = z.rows[0];
    if (!i) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
    if (i.status !== 'aktiv') throw new ProfilVerwaltungFehler('identitaet_nicht_aktiv');
    const wunsch = e.profil !== undefined || e.typ_id !== undefined || e.rolle !== undefined || e.modell !== undefined;
    if (wunsch) {
      // Profilaenderung laeuft ueber die Profilverwaltung (Schalter, CAS, Eigenprofilregel); Legacy-Koordinator kann sie nicht.
      if (akteur.art === 'legacy_koordinator' || akteur.art === 'daemon') throw new ProfilVerwaltungFehler('recht_fehlt');
      await W1B_DIENSTE.profil.aendereProfil({
        identity_id: i.id, erwartete_revision: i.profil_revision,
        patch: { ...(e.profil ?? {}), ...(e.rolle !== undefined ? { rolle: e.rolle } : {}), ...(e.modell !== undefined ? { modell: e.modell } : {}) } as Partial<ProfilInhalt>,
        ...(e.typ_id !== undefined ? { typ_id: e.typ_id } : {}), grund, ...(userAuftrag ? { user_auftrag: userAuftrag } : {}),
      }, akteur);
    }
    const a = await stelleAgentTokenAus({ project, name: i.name, identity_id: i.id, erstnutzung: true, ausweis_weg: 'neu_ausgestellt', grund }, principal);
    return ausgabe(project, e, a, false, false);
  }

  // ---- Neue Identitaet --------------------------------------------------------------------------
  if (name.length > 256 || name.includes('#') || name.toLowerCase() === 'user') throw new ProfilVerwaltungFehler('name_ungueltig');
  const rolle = e.rolle !== undefined ? pflichtText(e.rolle, 'rolle_ungueltig', 1, 32) : undefined;
  const vorhanden = await db.query<{ id: string }>('SELECT id FROM agent_identitaeten WHERE project=$1 AND agent_id=$2', [project, name]);
  if (vorhanden.rows[0]) throw new ProfilVerwaltungFehler('identitaet_existiert', { identity_id: vorhanden.rows[0].id });
  // Laufende Legacy-Sitzung gleichen Namens im Projekt -> Uebernahme (sofort aktiv, Zustellung wie Weg A).
  const legacy = await db.query("SELECT 1 FROM agent_sessions WHERE id=$1 AND project=$2 AND identity_id IS NULL AND status='active' LIMIT 1", [name, project]);
  const uebernahme = legacy.rows.length > 0;
  const typId = e.typ_id ?? null;
  const a = await stelleAgentTokenAus({
    project, name, ...(rolle ? { rolle } : {}), ...(e.modell ? { modell_bestaetigt: e.modell } : {}),
    erstnutzung: !uebernahme, ausweis_weg: uebernahme ? 'uebernahme' : 'vorbereitet', grund,
    nach_anlage: async (c, ident) => {
      // Profil Revision 1 in derselben Transaktion wie Identitaet und Ausweis.
      const typ = typId ? await sichtbarerTyp(c, typId, project) : null;
      const inhalt: Record<string, unknown> = { ...(e.profil ?? {}), rolle: ident.rolle, ...(e.modell ? { modell: e.modell } : {}) };
      const { profil, startrezept } = spaltenAusInhalt(inhalt);
      await c.query('UPDATE agent_identitaeten SET profil=$2::jsonb, startrezept=$3::jsonb, profil_revision=1, typ_id=$4, typ_revision=$5 WHERE id=$1',
        [ident.id, JSON.stringify(profil), JSON.stringify(startrezept), typ?.id ?? null, typ?.aktuelle_revision ?? null]);
      await schreibeProfilRevision(c, ident.id, 1, inhalt, typ?.id ?? null, typ?.aktuelle_revision ?? null,
        { wer: v.wer, actor: v.actor, user: istUser }, userAuftrag, grund);
      await identitaetAudit(c, ident.id, { wer: v.wer, actor: v.actor }, 'profil_bestaetigt', null,
        { profil_revision: 1, typ_id: typ?.id ?? null, weg: 'agent_vorbereiten' }, grund);
    },
  }, principal);
  return ausgabe(project, e, a, true, uebernahme);
}

async function ausgabe(
  project: string, e: AgentVorbereitenEingabe, a: Awaited<ReturnType<typeof stelleAgentTokenAus>>, neuAngelegt: boolean, legacyUebernahme: boolean,
): Promise<AgentVorbereitenAusgabe> {
  const rev = await getPool().query<{ profil_revision: number }>('SELECT profil_revision FROM agent_identitaeten WHERE id=$1', [a.identitaet.id]);
  const erstnutzungBis = a.gueltig_bis ?? null;
  // P22-T131: Startkonfiguration nennt agent_kennung nur bei Schalter agent_kennung_werbung EIN.
  const kennung = await leseAgentKennungWerbung(project);
  return {
    identity_id: a.identitaet.id, agent_id: a.identitaet.agent_id, project, rolle: a.identitaet.rolle,
    profil_revision: rev.rows[0]?.profil_revision ?? 0, neu_angelegt: neuAngelegt, legacy_uebernahme: legacyUebernahme,
    token: a.token, token_id: a.token_id, token_praefix: a.token_praefix,
    zustand: erstnutzungBis ? 'ausgestellt' : 'aktiv', ausweis_weg: (a.ausweis_weg as AusweisWeg | null) ?? 'vorbereitet',
    erstnutzung_bis: erstnutzungBis, startkonfiguration: baueStartkonfiguration(a.token, erstnutzungBis, e.startart, kennung),
  };
}

/**
 * Daemon agent_start / Koordinator-Respawn. Gueltiger Ausweis -> genau dieser (neu:false). Keiner oder
 * verfallen -> verfallenen loeschen (erstnutzung_verfallen), neuen mit Erstnutzungsfrist (neu:true, 'daemon_start').
 * Legt NIE eine Identitaet an.
 */
export async function ausweisFuerStart(project: string, identityId: string, akteur: AusweisAkteur): Promise<AusweisAbruf & { neu: boolean }> {
  if (typeof project !== 'string' || !project.trim()) throw new ProfilVerwaltungFehler('project_fehlt');
  if (typeof identityId !== 'string' || !identityId.trim()) throw new ProfilVerwaltungFehler('ziel_identity_id_fehlt');
  if (akteur.art !== 'daemon') {
    await pruefeAusweisKernEin(project);
    await pruefeAusweisAkteur(akteur, project, getPool());
  }
  const { wer } = ausweisAkteurKennung(akteur);
  return profilTransaktion(async (c) => {
    const i = await c.query<{ id: string; status: string }>('SELECT id, status FROM agent_identitaeten WHERE id=$1 AND project=$2 FOR UPDATE', [identityId, project]);
    if (!i.rows[0]) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
    if (i.rows[0].status !== 'aktiv') throw new ProfilVerwaltungFehler('identitaet_nicht_aktiv');
    const { zeile, neu } = await stelleOderHoleAusweisTx(c, { id: identityId }, {
      weg: 'daemon_start', erstnutzung: true, wer, grund: 'Start durch authentifizierten Projekt-Daemon',
    });
    return { ...ausweisAbrufAus(identityId, zeile), neu };
  });
}
