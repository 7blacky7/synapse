/**
 * models.dev — gemeinschaftlich gepflegte Datenbank mit Modell-Eigenschaften.
 *
 * Warum das hier steht: die wenigsten Anbieter verraten in ihrem eigenen
 * /models-Katalog, wie gross das Kontextfenster ist, was ein Token kostet oder
 * ob das Modell Werkzeuge aufrufen kann. OpenCode liefert vier Felder, NVIDIA
 * ebenfalls. models.dev kennt zu denselben Modellen Kontext, Kosten,
 * Faehigkeiten, Modalitaeten und Abkuendigungsstatus.
 *
 * Arbeitsteilung, die wir bewusst so halten:
 *   - Der Katalog des Anbieters bestimmt, WELCHE Modelle es gibt und
 *     tatsaechlich erreichbar sind.
 *   - models.dev beschreibt, WIE diese Modelle beschaffen sind.
 * Umgekehrt waere es falsch: models.dev ist gemeinschaftlich gepflegt und kann
 * einem Anbieter hinterherhinken oder Eintraege fuehren, die dein Zugang gar
 * nicht bedient.
 *
 * Robustheit: der Datensatz ist rund 4 MB. Er wird auf Platte zwischengelagert
 * und im Zweifel veraltet ausgeliefert, waehrend im Hintergrund erneuert wird —
 * ein Ausfall von models.dev darf die Modellsuche nie blockieren.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MODELS_DEV_URL = process.env.SYNAPSE_MODELS_DEV_URL || 'https://models.dev/api.json';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const FEHLER_SPERRE_MS = 5 * 60 * 1000;
const ABRUF_TIMEOUT_MS = 60_000;

function cachePfad(): string {
  const basis = process.env.SYNAPSE_CACHE_DIR || join(homedir(), '.synapse');
  return join(basis, 'models-dev.json');
}

// ---------------------------------------------------------------------------
// Typen — nur die Felder, die wir wirklich auswerten
// ---------------------------------------------------------------------------

export interface ModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  description?: string;
  /** USD je 1 Mio. Token. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  tool_call?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  /** Anhaenge, also Bilder/Dateien im Eingang. */
  attachment?: boolean;
  temperature?: boolean;
  open_weights?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  /** Vorhanden und "deprecated", wenn der Anbieter das Modell abkuendigt. */
  status?: string;
  modalities?: { input?: string[]; output?: string[] };
  /** Welche Reasoning-Stufen der Anbieter akzeptiert — sonst gibt es 400er. */
  reasoning_options?: Array<{ type?: string; values?: string[] }>;
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  /** Basis-URL des Anbieters. */
  api?: string;
  /** Uebliche Namen der Umgebungsvariablen fuer das Credential. */
  env?: string[];
  doc?: string;
  npm?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevRegistry = Record<string, ModelsDevProvider>;

// ---------------------------------------------------------------------------
// Zwischenspeicher
// ---------------------------------------------------------------------------

let registry: ModelsDevRegistry | null = null;
let registryZeit = 0;
let etag: string | null = null;
let sperreBis = 0;
let laufenderAbruf: Promise<ModelsDevRegistry | null> | null = null;

interface PlattenCache {
  etag: string | null;
  fetchedAt: number;
  data: ModelsDevRegistry;
}

async function ladeVonPlatte(): Promise<PlattenCache | null> {
  try {
    const roh = JSON.parse(await readFile(cachePfad(), 'utf8')) as PlattenCache;
    // Ein leerer oder kaputter Cache wird verworfen statt als "keine Modelle"
    // ausgeliefert — sonst verschwinden stillschweigend alle Eigenschaften.
    if (!roh || typeof roh !== 'object' || !roh.data || Object.keys(roh.data).length === 0) return null;
    return roh;
  } catch {
    return null;
  }
}

async function schreibeAufPlatte(cache: PlattenCache): Promise<void> {
  try {
    const pfad = cachePfad();
    await mkdir(dirname(pfad), { recursive: true });
    await writeFile(pfad, JSON.stringify(cache), 'utf8');
  } catch {
    // Ohne Schreibrecht laeuft alles weiter, nur eben ohne Plattencache.
  }
}

