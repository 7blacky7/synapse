import { apiFetch } from './auth';

/** P8-T31: Verweise in Texten aufloesen (gebuendelt, gecacht) und als Klartext lesen. */
export type VerweisArt = 'thought' | 'memory' | 'task' | 'plan' | 'doc' | 'event' | 'nachricht' | 'chat' | 'asset';

export interface VerweisTreffer {
  art: VerweisArt;
  id: string;
  titel: string;
}

export interface VerweisKandidat {
  text: string;
  hinweis?: 'event' | 'nachricht' | 'chat' | 'memory' | 'asset';
}

export interface VerweisInhalt {
  art: VerweisArt;
  id: string;
  titel: string;
  meta: Array<{ label: string; wert: string }>;
  text: string;
}

export const ART_LABEL: Record<VerweisArt, string> = {
  thought: 'Thought',
  memory: 'Memory',
  task: 'Task',
  plan: 'Plan',
  doc: 'Doku',
  event: 'Event',
  nachricht: 'Channel-Nachricht',
  chat: 'Chat-Nachricht',
  asset: 'Bild',
};

export function kandidatSchluessel(k: VerweisKandidat): string {
  return (k.hinweis ?? '') + '|' + k.text;
}

const aufgeloest = new Map<string, VerweisTreffer[]>();
const inhalte = new Map<string, VerweisInhalt>();

function cacheSchluessel(project: string, k: VerweisKandidat): string {
  return project + '|' + kandidatSchluessel(k);
}

/** Bereits bekannte Treffer (leeres Array = gefragt, nicht gefunden; undefined = noch nicht gefragt). */
export function bekannteTreffer(project: string, k: VerweisKandidat): VerweisTreffer[] | undefined {
  return aufgeloest.get(cacheSchluessel(project, k));
}

/** Fragt nur unbekannte Kandidaten in EINEM Aufruf ab; Fehler lassen den Cache leer (kein falscher Link). */
export async function loeseVerweiseAuf(project: string, kandidaten: VerweisKandidat[]): Promise<boolean> {
  const neu = kandidaten.filter((k) => !aufgeloest.has(cacheSchluessel(project, k)));
  if (!neu.length) return false;
  const response = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/verweise/aufloesen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kandidaten: neu }),
  });
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({})) as { ergebnisse?: Array<{ text: string; treffer: VerweisTreffer[] }> };
  const ergebnisse = data.ergebnisse ?? [];
  neu.forEach((k, index) => {
    const e = ergebnisse[index];
    if (e) aufgeloest.set(cacheSchluessel(project, k), e.treffer ?? []);
  });
  return true;
}

export async function ladeVerweis(project: string, art: VerweisArt, id: string): Promise<VerweisInhalt> {
  const schluessel = project + '|' + art + '|' + id;
  const bekannt = inhalte.get(schluessel);
  if (bekannt) return bekannt;
  const response = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/verweise/' + art + '/' + encodeURIComponent(id));
  const data = await response.json().catch(() => ({})) as { verweis?: VerweisInhalt; error?: { message?: string } };
  if (!response.ok || !data.verweis) throw new Error(data.error?.message || ART_LABEL[art] + ' ' + id + ' nicht gefunden');
  inhalte.set(schluessel, data.verweis);
  return data.verweis;
}
