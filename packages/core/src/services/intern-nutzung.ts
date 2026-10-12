/**
 * Read-only Nutzungsstatistik fuer das interne Diagnose-Tool.
 * Liefert ausschliesslich gruppierte Zaehler; args_preview und Ergebnisse werden nie ausgegeben.
 */
import { getPool } from '../db/client.js';

export interface NutzungsStatistikOptionen {
  seit?: string;
  bis?: string;
  bucket?: 'stunde' | 'tag';
  agent_ids?: string[];
  tools?: string[];
  project?: string;
  limit?: number;
  vergleich_seit?: string;
  vergleich_bis?: string;
}

interface NutzungsZeile {
  bucket: Date | string;
  agent_id: string | null;
  tool: string;
  action: string | null;
  anzahl: number;
}

function datum(value: string | undefined, fallback: Date, feld: string): Date {
  if (value === undefined) return fallback;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${feld}: ISO-Zeitpunkt erwartet.`);
  return new Date(ms);
}

async function gruppen(
  von: Date,
  bis: Date,
  opt: NutzungsStatistikOptionen,
  bucket: 'hour' | 'day',
  limit: number,
): Promise<{ rows: NutzungsZeile[]; gekappt: boolean }> {
  const { rows } = await getPool().query<NutzungsZeile>(
    `SELECT date_trunc($6, ts) AS bucket, agent_id, tool_name AS tool, action,
            count(*)::int AS anzahl
       FROM tool_calls
      WHERE ts >= $1 AND ts < $2
        AND ($3::text IS NULL OR project = $3)
        AND ($4::text[] IS NULL OR agent_id = ANY($4))
        AND ($5::text[] IS NULL OR tool_name = ANY($5))
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2 NULLS LAST, 3, 4 NULLS LAST
      LIMIT $7`,
    [von, bis, opt.project ?? null, opt.agent_ids?.length ? opt.agent_ids : null, opt.tools?.length ? opt.tools : null, bucket, limit + 1],
  );
  const gekappt = rows.length > limit;
  const ausgewaehlt = rows.slice(0, limit).map((r) => ({
    ...r,
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : new Date(r.bucket).toISOString(),
  }));
  return { rows: ausgewaehlt, gekappt };
}

export async function nutzungsStatistik(opt: NutzungsStatistikOptionen = {}): Promise<Record<string, unknown>> {
  const jetzt = new Date();
  const bis = datum(opt.bis, jetzt, 'bis');
  const seit = datum(opt.seit, new Date(bis.getTime() - 24 * 60 * 60 * 1000), 'seit');
  if (seit >= bis) throw new Error('seit muss vor bis liegen.');
  const bucket = opt.bucket ?? 'tag';
  if (bucket !== 'tag' && bucket !== 'stunde') throw new Error('bucket: tag | stunde.');
  const limit = Math.max(1, Math.min(Math.floor(opt.limit ?? 200), 500));
  const unit = bucket === 'stunde' ? 'hour' : 'day';
  const aktuell = await gruppen(seit, bis, opt, unit, limit);
  const antwort: Record<string, unknown> = {
    zeitraum: { seit: seit.toISOString(), bis: bis.toISOString() },
    gruppierung: bucket,
    nutzung: aktuell.rows,
    gekappt: aktuell.gekappt,
  };

  if (opt.vergleich_seit !== undefined || opt.vergleich_bis !== undefined) {
    if (opt.vergleich_seit === undefined || opt.vergleich_bis === undefined) {
      throw new Error('vergleich_seit und vergleich_bis muessen gemeinsam angegeben werden.');
    }
    const vorherSeit = datum(opt.vergleich_seit, jetzt, 'vergleich_seit');
    const vorherBis = datum(opt.vergleich_bis, jetzt, 'vergleich_bis');
    if (vorherSeit >= vorherBis) throw new Error('vergleich_seit muss vor vergleich_bis liegen.');
    const vorher = await gruppen(vorherSeit, vorherBis, opt, unit, limit);
    const zaehle = (rows: NutzungsZeile[]) => {
      const map = new Map<string, number>();
      for (const row of rows) {
        const key = JSON.stringify([row.agent_id, row.tool, row.action]);
        map.set(key, (map.get(key) ?? 0) + row.anzahl);
      }
      return map;
    };
    const alt = zaehle(vorher.rows);
    const neu = zaehle(aktuell.rows);
    const keys = new Set([...alt.keys(), ...neu.keys()]);
    const differenz = [...keys].map((key) => {
      const [agent_id, tool, action] = JSON.parse(key) as [string | null, string, string | null];
      const vorher_anzahl = alt.get(key) ?? 0;
      const aktuell_anzahl = neu.get(key) ?? 0;
      return { agent_id, tool, action, vorher: vorher_anzahl, aktuell: aktuell_anzahl, differenz: aktuell_anzahl - vorher_anzahl };
    }).sort((a, b) => Math.abs(b.differenz) - Math.abs(a.differenz));
    antwort.vergleich = {
      zeitraum: { seit: vorherSeit.toISOString(), bis: vorherBis.toISOString() },
      nutzung: vorher.rows,
      gekappt: vorher.gekappt,
      differenz,
    };
  }
  return antwort;
}
