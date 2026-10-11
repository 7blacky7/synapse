/**
 * MODUL: Ollama-Modellinfo (P15-T1)
 * ZWECK: Liest die Werte des aktiven Embedding-Modells aus dem Ollama des Servers, statt sie als
 *        Zahl/Name im Code zu fuehren (Regel regel-keine-festverdrahteten-modellwerte):
 *   - digest, groesseBytes   aus GET  /api/tags (Eintrag des Modells)
 *   - vramBytes              aus GET  /api/ps   (nur wenn das Modell geladen ist: size_vram)
 *   - nativeDimension        aus POST /api/show model_info["<arch>.embedding_length"]
 *   - kontextLaenge          aus POST /api/show model_info["<arch>.context_length"]
 *   - quantisierung          aus POST /api/show details.quantization_level
 *
 * Jede Quelle einzeln: faellt eine aus, ist nur ihr Feld null (der Aufrufer meldet, was fehlt).
 * Zwischenspeicher je URL+Modell, kurz (SYNAPSE_OLLAMA_INFO_TTL_MS, Standard 60 s) — der
 * Referenzvertrag wird bei jedem Heartbeat/Claim gebraucht, Ollama soll nicht jedes Mal gefragt werden.
 * Nur vollstaendig gelieferte Antworten (keine Quelle ausgefallen) werden gemerkt.
 */

import { getConfig } from '../config.js';
import { embeddingModellName } from './modell-profil.js';

export interface OllamaModellInfo {
  modell: string;
  /** voller sha256 (64 hex, ohne Praefix) laut /api/tags */
  digest: string | null;
  groesseBytes: number | null;
  /** belegter VRAM laut /api/ps; null, wenn das Modell gerade nicht geladen ist */
  vramBytes: number | null;
  nativeDimension: number | null;
  kontextLaenge: number | null;
  quantisierung: string | null;
  /** Quellen, die nicht geantwortet haben (tags, ps, show) */
  ausgefallen: string[];
}

interface TagModell { name: string; model?: string; digest?: string; size?: number }
interface PsModell { name: string; model?: string; size_vram?: number }
interface ShowAntwort { model_info?: Record<string, unknown>; details?: { quantization_level?: string } }

/** Ohne Tag meint Ollama :latest. */
const normal = (name: string): string => (name.includes(':') ? name : `${name}:latest`);
const gleich = (a: string, b: string): boolean => normal(a) === normal(b);

const zwischenspeicher = new Map<string, { info: OllamaModellInfo; bis: number }>();

/** Fuer Tests und nach einem Modellwechsel. */
export function vergissOllamaModellInfo(): void {
  zwischenspeicher.clear();
}

function ttlMs(): number {
  const n = Number(process.env.SYNAPSE_OLLAMA_INFO_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

async function hole<T>(basis: string, pfad: string, body?: unknown): Promise<T> {
  const antwort = await fetch(basis + pfad, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  if (!antwort.ok) throw new Error(`Ollama ${pfad} -> HTTP ${antwort.status}`);
  return (await antwort.json()) as T;
}

function positiveZahl(wert: unknown): number | null {
  const n = Number(wert);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Wert aus model_info: erst "<general.architecture>.<feld>", sonst der erste Schluessel auf ".<feld>". */
function ausModelInfo(info: Record<string, unknown> | undefined, feld: string): number | null {
  if (!info) return null;
  const arch = typeof info['general.architecture'] === 'string' ? info['general.architecture'] : null;
  if (arch && positiveZahl(info[`${arch}.${feld}`]) !== null) return positiveZahl(info[`${arch}.${feld}`]);
  const schluessel = Object.keys(info).find((k) => k.endsWith(`.${feld}`));
  return schluessel ? positiveZahl(info[schluessel]) : null;
}

/**
 * Werte des Modells aus Ollama. Ohne Angabe: das aktive Embedding-Modell (embeddingModellName)
 * am Ollama der Config.
 */
export async function ollamaModellInfo(
  optionen: { url?: string; modell?: string } = {},
): Promise<OllamaModellInfo> {
  const basis = (optionen.url ?? getConfig().embeddings.ollama.url).replace(/\/+$/, '');
  const modell = optionen.modell ?? embeddingModellName();
  const schluessel = `${basis}|${normal(modell)}`;
  const gemerkt = zwischenspeicher.get(schluessel);
  if (gemerkt && gemerkt.bis > Date.now()) return gemerkt.info;

  const ausgefallen: string[] = [];
  const [tags, ps, show] = await Promise.all([
    hole<{ models?: TagModell[] }>(basis, '/api/tags').catch(() => { ausgefallen.push('tags'); return null; }),
    hole<{ models?: PsModell[] }>(basis, '/api/ps').catch(() => { ausgefallen.push('ps'); return null; }),
    hole<ShowAntwort>(basis, '/api/show', { model: modell }).catch(() => { ausgefallen.push('show'); return null; }),
  ]);

  const tag = tags?.models?.find((m) => gleich(m.name, modell) || (m.model !== undefined && gleich(m.model, modell)));
  const geladen = ps?.models?.find((m) => gleich(m.name, modell) || (m.model !== undefined && gleich(m.model, modell)));
  const digest = (tag?.digest ?? '').trim().toLowerCase().replace(/^sha256:/, '');

  const info: OllamaModellInfo = {
    modell,
    digest: /^[a-f0-9]{64}$/.test(digest) ? digest : null,
    groesseBytes: positiveZahl(tag?.size),
    vramBytes: positiveZahl(geladen?.size_vram),
    nativeDimension: ausModelInfo(show?.model_info, 'embedding_length'),
    kontextLaenge: ausModelInfo(show?.model_info, 'context_length'),
    quantisierung: show?.details?.quantization_level?.trim() || null,
    ausgefallen,
  };
  if (ausgefallen.length === 0) zwischenspeicher.set(schluessel, { info, bis: Date.now() + ttlMs() });
  return info;
}
