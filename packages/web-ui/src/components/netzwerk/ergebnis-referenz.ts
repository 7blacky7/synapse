/** P22-T255: Quellen nur aus belegten IDs ableiten. */
export const objekt = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function dekodiere(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}
export function idAus(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) { const v = o[k]; if ((typeof v === 'string' || typeof v === 'number') && String(v)) return String(v); }
  return '';
}
export function originalVerweis(tool: string, args: unknown, result: unknown): {art: 'thought'|'memory'|'plan'|'nachricht'; id: string} | null {
  const a = objekt(dekodiere(args)), r = objekt(dekodiere(result));
  const kind = tool === 'thought' ? 'thought' : tool === 'memory' ? 'memory' : tool === 'plan' ? 'plan' : tool === 'channel' ? 'nachricht' : null;
  if (!kind) return null;
  const nested = objekt(r[kind]);
  const keys = kind === 'nachricht' ? ['message_id','messageId'] : kind === 'memory' ? ['name','id'] : kind === 'plan' ? ['plan_id','id'] : ['thought_id','id'];
  const id = idAus(r,...keys) || idAus(nested,...keys) || idAus(a,...keys);
  return id ? {art:kind, id} : null;
}
