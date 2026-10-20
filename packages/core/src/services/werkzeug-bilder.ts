/**
 * P22-T67: Bilder aus Werkzeugergebnissen (reine Funktionen, gemeinsam fuer die Driver der API und den Wrapper-Spiegel).
 *
 * Liefert ein Synapse-Tool ein Bild (code_intel file / asset_intel inspect mit ansicht:'inline'), steht es im Ergebnis als
 * image-Block mit Base64. Das Base64 gehoert weder in den Strom noch in den Verlauf: es wird durch eine Zeile
 * '[Bild <typ>, <groesse>]' ersetzt, gespeichert wird nur ein VERWEIS auf das Asset (project + file_path + revision + Masse).
 * Die Web-UI laedt das Bild ueber GET /api/main-agent/tool-bild nach (hauptagent-bilder.ts rendereToolBild).
 * Nutzer: rest-api agent-runtime/werkzeug-bilder.ts (claude-/codex-driver), agents verlauf-melden.ts (Session-JSONL).
 */
import type { VerlaufBild } from './hauptagent-verlauf.js';

/** Hoechstzahl Bilder je Werkzeugschritt (Schutz gegen Ausreisser). */
const BILDER_MAX = 8;

interface BildBlock { mime: string; bytes: number }

function bildBlock(wert: unknown): BildBlock | null {
  if (!wert || typeof wert !== 'object') return null;
  const o = wert as Record<string, unknown>;
  if (o.type !== 'image') return null;
  const quelle = o.source && typeof o.source === 'object' ? o.source as Record<string, unknown> : o;
  const daten = typeof quelle.data === 'string' ? quelle.data : '';
  const mime = [quelle.media_type, quelle.mimeType, quelle.mime_type, o.mimeType].find((m) => typeof m === 'string' && m) as string | undefined;
  return { mime: mime ?? 'image/png', bytes: Math.floor((daten.length * 3) / 4) };
}

/** Bloecke eines Ergebnisses: Array direkt oder Objekt mit content-Array (Codex: item.result.content). */
function bloecke(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  const inner = content && typeof content === 'object' ? (content as Record<string, unknown>).content : undefined;
  return Array.isArray(inner) ? inner : [];
}

/** Bildbloecke eines Werkzeugergebnisses als Metadaten (ohne Daten). */
export function werkzeugBilder(content: unknown): VerlaufBild[] {
  return bloecke(content).map(bildBlock).filter((b): b is BildBlock => b !== null).slice(0, BILDER_MAX)
    .map((b) => ({ mime_type: b.mime, bytes: b.bytes }));
}

/** Ergebnis ohne Bilddaten: jeder image-Block wird zu einem Textblock mit Typ und Groesse. */
export function ohneBilddaten(content: unknown): unknown {
  const ersetze = (teil: unknown): unknown => {
    const b = bildBlock(teil);
    return b ? { type: 'text', text: '[Bild ' + b.mime + ', ' + Math.max(1, Math.round(b.bytes / 1024)) + ' KB]' } : teil;
  };
  if (Array.isArray(content)) return content.map(ersetze);
  if (content && typeof content === 'object' && Array.isArray((content as Record<string, unknown>).content)) {
    const o = content as Record<string, unknown>;
    return { ...o, content: (o.content as unknown[]).map(ersetze) };
  }
  return content;
}

const zeichen = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const zahl = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);

/**
 * Asset-Verweis aus dem Aufruf: code_intel(file)/asset_intel(inspect) tragen project + file_path in den Argumenten;
 * Revision und Masse stehen (falls das Ergebnis nicht gekuerzt wurde) in ansicht.inline der Antwort.
 */
export function bildVerweisAusAufruf(name: string | undefined, input: unknown, output: string | undefined): Partial<VerlaufBild> {
  if (!name || !/(^|__|\.)(code_intel|asset_intel)$/.test(name)) return {};
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : null;
  const project = zeichen(args?.project);
  const file_path = zeichen(args?.file_path);
  if (!project || !file_path) return {};
  const verweis: Partial<VerlaufBild> = { project, file_path };
  try {
    const antwort = JSON.parse((output ?? '').split('\n… (gekuerzt)')[0]) as Record<string, unknown>;
    const ansicht = antwort.ansicht && typeof antwort.ansicht === 'object' ? antwort.ansicht as Record<string, unknown> : null;
    const inline = ansicht?.inline && typeof ansicht.inline === 'object' ? ansicht.inline as Record<string, unknown> : null;
    const revision = inline?.revision === undefined ? undefined : String(inline.revision);
    if (revision && /^[1-9][0-9]*$/.test(revision)) verweis.revision = revision;
    const breite = zahl(inline?.breite);
    const hoehe = zahl(inline?.hoehe);
    if (breite) verweis.breite = breite;
    if (hoehe) verweis.hoehe = hoehe;
  } catch {
    // Ergebnis gekuerzt oder kein JSON: Verweis ohne Revision/Masse (die Route nimmt dann die aktuelle Revision).
  }
  return verweis;
}
