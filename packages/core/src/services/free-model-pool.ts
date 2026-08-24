/**
 * Free-Model-Pool: Katalog externer API-Modelle, die Synapse zusaetzlich zu
 * Claude/Codex ansprechen kann.
 *
 * Grundgedanke: Synapse pflegt KEINE Modelllisten. Gepflegt wird nur die
 * Endpunkt-Registry (Basis-URL, Auth-Schema, ENV-Name) — die Modelle selbst
 * kommen live aus dem Katalog des jeweiligen Anbieters.
 *
 * Das Credential ist der Schluessel zur Erkennung: es bestimmt, welche Modelle
 * ueberhaupt sichtbar sind. Die Free/Paid-Einordnung ist danach eine Eigenschaft
 * je Modellzeile, die gefiltert und sortiert werden kann.
 *
 * Bewusst NICHT enthalten: eine Ausweich-Logik auf teurere Modelle. Wer nach
 * kostenlosen Modellen fragt und keine bekommt, bekommt eine leere Liste —
 * niemals ersatzweise ein kostenpflichtiges.
 */

import { readFileSync } from 'node:fs';

import { getModelsDev, findeModel, type ModelsDevModel, type ModelsDevRegistry } from './models-dev.js';
import type { ClassifiedFailure } from './free-model-pool-errors.js';
import {
  ladeZustand,
  speichereAnbieter,
  speichereSperre,
  loescheSperre,
  synchronisiereModelle,
  setzeFreigabe,
} from './free-model-pool-store.js';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

/** Wie der Katalog des Anbieters aufgebaut ist. */
export type WireFormat = 'openai' | 'gemini';

/** Wie das Credential mitgeschickt wird. */
export type AuthScheme = 'bearer' | 'query-key' | 'none';

/**
 * Art des kostenlosen Zugangs. Wichtig: `signup_credit` ist vorab aufgeladenes
 * Guthaben, das nach Verbrauch nahtlos in Pay-as-you-go uebergeht — deshalb ein
 * eigener Typ und nicht `recurring`.
 */
export type FreeType = 'recurring' | 'uncapped' | 'signup_credit' | 'keyless' | 'paid';

export interface ProviderEntry {
  /** Kurzname, zugleich Praefix der Modell-Referenz. */
  id: string;
  label: string;
  /** Basis-URL fuer Inferenz-Requests (ohne abschliessenden Slash). */
  baseUrl: string;
  /** Pfad der Modellliste, relativ zur Basis-URL. */
  modelsPath: string;
  wire: WireFormat;
  auth: AuthScheme;
  /** Name der Umgebungsvariablen mit dem API-Key. */
  envVar: string;
  freeType: FreeType;
  /** Wo man einen Schluessel bekommt — nur zur Anzeige. */
  signupUrl?: string;
  /** Kurzer Hinweis fuer die Anzeige (ToS, Besonderheiten). */
  note?: string;
  /**
   * Zusaetzliche Header fuer jeden Aufruf. Ein leerer Wert unterdrueckt den
   * Header aktiv — OpenCode Free lehnt jeden Bearer ab, den es nicht kennt.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Namensmuster, an denen dieser Anbieter kostenlose Modelle kennzeichnet.
   * OpenRouter benutzt ":free", OpenCode "-free". Wird nur geprueft, wenn der
   * Katalog keine Preise liefert — Preisangaben haben immer Vorrang.
   */
  freeSuffixes?: string[];
  /**
   * Katalog ist auch ohne gueltiges Credential lesbar. Dann beweist ein
   * erfolgreicher Katalogabruf NICHT, dass Inferenz erlaubt ist (NVIDIA gibt
   * 200 auf /models und 403 auf /chat/completions).
   */
  catalogPublic?: boolean;
  /**
   * Kennungen desselben Anbieters bei models.dev, falls sie von unserer
   * abweichen. Unsere "opencode-free" heisst dort schlicht "opencode".
   */
  modelsDevIds?: string[];
  enabled: boolean;
}

export type CostClass = 'free' | 'paid' | 'unknown';

/**
 * Ob ein Modell tatsaechlich aufrufbar ist — nicht, ob es im Katalog steht.
 * Der Unterschied ist bei NVIDIA schmerzhaft konkret: /models antwortet mit
 * 200, /chat/completions mit 403.
 */
export type Reachability =
  /** Nachweislich aufrufbar: Probe erfolgreich, oder der Katalog verlangte selbst ein Credential. */
  | 'ready'
  /** Katalog oeffentlich, Aufruf nie bestaetigt — kann beim ersten echten Request scheitern. */
  | 'unverified'
  /** Aufruf nachweislich abgelehnt (Berechtigung, Credential, Sperre). */
  | 'blocked'
  /** Kein Credential hinterlegt, der Anbieter verlangt aber eines. */
  | 'no_credential';

export interface PoolModel {
  /** Eindeutige Referenz ueber alle Anbieter: "<provider>/<modelId>". */
  ref: string;
  provider: string;
  /** Modell-ID genau so, wie sie in einen Request gehoert. */
  modelId: string;
  name?: string;
  /** Modellfamilie laut models.dev, z.B. "nemotron" — Grundlage der Kurznamen. */
  family: string | null;
  costClass: CostClass;
  /** USD je 1 Mio. Token; null wenn der Anbieter keine Preise liefert. */
  priceInPerMTok: number | null;
  priceOutPerMTok: number | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** Erkannte Faehigkeiten: tools | vision | reasoning | structured | audio. */
  capabilities: string[];
  inputModalities: string[];
  /** Basis-URL fuer den Aufruf — direkt verwendbar. */
  baseUrl: string;
  wire: WireFormat;
  freeType: FreeType;
  /** Ob der Aufruf dieses Modells realistisch gelingt. */
  reachability: Reachability;
  /** Klartext-Begruendung, wenn die Erreichbarkeit nicht 'ready' ist. */
  reachabilityNote: string | null;
  /**
   * Ob dieses Modell benutzt werden darf.
   * Kostenlose sind es von sich aus; alles andere braucht eine ausdrueckliche
   * Freigabe. Eine gespeicherte Entscheidung ueberstimmt beides — auch nach unten.
   */
  allowed: boolean;
  /** Woher die Erlaubnis kommt: Standardregel oder ausdrueckliche Entscheidung. */
  allowedSource: 'default' | 'explicit';
  /** Laeuft eine Sperre, endet sie zu diesem Zeitpunkt (ISO). */
  cooldownUntil: string | null;
  /** Warum der Kandidat pausiert. */
  cooldownReason: string | null;
  /** Vom Anbieter abgekuendigt — laeuft heute noch, morgen vielleicht nicht. */
  deprecated: boolean;
  /** Erlaubte Reasoning-Stufen; andere Werte quittiert der Anbieter mit 400. */
  reasoningEfforts: string[];
  /** Woher Kontext, Kosten und Faehigkeiten stammen. */
  metadataSource: 'provider' | 'models.dev' | 'none';
}

export interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  freeType: FreeType;
  baseUrl: string;
  envVar: string;
  /** Ob ein Credential gefunden wurde — der Wert selbst wird nie ausgegeben. */
  credentialPresent: boolean;
  modelCount: number;
  freeCount: number;
  error: string | null;
  reachability: Reachability;
  reachabilityNote: string | null;
  /** Zeitpunkt der letzten Probe, falls eine lief. */
  probedAt: string | null;
  signupUrl?: string;
  note?: string;
}

