/**
 * P22-T13 Paket D / K10A (User 02845fc2, Abnahme-Auflage C3): verschluesselt gespeicherte Agenten-Ausweise
 * jederzeit berechtigt abrufen.
 * - Abruf nur durch den User (authentifizierter Eingang) oder einen aktiven Koordinator DESSELBEN Projekts;
 *   Nicht-Koordinatoren und fremde Projekte werden abgelehnt (und ohne Tokenwert auditiert).
 * - Entschluesselung nur dort, wo der Schluessel liegt: SYNAPSE_AGENT_TOKEN_SCHLUESSEL gibt es nur in der
 *   API-Betriebskonfiguration (agent-token-tresor.ts); stdio-/Daemon-Prozesse ohne Schluessel scheitern
 *   mit token_schluessel_fehlt (kein Klartext-Fallback, kein neuer PC-PG-Zugang).
 * - Audit (agent_token_abruf_audit): Akteur, Ziel, Projekt, Zeitpunkt, Anlass, Erfolg - NIE der Tokenwert.
 *   Der Erfolgs-Audit wird VOR der Herausgabe geschrieben; scheitert er, wird kein Token ausgegeben.
 * - Die direkte, berechtigte Antwort darf den echten Token enthalten; sie gehoert in keine Log-/Audit-/
 *   Channel-Ausgabe (tool-call-log: admin:token_abrufen ohne result).
 * - Hash (token_hash) bleibt die einzige Grundlage der Identifikation; der Abruf aktiviert nichts.
 * Ausweise, die vor Einfuehrung des Tresors ausgestellt wurden, haben keinen Chiffretext (token_nicht_abrufbar);
 * dort hilft nur ein neuer Ausweis fuer dieselbe Identitaet (stelleAgentTokenAus mit identity_id).
 */
import { getPool } from '../db/client.js';
import { darfTokenAbrufen, type TokenAbrufDienst, type W1bAkteur } from './agent-profil-vertrag.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { TokenTresorFehler, entschluesseleAgentToken, tokenSchluesselStand, verschluesseleAgentToken } from './agent-token-tresor.js';
import { hashAgentToken } from './agent-identitaet.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter, type ProfilDb } from './agent-profil-verwalter.js';

/**
 * Legt den Chiffretext zu einem frisch ausgestellten Ausweis ab (in derselben Transaktion wie das INSERT).
 * Ohne Schluessel (Standard) passiert nichts: Verhalten und Spalten bleiben exakt wie t109.
 */
export async function speichereTokenChiffre(db: ProfilDb, tokenId: string, token: string): Promise<boolean> {
  if (!tokenSchluesselStand().vorhanden) return false;
  const v = verschluesseleAgentToken(token, tokenId);
  await db.query('UPDATE agent_identitaet_tokens SET token_verschluesselt=$2, token_schluessel_id=$3 WHERE id=$1', [tokenId, v.chiffre, v.schluessel_id]);
  return true;
}

