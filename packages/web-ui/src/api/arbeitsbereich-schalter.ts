import { apiFetch } from './auth';

/** P22-T253: Feature-Schalter; ein fehlender Stand oder Lesefehler bedeutet AUS. */
export interface ArbeitsbereichSchalter { aktiv: boolean; quelle: string; fehler: string | null }
export async function leseArbeitsbereichSchalter(project: string, funktion = 'web_ui_arbeitsbereich'): Promise<ArbeitsbereichSchalter> {
  try {
    const r = await apiFetch('/api/projects/' + encodeURIComponent(project || 'synapse') + '/agent-profile/schalter');
    const d = await r.json();
    if (!r.ok || d.success === false || !Array.isArray(d.schalter)) throw new Error('Schalter nicht lesbar');
    const s = d.schalter.find((v: {funktion?: string}) => v.funktion === funktion);
    if (!s) throw new Error('Schalter fehlt');
    return { aktiv: s.aktiv === true && !s.letzter_fehler, quelle: s.quelle || 'standard', fehler: s.letzter_fehler || null };
  } catch (e) { return { aktiv: false, quelle: 'fehler', fehler: e instanceof Error ? e.message : String(e) }; }
}
