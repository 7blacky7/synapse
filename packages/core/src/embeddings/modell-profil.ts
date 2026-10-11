/**
 * MODUL: Embedding-Modellprofil (P12-T4, P12-T6)
 * ZWECK: Zwei Dinge, die bisher fehlten und zu messbar schlechterer Suche gefuehrt haben:
 *
 * 1. PRAEFIXE (T4): Moderne Embedding-Modelle sind darauf trainiert, dass eine SUCHANFRAGE
 *    anders eingeleitet wird als ein gespeichertes DOKUMENT. Synapse hat beides gleich
 *    behandelt. Gemessen (Projekt embedding-vergleich, 09.10.2026): qwen3-embedding:8b
 *    Stichwortsuche MRR 69.1 ohne vs. 86.7 mit Instruct-Praefix; Nemotron/Gemma verlieren
 *    ohne Praefix 5-7 Punkte. Die Praefixe stehen in den Model-Cards der Modelle.
 *
 * 2. KENNUNG (T6): Welches Modell einen Vektor erzeugt hat, stand nirgends. Deshalb blieb der
 *    Wechsel Google -> Qwen (beide 3072d) unbemerkt und ~60 % der aelteren Memories/Thoughts
 *    tragen bis heute Vektoren des alten Modells (Befund 92009f99). Die Kennung wandert jetzt
 *    an jeden Qdrant-Punkt (Payload embedding_modell) und in embedding_collections.
 *
 * WICHTIG BEI QWEN: der Instruct-Praefix gehoert NUR an die Suchanfrage; Dokumente bleiben
 * unveraendert. Deshalb wirkt die Aenderung sofort, ohne Neu-Einbetten.
 * WICHTIG BEI NEMOTRON/GEMMA: auch Dokumente bekommen einen Praefix - das passt nur zu
 * Vektoren, die mit diesem Praefix erzeugt wurden (Re-Embedding P12-T12).
 *
 * UEBERSTEUERN (Env):
 *   EMBEDDING_PRAEFIXE=aus           schaltet beide Praefixe ab (altes Verhalten)
 *   EMBEDDING_QUERY_PREFIX=...       eigener Suchanfrage-Praefix (\n wird als Zeilenumbruch gelesen)
 *   EMBEDDING_DOC_PREFIX=...         eigener Dokument-Praefix
 */
import { getConfig } from '../config.js';

/** query = Suchanfrage (search*, Hooks, Duplikat-/Pattern-Abgleich); dokument = gespeicherter Inhalt. */
export type EmbedArt = 'query' | 'dokument';

interface Praefixe {
  query: string;
  dokument: string;
}

// Aufgabe fuer Instruct-Modelle (Qwen3-Embedding, Harrier): beschreibt WAS gesucht wird.
const AUFGABE_SYNAPSE =
  'Given a search query, retrieve relevant notes, decisions, code and documentation ' +
  'from a software project knowledge base that answer the query';

/** Profile nach Model-Card; Treffer per Teilstring im (kleingeschriebenen) Modellnamen. */
const PROFILE: Array<{ erkennt: (m: string) => boolean; praefixe: Praefixe }> = [
  {
    erkennt: (m) => m.includes('qwen3-embedding') || m.includes('harrier'),
    praefixe: { query: `Instruct: ${AUFGABE_SYNAPSE}\nQuery: `, dokument: '' },
  },
  {
    erkennt: (m) => m.includes('nemotron') && m.includes('embed'),
    praefixe: { query: 'query: ', dokument: 'passage: ' },
  },
  {
    erkennt: (m) => m.includes('embeddinggemma'),
    praefixe: { query: 'task: search result | query: ', dokument: 'title: none | text: ' },
  },
];

function envText(name: string): string | undefined {
  const wert = process.env[name];
  return wert === undefined ? undefined : wert.replace(/\\n/g, '\n');
}

/** Name des Text-Embedding-Modells, so wie der Provider es anspricht. */
export function embeddingModellName(): string {
  const cfg = getConfig().embeddings;
  if (cfg.provider === 'ollama') return process.env.OLLAMA_MODEL || cfg.ollama.model;
  return cfg.model || cfg.provider;
}

/** Praefixe fuer das aktive Modell (leer, wenn das Modell keine kennt oder abgeschaltet). */
export function aktivePraefixe(): Praefixe {
  if ((process.env.EMBEDDING_PRAEFIXE || '').toLowerCase() === 'aus') return { query: '', dokument: '' };
  const modell = embeddingModellName().toLowerCase();
  const profil = PROFILE.find((p) => p.erkennt(modell))?.praefixe ?? { query: '', dokument: '' };
  return {
    query: envText('EMBEDDING_QUERY_PREFIX') ?? profil.query,
    dokument: envText('EMBEDDING_DOC_PREFIX') ?? profil.dokument,
  };
}

/** Setzt den passenden Praefix vor den Text. Ohne Angabe gilt 'dokument' (sicherer Standard: Schreibwege). */
export function mitPraefix(text: string, art: EmbedArt = 'dokument'): string {
  const p = aktivePraefixe();
  const praefix = art === 'query' ? p.query : p.dokument;
  return praefix ? praefix + text : text;
}

/**
 * Kennung des Vektorraums: Provider, Modell, Zieldimension und Dokument-Praefix-Variante.
 * Zwei Vektoren sind nur vergleichbar, wenn ihre Kennungen gleich sind. Der Digest steht mit
 * drin, wenn er konfiguriert ist (Referenzvertrag SYNAPSE_OLLAMA_MODEL_DIGEST) - ein neu
 * quantisiertes Modell unter gleichem Namen ist ein anderer Vektorraum.
 */
export function embeddingModellKennung(): string {
  const cfg = getConfig().embeddings;
  const digest = (process.env.SYNAPSE_OLLAMA_MODEL_DIGEST || '').trim().toLowerCase().replace(/^sha256:/, '');
  const ziel = Number(process.env.EMBEDDING_TARGET_DIM) || 0;
  const dokPraefix = aktivePraefixe().dokument ? 'dokpraefix' : 'ohne-dokpraefix';
  return [
    `${cfg.provider}:${embeddingModellName()}`,
    digest ? `digest:${digest.slice(0, 12)}` : null,
    ziel ? `dim:${ziel}` : 'dim:nativ',
    dokPraefix,
  ].filter(Boolean).join('|');
}
