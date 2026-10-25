/**
 * P22-T165 (Entwurf ba4ebbc0, GO F1-F6): reine Logik fuer anklickbare Artefakte (ohne DOM testbar, keine Importe).
 *
 * VERWEIS: Ein Element mit data-synapse-verweis="<wert>" oder ein Link href="#verweis:<wert>" oeffnet in der Web-UI das
 *   Lesefenster (VerweisFensterProvider). Es laeuft KEIN Skript im Artefakt: den Klick faengt AgentRenderingSurface im Shadow-Root ab.
 *   <wert> = P22-T153 (task) | P22 (plan) | <art>:<id> fuer jede Art des Lesefensters (thought, memory, task, plan, doc, event,
 *   nachricht, chat, asset) | sonst freier Wert -> Aufloesung am Server (mehrere Treffer -> Auswahl).
 *   Projekt: data-synapse-projekt am Element oder einem Vorfahren (Vorlage: {{_meta.project}}), sonst das Projekt des Anzeigeorts.
 * ZUSTAND: Radio-/Checkbox-Auswahl und details[open] werden vor einer neuen Revision gemerkt und danach wiederhergestellt,
 *   damit eine CSS-Navigation (ein Radio je Plan) Live-Updates uebersteht.
 * Beides nur mit Produkt-Schalter artefakt_verweise (global, Standard AUS).
 */

export const VERWEIS_ARTEN = ['thought', 'memory', 'task', 'plan', 'doc', 'event', 'nachricht', 'chat', 'asset'] as const;
export type ArtefaktVerweisArt = typeof VERWEIS_ARTEN[number];
export const VERWEIS_HREF_PRAEFIX = '#verweis:';
export const VERWEIS_SELEKTOR = '[data-synapse-verweis],a[href^="#verweis:"]';
const WERT_MAX = 300;

export type VerweisZielRoh = { art: ArtefaktVerweisArt; id: string } | { art: null; text: string };

const kurzId = (s: string): string => (/^P\d+(-T\d+)?$/i.test(s) ? s.toUpperCase() : s);

/** Wert eines Verweises -> Ziel. null = leer/ungueltig. Rein. */
export function zerlegeVerweisWert(roh: string | null | undefined): VerweisZielRoh | null {
  let w = String(roh ?? '').trim();
  if (w.toLowerCase().startsWith(VERWEIS_HREF_PRAEFIX)) w = w.slice(VERWEIS_HREF_PRAEFIX.length);
  try { w = decodeURIComponent(w); } catch { /* bleibt roh */ }
  w = w.trim();
  if (!w || w.length > WERT_MAX) return null;
  const m = /^([a-z]+):(.*)$/i.exec(w);
  if (m && (VERWEIS_ARTEN as readonly string[]).includes(m[1].toLowerCase())) {
    const id = m[2].trim();
    return id ? { art: m[1].toLowerCase() as ArtefaktVerweisArt, id: kurzId(id) } : null;
  }
  if (/^P\d+-T\d+$/i.test(w)) return { art: 'task', id: w.toUpperCase() };
  if (/^P\d+$/i.test(w)) return { art: 'plan', id: w.toUpperCase() };
  return { art: null, text: w };
}

/** Minimales Element (DOM-Element oder Testattrappe). */
export interface VerweisElement {
  getAttribute(name: string): string | null;
  closest?(selektor: string): VerweisElement | null;
}

/** Roher Verweiswert eines Elements: data-synapse-verweis vor href="#verweis:...". */
export function verweisWertVon(el: VerweisElement): string | null {
  const d = el.getAttribute('data-synapse-verweis');
  if (d && d.trim()) return d;
  const href = el.getAttribute('href');
  return href && href.toLowerCase().startsWith(VERWEIS_HREF_PRAEFIX) ? href : null;
}

/** Projekt des Verweises: data-synapse-projekt am Element/Vorfahren vor dem Projekt des Anzeigeorts. */
export function verweisProjektVon(el: VerweisElement, anzeigeProjekt?: string | null): string | null {
  const eigen = el.closest?.('[data-synapse-projekt]')?.getAttribute('data-synapse-projekt')?.trim();
  const fallback = typeof anzeigeProjekt === 'string' ? anzeigeProjekt.trim() : '';
  return eigen || fallback || null;
}

// ───────────────────────── Zustand ueber Revisionen ─────────────────────────

export interface ArtefaktZustand { geprueft: Record<string, boolean>; offen: Record<string, boolean> }

interface EingabeLike { id: string; name: string; value: string; type: string; checked: boolean }
interface DetailsLike { id: string; open: boolean }
export interface ZustandWurzel { querySelectorAll(selektor: string): ArrayLike<unknown> }

/** Schluessel einer Eingabe: #id, sonst typ:name=wert, sonst typ@index. Rein. */
export function eingabeSchluessel(e: Pick<EingabeLike, 'id' | 'name' | 'value' | 'type'>, index: number): string {
  if (e.id) return '#' + e.id;
  if (e.name) return e.type + ':' + e.name + '=' + e.value;
  return e.type + '@' + index;
}
const detailsSchluessel = (d: DetailsLike, index: number): string => (d.id ? '#' + d.id : '@' + index);
const EINGABEN = 'input[type="radio"],input[type="checkbox"]';

/** Merkt Auswahl (Radio/Checkbox) und offene details eines Artefakts. */
export function merkeZustand(wurzel: ZustandWurzel): ArtefaktZustand {
  const z: ArtefaktZustand = { geprueft: {}, offen: {} };
  Array.from(wurzel.querySelectorAll(EINGABEN) as ArrayLike<EingabeLike>).forEach((e, i) => { z.geprueft[eingabeSchluessel(e, i)] = !!e.checked; });
  Array.from(wurzel.querySelectorAll('details') as ArrayLike<DetailsLike>).forEach((d, i) => { z.offen[detailsSchluessel(d, i)] = !!d.open; });
  return z;
}

/**
 * Stellt den gemerkten Zustand im neuen DOM wieder her (nur Elemente, die es noch gibt). Radios: nur die gewaehlten setzen (der
 * Browser loest die anderen der Gruppe). Rueckgabe: Zahl der geaenderten Elemente.
 */
export function stelleZustandHer(wurzel: ZustandWurzel, z: ArtefaktZustand): number {
  let n = 0;
  Array.from(wurzel.querySelectorAll(EINGABEN) as ArrayLike<EingabeLike>).forEach((e, i) => {
    const soll = z.geprueft[eingabeSchluessel(e, i)];
    if (soll === undefined || (e.type === 'radio' && !soll) || e.checked === soll) return;
    e.checked = soll;
    n++;
  });
  Array.from(wurzel.querySelectorAll('details') as ArrayLike<DetailsLike>).forEach((d, i) => {
    const soll = z.offen[detailsSchluessel(d, i)];
    if (soll === undefined || d.open === soll) return;
    d.open = soll;
    n++;
  });
  return n;
}
