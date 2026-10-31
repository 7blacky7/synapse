/**
 * P22-T238 / P22-T236 (User 31.10.2026, thoughts 4d6e67d6, 54ff9ce7, 5eae0647): Schalter-Lesestelle der Projekt-Asset-Grundsaetze.
 *
 * asset_transfer_generisch (P22-T238): Projekt-Assets ohne zustaendigen asset_intel-Inspector (z. B. avif, bmp, woff2, ttf)
 *   werden als generisches Binaer-Asset (Hash, Groesse, Endung als Format) auf den Share uebertragen und sind als Original
 *   oeffenbar. AUS = nur Formate mit Inspector. Lesestellen: AssetUploadKern.erstellen, AssetKonfliktKern (PC-Uebernahme),
 *   REST GET .../assets/sync-optionen (Daemon-Policy generischeFormate + generisch_debug).
 * asset_index_wirklichkeit (P22-T236): 'Index = Wirklichkeit'. EIN = asset_intel-Abfragen und die code_intel-Weiche zeigen nur
 *   VORHANDENE Projekt-Assets (ohne deleted_at, ohne quelle_nicht_gefunden; intel-bereich.ts), der Daemon meldet lokal
 *   entfernte Assets ohne Share-Bytes (POST .../assets/quelle-fehlt) und intern asset_altbestand_bereinigen darf ausfuehren.
 *   AUS = Altverhalten. Lesestellen: asset-intel-abfragen.ts mitLeser/assetHealth, asset-weiche.ts, routes/assets.ts,
 *   asset-altbestand.ts.
 *
 * SCHALTER (regel-neue-funktionen-mit-schalter-und-debug), je Funktion gleich:
 *   (I) Produkt-Schalter (agent_profil_schalter, projekt > global, Standard AUS, nur ausdruecklich - 'alle' schaltet ihn
 *       nicht). Setzen: admin profil_schalter_setzen bzw. Web-UI (User/Koordinator).
 *   (II) intern-Override gleichen Namens, modus 'freigegeben' (nur SYNAPSE_INTERN_TOOL=1, befristet).
 *   AUS / Lesefehler = Altverhalten. Gelesen ueber den Prozess-Puffer (kernTtlMs).
 * DEBUG: Stand mit quelle (standard | produkt-schalter | intern), bis und letzter_fehler.
 */
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseProfilProduktSchalterGepuffert } from './agent-profil-schalter.js';

export const ASSET_TRANSFER_GENERISCH = 'asset_transfer_generisch' as const;
export const ASSET_INDEX_WIRKLICHKEIT = 'asset_index_wirklichkeit' as const;
export type AssetGrundsatzSchalter = typeof ASSET_TRANSFER_GENERISCH | typeof ASSET_INDEX_WIRKLICHKEIT;

export interface AssetTransferGenerischStand {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}
export type AssetSchalterStand = AssetTransferGenerischStand;

async function leseAssetSchalter(funktion: AssetGrundsatzSchalter, project: string): Promise<AssetSchalterStand> {
  const produkt = await leseProfilProduktSchalterGepuffert(funktion, project);
  const stand: AssetSchalterStand = {
    aktiv: produkt.aktiv && !produkt.letzter_fehler,
    quelle: produkt.quelle,
    bis: null,
    letzter_fehler: produkt.letzter_fehler,
  };
  if (!internToolAktiv()) return stand;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: "SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())",
      values: [funktion],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    if (z) return { aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? new Date(z.bis).toISOString() : null, letzter_fehler: null };
  } catch {
    // Lesefehler des Overrides: der Produktionswert bleibt wirksam, der Fehler wird sichtbar.
    return { ...stand, letzter_fehler: stand.letzter_fehler ?? 'intern_schalter_nicht_lesbar' };
  }
  return stand;
}

/** P22-T238: generischer Transfer (Formate ohne Inspector). */
export function leseAssetTransferGenerisch(project: string): Promise<AssetTransferGenerischStand> {
  return leseAssetSchalter(ASSET_TRANSFER_GENERISCH, project);
}

/** P22-T236: Index = Wirklichkeit (nur vorhandene Assets sichtbar, Meldung lokal entfernter Assets, Altbestand). */
export function leseAssetIndexWirklichkeit(project: string): Promise<AssetSchalterStand> {
  return leseAssetSchalter(ASSET_INDEX_WIRKLICHKEIT, project);
}
