/**
 * P22-T13 Phase V: Schalter fuer W1b (regel-neue-funktionen-mit-schalter-und-debug).
 *
 * (I) PRODUKT-SCHALTER agent_profil_schalter (PG, Schema 113). Standard AUS = keine Zeile.
 *     Steuert die Verwaltungsfunktionen der Pakete A/B/D/T (PROFIL_PRODUKT_FUNKTIONEN).
 *     Setzen: User (authentifizierter User-Eingang) global/projekt, bestaetigter Koordinator nur
 *     fuer sein eigenes Projekt. Vorrang: projekt+funktion > projekt+alle > global+funktion >
 *     global+alle > Standard AUS. Lesefehler (z. B. vor Schema 113) -> AUS mit letzter_fehler.
 *     Gelesen wird NUR in Verwaltungspfaden, nie pro gewoehnlichem Tool-Aufruf.
 * (II) INTERNE TEST-OVERRIDES w1b_durchsetzung (Token-Selbstfeldpruefung F3, Neutralisierung der
 *     REST-Vorbelegung, Profil-Gate) und w1b_antwortanpassung (Paket C). Produktionsstandard per
 *     Env SYNAPSE_W1B_DURCHSETZUNG / SYNAPSE_W1B_ANTWORTANPASSUNG ('1' = EIN), Default AUS.
 *     Override nur bei SYNAPSE_INTERN_TOOL=1, modus 'freigegeben', befristet (intern-schalter.ts);
 *     Ablauf/Lesefehler/ohne intern -> Produktionsstandard. Ohne intern KEIN PG-Lesen.
 * AUS = t109-Verhalten. Bedeutung 'freigegeben' (aktiv=true heisst Funktion EIN, keine Pause).
 */
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';

export type W1bSchalterArt = 'durchsetzung' | 'antwortanpassung' | 'anmeldung';
export const W1B_INTERN_SCHALTER = {
  durchsetzung: 'w1b_durchsetzung',
  antwortanpassung: 'w1b_antwortanpassung',
  anmeldung: 'w1b_anmeldung',
} as const satisfies Record<W1bSchalterArt, string>;
const W1B_ENV: Record<W1bSchalterArt, string> = {
  durchsetzung: 'SYNAPSE_W1B_DURCHSETZUNG',
  antwortanpassung: 'SYNAPSE_W1B_ANTWORTANPASSUNG',
  anmeldung: 'SYNAPSE_W1B_ANMELDUNG',
};

export interface W1bSchalterStand {
  art: W1bSchalterArt;
  name: string;
  freigegeben: boolean;
  standard: boolean;
  quelle: 'standard' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache, damit ein abgelaufener/geloeschter Override sofort wegfaellt). */
