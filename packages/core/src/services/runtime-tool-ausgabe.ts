/** P22-T190: EINE PG-Lesestelle fuer CLI-Ausgabelimits (alle Container-Rollen); keine Secrets. */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseRuntimeUeberwachungEinstellungen, RUNTIME_UEBERWACHUNG_EINSTELLUNGEN } from './runtime-ueberwachung.js';
import type { ToolAusgabeStand, ToolAusgabeWerte } from './runtime-tool-ausgabe-regeln.js';
export const RUNTIME_TOOL_AUSGABE_FUNKTION = 'runtime_tool_ausgabe' as const;
const NAMEN = ['claude_mcp_output_tokens', 'codex_tool_output_tokens', 'tool_ausgabe_kontext_prozent', 'tool_ausgabe_guard_sekunden'] as const;
export async function leseRuntimeToolAusgabe(project: string | null = null): Promise<ToolAusgabeStand> {
  const stand: ToolAusgabeStand = {
    schalter: { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null },
    werte: Object.fromEntries(NAMEN.map(n => [n, RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[n].standard])) as unknown as ToolAusgabeWerte,
    quellen: Object.fromEntries(NAMEN.map(n => [n, 'standard'])) as ToolAusgabeStand['quellen'],
  };
  try {
    const s = await leseProfilProduktSchalter(RUNTIME_TOOL_AUSGABE_FUNKTION, project);
    stand.schalter = { aktiv: s.aktiv && !s.letzter_fehler, quelle: s.quelle, bis: null, letzter_fehler: s.letzter_fehler };
    const e = await leseRuntimeUeberwachungEinstellungen();
    for (const n of NAMEN) { stand.werte[n] = e[n].wert; stand.quellen[n] = e[n].quelle; }
  } catch { stand.schalter.aktiv = false; stand.schalter.letzter_fehler = 'tool_ausgabe_nicht_lesbar'; }
  // Nur befristete Testfreigabe; ohne intern-Tool, nach Ablauf/Lesefehler gilt der Produktwert.
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date }>({
        text: "SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis IS NOT NULL AND bis>NOW()",
        values: [RUNTIME_TOOL_AUSGABE_FUNKTION], query_timeout: 2000,
      } as import('pg').QueryConfig & { query_timeout: number });
      const z = r.rows[0];
      if (z && !stand.schalter.letzter_fehler) stand.schalter = { aktiv: z.aktiv, quelle: 'intern', bis: z.bis.toISOString(), letzter_fehler: null };
    } catch { /* Produktstand bleibt */ }
  }
  return stand;
}
