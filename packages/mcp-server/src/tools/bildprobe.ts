/** P13-T14: Inline lokal; Einmal-Link und API-Kennungen brauchen den API-Prozess. */
import { BildprobeDienst, type BildprobeErgebnis } from '@synapse/core';
const lokal = new BildprobeDienst();
function fehler(error: string): BildprobeErgebnis {
  const payload = { success: false, error };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}
export async function fuehreStdioBildprobeAus(args: Record<string, unknown>): Promise<BildprobeErgebnis> {
  if (args.modus !== 'link' && !(typeof args.probe_id === 'string' && args.probe_id.startsWith('api.'))) {
    return lokal.ausfuehren(args);
  }
  const base = process.env.SYNAPSE_API_URL, token = process.env.SYNAPSE_API_TOKEN;
  if (!base || !token) return fehler('bildprobe_api_konfiguration_fehlt');
  let url: URL;
  try {
    url = new URL(base.replace(/\/+$/, '') + '/api/bildprobe');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error();
  } catch { return fehler('bildprobe_api_konfiguration_ungueltig'); }
  try {
    const r = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ modus: args.modus, probe_id: args.probe_id, wort: args.wort }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return fehler('bildprobe_api_http_fehler');
    const result = await r.json() as BildprobeErgebnis;
    if (!Array.isArray(result.content) || result.content.some(c => c.type !== 'text')) {
      return fehler('bildprobe_api_antwort_ungueltig');
    }
    return result;
  } catch { return fehler('bildprobe_api_nicht_erreichbar'); }
}
