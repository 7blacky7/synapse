/**
 * P22-T190: EINE PG-Lesestelle fuer CLI-Ausgabelimits (alle Container-Rollen); keine Secrets.
 * P22-T287 S4: ziel (nur ausdruecklich; Daemon-Start agent_start mit der GESTARTETEN Identitaet) - Schalter runtime_tool_ausgabe mit
 *   Ebenen je Agent und Werte je Agent (ZIEL_EINSTELLUNG_BEREICHE.runtime_tool_ausgabe) ueber dem globalen Wert; nur bei
 *   schalter_identitaet EIN, sonst Bestand. quellen nennt identitaet|agent|typ, ziel_fehler bei Lesefehler. Wirkung beim naechsten Lauf.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { leseZielWerte, type SchalterZiel } from './agent-profil-schalter-ziel.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseRuntimeUeberwachungEinstellungen, RUNTIME_UEBERWACHUNG_EINSTELLUNGEN } from './runtime-ueberwachung.js';
import type { ToolAusgabeStand, ToolAusgabeWerte } from './runtime-tool-ausgabe-regeln.js';
export const RUNTIME_TOOL_AUSGABE_FUNKTION = 'runtime_tool_ausgabe' as const;
const NAMEN = ['claude_mcp_output_tokens', 'codex_tool_output_tokens', 'tool_ausgabe_kontext_prozent', 'tool_ausgabe_guard_sekunden', 'api_tool_output_tokens'] as const;
export async function leseRuntimeToolAusgabe(project: string | null = null, ziel: SchalterZiel | null = null): Promise<ToolAusgabeStand> {
  const stand: ToolAusgabeStand = {
    schalter: { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null },
    werte: Object.fromEntries(NAMEN.map(n => [n, RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[n].standard])) as unknown as ToolAusgabeWerte,
    quellen: Object.fromEntries(NAMEN.map(n => [n, 'standard'])) as ToolAusgabeStand['quellen'],
  };
  try {
    const s = await leseProfilProduktSchalter(RUNTIME_TOOL_AUSGABE_FUNKTION, project, ziel);
    stand.schalter = { aktiv: s.aktiv && !s.letzter_fehler, quelle: s.quelle, bis: null, letzter_fehler: s.letzter_fehler, ...(s.ziel_ebene ? { ziel_ebene: s.ziel_ebene } : {}) };
    const e = await leseRuntimeUeberwachungEinstellungen();
    for (const n of NAMEN) { stand.werte[n] = e[n].wert; stand.quellen[n] = e[n].quelle; }
    // P22-T287 S4: Werte je Agent (nur innerhalb der Grenzen des globalen Werts; sonst bleibt der globale Wert).
    if (ziel && project) {
      const zw = await leseZielWerte('runtime_tool_ausgabe', project, ziel);
      for (const n of NAMEN) {
        const t = zw.werte[n];
        const d = RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[n];
        if (t && t.wert >= d.min && t.wert <= d.max) { stand.werte[n] = t.wert; stand.quellen[n] = t.ziel_ebene; }
      }
      if (zw.fehler) stand.ziel_fehler = zw.fehler;
    }
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
