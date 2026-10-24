/**
 * P22-T24 (W12-A, Vertrag 27acb98b V1/V4, memory entscheidung-agenten-ausweis-2026-10-19 Punkt 5):
 * Ausweise liegen OFFEN in agent_identitaet_tokens.token_offen (kein Hash, kein Tresor, kein Schluessel).
 * - Abruf = lesen: nur User (authentifizierter Eingang) oder Koordinator DESSELBEN Projekts (auch ein
 *   Legacy-Koordinator ohne eigenen Ausweis, Erkennung wie P22-T18). Kein eigener Schalter token_abruf;
 *   der Ausweis-Kern (leseAusweisKern) muss EIN sein.
 * - Loeschen = Ausweis widerrufen (widerrufen_am + Grund), die Identitaet bleibt. Idempotent.
 * - Audit (agent_token_abruf_audit / agent_identitaet_audit): Akteur, Ziel, Projekt, Zeitpunkt, Anlass/Grund,
 *   Erfolg - NIE der Tokenwert. Der Erfolgs-Audit wird VOR der Herausgabe geschrieben; scheitert er, wird
 *   kein Token ausgegeben.
 * - Die direkte, berechtigte Antwort darf den echten Token enthalten; sie gehoert in keine Log-/Audit-/
 *   Channel-Ausgabe (tool-call-log: admin:token_abrufen ohne result).
 * - Altzeilen ohne token_offen (Hash-/Tresor-Zeit) sind kein Ausweis mehr: ausweis_fehlt, neu ausstellen
 *   (admin agent_vorbereiten mit identity_id).
 */
import { getPool } from '../db/client.js';
import {
  ausweisZustand, darfAusweisVerwalten,
  type AusweisAbruf, type AusweisAkteur, type AusweisWeg, type TokenAbrufDienst,
} from './agent-profil-vertrag.js';
import { leseAusweisKern } from './agent-profil-schalter.js';
import { holeAusweis, schreibeIdentitaetAudit } from './agent-identitaet.js';
import {
  ProfilVerwaltungFehler, mainVerwaltetProjekt, pflichtText, pruefeProfilVerwalter, profilTransaktion, type ProfilDb,
} from './agent-profil-verwalter.js';
import { rolleFuerAgent } from './agent-rollen.js';