export async function leseW1bSchalter(art: W1bSchalterArt): Promise<W1bSchalterStand> {
  const standard = process.env[W1B_ENV[art]] === '1';
  const basis: W1bSchalterStand = { art, name: W1B_INTERN_SCHALTER[art], freigegeben: standard, standard,
    quelle: 'standard', bis: null, letzter_fehler: null };
  if (!internToolAktiv()) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: `SELECT aktiv, bis FROM intern_schalter
        WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
      values: [W1B_INTERN_SCHALTER[art]],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    return z ? { ...basis, freigegeben: z.aktiv, quelle: 'intern', bis: z.bis?.toISOString() ?? null } : basis;
  } catch {
    return { ...basis, letzter_fehler: 'schalter_nicht_erreichbar' };
  }
}

export const PROFIL_PRODUKT_FUNKTIONEN = [
  'profilverwaltung', 'typkatalog', 'schattenprofile', 'persona', 'task_bindung', 'token_abruf',
] as const;
export type ProfilProduktFunktion = typeof PROFIL_PRODUKT_FUNKTIONEN[number];

export interface ProfilProduktSchalterStand {
  funktion: ProfilProduktFunktion;
  project: string | null;
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter';
  ebene: 'global' | 'projekt' | null;
  regel_funktion: ProfilProduktFunktion | 'alle' | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

export class ProfilSchalterFehler extends Error {
  constructor(public readonly code: string) { super(code); }
}

interface SchalterZeile {
  ebene: 'global' | 'projekt'; project: string | null; funktion: string; aktiv: boolean;
  grund: string | null; gesetzt_von: string; gesetzt_am: Date;
}

function istFunktion(f: string): f is ProfilProduktFunktion {
  return (PROFIL_PRODUKT_FUNKTIONEN as readonly string[]).includes(f);
}

export async function leseProfilProduktSchalter(
  funktion: ProfilProduktFunktion, project?: string | null,
): Promise<ProfilProduktSchalterStand> {
  const basis: ProfilProduktSchalterStand = { funktion, project: project ?? null, aktiv: false, quelle: 'standard',
    ebene: null, regel_funktion: null, gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null };
  if (!istFunktion(funktion)) return { ...basis, letzter_fehler: 'funktion_unbekannt' };
  try {
    const r = await getPool().query<SchalterZeile>({
      text: `SELECT ebene, project, funktion, aktiv, grund, gesetzt_von, gesetzt_am FROM agent_profil_schalter
        WHERE funktion = ANY($1::text[]) AND (ebene = 'global' OR (ebene = 'projekt' AND project = $2))`,
      values: [[funktion, 'alle'], project ?? null],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const rang = (z: SchalterZeile) => (z.ebene === 'projekt' ? 2 : 0) + (z.funktion === funktion ? 1 : 0);
    const z = [...r.rows].sort((a, b) => rang(b) - rang(a))[0];
    if (!z) return basis;
    return { ...basis, aktiv: z.aktiv, quelle: 'produkt-schalter', ebene: z.ebene,
      regel_funktion: z.funktion as ProfilProduktFunktion | 'alle', gesetzt_von: z.gesetzt_von,
      gesetzt_am: z.gesetzt_am.toISOString(), grund: z.grund };
  } catch {
    return { ...basis, letzter_fehler: 'produkt_schalter_nicht_lesbar' };
  }
}

/** Akteur kommt ausschliesslich aus authentifiziertem Transport bzw. Tokenpruefung, nie aus Tool-Argumenten. */
export interface ProfilSchalterAkteur {
  system?: 'user';
  identity_id?: string;
}

export async function setzeProfilProduktSchalter(
  e: { ebene: 'global' | 'projekt'; project?: string | null; funktion: ProfilProduktFunktion | 'alle'; aktiv: boolean; grund: string },
  akteur: ProfilSchalterAkteur,
): Promise<ProfilProduktSchalterStand> {
  if (e.funktion !== 'alle' && !istFunktion(e.funktion)) throw new ProfilSchalterFehler('funktion_unbekannt');
  if (e.ebene !== 'global' && e.ebene !== 'projekt') throw new ProfilSchalterFehler('ebene_ungueltig');
  const project = e.ebene === 'projekt' ? (e.project ?? '').trim() : null;
  if (e.ebene === 'projekt' && !project) throw new ProfilSchalterFehler('project_fehlt');
  if (typeof e.grund !== 'string' || e.grund.trim().length < 5) throw new ProfilSchalterFehler('grund_fehlt');
  if (typeof e.aktiv !== 'boolean') throw new ProfilSchalterFehler('aktiv_fehlt');
  let wer: string;
  let setter: string | null = null;
  if (akteur.system === 'user') {
    wer = 'user';
  } else if (akteur.identity_id && e.ebene === 'projekt') {
    const r = await getPool().query(
      "SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv' AND rolle='koordinator'",
      [akteur.identity_id, project]);
    if (!r.rows.length) throw new ProfilSchalterFehler('recht_fehlt');
    wer = akteur.identity_id;
    setter = akteur.identity_id;
  } else {
    throw new ProfilSchalterFehler('recht_fehlt');
  }
  await getPool().query(
    `INSERT INTO agent_profil_schalter (ebene, project, funktion, aktiv, grund, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (ebene, (COALESCE(project, '')), funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
       gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=EXCLUDED.setter_identity_id, gesetzt_am=EXCLUDED.gesetzt_am`,
    [e.ebene, project, e.funktion, e.aktiv, e.grund.trim(), wer, setter]);
  return leseProfilProduktSchalter(e.funktion === 'alle' ? 'profilverwaltung' : e.funktion, project);
}
