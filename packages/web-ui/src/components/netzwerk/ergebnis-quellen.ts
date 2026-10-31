import { apiFetch } from '../../api/auth';
import { ladeVerweis } from '../../api/verweise';
import { objekt, dekodiere, idAus, originalVerweis } from './ergebnis-referenz';

/** P22-T255: Audit ist ein möglicher Rückfall; Originalquellen nur anhand belegter IDs öffnen. */
export type Detail = { quelle: string; wert: unknown; hinweis?: string };
async function json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await apiFetch(url, init); const data = await r.json();
  if (!r.ok || data.success === false) throw new Error('Quelle HTTP ' + r.status);
  return data as Record<string, unknown>;
}
async function shellLog(project: string, id: string): Promise<Detail> {
  let from = 1, total = 1, text = '', hinweis = '';
  while (from <= total) {
    const d = await json('/api/shell', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'log',project,id,from_line:from,to_line:from+999})});
    const lines = Array.isArray(d.lines) ? d.lines : [];
    text += (text ? '\n' : '') + lines.join('\n');
    total = Number(d.total_lines ?? 0);
    if (d.gekuerzte_zeilen || ['luecke','unvollstaendig','grenze'].includes(String(d.ausgabe_stand))) hinweis = 'Die Shell-Quelle meldet gekürzte Zeilen oder eine unvollständige Ausgabe.';
    const next = Number(objekt(d.naechster_bereich).from_line ?? Number(d.to_line) + 1);
    if (!lines.length || !Number.isFinite(next) || next <= from) { if (from <= total) hinweis = 'Die Shell-Ausgabe konnte nicht vollständig geladen werden.'; break; }
    from = next;
  }
  const job = await json('/api/shell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'get',id})});
  if (objekt(job.job).output_truncated === true) hinweis = 'Die gespeicherte Shell-Ausgabe ist unvollständig.';
  return {quelle:'Shell-Log',wert:text,hinweis:hinweis || undefined};
}
export async function ladeNetzErgebnis(project: string, id: string): Promise<Detail> {
  const d = await json('/api/projects/'+encodeURIComponent(project)+'/tool-calls/'+encodeURIComponent(id));
  const c = objekt(d.call), tool = String(c.tool_name ?? ''), result = c.result ?? c.error ?? c.result_preview ?? '';
  try {
    if (tool === 'files') {
      const a = objekt(dekodiere(c.args_preview)), r = objekt(dekodiere(result));
      const version = idAus(r,'version_id') || idAus(a,'version_id');
      const plan = idAus(r,'plan_id') || idAus(a,'plan_id');
      const art = version ? 'version' : plan ? 'plan' : '';
      if (art) { const d = await json('/api/projects/'+encodeURIComponent(project)+'/netzwerk-original/'+art+'/'+encodeURIComponent(version || plan)); return {quelle:String(d.quelle),wert:d.wert}; }
    }
    if (tool === 'shell') {
      const a = objekt(dekodiere(c.args_preview)), r = objekt(dekodiere(result));
      const job = idAus(r,'job_id','id') || idAus(objekt(r.job),'id') || idAus(a,'id');
      if (job) return await shellLog(project,job);
    }
    const ref = originalVerweis(tool,c.args_preview,result);
    if (ref) {
      const v = await ladeVerweis(project,ref.art,ref.id);
      return {quelle:'Originalquelle: '+v.titel, wert:v.text};
    }
  } catch { /* Quelle nicht verfügbar: Audit mit sichtbarem Hinweis statt leerem Fenster. */ }
  const gekuerzt = c.result_truncated === true;
  const groesse = typeof c.result === 'string' ? Math.ceil(new TextEncoder().encode(c.result).length / 1024) : 0;
  return {quelle:'Audit · tool_calls',wert:dekodiere(result),hinweis:gekuerzt ? 'Audit gekürzt auf etwa '+groesse+' KB; Originalquelle nicht verfügbar.' : 'Originalquelle nicht verfügbar; gespeichertes Audit-Ergebnis.'};
}
