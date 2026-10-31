/**
 * P22-T206 (Befunde 4c11e135, ccb14310, d8ce908a): Eine im Journalstatus 'staged' verwaiste Projekt-Publikationssperre
 * (.intern/locks/publish) blockierte seit 26.10. jede Finalisierung fuer synapse (Folge: P22-T240 Download-Schleife).
 *
 * WIRKUNG:
 *  - pruefePublishSperre(project): Zustand der Sperre (frei | aktiv | lease_laeuft | verwaist_unbewiesen | pg_aktiv | loesbar |
 *    geloest | andere_recovery | unklar) mit Besitzer, Journalstatus und Pfad. ausfuehren:true loest NUR, wenn AssetSpeicher.
 *    publishSperre die Verwaisung nachweist (Besitzer im Journal: anderer Prozess + abgelaufene Lease, PG: keine aktive
 *    Finalisierung, keine Sitzung kennt die Operation). Alt-Sperren ohne Besitzerangabe nur mit ohneBesitzerNachweis
 *    (USER-FREIGABE, REST-Route mit bestaetigt+grund) - nie automatisch und nie bloss nach Alter.
 *  - starteAssetSperrenRecovery(): API-Schleife (Takt scanIntervallMs) je freigegebenem Projekt, loest automatisch nur mit
 *    Besitzernachweis; letzter Stand je Projekt als Debug (letztePublishSperrenPruefungen).
 * SCHALTER (regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter 'asset_publish_recovery' (projekt > global,
 *   Standard AUS, nur ausdruecklich) + intern-Override gleichen Namens. AUS = Altverhalten (nur Pruefen/Anzeigen, nichts loesen).
 */
import { getPool } from '../db/client.js';
import { getAssetKonfiguration } from '../config/asset-konfig.js';
import type { AssetKonfiguration } from '../config/asset-konfig.js';
import { AssetSpeicher } from './asset-speicher.js';
import type { AssetOperation, AssetPublishSperreStand } from './asset-speicher.js';
import type { AssetUploadDb } from './asset-upload.js';
import { starteApiAuftragsLoop } from './api-auftrags-loop.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseProfilProduktSchalterGepuffert } from './agent-profil-schalter.js';

export const ASSET_PUBLISH_RECOVERY = 'asset_publish_recovery' as const;
type Db = Pick<AssetUploadDb, 'query'>;
const PROJEKT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;

export interface AssetPublishRecoverySchalter { aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; bis: string | null; letzter_fehler: string | null }

export async function leseAssetPublishRecoverySchalter(project: string | null): Promise<AssetPublishRecoverySchalter> {
  const p = await leseProfilProduktSchalterGepuffert(ASSET_PUBLISH_RECOVERY, project);
  const stand: AssetPublishRecoverySchalter = { aktiv: p.aktiv && !p.letzter_fehler, quelle: p.quelle, bis: null, letzter_fehler: p.letzter_fehler };
  if (!internToolAktiv()) return stand;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: "SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())",
      values: [ASSET_PUBLISH_RECOVERY], query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    if (z) return { aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? new Date(z.bis).toISOString() : null, letzter_fehler: null };
  } catch { return { ...stand, letzter_fehler: stand.letzter_fehler ?? 'intern_schalter_nicht_lesbar' }; }
  return stand;
}

/**
 * PG-Nachweis fuer eine staged-Operation: keine Upload-Sitzung kennt sie als publish_operation (sonst gehoert sie zur
 * prepared-Recovery), und keine Sitzung desselben Pfads bzw. des Besitzerauftrags finalisiert gerade mit gueltiger Lease.
 */
export async function publishOperationVerwaist(db: Db, project: string, op: Readonly<AssetOperation>): Promise<boolean> {
  const bekannt = (await db.query(
    "SELECT 1 FROM asset_upload_sitzungen WHERE bereich='projekt' AND ziel_ref=$1 AND publish_operation->>'id'=$2 LIMIT 1", [project, op.id])).rows;
  if (bekannt.length) return false;
  const aktiv = (await db.query(
    `SELECT 1 FROM asset_upload_sitzungen WHERE bereich='projekt' AND ziel_ref=$1 AND status='vollstaendig' AND finalisierer_bis>clock_timestamp()
       AND (logischer_pfad=$2 OR id::text=$3) LIMIT 1`, [project, op.adresse.logischer_pfad, op.besitzer?.auftrag?.id ?? ''])).rows;
  return aktiv.length === 0;
}

export interface PublishSperrePruefung extends AssetPublishSperreStand { project: string; geprueft_am: string }

export async function pruefePublishSperre(project: string, o: { db?: Db; speicher?: AssetSpeicher; konfiguration?: AssetKonfiguration;
  ausfuehren?: boolean; ohneBesitzerNachweis?: boolean } = {}): Promise<PublishSperrePruefung> {
  if (!PROJEKT.test(project)) throw new Error('Ungueltiger Projektname.');
  const db = o.db ?? (getPool() as unknown as Db), cfg = o.konfiguration ?? getAssetKonfiguration();
  const speicher = o.speicher ?? new AssetSpeicher({ konfiguration: cfg });
  const r = await speicher.publishSperre({ bereich: 'projekt', ziel_ref: project, storage_kind: 'assets', logischer_pfad: 'sperren-pruefung' }, {
    vorschau: !o.ausfuehren, ohneBesitzerNachweis: o.ohneBesitzerNachweis === true,
    istVerwaist: (op) => publishOperationVerwaist(db, project, op),
  });
  if (r.zustand === 'geloest') console.warn(`[asset-sperre] ${project}: verwaiste staged-Sperre ${r.owner} geloest (${r.logischer_pfad}).`);
  return { project, geprueft_am: new Date().toISOString(), ...r };
}

const LETZTE = new Map<string, PublishSperrePruefung>();
/** Debug: letzter Stand der automatischen Pruefung je Projekt. */
export function letztePublishSperrenPruefungen(): PublishSperrePruefung[] { return [...LETZTE.values()]; }

/** API-Schleife: automatisch nur mit Besitzernachweis (nie ohneBesitzerNachweis), nur Projekte mit Schalter EIN. */
export function starteAssetSperrenRecovery(o: { db?: Db; konfiguration?: AssetKonfiguration; speicher?: AssetSpeicher } = {}) {
  const cfg = o.konfiguration ?? getAssetKonfiguration();
  const db = o.db ?? (getPool() as unknown as Db), speicher = o.speicher ?? new AssetSpeicher({ konfiguration: cfg });
  return starteApiAuftragsLoop({
    intervallMs: cfg.sync.scanIntervallMs,
    arbeit: async () => {
      const rows = (await db.query('SELECT name FROM projects GROUP BY name HAVING bool_or(enabled)')).rows;
      for (const row of rows) {
        const p = String(row.name);
        if (!PROJEKT.test(p) || !(await leseAssetPublishRecoverySchalter(p)).aktiv) continue;
        try { LETZTE.set(p, await pruefePublishSperre(p, { db, konfiguration: cfg, speicher, ausfuehren: true })); }
        catch (e) { LETZTE.set(p, { project: p, geprueft_am: new Date().toISOString(), zustand: 'unklar', grund: (e as Error).message }); }
      }
    },
    fehler: (e) => console.error('[asset-sperre]', e),
  });
}
