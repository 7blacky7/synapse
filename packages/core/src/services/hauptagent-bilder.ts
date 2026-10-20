/**
 * P22-T67: Bild zu einem Werkzeugaufruf des Hauptagenten (Chatverlauf der Web-UI).
 *
 * Der Verlauf speichert KEIN Base64, sondern den Verweis project + file_path (+ revision) auf das Asset. Dieser Dienst
 * rendert daraus beim Anzeigen die Ansicht ueber denselben A14-Ansichtsdienst wie ansicht:'inline' der Tools. Rechte wie die
 * Web-UI-Sitzung des Users (Aufruf nur aus der geschuetzten REST-Route); das Projekt muss freigegeben sein. Ist die
 * gespeicherte Revision nicht mehr abrufbar, kommt die aktuelle Revision (aktuell:true), sonst eine Fehlermeldung statt Bild.
 * Kein Schalter: reine Anzeige.
 */
import { getPool } from '../db/client.js';
import { gemeinsamerAnsichtDienst } from './asset-ansicht-link.js';
import type { AssetAnsichtErgebnis, AssetAnsichtReferenz } from './asset-ansicht.js';
import { isProjectEnabled } from './project-registry.js';

export interface ToolBildEingabe { project: unknown; file_path: unknown; revision?: unknown }
export type ToolBildErgebnis =
  | { ok: true; png: Buffer; breite: number; hoehe: number; revision: string; aktuell: boolean }
  | { ok: false; status: number; fehlercode: string; grund: string };

/** Abhaengigkeiten, fuer Tests ersetzbar. */
export interface ToolBildDienste {
  ansicht: { ansichten(refs: readonly AssetAnsichtReferenz[]): Promise<AssetAnsichtErgebnis[]> };
  projektAktiv: (projekt: string) => Promise<boolean>;
  assetId: (projekt: string, pfad: string) => Promise<string | null>;
}

const standardDienste = (): ToolBildDienste => ({
  ansicht: gemeinsamerAnsichtDienst(),
  projektAktiv: isProjectEnabled,
  assetId: async (projekt, pfad) => {
    const r = await getPool().query('SELECT id::text AS id FROM asset_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [projekt, pfad]);
    return (r.rows[0] as { id: string } | undefined)?.id ?? null;
  },
});

const fehlerStatus = (code: string): number =>
  code === 'kein_asset' ? 404 : code === 'projekt_verboten' ? 403 : code === 'ansicht_nicht_darstellbar' ? 415
    : code === 'ansicht_limit' ? 413 : code === 'parameter_ungueltig' ? 400 : 502;

const fehler = (fehlercode: string, grund: string): ToolBildErgebnis => ({ ok: false, status: fehlerStatus(fehlercode), fehlercode, grund });

export async function rendereToolBild(e: ToolBildEingabe, dienste: Partial<ToolBildDienste> = {}): Promise<ToolBildErgebnis> {
  const project = typeof e.project === 'string' ? e.project.trim() : '';
  const pfad = typeof e.file_path === 'string' ? e.file_path.trim() : '';
  const revision = typeof e.revision === 'string' && e.revision ? e.revision : undefined;
  if (!project || !pfad || pfad.length > 1024 || pfad.split(/[\\/]/).includes('..')) return fehler('parameter_ungueltig', 'project und file_path (ohne ..) sind Pflicht.');
  if (revision !== undefined && !/^[1-9][0-9]*$/.test(revision)) return fehler('parameter_ungueltig', 'revision muss eine positive ganze Zahl sein.');
  const d = { ...standardDienste(), ...dienste };
  try {
    if (!(await d.projektAktiv(project))) return fehler('projekt_verboten', 'Projekt fehlt oder ist nicht freigegeben.');
    const id = await d.assetId(project, pfad);
    if (!id) return fehler('kein_asset', 'Kein (nicht geloeschtes) Asset unter ' + pfad + '.');
    const ref = (rev?: string): AssetAnsichtReferenz => ({ bereich: 'projekt', ziel_ref: project, id, ...(rev ? { revision: rev } : {}) });
    let aktuell = revision === undefined;
    let [r] = await d.ansicht.ansichten([ref(revision)]);
    if (!r?.success && revision) {
      // Gespeicherte Revision nicht mehr abrufbar: aktuelle Fassung zeigen und das kenntlich machen.
      [r] = await d.ansicht.ansichten([ref()]);
      aktuell = true;
    }
    if (!r || !r.success) return fehler(r?.fehlercode ?? 'ansicht_fehler', r?.grund ?? 'Keine Ansicht erzeugt.');
    return { ok: true, png: r.png, breite: r.breite, hoehe: r.hoehe, revision: r.quelle.revision, aktuell };
  } catch (error) {
    return fehler('ansicht_fehler', error instanceof Error ? error.message : String(error));
  }
}