interface AbrufAudit {
  project: string; ziel: string; tokenId: string | null; wer: string; actor: string | null;
  anlass: string | null; erfolg: boolean; fehler: string | null;
}
async function schreibeAudit(db: ProfilDb, a: AbrufAudit): Promise<void> {
  await db.query(
    `INSERT INTO agent_token_abruf_audit (project, ziel_identity_id, token_id, wer, actor_identity_id, anlass, erfolg, fehler)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [a.project, a.ziel, a.tokenId, a.wer, a.actor, a.anlass, a.erfolg, a.fehler]);
}

/** Der Ausweis-Kern (Vertrag V7) muss fuer das Projekt EIN sein; sonst ausweis_kern_aus bzw. agent_bezug_modus_nicht_beide. */
export async function pruefeAusweisKernEin(project: string): Promise<void> {
  const k = await leseAusweisKern(project);
  if (k.aktiv) return;
  throw new ProfilVerwaltungFehler(k.letzter_fehler === 'agent_bezug_modus_nicht_beide' ? 'agent_bezug_modus_nicht_beide' : 'ausweis_kern_aus',
    { quelle: k.quelle, ...(k.agent_bezug_modus ? { agent_bezug_modus: k.agent_bezug_modus } : {}), ...(k.letzter_fehler ? { letzter_fehler: k.letzter_fehler } : {}) });
}

/** Kennung des Akteurs fuer Audit (kein Tokenwert). */
export function ausweisAkteurKennung(akteur: AusweisAkteur): { wer: string; actor: string | null } {
  if (akteur.art === 'user') return { wer: 'user', actor: null };
  if (akteur.art === 'daemon') return { wer: 'daemon', actor: null };
  if (akteur.art === 'legacy_koordinator') return { wer: 'legacy:' + String(akteur.agent_id ?? ''), actor: null };
  return { wer: akteur.principal.identity_id, actor: akteur.principal.identity_id };
}

/**
 * V4 (+ Koordinator-Vorgabe 27920): vorbereiten/abrufen/loeschen duerfen User und Koordinator desselben Projekts.
 * Ein Koordinator ohne eigenen Ausweis (Legacy) wird wie in P22-T18 am Namensmuster/der Rolle erkannt, nie an einem
 * Argument allein: der Name darf keiner Token-Identitaet gehoeren (dann braucht der Aufruf deren Ausweis).
 * Der Daemon hat nur ausweisFuerStart.
 */
export async function pruefeAusweisAkteur(akteur: AusweisAkteur, project: string, db: ProfilDb): Promise<{ wer: string; actor: string | null }> {
  if (akteur.art === 'legacy_koordinator') {
    const agent = typeof akteur.agent_id === 'string' ? akteur.agent_id.trim() : '';
    if (!agent || rolleFuerAgent(agent).rolle !== 'koordinator') throw new ProfilVerwaltungFehler('recht_fehlt');
    const r = await db.query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [project, agent]);
    if (r.rows[0]) throw new ProfilVerwaltungFehler('recht_fehlt');
    return { wer: 'legacy:' + agent, actor: null };
  }
  // P22-T79: Agenten-Verwaltung des Main (nur mit Freigabe der Ausweis-Grenze, siehe mainVerwaltetProjekt).
  const main = await mainVerwaltetProjekt(akteur, project, db);
  if (main) return { wer: main.wer, actor: main.actor_identity_id };
  if (akteur.art === 'daemon' || !darfAusweisVerwalten(akteur, project)) throw new ProfilVerwaltungFehler('recht_fehlt');
  const v = await pruefeProfilVerwalter(akteur, project, { db });
  return { wer: v.wer, actor: v.actor_identity_id };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** AusweisAbruf aus einer Ablagezeile (Zustand allein aus den Spalten). */
export function ausweisAbrufAus(identityId: string, z: NonNullable<Awaited<ReturnType<typeof holeAusweis>>>): AusweisAbruf {
  const zustand = ausweisZustand({ gueltig_bis: z.gueltig_bis, widerrufen_am: null });
  return {
    identity_id: identityId, token: z.token, token_id: z.id, token_praefix: z.token_praefix, zustand,
    ausweis_weg: (z.ausweis_weg as AusweisWeg | null) ?? null,
    erstnutzung_bis: zustand === 'ausgestellt' ? iso(z.gueltig_bis) : null, zuletzt_benutzt: iso(z.zuletzt_benutzt),
  };
}

/** V1/V4: Ausweis offen lesen. Antwort enthaelt den Wert; Audit nie. */
export async function rufeAusweisAb(project: string, zielIdentityId: string, akteur: AusweisAkteur, anlass: string): Promise<AusweisAbruf> {
  if (typeof project !== 'string' || !project.trim()) throw new ProfilVerwaltungFehler('project_fehlt');
  if (typeof zielIdentityId !== 'string' || !zielIdentityId.trim()) throw new ProfilVerwaltungFehler('ziel_identity_id_fehlt');
  const grund = pflichtText(anlass, 'anlass_fehlt', 3, 200);
  await pruefeAusweisKernEin(project);
  const db = getPool();
  const { wer, actor } = ausweisAkteurKennung(akteur);
  const ziel = await db.query<{ id: string; status: string }>('SELECT id, status FROM agent_identitaeten WHERE id=$1 AND project=$2', [zielIdentityId, project]);
  const verweigere = async (code: string, tokenId: string | null = null): Promise<never> => {
    // Fremde/unbekannte Ziele haben keine Audit-Zeile (FK) - dann bleibt nur der Fehler.
    if (ziel.rows[0]) await schreibeAudit(db, { project, ziel: zielIdentityId, tokenId, wer, actor, anlass: grund, erfolg: false, fehler: code }).catch(() => undefined);
    throw new ProfilVerwaltungFehler(code);
  };
  try { await pruefeAusweisAkteur(akteur, project, db); } catch { return verweigere('recht_fehlt'); }
  if (!ziel.rows[0]) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
  if (ziel.rows[0].status !== 'aktiv') return verweigere('identitaet_nicht_aktiv');
  const z = await holeAusweis(db, zielIdentityId);
  if (!z) return verweigere('ausweis_fehlt');
  await schreibeAudit(db, { project, ziel: zielIdentityId, tokenId: z.id, wer, actor, anlass: grund, erfolg: true, fehler: null });
  return ausweisAbrufAus(zielIdentityId, z);
}

/** V4: Ausweis loeschen (widerrufen); die Identitaet bleibt. Idempotent (geloescht:false = es gab keinen). */
export async function loescheAusweis(
  project: string, zielIdentityId: string, akteur: AusweisAkteur, grund: string,
): Promise<{ identity_id: string; token_id: string | null; geloescht: boolean }> {
  if (typeof project !== 'string' || !project.trim()) throw new ProfilVerwaltungFehler('project_fehlt');
  if (typeof zielIdentityId !== 'string' || !zielIdentityId.trim()) throw new ProfilVerwaltungFehler('ziel_identity_id_fehlt');
  const g = pflichtText(grund, 'grund_fehlt', 5, 500);
  await pruefeAusweisKernEin(project);
  return profilTransaktion(async (c) => {
    const v = await pruefeAusweisAkteur(akteur, project, c);
    const i = await c.query('SELECT id FROM agent_identitaeten WHERE id=$1 AND project=$2 FOR UPDATE', [zielIdentityId, project]);
    if (!i.rows[0]) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
    const z = await holeAusweis(c, zielIdentityId, true);
    if (!z) return { identity_id: zielIdentityId, token_id: null, geloescht: false };
    await c.query(`UPDATE agent_identitaet_tokens SET widerrufen_am=NOW(), widerrufen_von=$2,
        widerrufen_von_identity_id=(SELECT id FROM agent_identitaeten WHERE id=$2), widerrufen_grund=$3 WHERE id=$1`, [z.id, v.wer, g]);
    await schreibeIdentitaetAudit(c, zielIdentityId, v.wer, 'token_widerrufen',
      { token_id: z.id, token_praefix: z.token_praefix, widerrufen: false }, { token_id: z.id, widerrufen: true, ausweis_geloescht: true }, g);
    return { identity_id: zielIdentityId, token_id: z.id, geloescht: true };
  });
}

/** Bestandsschnittstelle (W1B_DIENSTE.tokenAbruf): wie rufeAusweisAb, nur mit der alten Ausgabeform. */
export interface ProfilTokenAbruf { token: string; token_id: string; token_praefix: string }
export async function rufeProfilTokenAb(
  project: string, zielIdentityId: string, akteur: AusweisAkteur, anlass: string,
): Promise<ProfilTokenAbruf> {
  const a = await rufeAusweisAb(project, zielIdentityId, akteur, anlass);
  return { token: a.token, token_id: a.token_id, token_praefix: a.token_praefix };
}

export interface WebUiKoordinatorToken extends ProfilTokenAbruf { identity_id: string; agent_id: string; name: string }

/**
 * Anzeige des Tokens des Web-UI-Koordinatorprofils (02845fc2 Punkt 6): nur fuer den User ueber den
 * authentifizierten User-Eingang. Ohne identity_id gilt der zuletzt aktive Koordinator, der ueber den
 * User-Eingang angelegt wurde (erstellt_von = 'user'); die UI kann ueber die Profiluebersicht explizit waehlen.
 */
export async function rufeWebUiKoordinatorTokenAb(
  project: string, akteur: AusweisAkteur, identityId?: string,
): Promise<WebUiKoordinatorToken> {
  if (akteur.art !== 'user') throw new ProfilVerwaltungFehler('recht_fehlt');
  const r = await getPool().query<{ id: string; agent_id: string; name: string }>(
    identityId
      ? "SELECT id, agent_id, name FROM agent_identitaeten WHERE id=$2 AND project=$1 AND rolle='koordinator' AND status='aktiv'"
      : "SELECT id, agent_id, name FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator' AND status='aktiv' AND erstellt_von='user' ORDER BY zuletzt_aktiv DESC LIMIT 1",
    identityId ? [project, identityId] : [project]);
  const z = r.rows[0];
  if (!z) throw new ProfilVerwaltungFehler('web_ui_koordinator_nicht_gefunden');
  const t = await rufeProfilTokenAb(project, z.id, akteur, 'web-ui-anzeige');
  return { ...t, identity_id: z.id, agent_id: z.agent_id, name: z.name };
}

export const tokenAbrufDienst: TokenAbrufDienst = { rufeProfilTokenAb };
