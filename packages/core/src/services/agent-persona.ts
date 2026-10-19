/**
 * P22-T13 Paket D / K7 (User 15b01fa5): Persona ausschliesslich auf User-Wunsch.
 * - Standard leer: ohne ausdrueckliche Zuweisung keine Zeile in agent_persona_zuweisungen.
 * - Eigene versionierte Bibliothek (agent_persona_vorlagen/-versionen); eine neue Version ueberschreibt
 *   KEINE laufende Zuweisung (die Zuweisung haelt ihre Version fest).
 * - Anlegen/neue Version/Zuweisen nur mit dokumentiertem User-Auftrag (User ueber den authentifizierten
 *   Eingang, oder Koordinator desselben Projekts mit Wortlaut). Globale Vorlagen nur der User.
 * - Entfernen jederzeit (auch bei Schalter AUS); Rollback eines Profils beruehrt Personas nie.
 * - Eigenprofilregel (darfProfilAendern): ein Koordinator aendert seine EIGENE Persona nicht.
 * Produkt-Schalter 'persona' (Standard AUS) gilt fuer alles ausser Entfernen und Lesen der Zuweisung.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { darfProfilAendern, type PersonaDienst, type PersonaVersion, type PersonaVorlage, type PersonaZuweisung, type W1bAkteur } from './agent-profil-vertrag.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, isoZeit, pflichtText, profilTransaktion, pruefeProfilVerwalter, userAuftragFuer } from './agent-profil-verwalter.js';

const VORLAGE_SPALTEN = 'id, scope, project, name, aktuelle_version, status';
const MAX_INHALT_ZEICHEN = 20_000;

async function schalterEin(project: string | null): Promise<void> {
  const s = await leseProfilProduktSchalter('persona', project);
  if (!s.aktiv) throw new ProfilVerwaltungFehler('funktion_aus', { funktion: 'persona', quelle: s.quelle, ...(s.letzter_fehler ? { letzter_fehler: s.letzter_fehler } : {}) });
}

function pruefeInhalt(inhalt: unknown): Record<string, unknown> {
  if (!inhalt || typeof inhalt !== 'object' || Array.isArray(inhalt) || !Object.keys(inhalt).length) throw new ProfilVerwaltungFehler('inhalt_ungueltig');
  const text = JSON.stringify(inhalt);
  // Eine Persona ist Charakter-/Stilbeschreibung; nie ein Zugangswert und nie unbegrenzt.
  if (text.length > MAX_INHALT_ZEICHEN || /sai_[a-f0-9]{64}/.test(text)) throw new ProfilVerwaltungFehler('inhalt_ungueltig');
  return inhalt as Record<string, unknown>;
}

interface VorlageZeile { id: string; scope: 'global' | 'projekt'; project: string | null; name: string; aktuelle_version: number; status: 'aktiv' | 'archiviert' }
const alsVorlage = (z: VorlageZeile): PersonaVorlage => ({ id: z.id, scope: z.scope, project: z.project, name: z.name,
  aktuelle_version: z.aktuelle_version, status: z.status });

interface VersionZeile { vorlage_id: string; version: number; inhalt: Record<string, unknown>; user_auftrag: string; wann: Date }
const alsVersion = (z: VersionZeile): PersonaVersion => ({ vorlage_id: z.vorlage_id, version: z.version, inhalt: z.inhalt,
  user_auftrag: z.user_auftrag, wann: isoZeit(z.wann) as string });

interface ZuweisungZeile { identity_id: string; vorlage_id: string; version: number; user_auftrag: string; gesetzt_von: string; gesetzt_am: Date }
const alsZuweisung = (z: ZuweisungZeile): PersonaZuweisung => ({ identity_id: z.identity_id, vorlage_id: z.vorlage_id, version: z.version,
  user_auftrag: z.user_auftrag, gesetzt_von: z.gesetzt_von, gesetzt_am: isoZeit(z.gesetzt_am) as string });

async function zielIdentitaet(c: Pick<PoolClient, 'query'>, identityId: unknown, nurAktiv: boolean): Promise<{ id: string; project: string }> {
  if (typeof identityId !== 'string' || !identityId.trim()) throw new ProfilVerwaltungFehler('ziel_identity_id_fehlt');
  const r = await c.query<{ id: string; project: string; status: string }>(
    'SELECT id, project, status FROM agent_identitaeten WHERE id=$1 FOR SHARE', [identityId]);
  const z = r.rows[0];
  if (!z) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
  if (nurAktiv && z.status !== 'aktiv') throw new ProfilVerwaltungFehler('identitaet_nicht_aktiv');
  return { id: z.id, project: z.project };
}

function pruefeEigenprofil(akteur: W1bAkteur, ziel: { id: string; project: string }): void {
  if (!darfProfilAendern(akteur, { identity_id: ziel.id, project: ziel.project })) throw new ProfilVerwaltungFehler('eigenprofil_nicht_aenderbar');
}

export async function listePersonaVorlagen(project: string, akteur: W1bAkteur): Promise<PersonaVorlage[]> {
  if (typeof project !== 'string' || !project.trim()) throw new ProfilVerwaltungFehler('project_fehlt');
  await schalterEin(project);
  await pruefeProfilVerwalter(akteur, project);
  const r = await getPool().query<VorlageZeile>(
    `SELECT ${VORLAGE_SPALTEN} FROM agent_persona_vorlagen WHERE scope='global' OR (scope='projekt' AND project=$1) ORDER BY scope, name`, [project]);
  return r.rows.map(alsVorlage);
}

export async function listePersonaVersionen(vorlageId: string, project: string, akteur: W1bAkteur): Promise<PersonaVersion[]> {
  await schalterEin(project);
  await pruefeProfilVerwalter(akteur, project);
  const v = await getPool().query<VorlageZeile>(
    `SELECT ${VORLAGE_SPALTEN} FROM agent_persona_vorlagen WHERE id=$1 AND (scope='global' OR project=$2)`, [vorlageId, project]);
  if (!v.rows[0]) throw new ProfilVerwaltungFehler('vorlage_unbekannt');
  const r = await getPool().query<VersionZeile>(
    'SELECT vorlage_id, version, inhalt, user_auftrag, wann FROM agent_persona_versionen WHERE vorlage_id=$1 ORDER BY version', [vorlageId]);
  return r.rows.map(alsVersion);
}

export async function legePersonaVorlageAn(
  e: { scope: 'global' | 'projekt'; project?: string | null; name: string; inhalt: Record<string, unknown> },
  akteur: W1bAkteur, userAuftrag: string,
): Promise<PersonaVersion> {
  if (e?.scope !== 'global' && e?.scope !== 'projekt') throw new ProfilVerwaltungFehler('scope_ungueltig');
  const project = e.scope === 'projekt' ? (typeof e.project === 'string' ? e.project.trim() : '') : null;
  if (e.scope === 'projekt' && !project) throw new ProfilVerwaltungFehler('project_fehlt');
  const name = pflichtText(e.name, 'name_ungueltig', 1, 120);
  const inhalt = pruefeInhalt(e.inhalt);
  await schalterEin(project);
  return profilTransaktion(async (c) => {
    const wer = await pruefeProfilVerwalter(akteur, project, { nurUser: e.scope === 'global', db: c });
    const auftrag = userAuftragFuer(akteur, userAuftrag);
    const id = randomUUID();
    try {
      await c.query('SAVEPOINT vorlage');
      await c.query(
        `INSERT INTO agent_persona_vorlagen (id, scope, project, name, aktuelle_version, erstellt_von, erstellt_von_identity_id)
         VALUES ($1,$2,$3,$4,1,$5,$6)`, [id, e.scope, project, name, wer.wer, wer.actor_identity_id]);
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT vorlage');
      if ((err as { code?: string })?.code === '23505') throw new ProfilVerwaltungFehler('vorlage_name_belegt');
      throw err;
    }
    const v = await c.query<VersionZeile>(
      `INSERT INTO agent_persona_versionen (vorlage_id, version, inhalt, wer, actor_identity_id, user_auftrag)
       VALUES ($1,1,$2::jsonb,$3,$4,$5) RETURNING vorlage_id, version, inhalt, user_auftrag, wann`,
      [id, JSON.stringify(inhalt), wer.wer, wer.actor_identity_id, auftrag]);
    return alsVersion(v.rows[0]);
  });
}

/** Neue Bibliotheksversion; laufende Zuweisungen behalten ihre Version (K7: kein unbemerktes Ueberschreiben). */
export async function legePersonaVersionAn(
  vorlageId: string, inhalt: Record<string, unknown>, akteur: W1bAkteur, userAuftrag: string,
): Promise<PersonaVersion> {
  const neu = pruefeInhalt(inhalt);
  return profilTransaktion(async (c) => {
    const r = await c.query<VorlageZeile>(`SELECT ${VORLAGE_SPALTEN} FROM agent_persona_vorlagen WHERE id=$1 FOR UPDATE`, [vorlageId]);
    const v = r.rows[0];
    if (!v) throw new ProfilVerwaltungFehler('vorlage_unbekannt');
    await schalterEin(v.project);
    if (v.status !== 'aktiv') throw new ProfilVerwaltungFehler('vorlage_archiviert');
    const wer = await pruefeProfilVerwalter(akteur, v.project, { nurUser: v.scope === 'global', db: c });
    const auftrag = userAuftragFuer(akteur, userAuftrag);
    const version = v.aktuelle_version + 1;
    const z = await c.query<VersionZeile>(
      `INSERT INTO agent_persona_versionen (vorlage_id, version, inhalt, wer, actor_identity_id, user_auftrag)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6) RETURNING vorlage_id, version, inhalt, user_auftrag, wann`,
      [vorlageId, version, JSON.stringify(neu), wer.wer, wer.actor_identity_id, auftrag]);
    await c.query('UPDATE agent_persona_vorlagen SET aktuelle_version=$2 WHERE id=$1', [vorlageId, version]);
    return alsVersion(z.rows[0]);
  });
}

