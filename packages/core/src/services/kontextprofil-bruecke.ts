/**
 * P22-T287 S2 (Konzept ebe24645 Abschnitt 3, Freigabe Pruefer Runde 2): Bruecke kontextprofil_* -> Agentenprofil (P22-T13).
 *
 * ziel 'identity:<id>' schreibt stufe / kontext_budget / hinweise_aus / hinweise_nur in das Profil der Identitaet, ueber den
 * bestehenden profil_aendern-Weg (W1B_DIENSTE.profil.aendereProfil: Rechte, Revision/CAS, Audit, Schalter profilverwaltung) statt
 * coming_soon (kontextprofil-admin.ts) bzw. ausloeser_hinweis_profile. Namensziele (z. B. luna-*) bleiben beim Altweg.
 * Wirkung der Profilfelder im Tool-Aufruf nur mit profil_antwortanpassung (agent-profil-schalter.ts leseAntwortanpassungSchalter).
 * SCHALTER: Produkt-Schalter kontextprofil_bruecke (projekt/global, Standard AUS, nur ausdruecklich). AUS -> null = Altverhalten.
 * ABBILDUNG: stufe -> kontext_stufe; kontext_budget -> kontext_budget; hinweise_aus -> hinweise[id] = false (zum bestehenden
 *   Override); hinweise_nur -> alle optionalen Katalogarten false ausser den genannten (true); entfernen -> kontext_stufe 'normal',
 *   kontext_budget null, hinweise {} (Standardverhalten). liste -> wirksame Werte mit Herkunft (standard/global_typ/projekt_typ/profil).
 * RECHTE: Akteur aus User-Eingang bzw. Ausweis (aktuellerW1bAkteur) oder Legacy-Koordinator ohne Ausweis (agent_id); geprueft im
 *   Profildienst (pruefeProfilRecht) bzw. bei liste ueber pruefeProfilVerwalter. Pflichthinweise bleiben nicht abschaltbar.
 * DEBUG: jede Antwort traegt weg 'kontextprofil_bruecke' und den Schalterstand.
 */
import { getPool } from '../db/client.js';
import { HINWEIS_KATALOG } from './hinweis-katalog.js';
import type { AusweisAkteur, W1bAkteur, ProfilInhalt } from './agent-profil-vertrag.js';

export const KONTEXTPROFIL_BRUECKE_FUNKTION = 'kontextprofil_bruecke' as const;
const AKTIONEN = ['kontextprofil_setzen', 'kontextprofil_liste', 'kontextprofil_entfernen'];
const PRAEFIX = 'identity:';

function liste(v: unknown): string[] | null | 'ungueltig' {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim())) return 'ungueltig';
  return (v as string[]).map((x) => x.trim());
}

/** null = nicht zustaendig (kein identity-Ziel, Schalter AUS, Aktion fremd) -> Altweg. */
export async function fuehreKontextprofilBrueckeAus(action: string, args: Record<string, unknown>, agentId?: string | null): Promise<Record<string, unknown> | null> {
  if (!AKTIONEN.includes(action)) return null;
  const ziel = typeof args.ziel === 'string' ? args.ziel.trim() : '';
  const project = typeof args.project === 'string' ? args.project.trim() : '';
  if (!ziel.startsWith(PRAEFIX) || !project) return null;
  const { leseProfilProduktSchalter } = await import('./agent-profil-schalter.js');
  const schalter = await leseProfilProduktSchalter(KONTEXTPROFIL_BRUECKE_FUNKTION, project, null);
  if (!schalter.aktiv) return null;
  const identity_id = ziel.slice(PRAEFIX.length).trim();
  const debug = { weg: 'kontextprofil_bruecke', schalter: { funktion: KONTEXTPROFIL_BRUECKE_FUNKTION, aktiv: true, quelle: schalter.quelle, ebene: schalter.ebene } };
  const fehler = (error: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ success: false, action, project, ziel, error, ...extra, ...debug });
  try {
    const { aktuellerW1bAkteur, pruefeProfilVerwalter } = await import('./agent-profil-verwalter.js');
    let akteur: AusweisAkteur | null = aktuellerW1bAkteur();
    if (!akteur) {
      const roh = agentId ?? args.agent_id;
      const a = typeof roh === 'string' ? roh.trim() : '';
      const { rolleFuerAgent } = await import('./agent-rollen.js');
      if (a && rolleFuerAgent(a).rolle === 'koordinator') akteur = { art: 'legacy_koordinator', agent_id: a };
    }
    if (!akteur) return fehler('recht_fehlt');
    const r = await getPool().query<{ profil: Record<string, unknown> | null; profil_revision: number }>(
      'SELECT profil, profil_revision FROM agent_identitaeten WHERE id=$1 AND project=$2', [identity_id, project]);
    const z = r.rows[0];
    if (!z) return fehler('identitaet_unbekannt');
    const { W1B_DIENSTE } = await import('./agent-profil-vertrag.js');
    if (action === 'kontextprofil_liste') {
      await pruefeProfilVerwalter(akteur, project);
      const w = await W1B_DIENSTE.profil.leseWirksamesProfil(identity_id, akteur as W1bAkteur);
      return { success: true, action, project, ziel, profil_revision: w.profil_revision,
        kontextprofil: { kontext_stufe: w.werte.kontext_stufe ?? null, kontext_budget: w.werte.kontext_budget ?? null, hinweise: w.werte.hinweise ?? {} },
        herkunft: { kontext_stufe: w.herkunft.kontext_stufe ?? 'standard', kontext_budget: w.herkunft.kontext_budget ?? 'standard', hinweise: w.herkunft.hinweise ?? 'standard' },
        ...debug };
    }
    const patch: Partial<ProfilInhalt> = {};
    if (action === 'kontextprofil_entfernen') {
      patch.kontext_stufe = 'normal';
      patch.kontext_budget = null;
      patch.hinweise = {};
    } else {
      const aus = liste(args.hinweise_aus);
      const nur = liste(args.hinweise_nur);
      if (aus === 'ungueltig' || nur === 'ungueltig') return fehler('ungueltige_hinweisliste');
      if (args.stufe !== undefined) patch.kontext_stufe = args.stufe as ProfilInhalt['kontext_stufe'];
      if (args.kontext_budget !== undefined) patch.kontext_budget = args.kontext_budget as number;
      if (aus || nur) {
        const alt = z.profil?.hinweise && typeof z.profil.hinweise === 'object' && !Array.isArray(z.profil.hinweise)
          ? { ...(z.profil.hinweise as Record<string, boolean>) } : {};
        const neu: Record<string, boolean> = nur
          ? Object.fromEntries(HINWEIS_KATALOG.filter((e) => e.klasse === 'optional').map((e) => [e.schluessel, false])) : alt;
        for (const k of nur ?? []) neu[k] = true;
        for (const k of aus ?? []) neu[k] = false;
        patch.hinweise = neu;
      }
      if (!Object.keys(patch).length) return fehler('nichts_zu_setzen', { erwartet: 'stufe, kontext_budget, hinweise_aus oder hinweise_nur' });
    }
    const grund = typeof args.grund === 'string' ? args.grund.trim() : '';
    const erg = await W1B_DIENSTE.profil.aendereProfil({ identity_id, erwartete_revision: z.profil_revision, patch, grund }, akteur as W1bAkteur);
    return { success: true, action, project, ziel, profil_revision: erg.profil_revision, gesetzt: patch, ...debug };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    const details = (e as { details?: unknown })?.details;
    return fehler(typeof code === 'string' ? code : 'kontextprofil_bruecke_fehler',
      details && typeof details === 'object' ? { details } : {});
  }
}
