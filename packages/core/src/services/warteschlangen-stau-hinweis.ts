/**
 * MODUL: Hinweis warteschlangen_stau (P27-T3, 31.10.2026; Vertrag P27-T1 thought 675edb08, Review 3345014e)
 * ZWECK: Baut das Antwortfeld warteschlangen_stau fuer ergaenzeToolHinweise (tool-antwort.ts, REST und stdio gleich).
 *        NUR aus dem Schnappschuss des Stau-Waechters (warteschlangen-stau-stand.ts): synchron, keine PG-/Netz-/Daemon-/
 *        Schalter-Abfrage, kein zustand(), kein Embedding. Einziger Import ist das Blattmodul. Nur Info, nie Blocker.
 *
 * EPISODEN je Agent (RAM, je Prozess):
 *   neu        Stau-Episode (Queue-Instanz + Beginn) zum ersten Mal fuer diesen Agenten.
 *   andauernd  dieselbe Episode, fruehestens nach stau_hinweis_wiederholung_minuten erneut.
 *   behoben    genau einmal je Instanz, wenn ein FRISCHER Schnappschuss dieselbe Instanz als 'gesund' zeigt. Schweigen,
 *              'unbekannt', 'nicht_zutreffend', fehlende Instanz (z. B. Bootwechsel) und alter Schnappschuss sind KEINE
 *              Erholung; solche Episoden verfallen nach EPISODE_TTL_MS still.
 *   Kein Verbrauch, wenn das Feld nicht ausgeliefert wird: Profil AUS (hinweisAktiv vor dem Aufruf), Produkt-Schalter AUS
 *   (Schnappschuss aktiv:false), Schnappschuss zu alt bzw. fehlend. Parallele Aufrufe: der Abschnitt ist synchron, eine
 *   Episode wird je Agent nie doppelt als 'neu' gemeldet. Neustart der API: RAM leer -> laufender Stau wird wieder 'neu'
 *   gemeldet (nach der Erstbeobachtung des Waechters), nie 'behoben'.
 * SICHTBARKEIT: Eintraege ohne Projekt (Prozess-/Systemwarteschlangen) fuer alle Agenten; Eintraege mit Projekt nur fuer
 *   dieses Projekt. Inhalt: Name, Ort, Host nur bei Daemon, Dauer, kurzer Grund (nur Zaehlwerte), Diagnoseweg - keine Pfade
 *   oder Jobdaten. Hoechstens stau_hinweis_max Stau-Eintraege, Texte gekuerzt. Folgestufen einer Pipeline (folge_von)
 *   erscheinen nicht.
 */

import { stauSchnappschuss } from './warteschlangen-stau-stand.js';

export interface StauHinweis {
  name: string;
  ort: string;
  status: 'neu' | 'andauernd' | 'behoben';
  seit_min: number | null;
  grund: string;
  diagnose: string;
  host?: string;
  projekt?: string;
}

interface Gemeldet {
  schluessel: string;
  zuletzt_mono: number;
  name: string;
  ort: string;
  host: string;
  projekt: string | null;
  diagnose: string;
}

interface AgentStand {
  /** Episode -> zuletzt gemeldet */
  gemeldet: Map<string, Gemeldet>;
  zuletzt_mono: number;
}

export const STAU_HINWEIS_AGENT_TTL_MS = 6 * 3600_000;
export const STAU_HINWEIS_EPISODE_TTL_MS = 24 * 3600_000;
const AGENTEN_MAX = 2000;
const BEHOBEN_MAX = 5;
const TEXT_MAX = 160;

const agenten = new Map<string, AgentStand>();
const kurz = (t: string): string => (t.length > TEXT_MAX ? t.slice(0, TEXT_MAX - 1) + '…' : t);

function aufraeumen(jetzt: number): void {
  for (const [id, a] of agenten) {
    if (jetzt - a.zuletzt_mono > STAU_HINWEIS_AGENT_TTL_MS) { agenten.delete(id); continue; }
    for (const [ep, g] of a.gemeldet) if (jetzt - g.zuletzt_mono > STAU_HINWEIS_EPISODE_TTL_MS) a.gemeldet.delete(ep);
  }
  while (agenten.size > AGENTEN_MAX) {
    const aeltester = [...agenten].sort((x, y) => x[1].zuletzt_mono - y[1].zuletzt_mono)[0];
    if (!aeltester) break;
    agenten.delete(aeltester[0]);
  }
}