export async function weisePersonaZu(
  identityId: string, vorlageId: string, version: number, akteur: W1bAkteur, userAuftrag: string,
): Promise<PersonaZuweisung> {
  if (!Number.isInteger(version) || version < 1) throw new ProfilVerwaltungFehler('version_ungueltig');
  return profilTransaktion(async (c) => {
    const ziel = await zielIdentitaet(c, identityId, true);
    await schalterEin(ziel.project);
    const wer = await pruefeProfilVerwalter(akteur, ziel.project, { db: c });
    pruefeEigenprofil(akteur, ziel);
    const auftrag = userAuftragFuer(akteur, userAuftrag);
    const v = await c.query<VorlageZeile>(
      `SELECT ${VORLAGE_SPALTEN} FROM agent_persona_vorlagen WHERE id=$1 AND (scope='global' OR project=$2) FOR SHARE`, [vorlageId, ziel.project]);
    if (!v.rows[0]) throw new ProfilVerwaltungFehler('vorlage_unbekannt');
    if (v.rows[0].status !== 'aktiv') throw new ProfilVerwaltungFehler('vorlage_archiviert');
    const ver = await c.query('SELECT 1 FROM agent_persona_versionen WHERE vorlage_id=$1 AND version=$2', [vorlageId, version]);
    if (!ver.rows[0]) throw new ProfilVerwaltungFehler('version_unbekannt');
    const alt = await c.query<ZuweisungZeile>(
      'SELECT identity_id, vorlage_id, version, user_auftrag, gesetzt_von, gesetzt_am FROM agent_persona_zuweisungen WHERE identity_id=$1 FOR UPDATE', [ziel.id]);
    if (alt.rows[0] && alt.rows[0].vorlage_id === vorlageId && alt.rows[0].version === version) return alsZuweisung(alt.rows[0]);
    const z = await c.query<ZuweisungZeile>(
      `INSERT INTO agent_persona_zuweisungen (identity_id, vorlage_id, version, user_auftrag, gesetzt_von, gesetzt_von_identity_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (identity_id) DO UPDATE SET vorlage_id=EXCLUDED.vorlage_id, version=EXCLUDED.version, user_auftrag=EXCLUDED.user_auftrag,
         gesetzt_von=EXCLUDED.gesetzt_von, gesetzt_von_identity_id=EXCLUDED.gesetzt_von_identity_id, gesetzt_am=NOW()
       RETURNING identity_id, vorlage_id, version, user_auftrag, gesetzt_von, gesetzt_am`,
      [ziel.id, vorlageId, version, auftrag, wer.wer, wer.actor_identity_id]);
    await c.query(
      `INSERT INTO agent_persona_audit (identity_id, aktion, alt, neu, wer, actor_identity_id, user_auftrag)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)`,
      [ziel.id, alt.rows[0] ? 'aendern' : 'zuweisen',
        alt.rows[0] ? JSON.stringify({ vorlage_id: alt.rows[0].vorlage_id, version: alt.rows[0].version }) : null,
        JSON.stringify({ vorlage_id: vorlageId, version }), wer.wer, wer.actor_identity_id, auftrag]);
    return alsZuweisung(z.rows[0]);
  });
}

