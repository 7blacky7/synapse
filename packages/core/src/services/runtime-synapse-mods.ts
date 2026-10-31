/**
 * P22-T194 / f18b99fb, Freigabe 26.10.: verwaltete Runtime-Mods, Produktstandard AUS.
 * PG ist die Quelle; Env transportiert nur den autorisierten Stand zum naechsten CLI-Start.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
export const RUNTIME_SYNAPSE_MODS_FUNKTION = 'runtime_synapse_mods' as const;
export interface RuntimeModStand {
  aktiv: boolean; quelle: string; bis: string | null; letzter_fehler: string | null;
  produkt: { aktiv: boolean; quelle: string; letzter_fehler: string | null };
}
export async function leseRuntimeSynapseMods(project: string | null = null): Promise<RuntimeModStand> {
  let produkt: RuntimeModStand['produkt'] = { aktiv: false, quelle: 'standard', letzter_fehler: null };
  try {
    const p = await leseProfilProduktSchalter(RUNTIME_SYNAPSE_MODS_FUNKTION, project);
    produkt = { aktiv: p.aktiv && !p.letzter_fehler, quelle: p.quelle, letzter_fehler: p.letzter_fehler };
  } catch { produkt.letzter_fehler = 'runtime_mod_schalter_nicht_lesbar'; }
  const basis: RuntimeModStand = { ...produkt, bis: null, produkt };
  if (!internToolAktiv() || produkt.letzter_fehler) return basis;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date }>({
      text: "SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis IS NOT NULL AND bis>NOW()",
      values: [RUNTIME_SYNAPSE_MODS_FUNKTION], query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    return z ? { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis.toISOString() } : basis;
  } catch { return basis; }
}
export function runtimeModsUmgebung(stand: RuntimeModStand): Record<string, string> {
  return { SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND: JSON.stringify(stand) };
}
