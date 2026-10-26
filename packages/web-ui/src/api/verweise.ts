import { apiFetch } from './auth';
import { leseAnmerkungQuelle } from './quellenanmerkungen';

/** P8-T31: Verweise in Texten aufloesen (gebuendelt, gecacht) und als Klartext lesen. */
export type VerweisArt = 'thought' | 'memory' | 'task' | 'plan' | 'doc' | 'event' | 'nachricht' | 'chat' | 'asset' | 'artefakt';

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
  artefakt: 'Artefakt',
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

const laufend = new Map<string, Promise<void>>();

/**
 * Fragt nur unbekannte Kandidaten in EINEM Aufruf ab; Fehler lassen den Cache leer (kein falscher Link).
 * P22-T150: Was gerade schon abgefragt wird (Pfad-Link und Bildleiste derselben Nachricht), wird abgewartet statt doppelt gefragt.
 * true = es kam etwas in den Cache.
 */
export async function loeseVerweiseAuf(project: string, kandidaten: VerweisKandidat[]): Promise<boolean> {
  const neu: VerweisKandidat[] = [];
  const schluessel = new Set<string>();
  const warten = new Set<Promise<void>>();
  for (const k of kandidaten) {
    const s = cacheSchluessel(project, k);
    if (aufgeloest.has(s) || schluessel.has(s)) continue;
    const l = laufend.get(s);
    if (l) { warten.add(l); continue; }
    schluessel.add(s);
    neu.push(k);
  }
  if (!neu.length && !warten.size) return false;
  let anfrage: Promise<boolean> = Promise.resolve(false);
  if (neu.length) {
    anfrage = frageVerweise(project, neu);
    const fertig = anfrage.then(() => undefined, () => undefined);
    for (const s of schluessel) laufend.set(s, fertig);
    void fertig.then(() => { for (const s of schluessel) if (laufend.get(s) === fertig) laufend.delete(s); });
  }
  const [geaendert] = await Promise.all([anfrage, ...warten]);
  return geaendert || warten.size > 0;
}

async function frageVerweise(project: string, neu: VerweisKandidat[]): Promise<boolean> {
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
  // P22-T195: Artefakt-Lesefenster verwendet den authentifizierten User-Weg mit den bestehenden Artefakt-Rechten.
  if (art === 'artefakt') { const r = await leseAnmerkungQuelle(project, 'artefakt', id); return {art,id:r.quelle.id,titel:r.quelle.titel,meta:[],text:r.quelle.text}; }
  const schluessel = project + '|' + art + '|' + id;
  const bekannt = inhalte.get(schluessel);
  if (bekannt) return bekannt;
  const response = await apiFetch('/api/projects/' + encodeURIComponent(project) + '/verweise/' + art + '/' + encodeURIComponent(id));
  const data = await response.json().catch(() => ({})) as { verweis?: VerweisInhalt; error?: { message?: string } };
  if (!response.ok || !data.verweis) throw new Error(data.error?.message || ART_LABEL[art] + ' ' + id + ' nicht gefunden');
  inhalte.set(schluessel, data.verweis);
  return data.verweis;
}
