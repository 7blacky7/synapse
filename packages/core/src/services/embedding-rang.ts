/** P22-T193: Dokumentklassen der bestehenden Queue; Suchanfragen bleiben interaktiv. */
export type EmbeddingKlasse = 'interaktiv' | 'code' | 'wissen' | 'verlauf';
export function embeddingKlasse(source: string | undefined, priority: string, art?: string): EmbeddingKlasse {
  if (art === 'query') return 'interaktiv';
  if (source === 'verlauf') return 'verlauf';
  if (source?.startsWith('wissen')) return 'wissen';
  if (source === 'parser-worker' || source === 'compute-node') return 'code';
  return priority === 'interactive' || priority === 'interaktiv' ? 'interaktiv' : 'code';
}
export const EMBEDDING_RANG: Record<EmbeddingKlasse, number> = { interaktiv: 0, code: 1, wissen: 2, verlauf: 3 };
/** Quelle stammt aus dem gebundenen Request, keine neue ResourceDomain oder Client-Rolle. */
export const EMBEDDING_ADMISSION_RANG_SQL = `CASE
 WHEN source='verlauf' THEN 3
 WHEN source LIKE 'wissen%' THEN 2
 WHEN source IN ('parser-worker','compute-node') THEN 1
 ELSE GREATEST(0,(CASE priority WHEN 'interaktiv' THEN 0 WHEN 'hintergrund' THEN 1 ELSE 2 END)
   -FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-queued_at))*1000/$2)) END`;