/**
 * Hinweise fuer einen Agenten (bestaetigte Identitaet bzw. effektive Agent-ID). projekt = Projekt des Aufrufs (null = nur
 * projektlose Eintraege). Synchron, ohne I/O. Wirft nicht (der Aufrufer faengt trotzdem ab).
 */
export function holeStauHinweise(agentId: string, projekt: string | null | undefined, jetztMono: number = performance.now()): StauHinweis[] {
  const s = stauSchnappschuss();
  if (!agentId || !s || !s.aktiv) return [];
  if ((jetztMono - s.erstellt_mono_ms) / 1000 > s.max_alter_s) return [];
  aufraeumen(jetztMono);
  const p = projekt || null;
  const sichtbar = (e: { projekt: string | null }): boolean => e.projekt === null || (p !== null && e.projekt === p);
  const zusatz = (ort: string, host: string, proj: string | null): Pick<StauHinweis, 'host' | 'projekt'> => ({
    ...(ort === 'daemon' ? { host } : {}), ...(proj ? { projekt: proj } : {}),
  });
  const aus: StauHinweis[] = [];
  let a = agenten.get(agentId);

  // Erholung: genau einmal je Instanz, nur bei frischer Gesundmeldung derselben Instanz.
  if (a) {
    const gesund = new Set(s.eintraege.filter((e) => e.bewertung === 'gesund').map((e) => e.schluessel));
    const erledigt = new Set<string>();
    for (const [ep, g] of [...a.gemeldet]) {
      if (!gesund.has(g.schluessel)) continue;
      a.gemeldet.delete(ep);
      if (erledigt.has(g.schluessel)) continue;
      erledigt.add(g.schluessel);
      if (aus.length < BEHOBEN_MAX) {
        aus.push({ name: g.name, ort: g.ort, status: 'behoben', seit_min: null, grund: 'wieder Fortschritt', diagnose: kurz(g.diagnose), ...zusatz(g.ort, g.host, g.projekt) });
      }
    }
  }

  const staus = s.eintraege
    .filter((e) => e.bewertung === 'stau' && e.episode !== null && !e.folge_von && sichtbar(e))
    .sort((x, y) => (y.seit_min ?? 0) - (x.seit_min ?? 0));
  let gemeldet = 0;
  for (const e of staus) {
    if (gemeldet >= s.hinweis_max) break;
    const ep = e.episode as string;
    const alt = a?.gemeldet.get(ep);
    const status: StauHinweis['status'] | null = !alt ? 'neu' : jetztMono - alt.zuletzt_mono >= s.wiederholung_s * 1000 ? 'andauernd' : null;
    if (!status) continue;
    if (!a) {
      a = { gemeldet: new Map(), zuletzt_mono: jetztMono };
      agenten.set(agentId, a);
    }
    a.gemeldet.set(ep, { schluessel: e.schluessel, zuletzt_mono: jetztMono, name: e.name, ort: e.ort, host: e.host, projekt: e.projekt, diagnose: e.diagnose });
    aus.push({ name: e.name, ort: e.ort, status, seit_min: e.seit_min, grund: kurz(e.grund), diagnose: kurz(e.diagnose), ...zusatz(e.ort, e.host, e.projekt) });
    gemeldet++;
  }
  if (a) a.zuletzt_mono = jetztMono;
  return aus;
}

/** Nur fuer Tests: Episodenstand vergessen. */
export function vergissStauHinweise(): void {
  agenten.clear();
}

/** Diagnose: Anzahl Agenten/Episoden im RAM. */
export function stauHinweisStand(): { agenten: number; episoden: number } {
  let episoden = 0;
  for (const a of agenten.values()) episoden += a.gemeldet.size;
  return { agenten: agenten.size, episoden };
}
