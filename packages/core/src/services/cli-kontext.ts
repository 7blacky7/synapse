/**
 * P22-T75: Kontextfenster eines Modells aus der CLI-Liste des Runtime-Containers (Codex: models_cache.json, Claude: Modellkatalog).
 * Die REST-API haengt hier ihre Auslese ein (agent-runtimes.ts); core selbst kennt keinen Container. Ohne Quelle oder ohne
 * Treffer: null, und der Aufrufer rechnet sichtbar mit dem Rueckfall (quelle 'fallback').
 */
export type CliKontextQuelle = (modell: string) => Promise<number | null>;

let quelle: CliKontextQuelle | null = null;

export function setzeCliKontextQuelle(q: CliKontextQuelle | null): void {
  quelle = q;
}

export async function cliKontextFenster(modell: string): Promise<number | null> {
  if (!quelle) return null;
  try {
    const n = await quelle(modell);
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}