export interface PoolSnapshot {
  models: PoolModel[];
  providers: ProviderStatus[];
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Endpunkt-Registry
//
// Das ist die einzige von Hand gepflegte Liste. Sie beschreibt Tueren, keine
// Inhalte: Basis-URL, Katalogpfad, Auth-Schema, ENV-Name. Ein neuer Anbieter ist
// ein Eintrag, kein Code.
//
// Stand der Endpunkt-Pruefung: 2026-08-24.
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY: ProviderEntry[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_OPENROUTER_API_KEY',
    freeType: 'recurring',
    signupUrl: 'https://openrouter.ai/keys',
    note: 'Katalog auch ohne Schluessel lesbar. Liefert Preise, Kontext, Modalitaeten und Parameter — beste Datenlage. Modelle mit Suffix ":free" sind kostenlos.',
    freeSuffixes: [':free'],
    catalogPublic: true,
    modelsDevIds: ['openrouter'],
    defaultHeaders: { 'HTTP-Referer': 'https://synapse.local', 'X-Title': 'Synapse' },
    enabled: true,
  },
  {
    // Verifiziert am 2026-08-24: echte Inferenz ohne jedes Credential.
    // Der Relay antwortet auf einen unbekannten Bearer mit 401, deshalb darf
    // hier gar kein Authorization-Header gesetzt werden (auth: 'none').
    id: 'opencode-free',
    label: 'OpenCode Free',
    baseUrl: 'https://opencode.ai/zen/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'none',
    envVar: '',
    freeType: 'keyless',
    note: 'Kostenlose Modelle des OpenCode-Zen-Relays, ohne Konto nutzbar. Katalog nennt keine Preise; kostenlose Modelle tragen das Suffix "-free". Gepruefte Ausnahmen: "big-pickle" ist an den User-Agent der OpenCode-CLI gebunden, "muse-spark-1.2-contributor-free" erlaubt dem Anbieter das Training auf Prompts und Antworten — beide nicht verwenden.',
    freeSuffixes: ['-free'],
    catalogPublic: true,
    modelsDevIds: ['opencode', 'opencode-go'],
    defaultHeaders: { 'HTTP-Referer': 'https://synapse.local', 'X-Title': 'Synapse' },
    enabled: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_GROQ_API_KEY',
    freeType: 'recurring',
    signupUrl: 'https://console.groq.com',
    note: 'Freier Tarif mit Ratenbegrenzung. Katalog nur mit Schluessel lesbar.',
    enabled: true,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_CEREBRAS_API_KEY',
    freeType: 'recurring',
    signupUrl: 'https://cloud.cerebras.ai',
    note: 'Freier Tarif mit Ratenbegrenzung, sehr niedrige Latenz.',
    enabled: true,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_MISTRAL_API_KEY',
    freeType: 'recurring',
    signupUrl: 'https://console.mistral.ai',
    note: 'Groesster dokumentierter kostenloser Kontingentpool; der Katalog unterscheidet frei und kostenpflichtig nicht selbst.',
    enabled: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_NVIDIA_API_KEY',
    freeType: 'signup_credit',
    signupUrl: 'https://build.nvidia.com',
    note: 'Katalog ohne Schluessel lesbar, liefert aber weder Preise noch Kontextlaengen — alle Zeilen landen in "unknown". Achtung: /models antwortet auch ohne Berechtigung mit 200, waehrend /chat/completions 403 liefert, solange die Organisation die Freigabe "Public API Endpoints" nicht hat (bekanntes Verifizierungsproblem bei build.nvidia.com).',
    catalogPublic: true,
    enabled: true,
  },
  {
    id: 'gemini',
    label: 'Google AI Studio (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelsPath: '/models',
    wire: 'gemini',
    auth: 'query-key',
    envVar: 'FREEPOOL_GEMINI_API_KEY',
    freeType: 'recurring',
    signupUrl: 'https://aistudio.google.com/apikey',
    note: 'Eigenes Katalogformat. Fuer Inferenz gibt es zusaetzlich einen OpenAI-kompatiblen Pfad unter /v1beta/openai.',
    enabled: true,
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_SAMBANOVA_API_KEY',
    freeType: 'recurring',
    signupUrl: 'https://cloud.sambanova.ai',
    note: 'Katalog ohne Schluessel lesbar und mit Preisen — dadurch sauber einzuordnen.',
    enabled: true,
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_SILICONFLOW_API_KEY',
    freeType: 'uncapped',
    note: 'Dauerhaft kostenlose Modelle ohne veroeffentlichte Obergrenze, aber ratenbegrenzt.',
    enabled: true,
  },
  {
    id: 'zai',
    label: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_ZAI_API_KEY',
    freeType: 'uncapped',
    note: 'GLM-Flash-Modelle dauerhaft kostenlos.',
    enabled: true,
  },
  {
    id: 'cohere',
    label: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    modelsPath: '/models',
    wire: 'openai',
    auth: 'bearer',
    envVar: 'FREEPOOL_COHERE_API_KEY',
    freeType: 'recurring',
    signupUrl: 'https://dashboard.cohere.com',
    note: 'Testschluessel mit Ratenbegrenzung; OpenAI-kompatibler Pfad.',
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Credentials
//
// Reihenfolge: Prozess-Umgebung, dann optionale Datei aus FREEPOOL_ENV_FILE.
// Der Wert wird nur intern benutzt und nie in ein Ergebnis geschrieben.
// ---------------------------------------------------------------------------

let dateiCache: Record<string, string> | null = null;

function ladeEnvDatei(): Record<string, string> {
  if (dateiCache) return dateiCache;
  dateiCache = {};
  const pfad = process.env.FREEPOOL_ENV_FILE;
  if (!pfad) return dateiCache;
  try {
    // Ein von manchen Editoren geschriebenes BOM klebt sonst am Namen der
    // ersten Variablen, die damit nie gefunden wird.
    const inhalt = readFileSync(pfad, 'utf8').replace(/^﻿/, '');
    for (const zeile of inhalt.split('\n')) {
      const treffer = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(zeile.trim());
      if (!treffer) continue;
      const wert = treffer[2].trim().replace(/^["']|["']$/g, '');
      if (wert) dateiCache[treffer[1]] = wert;
    }
  } catch {
    // Keine oder unlesbare Datei ist kein Fehler — dann gilt nur die Umgebung.
  }
  return dateiCache;
}

function credential(provider: ProviderEntry): string | null {
  const ausUmgebung = process.env[provider.envVar];
  if (ausUmgebung && ausUmgebung.trim()) return ausUmgebung.trim();
  const ausDatei = ladeEnvDatei()[provider.envVar];
  return ausDatei && ausDatei.trim() ? ausDatei.trim() : null;
}

/** Verwirft den Datei-Cache, damit ein nachgetragener Schluessel sofort greift. */
export function invalidiereCredentialCache(): void {
  dateiCache = null;
}

// ---------------------------------------------------------------------------
// Katalog-Abruf
// ---------------------------------------------------------------------------

const ABRUF_TIMEOUT_MS = 20_000;

interface RohModell {
  [key: string]: unknown;
}

async function holeKatalog(provider: ProviderEntry, key: string | null): Promise<RohModell[]> {
  const kopf: Record<string, string> = { Accept: 'application/json' };
  let url = provider.baseUrl + provider.modelsPath;

  // Leere Werte sind Absicht: sie unterdruecken einen Header, statt ihn zu setzen.
  for (const [name, wert] of Object.entries(provider.defaultHeaders ?? {})) {
    if (wert) kopf[name] = wert;
  }
  if (provider.auth === 'bearer' && key) kopf.Authorization = 'Bearer ' + key;
  if (provider.auth === 'query-key' && key) url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);

  const abbruch = AbortSignal.timeout(ABRUF_TIMEOUT_MS);
  const antwort = await fetch(url, { headers: kopf, signal: abbruch });
  if (!antwort.ok) {
    const text = (await antwort.text()).slice(0, 200).replace(/\s+/g, ' ');
    throw new Error('HTTP ' + antwort.status + (text ? ': ' + text : ''));
  }
  const koerper = (await antwort.json()) as Record<string, unknown>;
  const liste = koerper.data ?? koerper.models;
  if (!Array.isArray(liste)) throw new Error('Katalog enthaelt keine Modell-Liste');
  return liste as RohModell[];
}

// ---------------------------------------------------------------------------
// Normalisierung
// ---------------------------------------------------------------------------

function zahl(wert: unknown): number | null {
  if (typeof wert === 'number' && Number.isFinite(wert)) return wert;
  if (typeof wert === 'string' && wert.trim() !== '') {
    const n = Number(wert);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Verwirft offensichtlich falsche Preise.
 *
 * Nicht jeder Katalog meint dasselbe mit seinen Zahlen: manche nennen den Preis
 * je Token, manche bereits je Million. Wer das verwechselt, liegt um den Faktor
 * einer Million daneben. Ein Preis jenseits von 10.000 USD je Million Token ist
 * kein Preis, sondern ein Einheitenfehler — und lieber "unbekannt" als eine
 * falsche Kostenklasse, die eine Freigabe-Entscheidung verdirbt.
 */
function plausiblerPreis(wert: number | null): number | null {
  if (wert === null || !Number.isFinite(wert) || wert < 0) return null;
  return wert <= 10_000 ? wert : null;
}

function textArray(wert: unknown): string[] {
  return Array.isArray(wert) ? wert.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Faehigkeiten aus den Angaben des Anbieters ableiten. Liefert der Katalog
 * nichts, bleibt die Liste leer — geraten wird nicht.
 */
function faehigkeiten(roh: RohModell, inputModalities: string[]): string[] {
  const gefunden = new Set<string>();
  const parameter = new Set(textArray(roh.supported_parameters));

  if (parameter.has('tools') || parameter.has('tool_choice')) gefunden.add('tools');
  if (parameter.has('reasoning') || parameter.has('include_reasoning')) gefunden.add('reasoning');
  if (parameter.has('structured_outputs') || parameter.has('response_format')) gefunden.add('structured');
  if (inputModalities.includes('image')) gefunden.add('vision');
  if (inputModalities.includes('audio')) gefunden.add('audio');

  // Gemini beschreibt Faehigkeiten ueber die unterstuetzten Methoden.
  const methoden = new Set(textArray(roh.supportedGenerationMethods));
  if (methoden.has('generateContent')) gefunden.add('tools');

  return [...gefunden].sort();
}

/**
 * Einordnung als kostenlos, kostenpflichtig oder unbekannt.
 *
 * Reihenfolge der Evidenz:
 *   1. Suffix ":free" in der Modell-ID (OpenRouter-Konvention)
 *   2. Preisangaben des Anbieters: beide 0 = kostenlos, sonst kostenpflichtig
 *   3. keine Preisangaben = unbekannt
 *
 * "unbekannt" wird bewusst nicht zu "kostenlos" verkuerzt: ein Anbieter, der
 * keine Preise nennt, ist keine Zusage.
 */
function einordnen(
  provider: ProviderEntry,
  modelId: string,
  preisEin: number | null,
  preisAus: number | null,
): CostClass {
  const muster = provider.freeSuffixes ?? [':free'];
  if (muster.some((suffix) => modelId.endsWith(suffix))) return 'free';
  if (preisEin === null && preisAus === null) return 'unknown';
  if ((preisEin ?? 0) === 0 && (preisAus ?? 0) === 0) return 'free';
  return 'paid';
}

function normalisiere(
  provider: ProviderEntry,
  roh: RohModell,
  modelsDev: ModelsDevRegistry | null,
  erreichbarkeit: { reachability: Reachability; note: string | null },
): PoolModel | null {
  // Gemini liefert "models/gemini-x" im Feld name, alle anderen eine flache id.
  const rohId = typeof roh.id === 'string' ? roh.id : typeof roh.name === 'string' ? roh.name : null;
  if (!rohId) return null;
  const modelId = provider.wire === 'gemini' ? rohId.replace(/^models\//, '') : rohId;

  const preise = (roh.pricing ?? null) as Record<string, unknown> | null;
  // OpenAI-kompatible Kataloge nennen Preise je Token; wir rechnen auf 1 Mio. um.
  const preisEinRoh = preise ? zahl(preise.prompt ?? preise.input) : null;
  const preisAusRoh = preise ? zahl(preise.completion ?? preise.output) : null;
  const preisEin = plausiblerPreis(preisEinRoh === null ? null : preisEinRoh * 1_000_000);
  const preisAus = plausiblerPreis(preisAusRoh === null ? null : preisAusRoh * 1_000_000);

  const architektur = (roh.architecture ?? null) as Record<string, unknown> | null;
  const inputModalities = architektur ? textArray(architektur.input_modalities) : [];

  const topProvider = (roh.top_provider ?? null) as Record<string, unknown> | null;
  const kontext =
    zahl(roh.context_length) ??
    zahl(roh.inputTokenLimit) ??
    (topProvider ? zahl(topProvider.context_length) : null);
  const maxAus =
    (topProvider ? zahl(topProvider.max_completion_tokens) : null) ??
    zahl(roh.max_completion_tokens) ??
    zahl(roh.max_output_tokens) ??
    zahl(roh.outputTokenLimit);

  const anzeigename =
    typeof roh.name === 'string' && provider.wire !== 'gemini'
      ? roh.name
      : typeof roh.displayName === 'string'
        ? roh.displayName
        : undefined;

  // models.dev beschreibt dieselben Modelle deutlich vollstaendiger als die
  // meisten Anbieterkataloge. Eigene Angaben des Anbieters behalten Vorrang;
  // ergaenzt wird nur, was dort fehlt.
  const extern = findeModel(modelsDev, [...(provider.modelsDevIds ?? []), provider.id], modelId);

  const kostenExtern = extern?.cost;
  const preisEinFinal = preisEin ?? (typeof kostenExtern?.input === 'number' ? kostenExtern.input : null);
  const preisAusFinal = preisAus ?? (typeof kostenExtern?.output === 'number' ? kostenExtern.output : null);
  const kontextFinal = kontext ?? extern?.limit?.context ?? null;
  const maxAusFinal = maxAus ?? extern?.limit?.output ?? null;

  const modalitaeten = inputModalities.length ? inputModalities : (extern?.modalities?.input ?? []);
  const eigene = faehigkeiten(roh, modalitaeten);
  const zusammen = new Set(eigene);
  if (extern?.tool_call) zusammen.add('tools');
  if (extern?.reasoning) zusammen.add('reasoning');
  if (extern?.structured_output) zusammen.add('structured');
  if (modalitaeten.includes('image') || extern?.attachment) zusammen.add('vision');
  if (modalitaeten.includes('audio')) zusammen.add('audio');

  const effortStufen = (extern?.reasoning_options ?? [])
    .filter((option) => option.type === 'effort')
    .flatMap((option) => option.values ?? []);

  const eigeneAngaben = kontext !== null || preisEin !== null || eigene.length > 0;
  const metadataSource: PoolModel['metadataSource'] = eigeneAngaben
    ? 'provider'
    : extern
      ? 'models.dev'
      : 'none';

  const ref = provider.id + '/' + modelId;
  const kostenklasse = einordnen(provider, modelId, preisEinFinal, preisAusFinal);
  const erlaubnis = darfBenutztWerden(ref, kostenklasse);

  return {
    ref,
    provider: provider.id,
    modelId,
    name: anzeigename ?? extern?.name,
    family: extern?.family ?? null,
    costClass: kostenklasse,
    priceInPerMTok: preisEinFinal,
    priceOutPerMTok: preisAusFinal,
    contextLength: kontextFinal,
    maxOutputTokens: maxAusFinal,
    capabilities: [...zusammen].sort(),
    inputModalities: modalitaeten,
    baseUrl: provider.baseUrl,
    wire: provider.wire,
    freeType: provider.freeType,
    allowed: erlaubnis.allowed,
    allowedSource: erlaubnis.source,
    reachability: erreichbarkeit.reachability,
    reachabilityNote: erreichbarkeit.note,
    cooldownUntil: null,
    cooldownReason: null,
    deprecated: extern?.status === 'deprecated',
    reasoningEfforts: effortStufen,
    metadataSource,
  };
}

// ---------------------------------------------------------------------------
// Snapshot mit Cache
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Erreichbarkeit: das Ergebnis echter Aufrufe, nicht des Katalogabrufs
// ---------------------------------------------------------------------------

/**
 * Ergebnis eines echten Aufrufs.
 *
 * `inconclusive` ist der wichtige dritte Fall: ein 429 oder 503 sagt etwas
 * ueber die Last oder ueber genau dieses Modell aus, aber nichts ueber die
 * Zugangsberechtigung. Nur 401 und 403 sind Aussagen ueber den Zugang.
 */
type ProbeVerdikt = 'ready' | 'blocked' | 'inconclusive';

interface ProbeErgebnis {
  verdikt: ProbeVerdikt;
  detail: string;
  at: string;
}

function bewerteAntwort(status: number): ProbeVerdikt {
  if (status >= 200 && status < 300) return 'ready';
  // Anmeldung/Berechtigung — das betrifft den ganzen Anbieter.
  if (status === 401 || status === 403) return 'blocked';
  // 404 (Modell gibt es hier nicht), 429 (Ratengrenze), 5xx (Anbieter
  // gerade ueberlastet): sagt nichts ueber den Zugang.
  return 'inconclusive';
}

const probeErgebnisse = new Map<string, ProbeErgebnis>();

// ---------------------------------------------------------------------------
// Sperren je Modell
//
// Bewusst je Modell und nicht je Anbieter: ein gedrosseltes oder verschwundenes
// Modell sagt nichts ueber die uebrigen desselben Anbieters. Anbieterweite
// Aussagen trifft nur die Erreichbarkeitspruefung.
// ---------------------------------------------------------------------------

interface Sperre {
  until: number;
  reason: string;
  message: string;
  failures: number;
}

const sperren = new Map<string, Sperre>();

/** Ausdrueckliche Freigaben aus der Datenbank; ohne Eintrag gilt die Standardregel. */
const freigaben = new Map<string, boolean>();

/** Laufende Spiegelung des Katalogs — abwartbar, bevor jemand darauf schreibt. */
let laufendeSpiegelung: Promise<void> | null = null;
let spiegelungLaeuft = false;

/**
 * Sorgt dafuer, dass immer nur EINE Spiegelung laeuft. Zwei gleichzeitige
 * Transaktionen ueber dieselben Zeilen haben sich gegenseitig blockiert;
 * PostgreSQL loeste das mit einem Deadlock-Abbruch.
 */
async function spiegeleEinmal(zeilen: Parameters<typeof synchronisiereModelle>[0]): Promise<void> {
  if (spiegelungLaeuft) return;
  spiegelungLaeuft = true;
  try {
    await synchronisiereModelle(zeilen);
  } finally {
    spiegelungLaeuft = false;
  }
}

/** Einmaliges Laden des gemerkten Zustands — Sperren, Anbieter, Freigaben. */
let zustandGeladen: Promise<void> | null = null;

function ladeGemerktenZustand(): Promise<void> {
  if (!zustandGeladen) {
    zustandGeladen = ladeZustand().then((zustand) => {
      const jetzt = Date.now();
      for (const eintrag of zustand.sperren) {
        if (eintrag.until > jetzt) {
          sperren.set(eintrag.ref, {
            until: eintrag.until,
            reason: eintrag.reason,
            message: eintrag.message,
            failures: eintrag.failures,
          });
        }
      }
      for (const eintrag of zustand.anbieter) {
        // 'unverified' ist kein Ergebnis, sondern dessen Abwesenheit — das
        // muss nicht wiederhergestellt werden.
        if (eintrag.reachability === 'ready' || eintrag.reachability === 'blocked') {
          probeErgebnisse.set(eintrag.id, {
            verdikt: eintrag.reachability,
            detail: eintrag.note ?? '',
            at: eintrag.probedAt ?? new Date().toISOString(),
          });
        }
      }
      for (const [ref, erlaubt] of zustand.freigaben) freigaben.set(ref, erlaubt);
    });
  }
  return zustandGeladen;
}

/**
 * Entscheidet, ob ein Modell benutzt werden darf.
 * Standardregel: kostenlos ja, kostenpflichtig und unbekannt nein.
 * Eine gespeicherte Entscheidung schlaegt die Regel in beide Richtungen.
 */
function darfBenutztWerden(ref: string, kosten: CostClass): { allowed: boolean; source: 'default' | 'explicit' } {
  const ausdruecklich = freigaben.get(ref);
  if (ausdruecklich !== undefined) return { allowed: ausdruecklich, source: 'explicit' };
  return { allowed: kosten === 'free', source: 'default' };
}

/** Uebernimmt eine Freigabe-Entscheidung in den laufenden Betrieb. */
export function uebernimmFreigabe(ref: string, erlaubt: boolean | null): void {
  if (erlaubt === null) freigaben.delete(ref);
  else freigaben.set(ref, erlaubt);
  // Den vorhandenen Katalog punktuell anpassen statt ihn zu verwerfen: ein
  // Verwerfen wuerde bei der naechsten Suche alle Anbieter neu abfragen — und
  // eine zweite Spiegelung neben der laufenden starten.
  if (snapshot) {
    snapshot = {
      ...snapshot,
      models: snapshot.models.map((modell) =>
        modell.ref === ref
          ? { ...modell, ...darfBenutztWerden(modell.ref, modell.costClass) }
          : modell,
      ),
    };
  }
}

/**
 * Gibt ein Modell frei oder sperrt es ausdruecklich. `null` nimmt die
 * Entscheidung zurueck, dann gilt wieder die Standardregel.
 *
 * Nimmt auch Kurznamen. Geprueft wird gegen den LEBENDEN Katalog, nicht gegen
 * die Spiegelung: eine Freigabe fuer ein Modell, das es gar nicht gibt, waere
 * ein stiller Tippfehler.
 */
export async function setzeModellFreigabe(
  refOderAlias: string,
  erlaubt: boolean | null,
  grund?: string,
): Promise<PoolModel> {
  const modell = await getPoolModel(refOderAlias);
  if (!modell) {
    throw new Error(
      'Modell "' + refOderAlias + '" ist im Katalog nicht zu finden. '
      + 'Mit der Modellsuche pruefen oder einen Kurznamen verwenden.',
    );
  }
  // Die Spiegelung laeuft nebenlaeufig zum Katalogaufbau. Ohne dieses Warten
  // trifft die Freigabe auf eine Zeile, die es noch nicht gibt.
  if (laufendeSpiegelung) await laufendeSpiegelung.catch(() => undefined);
  await setzeFreigabe(modell.ref, erlaubt, grund);
  uebernimmFreigabe(modell.ref, erlaubt);
  return { ...modell, allowed: erlaubt ?? modell.costClass === 'free', allowedSource: erlaubt === null ? 'default' : 'explicit' };
}

/** Traegt einen gescheiterten Aufruf ein und sperrt den Kandidaten entsprechend. */
export function markiereFehlschlag(ref: string, fehler: ClassifiedFailure): void {
  if (fehler.cooldownMs <= 0) return;
  const bisher = sperren.get(ref);
  const [provider, ...rest] = ref.split('/');
  // Wiederholte Fehlschlaege verlaengern die Sperre, gedeckelt auf das
  // Achtfache: sonst hat ein zaeh haengender Anbieter nach wenigen Runden eine
  // Sperre von Tagen.
  const stufe = Math.min((bisher?.failures ?? 0) + 1, 4);
  const dauer = Math.min(fehler.cooldownMs * stufe, fehler.cooldownMs * 8);
  const bis = Date.now() + dauer;
  sperren.set(ref, {
    until: bis,
    reason: fehler.reason,
    message: fehler.message,
    failures: stufe,
  });
  // Nebenlaeufig: eine nicht gespeicherte Sperre kostet nach einem Neustart
  // einen Fehlversuch, mehr nicht — das darf den Aufruf nicht aufhalten.
  void speichereSperre(ref, provider, rest.join('/'), new Date(bis), fehler.reason, stufe);
}

/** Ein erfolgreicher Aufruf hebt die Sperre und den Fehlerzaehler auf. */
export function markiereErfolg(ref: string): void {
  sperren.delete(ref);
  void loescheSperre(ref);
}

/**
 * Traegt ein Ergebnis auf ANBIETER-Ebene ein.
 *
 * Nur fuer Fehler, die den Zugang betreffen (Anmeldung, Abrechnung): die gelten
 * fuer alle Modelle dieses Anbieters. Ohne das kommt ein Anbieter mit
 * ungueltigem Schluessel bei jedem seiner Modelle erneut an die Reihe.
 * Modell- oder lastbezogene Fehler haben hier NICHTS zu suchen.
 */
export function markiereAnbieterZugang(providerId: string, ok: boolean, detail: string): void {
  probeErgebnisse.set(providerId, {
    verdikt: ok ? 'ready' : 'blocked',
    detail,
    at: new Date().toISOString(),
  });
  void speichereAnbieter(providerId, ok ? 'ready' : 'blocked', detail, true);
  // Die Erreichbarkeit steckt in jedem Modell — aber ein Neuaufbau waere hier
  // besonders teuer, weil er mitten in einem Aufrufversuch passiert.
  if (snapshot) {
    const erreichbarkeit: Reachability = ok ? 'ready' : 'blocked';
    snapshot = {
      ...snapshot,
      models: snapshot.models.map((modell) =>
        modell.provider === providerId
          ? { ...modell, reachability: erreichbarkeit, reachabilityNote: ok ? null : detail }
          : modell,
      ),
      providers: snapshot.providers.map((eintrag) =>
        eintrag.id === providerId
          ? { ...eintrag, reachability: erreichbarkeit, reachabilityNote: ok ? null : detail, probedAt: new Date().toISOString() }
          : eintrag,
      ),
    };
  }
}

function sperreFuer(ref: string): Sperre | null {
  const eintrag = sperren.get(ref);
  if (!eintrag) return null;
  if (eintrag.until <= Date.now()) {
    // Abgelaufen: Eintrag behalten waere irrefuehrend, der Zaehler geht mit.
    sperren.delete(ref);
    return null;
  }
  return eintrag;
}

/** Alle laufenden Sperren — fuer Anzeige und Diagnose. */
export function listeSperren(): Array<{ ref: string; until: string; reason: string; message: string }> {
  const jetzt = Date.now();
  return [...sperren.entries()]
    .filter(([, s]) => s.until > jetzt)
    .map(([ref, s]) => ({
      ref,
      until: new Date(s.until).toISOString(),
      reason: s.reason,
      message: s.message,
    }))
    .sort((a, b) => a.until.localeCompare(b.until));
}

/** Hebt alle Sperren auf — fuer einen manuellen Neuversuch aus der Oberflaeche. */
export function loescheSperren(): number {
  const anzahl = sperren.size;
  sperren.clear();
  return anzahl;
}

/**
 * Prueft mit einem minimalen Aufruf, ob der Anbieter Inferenz erlaubt.
 * Verbraucht ein paar Token — deshalb nur auf ausdrueckliche Anforderung und
 * nie im Rahmen eines Katalogabrufs.
 */
export async function probeProvider(providerId: string, modelId?: string): Promise<ProviderStatus> {
  const provider = PROVIDER_REGISTRY.find((p) => p.id === providerId);
  if (!provider) throw new Error('Unbekannter Anbieter: ' + providerId);

  const key = credential(provider);
  if (!key && provider.auth !== 'none') {
    probeErgebnisse.set(providerId, {
      verdikt: 'blocked',
      detail: 'Kein Credential in ' + provider.envVar,
      at: new Date().toISOString(),
    });
    snapshot = null;
    return (await getPoolProviders()).find((p) => p.id === providerId) as ProviderStatus;
  }

  // Ein Modell waehlen, das sich zum Pruefen eignet: ein Chat-Modell, das
  // Werkzeuge kann (Embedding- und Spezialmodelle antworten auf
  // /chat/completions mit 404), moeglichst kostenlos und nicht abgekuendigt.
  const daten = await getPoolSnapshot();
  const eigene = daten.models.filter((m) => m.provider === providerId && !m.deprecated);
  const geeignet = eigene.filter((m) => m.capabilities.includes('tools'));
  const reihenfolge = [
    ...geeignet.filter((m) => m.costClass === 'free'),
    ...geeignet.filter((m) => m.costClass !== 'free'),
    ...eigene,
  ];

  // Bis zu drei verschiedene Modelle: das erste kann ausgerechnet das sein,
  // das gerade ueberlastet oder gesperrt ist. Aufgehoert wird, sobald ein
  // Ergebnis eindeutig ist.
  const kandidaten = modelId
    ? [modelId]
    : [...new Set(reihenfolge.map((m) => m.modelId))].slice(0, 3);
  if (kandidaten.length === 0) throw new Error('Kein Modell zum Pruefen bei ' + providerId);

  const kopf: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const [name, wert] of Object.entries(provider.defaultHeaders ?? {})) {
    if (wert) kopf[name] = wert;
  }
  if (provider.auth === 'bearer' && key) kopf.Authorization = 'Bearer ' + key;

  let url = provider.baseUrl + '/chat/completions';
  if (provider.auth === 'query-key' && key) url += '?key=' + encodeURIComponent(key);

  const versuche: string[] = [];
  let ergebnis: ProbeErgebnis | null = null;

  for (const kandidat of kandidaten) {
    try {
      const antwort = await fetch(url, {
        method: 'POST',
        headers: kopf,
        body: JSON.stringify({
          model: kandidat,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(45_000),
      });

      const verdikt = bewerteAntwort(antwort.status);
      if (verdikt === 'ready') {
        ergebnis = {
          verdikt: 'ready',
          detail: 'Aufruf bestaetigt (' + kandidat + ')',
          at: new Date().toISOString(),
        };
        break;
      }

      const text = (await antwort.text()).slice(0, 140).replace(/\s+/g, ' ');
      const meldung = 'HTTP ' + antwort.status + ' bei ' + kandidat + (text ? ': ' + text : '');
      if (verdikt === 'blocked') {
        ergebnis = { verdikt: 'blocked', detail: meldung, at: new Date().toISOString() };
        break;
      }
      versuche.push(meldung);
    } catch (fehler) {
      versuche.push((fehler as Error).message + ' bei ' + kandidat);
    }
  }

  if (!ergebnis) {
    // Nichts Eindeutiges: der Anbieterzustand bleibt, was er war. Ein
    // ueberlastetes Einzelmodell ist keine Aussage ueber den Zugang.
    const vorher = probeErgebnisse.get(providerId);
    ergebnis = {
      verdikt: vorher?.verdikt === 'ready' ? 'ready' : 'inconclusive',
      detail:
        'Kein eindeutiges Ergebnis nach ' + kandidaten.length + ' Versuch(en): ' + versuche.join(' | ')
        + ' — sagt nichts ueber die Zugangsberechtigung',
      at: new Date().toISOString(),
    };
  }

  probeErgebnisse.set(providerId, ergebnis);

  // Der Snapshot traegt die Erreichbarkeit, also frisch ableiten.
  snapshot = null;
  return (await getPoolProviders()).find((p) => p.id === providerId) as ProviderStatus;
}

/**
 * Leitet ab, wie belastbar die Aussage "das laesst sich aufrufen" ist.
 *
 * Der entscheidende Punkt: ein erfolgreicher Katalogabruf beweist nur dann
 * etwas, wenn er selbst ein Credential verlangt hat. Ist der Katalog
 * oeffentlich, sagt er ueber die Aufrufberechtigung nichts aus.
 */
function leiteErreichbarkeitAb(
  provider: ProviderEntry,
  hatCredential: boolean,
  katalogFehler: string | null,
): { reachability: Reachability; note: string | null } {
  const probe = probeErgebnisse.get(provider.id);
  if (probe?.verdikt === 'ready') return { reachability: 'ready', note: null };
  if (probe?.verdikt === 'blocked') return { reachability: 'blocked', note: probe.detail };
  // 'inconclusive' faellt bewusst durch: der Zustand bleibt, was er ohne die
  // Probe gewesen waere, nur mit dem Ergebnis als Begruendung.
  const ausProbe = probe?.detail ?? null;
  if (!hatCredential && provider.auth !== 'none') {
    return { reachability: 'no_credential', note: 'Kein Credential in ' + provider.envVar };
  }
  if (katalogFehler) {
    return { reachability: 'blocked', note: katalogFehler };
  }
  if (provider.catalogPublic) {
    return {
      reachability: 'unverified',
      note:
        ausProbe ??
        'Katalog ist oeffentlich lesbar — das belegt keine Aufrufberechtigung. Mit action="probe" pruefen.',
    };
  }
  // Der Katalog verlangte ein Credential und lieferte: damit ist die
  // Anmeldung belegt.
  return { reachability: 'ready', note: null };
}

const CACHE_TTL_MS = 15 * 60 * 1000;

let snapshot: PoolSnapshot | null = null;
let snapshotZeit = 0;
let laufenderAbruf: Promise<PoolSnapshot> | null = null;

async function baueSnapshot(): Promise<PoolSnapshot> {
  const modelle: PoolModel[] = [];
  const zustaende: ProviderStatus[] = [];

  // Erst das Gedaechtnis, dann die Kataloge: sonst gilt ein gesperrter Anbieter
  // beim ersten Aufbau nach einem Neustart wieder als Kandidat.
  await ladeGemerktenZustand();

  // Einmal je Durchlauf holen und an alle Anbieter durchreichen. Faellt
  // models.dev aus, liefert das null und die Anreicherung entfaellt still.
  const modelsDev = await getModelsDev().catch(() => null);

  const ergebnisse = await Promise.all(
    PROVIDER_REGISTRY.filter((p) => p.enabled).map(async (provider) => {
      const key = credential(provider);
      const basis = {
        id: provider.id,
        label: provider.label,
        enabled: provider.enabled,
        freeType: provider.freeType,
        baseUrl: provider.baseUrl,
        envVar: provider.envVar,
        credentialPresent: key !== null,
        signupUrl: provider.signupUrl,
        note: provider.note,
      };

      // Ohne Schluessel gar nicht erst anfragen — ausser der Anbieter braucht keinen.
      if (!key && provider.auth !== 'none') {
        const ohne = leiteErreichbarkeitAb(provider, false, null);
        return {
          status: {
            ...basis,
            modelCount: 0,
            freeCount: 0,
            error: 'Kein Credential in ' + provider.envVar,
            reachability: ohne.reachability,
            reachabilityNote: ohne.note,
            probedAt: probeErgebnisse.get(provider.id)?.at ?? null,
          },
          modelle: [] as PoolModel[],
        };
      }

      try {
        const roh = await holeKatalog(provider, key);
        const erreichbarkeit = leiteErreichbarkeitAb(provider, key !== null, null);
        const liste = roh
          .map((eintrag) => normalisiere(provider, eintrag, modelsDev, erreichbarkeit))
          .filter((m): m is PoolModel => m !== null);
        return {
          status: {
            ...basis,
            modelCount: liste.length,
            freeCount: liste.filter((m) => m.costClass === 'free').length,
            error: null,
            reachability: erreichbarkeit.reachability,
            reachabilityNote: erreichbarkeit.note,
            probedAt: probeErgebnisse.get(provider.id)?.at ?? null,
          },
          modelle: liste,
        };
      } catch (fehler) {
        const meldung = fehler instanceof Error ? fehler.message : String(fehler);
        const erreichbarkeit = leiteErreichbarkeitAb(provider, key !== null, meldung);
        return {
          status: {
            ...basis,
            modelCount: 0,
            freeCount: 0,
            error: meldung,
            reachability: erreichbarkeit.reachability,
            reachabilityNote: erreichbarkeit.note,
            probedAt: probeErgebnisse.get(provider.id)?.at ?? null,
          },
          modelle: [] as PoolModel[],
        };
      }
    }),
  );

  for (const ergebnis of ergebnisse) {
    zustaende.push(ergebnis.status);
    modelle.push(...ergebnis.modelle);
    // Auch ohne Pruefung festhalten: sonst steht in der Tabelle nur, wer schon
    // einmal geprueft wurde oder gescheitert ist — und die Oberflaeche zeigt
    // nach einem Neustart einen leeren Anbieterzustand.
    void speichereAnbieter(
      ergebnis.status.id,
      ergebnis.status.reachability,
      ergebnis.status.reachabilityNote,
      false,
    );
  }

  // Den erkannten Katalog spiegeln, damit die Oberflaeche ihn ohne Netzzugriff
  // anzeigen kann und Freigaben eine Zeile zum Anhaengen haben.
  laufendeSpiegelung = spiegeleEinmal(
    modelle.map((m) => ({
      ref: m.ref,
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.name ?? null,
      family: m.family,
      costClass: m.costClass,
      priceIn: m.priceInPerMTok,
      priceOut: m.priceOutPerMTok,
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      capabilities: m.capabilities,
      deprecated: m.deprecated,
      metadataSource: m.metadataSource,
    })),
  );

  return { models: modelle, providers: zustaende, fetchedAt: new Date().toISOString() };
}

/**
 * Liefert den Katalog. Innerhalb der Cache-Zeit ohne Netzzugriff; parallele
 * Aufrufe teilen sich einen laufenden Abruf.
 */
export async function getPoolSnapshot(force = false): Promise<PoolSnapshot> {
  const frisch = snapshot !== null && Date.now() - snapshotZeit < CACHE_TTL_MS;
  if (frisch && !force) return snapshot as PoolSnapshot;
  if (laufenderAbruf && !force) return laufenderAbruf;

  if (force) invalidiereCredentialCache();
  laufenderAbruf = baueSnapshot()
    .then((neu) => {
      snapshot = neu;
      snapshotZeit = Date.now();
      return neu;
    })
    .finally(() => {
      laufenderAbruf = null;
    });
  return laufenderAbruf;
}

// ---------------------------------------------------------------------------
// Suche
// ---------------------------------------------------------------------------

export interface PoolFilter {
  /** Standard: nur kostenlose. 'any' hebt die Einschraenkung auf. */
  cost?: CostClass | 'any';
  provider?: string;
  /** Freitext auf Modell-ID und Anzeigename. */
  query?: string;
  minContext?: number;
  /** Alle genannten Faehigkeiten muessen vorhanden sein. */
  capabilities?: string[];
  /** Abgekuendigte Modelle mitliefern (Standard: nein). */
  includeDeprecated?: boolean;
  /** Nur Modelle, deren Aufruf nicht nachweislich scheitert (Standard: ja). */
  onlyReachable?: boolean;
  /** Gesperrte Kandidaten mitliefern (Standard: nein). */
  includeCooling?: boolean;
  /**
   * Auch nicht freigegebene Modelle mitliefern (Standard: nein).
   * Nur zum Anschauen — wer sie benutzen will, braucht eine Freigabe.
   */
  includeForbidden?: boolean;
  sort?: 'context' | 'name' | 'price';
  limit?: number;
}

export interface PoolSuchergebnis {
  models: PoolModel[];
  /** Treffer vor der Begrenzung durch `limit`. */
  matched: number;
  total: number;
  fetchedAt: string;
  providers: ProviderStatus[];
}

export async function searchPool(filter: PoolFilter = {}): Promise<PoolSuchergebnis> {
  const roh = await getPoolSnapshot();
  // Sperren sind fluechtig und liegen ausserhalb des Katalog-Zwischenspeichers;
  // sie werden bei jeder Suche frisch aufgesetzt.
  const daten: PoolSnapshot = {
    ...roh,
    models: roh.models.map((modell) => {
      const sperre = sperreFuer(modell.ref);
      return sperre
        ? {
            ...modell,
            cooldownUntil: new Date(sperre.until).toISOString(),
            cooldownReason: sperre.reason,
          }
        : modell;
    }),
  };
  const kosten = filter.cost ?? 'free';
  const suchtext = filter.query?.trim().toLowerCase();
  const noetigeFaehigkeiten = filter.capabilities ?? [];

  let treffer = daten.models.filter((modell) => {
    if (kosten !== 'any' && modell.costClass !== kosten) return false;
    if (filter.provider && modell.provider !== filter.provider) return false;
    if (filter.minContext && (modell.contextLength ?? 0) < filter.minContext) return false;
    if (modell.deprecated && !filter.includeDeprecated) return false;
    // 'blocked' und 'no_credential' sind belegte Fehlschlaege — die gehoeren
    // nicht in eine Auswahlliste. 'unverified' bleibt drin, aber gekennzeichnet.
    if (filter.onlyReachable !== false && (modell.reachability === 'blocked' || modell.reachability === 'no_credential')) {
      return false;
    }
    if (modell.cooldownUntil && !filter.includeCooling) return false;
    // Die Freigabe ist der eigentliche Kostenriegel: ohne sie taucht ein
    // kostenpflichtiges Modell gar nicht erst in einer Auswahl auf.
    if (!modell.allowed && !filter.includeForbidden) return false;
    if (noetigeFaehigkeiten.some((f) => !modell.capabilities.includes(f))) return false;
    if (suchtext) {
      const heuhaufen = (modell.ref + ' ' + (modell.name ?? '')).toLowerCase();
      if (!heuhaufen.includes(suchtext)) return false;
    }
    return true;
  });

  const anzahlTreffer = treffer.length;

  // Belegte Nutzbarkeit schlaegt jedes andere Kriterium: ein grosses
  // Kontextfenster nuetzt nichts, wenn der Aufruf scheitert.
  const rang: Record<Reachability, number> = { ready: 0, unverified: 1, blocked: 2, no_credential: 3 };

  const sortierung = filter.sort ?? 'context';
  treffer = [...treffer].sort((a, b) => {
    const nutzbar = rang[a.reachability] - rang[b.reachability];
    if (nutzbar !== 0) return nutzbar;
    if (sortierung === 'name') return a.ref.localeCompare(b.ref);
    if (sortierung === 'price') {
      // Unbekannte Preise ans Ende, damit die guenstigsten oben stehen.
      const pa = a.priceInPerMTok ?? Number.POSITIVE_INFINITY;
      const pb = b.priceInPerMTok ?? Number.POSITIVE_INFINITY;
      return pa - pb || a.ref.localeCompare(b.ref);
    }
    return (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.ref.localeCompare(b.ref);
  });

  const grenze = Math.max(1, Math.min(filter.limit ?? 20, 200));
  return {
    models: treffer.slice(0, grenze),
    matched: anzahlTreffer,
    total: daten.models.length,
    fetchedAt: daten.fetchedAt,
    providers: daten.providers,
  };
}

// ---------------------------------------------------------------------------
// Kurznamen
//
// Ein Kurzname bezeichnet eine Familie, keine Fassung: "nemotron" statt
// "opencode-free/nemotron-3-ultra-free". Aufgeloest wird gegen den Live-Katalog,
// damit ein Versionswechsel beim Anbieter niemanden etwas angeht.
// ---------------------------------------------------------------------------

/**
 * Zerlegt eine Modell-ID in Namensbestandteile. Bewusst Segmente und keine
 * Teilzeichenketten: eine Suche nach "hermes" darf nicht auf
 * "hermes-brain-qwen3" anschlagen, nur weil der Name darin vorkommt.
 */
function segmente(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[/:_\-.\s]+/)
    .filter(Boolean);
}

/**
 * Loest einen Kurznamen zu Kandidaten auf, beste zuerst.
 *
 * Reihenfolge der Genauigkeit: vollstaendige Referenz, exakte Modell-ID,
 * Familienname, einzelnes Namenssegment. Innerhalb gleicher Genauigkeit
 * gewinnt, was kostenlos, erreichbar und nicht gesperrt ist — danach das
 * groessere Kontextfenster.
 */
export async function loeseAliasAuf(alias: string): Promise<PoolModel[]> {
  const gesucht = alias.trim().toLowerCase();
  if (!gesucht) return [];
  const daten = await getPoolSnapshot();

  const bewertet = daten.models.map((modell) => {
    const ref = modell.ref.toLowerCase();
    const id = modell.modelId.toLowerCase();
    let genauigkeit = 0;
    if (ref === gesucht) genauigkeit = 4;
    else if (id === gesucht) genauigkeit = 3;
    else if (modell.family && modell.family.toLowerCase() === gesucht) genauigkeit = 2;
    else if (segmente(modell.modelId).includes(gesucht)) genauigkeit = 1;
    return { modell, genauigkeit };
  });

  const treffer = bewertet.filter((eintrag) => eintrag.genauigkeit > 0);
  if (treffer.length === 0) return [];

  const rang: Record<Reachability, number> = { ready: 0, unverified: 1, blocked: 2, no_credential: 3 };
  treffer.sort((a, b) => {
    if (a.genauigkeit !== b.genauigkeit) return b.genauigkeit - a.genauigkeit;
    const sperreA = sperreFuer(a.modell.ref) ? 1 : 0;
    const sperreB = sperreFuer(b.modell.ref) ? 1 : 0;
    if (sperreA !== sperreB) return sperreA - sperreB;
    const kostenA = a.modell.costClass === 'free' ? 0 : 1;
    const kostenB = b.modell.costClass === 'free' ? 0 : 1;
    if (kostenA !== kostenB) return kostenA - kostenB;
    const erreichbarA = rang[a.modell.reachability];
    const erreichbarB = rang[b.modell.reachability];
    if (erreichbarA !== erreichbarB) return erreichbarA - erreichbarB;
    if (a.modell.deprecated !== b.modell.deprecated) return a.modell.deprecated ? 1 : -1;
    return (b.modell.contextLength ?? 0) - (a.modell.contextLength ?? 0);
  });

  return treffer.map((eintrag) => eintrag.modell);
}

/**
 * Namensbestandteile, die keine Familie bezeichnen, sondern Fassung, Groesse
 * oder Zweck. Als Kurzname waeren sie wertlos: "free" traefe zwei Dutzend
 * Modelle ohne jeden Zusammenhang.
 */
const KEINE_KURZNAMEN = new Set([
  'free', 'instruct', 'instruct2', 'preview', 'chat', 'base', 'latest', 'beta', 'alpha', 'exp',
  'experimental', 'nano', 'mini', 'small', 'medium', 'large', 'pro', 'max', 'ultra', 'lite',
  'turbo', 'plus', 'thinking', 'reasoning', 'vision', 'text', 'tools', 'safety', 'contributor',
]);

/** Alle bekannten Kurznamen mit der Zahl ihrer Treffer — fuer Anzeige und Hilfe. */
export async function listeAliase(): Promise<Array<{ alias: string; models: number; free: number }>> {
  const daten = await getPoolSnapshot();
  const zaehler = new Map<string, { models: number; free: number }>();
  for (const modell of daten.models) {
    const namen = new Set<string>();
    if (modell.family) namen.add(modell.family.toLowerCase());
    // Nur Segmente aus Buchstaben: Versionsnummern und Groessenangaben wie
    // "30b" taugen nicht als Kurzname.
    for (const teil of segmente(modell.modelId)) {
      if (teil.length >= 3 && /^[a-z]+$/.test(teil) && !KEINE_KURZNAMEN.has(teil)) namen.add(teil);
    }
    for (const name of namen) {
      const eintrag = zaehler.get(name) ?? { models: 0, free: 0 };
      eintrag.models += 1;
      if (modell.costClass === 'free') eintrag.free += 1;
      zaehler.set(name, eintrag);
    }
  }
  return [...zaehler.entries()]
    .map(([alias, werte]) => ({ alias, ...werte }))
    .filter((eintrag) => eintrag.free > 0)
    .sort((a, b) => b.free - a.free || a.alias.localeCompare(b.alias));
}

/** Ein Modell ueber seine Referenz "<provider>/<modelId>" oder die blosse ID. */
export async function getPoolModel(ref: string): Promise<PoolModel | null> {
  const daten = await getPoolSnapshot();
  const gesucht = ref.trim();
  const treffer =
    daten.models.find((m) => m.ref === gesucht) ??
    daten.models.find((m) => m.modelId === gesucht) ??
    // Kein Volltreffer: als Kurznamen versuchen, damit "nemotron" genauso
    // funktioniert wie die vollstaendige Referenz.
    (await loeseAliasAuf(gesucht))[0] ??
    null;
  if (!treffer) return null;
  const sperre = sperreFuer(treffer.ref);
  return sperre
    ? { ...treffer, cooldownUntil: new Date(sperre.until).toISOString(), cooldownReason: sperre.reason }
    : treffer;
}

/** Anbieter-Uebersicht ohne Modelldaten. */
export async function getPoolProviders(force = false): Promise<ProviderStatus[]> {
  return (await getPoolSnapshot(force)).providers;
}

// ---------------------------------------------------------------------------
// Aufrufziel
//
// Bewusst getrennt von PoolModel: dieses geht an das MCP-Werkzeug und damit an
// Agenten. Zugangsdaten haben dort nichts zu suchen. Wer wirklich aufrufen
// will, holt sich hier fertige Kopfzeilen — der Schluessel selbst wird nie als
// eigenes Feld herausgereicht.
// ---------------------------------------------------------------------------

export interface AufrufZiel {
  ref: string;
  provider: string;
  /** Modell-ID genau so, wie sie in den Rumpf gehoert. */
  modelId: string;
  /** Vollstaendige URL fuer Chat-Vervollstaendigungen. */
  url: string;
  wire: WireFormat;
  /** Fertige Kopfzeilen inklusive Anmeldung. */
  headers: Record<string, string>;
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** Erlaubte Reasoning-Stufen; ein anderer Wert quittiert der Anbieter mit 400. */
  reasoningEfforts: string[];
}

/**
 * Liefert alles, was ein Aufruf braucht — oder null, wenn das Modell unbekannt
 * ist. Ein gesperrter oder unerreichbarer Kandidat wird hier NICHT abgelehnt:
 * ob er drankommt, entscheidet die Auswahl, nicht diese Funktion.
 */
export async function getAufrufZiel(ref: string): Promise<AufrufZiel | null> {
  const modell = await getPoolModel(ref);
  if (!modell) return null;
  const provider = PROVIDER_REGISTRY.find((p) => p.id === modell.provider);
  if (!provider) return null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Leere Werte sind Absicht — sie unterdruecken eine Kopfzeile, statt sie zu
  // setzen (OpenCode Free lehnt jede unbekannte Anmeldung ab).
  for (const [name, wert] of Object.entries(provider.defaultHeaders ?? {})) {
    if (wert) headers[name] = wert;
  }

  const key = credential(provider);
  let url = provider.baseUrl + '/chat/completions';
  if (provider.auth === 'bearer' && key) headers.Authorization = 'Bearer ' + key;
  if (provider.auth === 'query-key' && key) url += '?key=' + encodeURIComponent(key);

  return {
    ref: modell.ref,
    provider: modell.provider,
    modelId: modell.modelId,
    url,
    wire: modell.wire,
    headers,
    contextLength: modell.contextLength,
    maxOutputTokens: modell.maxOutputTokens,
    reasoningEfforts: modell.reasoningEfforts,
  };
}