interface AbrufAudit {
  project: string; ziel: string; tokenId: string | null; wer: string; actor: string | null;
  anlass: string | null; erfolg: boolean; fehler: string | null;
}
async function schreibeAudit(db: ProfilDb, a: AbrufAudit): Promise<void> {
  await db.query(
    `INSERT INTO agent_token_abruf_audit (project, ziel_identity_id, token_id, wer, actor_identity_id, anlass, erfolg, fehler)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [a.project, a.ziel, a.tokenId, a.wer, a.actor, a.anlass, a.erfolg, a.fehler]);
}

async function schalterEin(project: string): Promise<void> {
  const s = await leseProfilProduktSchalter('token_abruf', project);
  if (!s.aktiv) throw new ProfilVerwaltungFehler('funktion_aus', { funktion: 'token_abruf', quelle: s.quelle, ...(s.letzter_fehler ? { letzter_fehler: s.letzter_fehler } : {}) });
}

export interface ProfilTokenAbruf { token: string; token_id: string; token_praefix: string }

export async function rufeProfilTokenAb(
  project: string, zielIdentityId: string, akteur: W1bAkteur, anlass: string,
): Promise<ProfilTokenAbruf> {
  if (typeof project !== 'string' || !project.trim()) throw new ProfilVerwaltungFehler('project_fehlt');
  if (typeof zielIdentityId !== 'string' || !zielIdentityId.trim()) throw new ProfilVerwaltungFehler('ziel_identity_id_fehlt');
  const grund = pflichtText(anlass, 'anlass_fehlt', 3, 200);
  await schalterEin(project);
  const db = getPool();
  // Rechte: Haupttor (reine Entscheidung) + PG-Gegenpruefung von Rolle/Status/Projekt des Koordinators.
  const wer = akteur.art === 'user' ? 'user' : akteur.art === 'identitaet' ? akteur.principal.identity_id : akteur.art;
  const actor = akteur.art === 'identitaet' ? akteur.principal.identity_id : null;
  const ziel = await db.query<{ id: string; status: string }>('SELECT id, status FROM agent_identitaeten WHERE id=$1 AND project=$2', [zielIdentityId, project]);
  const verweigere = async (code: string, tokenId: string | null = null): Promise<never> => {
    // Fremde/unbekannte Ziele haben keine Audit-Zeile (FK) - dann bleibt nur der Fehler.
    if (ziel.rows[0]) await schreibeAudit(db, { project, ziel: zielIdentityId, tokenId, wer, actor, anlass: grund, erfolg: false, fehler: code }).catch(() => undefined);
    throw new ProfilVerwaltungFehler(code);
  };
  if (!darfTokenAbrufen(akteur, project)) return verweigere('recht_fehlt');
  try { await pruefeProfilVerwalter(akteur, project, { db }); } catch { return verweigere('recht_fehlt'); }
  if (!ziel.rows[0]) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
  if (ziel.rows[0].status !== 'aktiv') return verweigere('identitaet_nicht_aktiv');
  // Aktueller Hauptausweis (kein befristeter Start-Ausweis) mit Chiffretext.
  const t = await db.query<{ id: string; token_hash: string; token_praefix: string; token_verschluesselt: string | null; token_schluessel_id: string | null }>(
    `SELECT id, token_hash, token_praefix, token_verschluesselt, token_schluessel_id FROM agent_identitaet_tokens
      WHERE identity_id=$1 AND start_art IS NULL AND widerrufen_am IS NULL AND (gueltig_bis IS NULL OR gueltig_bis>NOW())
      ORDER BY erstellt_am DESC`, [zielIdentityId]);
  const zeile = t.rows.find(r => r.token_verschluesselt);
  if (!zeile) return verweigere('token_nicht_abrufbar');
  let token: string;
  try {
    token = entschluesseleAgentToken(zeile.token_verschluesselt as string, zeile.id, zeile.token_schluessel_id);
  } catch (e) {
    return verweigere(e instanceof TokenTresorFehler ? e.code : 'token_chiffre_ungueltig', zeile.id);
  }
  // Integritaet: der entschluesselte Wert muss zum gespeicherten Identifikations-Hash passen.
  if (hashAgentToken(token) !== zeile.token_hash) return verweigere('token_chiffre_ungueltig', zeile.id);
  await schreibeAudit(db, { project, ziel: zielIdentityId, tokenId: zeile.id, wer, actor, anlass: grund, erfolg: true, fehler: null });
  return { token, token_id: zeile.id, token_praefix: zeile.token_praefix };
}

export interface WebUiKoordinatorToken extends ProfilTokenAbruf { identity_id: string; agent_id: string; name: string }

/**
 * Anzeige des Tokens des Web-UI-Koordinatorprofils (02845fc2 Punkt 6): nur fuer den User ueber den
 * authentifizierten User-Eingang. Ohne identity_id gilt der zuletzt aktive Koordinator, der ueber den
 * User-Eingang angelegt wurde (erstellt_von = 'user'); die UI kann ueber die Profiluebersicht explizit waehlen.
 */
export async function rufeWebUiKoordinatorTokenAb(
  project: string, akteur: W1bAkteur, identityId?: string,
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
