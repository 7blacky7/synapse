/**
 * P6-T49 Nachtrag (Koordinator 28011, memory regel-neue-funktionen-mit-schalter-und-debug Punkt 2/7): PRODUKT-SCHALTER fuer
 * den Fristablauf offener files-Plaene (REST-Worker files_plan_ablauf, file-plan-ablauf.ts).
 * CODE-STANDARD EIN (User 19.10.2026: 'Ein Fileplan ist nach 2 Tagen auf jeden Fall abgeschlossen').
 * SPEICHER: Tabelle agent_profil_schalter (Schema 113, keine neue Tabelle), funktion 'files_plan_ablauf'. Bewusst NICHT im
 *   Katalog PROFIL_PRODUKT_FUNKTIONEN (dort gilt Standard AUS und 'alle'); profil_schalter_setzen mit 'alle' beruehrt diesen
 *   Schalter nicht. Gelesen wird nur die exakte Funktion, Rangfolge projekt > global > Standard EIN.
 * VERWALTUNG: admin(ausweis_fristen, files_plan_ablauf_aktiv:true|false [modus setzen] bzw. modus entfernen) und REST
 *   GET/PUT /api/projects/:project/agent-profile/ausweis-fristen (Web-UI Agenten-Ausweis); Rechte wie die Fristen
 *   (User oder Koordinator des Projekts, auch Legacy-Koordinator). Grund Pflicht (min. 5 Zeichen), gesetzt_von protokolliert.
 * DEBUG: Antwort files_plan_ablauf {aktiv, quelle standard|global|projekt, standard, global, projekt, gesetzt_von/_am, grund,
 *   letzter_fehler}; der Worker meldet je Projekt schalter{aktiv, quelle} und listet abgeschaltete Projekte unter aus[].
 * ENV: SYNAPSE_FILES_PLAN_ABLAUF_DISABLED=1 bleibt nur Infrastruktur-Notbremse (Worker startet gar nicht).
 * Lesefehler -> Standard EIN mit letzter_fehler (nicht gepuffert; gelesen wird nur im Worker-Lauf und in der Verwaltung).
 */
import { getPool } from '../db/client.js';

export const FILES_PLAN_ABLAUF_SCHALTER = 'files_plan_ablauf' as const;
export type FilesPlanAblaufQuelle = 'standard' | 'global' | 'projekt';
export interface FilesPlanAblaufSchalterStand {
  project: string | null;
  /** wirksam: true = offene Plaene laufen nach files_plan_stunden ab */
  aktiv: boolean;
  quelle: FilesPlanAblaufQuelle;
  standard: true;
  global: boolean | null;
  projekt: boolean | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
  hinweis: string;
}

/** Geheimnisfreier Fachfehler (code); die admin-Fehlerantwort gibt ihn weiter. */
export class FilesPlanAblaufSchalterFehler extends Error {
  constructor(public readonly code: string) { super(code); }
}

const HINWEIS = 'Produkt-Schalter Fristablauf offener files-Plaene (Worker files_plan_ablauf): Rangfolge projekt > global > Standard EIN; '
  + 'aus = offene Plaene dieses Bereichs laufen nicht ab. Frist: files_plan_stunden.';

interface Zeile { ebene: 'global' | 'projekt'; aktiv: boolean; grund: string | null; gesetzt_von: string; gesetzt_am: Date | string }

/** EINE Lesestelle des Schalters. project null = nur global/Standard. */
export async function leseFilesPlanAblaufSchalter(project?: string | null): Promise<FilesPlanAblaufSchalterStand> {
  const p = typeof project === 'string' && project.trim() ? project.trim() : null;
  const basis: FilesPlanAblaufSchalterStand = { project: p, aktiv: true, quelle: 'standard', standard: true, global: null, projekt: null,
    gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null, hinweis: HINWEIS };
  try {
    const r = await getPool().query<Zeile>({
      text: `SELECT ebene, aktiv, grund, gesetzt_von, gesetzt_am FROM agent_profil_schalter
        WHERE funktion = $1 AND (ebene = 'global' OR (ebene = 'projekt' AND project = $2))`,
      values: [FILES_PLAN_ABLAUF_SCHALTER, p],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const g = r.rows.find((z) => z.ebene === 'global');
    const pz = p === null ? undefined : r.rows.find((z) => z.ebene === 'projekt');
    const w = pz ?? g;
    return { ...basis, aktiv: w ? w.aktiv : true, quelle: pz ? 'projekt' : g ? 'global' : 'standard',
      global: g ? g.aktiv : null, projekt: pz ? pz.aktiv : null, gesetzt_von: w?.gesetzt_von ?? null,
      gesetzt_am: w ? new Date(w.gesetzt_am).toISOString() : null, grund: w?.grund ?? null };
  } catch {
    return { ...basis, letzter_fehler: 'files_plan_ablauf_schalter_nicht_lesbar' };
  }
}

/**
 * Setzt (aktiv true|false) oder entfernt (entfernen:true) den Schalter auf EINER Ebene. Rechte prueft der Aufrufer
 * (admin ausweis_fristen: pruefeProfilVerwalter); wer/setter_identity_id landen in der Zeile.
 */
export async function setzeFilesPlanAblaufSchalter(
  e: { ebene: unknown; project?: string | null; aktiv?: unknown; entfernen?: boolean; grund: unknown },
  wer: { wer: string; setter_identity_id: string | null },
): Promise<FilesPlanAblaufSchalterStand> {
  if (e.ebene !== 'global' && e.ebene !== 'projekt') throw new FilesPlanAblaufSchalterFehler('ebene_ungueltig');
  const project = e.ebene === 'projekt' ? (typeof e.project === 'string' ? e.project.trim() : '') : null;
  if (e.ebene === 'projekt' && !project) throw new FilesPlanAblaufSchalterFehler('project_fehlt');
  const grund = typeof e.grund === 'string' ? e.grund.trim() : '';
  if (grund.length < 5 || grund.length > 1000) throw new FilesPlanAblaufSchalterFehler('grund_fehlt');
  if (e.entfernen !== true && typeof e.aktiv !== 'boolean') throw new FilesPlanAblaufSchalterFehler('files_plan_ablauf_aktiv_ungueltig');
  try {
    if (e.entfernen === true) {
      await getPool().query(
        `DELETE FROM agent_profil_schalter WHERE ebene = $1 AND COALESCE(project, '') = COALESCE($2, '') AND funktion = $3`,
        [e.ebene, project, FILES_PLAN_ABLAUF_SCHALTER]);
    } else {
      await getPool().query(
        `INSERT INTO agent_profil_schalter (ebene, project, funktion, aktiv, grund, gesetzt_von, setter_identity_id, gesetzt_am)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (ebene, (COALESCE(project, '')), funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
           gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=EXCLUDED.setter_identity_id, gesetzt_am=EXCLUDED.gesetzt_am`,
        [e.ebene, project, FILES_PLAN_ABLAUF_SCHALTER, e.aktiv, grund, wer.wer, wer.setter_identity_id]);
    }
  } catch {
    // DB-Fehler nicht weiterreichen (koennen Werte enthalten).
    throw new FilesPlanAblaufSchalterFehler('files_plan_ablauf_speicher_fehler');
  }
  return leseFilesPlanAblaufSchalter(project);
}