/** Jederzeit moeglich (kein Schalter, auch fuer deaktivierte Identitaeten); Audit mit alt/neu und Grund. */
export async function entfernePersona(identityId: string, akteur: W1bAkteur, grund: string): Promise<void> {
  const text = pflichtText(grund, 'grund_fehlt');
  await profilTransaktion(async (c) => {
    const ziel = await zielIdentitaet(c, identityId, false);
    const wer = await pruefeProfilVerwalter(akteur, ziel.project, { db: c });
    pruefeEigenprofil(akteur, ziel);
    const alt = await c.query<ZuweisungZeile>(
      'DELETE FROM agent_persona_zuweisungen WHERE identity_id=$1 RETURNING identity_id, vorlage_id, version, user_auftrag, gesetzt_von, gesetzt_am', [ziel.id]);
    if (!alt.rows[0]) throw new ProfilVerwaltungFehler('keine_zuweisung');
    await c.query(
      `INSERT INTO agent_persona_audit (identity_id, aktion, alt, neu, wer, actor_identity_id, grund)
       VALUES ($1,'entfernen',$2::jsonb,NULL,$3,$4,$5)`,
      [ziel.id, JSON.stringify({ vorlage_id: alt.rows[0].vorlage_id, version: alt.rows[0].version }), wer.wer, wer.actor_identity_id, text]);
  });
}

/** Reiner Lesezugriff ohne Rechtepruefung (Aufrufer: Profilresolver, Verwaltung); keine Zeile = keine Persona. */
export async function lesePersonaZuweisung(identityId: string): Promise<PersonaZuweisung | null> {
  const r = await getPool().query<ZuweisungZeile>(
    'SELECT identity_id, vorlage_id, version, user_auftrag, gesetzt_von, gesetzt_am FROM agent_persona_zuweisungen WHERE identity_id=$1', [identityId]);
  return r.rows[0] ? alsZuweisung(r.rows[0]) : null;
}

export const personaDienst: PersonaDienst = {
  listeVorlagen: listePersonaVorlagen,
  legeVorlageAn: legePersonaVorlageAn,
  neueVersion: legePersonaVersionAn,
  weiseZu: weisePersonaZu,
  entferne: entfernePersona,
  leseZuweisung: lesePersonaZuweisung,
};