async function holeVomNetz(): Promise<ModelsDevRegistry | null> {
  const kopf: Record<string, string> = { Accept: 'application/json' };
  // Solange wir etwas Auslieferbares haben, fragen wir bedingt an: eine
  // Antwort "304 nicht geaendert" bestaetigt den Bestand ohne 4 MB Download.
  if (etag && registry) kopf['If-None-Match'] = etag;

  const antwort = await fetch(MODELS_DEV_URL, {
    headers: kopf,
    signal: AbortSignal.timeout(ABRUF_TIMEOUT_MS),
  });

  if (antwort.status === 304 && registry) {
    registryZeit = Date.now();
    return registry;
  }
  if (!antwort.ok) throw new Error('models.dev antwortete mit HTTP ' + antwort.status);

  const daten = (await antwort.json()) as ModelsDevRegistry;
  if (!daten || typeof daten !== 'object' || Object.keys(daten).length === 0) {
    throw new Error('models.dev lieferte einen leeren Datensatz');
  }

  etag = antwort.headers.get('etag');
  registry = daten;
  registryZeit = Date.now();
  await schreibeAufPlatte({ etag, fetchedAt: registryZeit, data: daten });
  return daten;
}

/**
 * Liefert den Datensatz. Nie blockierend laenger als noetig: ist etwas
 * vorhanden, wird es ausgeliefert und im Hintergrund erneuert. `null` bedeutet,
 * dass es weder Speicher- noch Plattenstand gibt und das Netz nicht erreichbar
 * war — dann laeuft die Modellsuche eben ohne angereicherte Eigenschaften.
 */
export async function getModelsDev(options: { force?: boolean } = {}): Promise<ModelsDevRegistry | null> {
  const frisch = registry !== null && Date.now() - registryZeit < CACHE_TTL_MS;
  if (frisch && !options.force) return registry;

  if (registry === null) {
    const platte = await ladeVonPlatte();
    if (platte) {
      registry = platte.data;
      registryZeit = platte.fetchedAt;
      etag = platte.etag;
      // Alter Plattenstand: ausliefern und nur im Hintergrund erneuern.
      if (Date.now() - registryZeit < CACHE_TTL_MS && !options.force) return registry;
    }
  }

  if (!options.force && Date.now() < sperreBis) return registry;
  if (laufenderAbruf && !options.force) return laufenderAbruf;

  laufenderAbruf = holeVomNetz()
    .catch((fehler) => {
      // Fehlschlag sperrt neue Versuche kurz, damit nicht jeder Aufruf ins
      // Netz rennt. Vorhandene Daten bleiben gueltig.
      sperreBis = Date.now() + FEHLER_SPERRE_MS;
      if (registry === null) {
        console.warn('[models.dev] nicht erreichbar, Modell-Eigenschaften fehlen: ' + (fehler as Error).message);
      }
      return registry;
    })
    .finally(() => {
      laufenderAbruf = null;
    });

  // Mit vorhandenem Bestand nicht auf das Netz warten.
  return registry ?? laufenderAbruf;
}

// ---------------------------------------------------------------------------
// Nachschlagen
// ---------------------------------------------------------------------------

/**
 * Sucht ein Modell im Datensatz. `providerIds` erlaubt mehrere Kandidaten,
 * weil unsere Anbieter-Kennungen nicht immer denen von models.dev entsprechen
 * (bei uns "opencode-free", dort "opencode").
 */
export function findeModel(
  daten: ModelsDevRegistry | null,
  providerIds: string[],
  modelId: string,
): ModelsDevModel | null {
  if (!daten) return null;
  // OpenRouter haengt Varianten mit Doppelpunkt an ("...:free"), models.dev
  // fuehrt sie teils ohne. Beide Schreibweisen probieren.
  const kandidaten = [modelId, modelId.split(':')[0]];

  for (const providerId of providerIds) {
    const modelle = daten[providerId]?.models;
    if (!modelle) continue;
    for (const kandidat of kandidaten) {
      const treffer = modelle[kandidat];
      if (treffer) return treffer;
    }
  }
  return null;
}

/** Alle Anbieter-Kennungen des Datensatzes — fuer Diagnose und Abgleich. */
export function listeProviderIds(daten: ModelsDevRegistry | null): string[] {
  return daten ? Object.keys(daten).sort() : [];
}
