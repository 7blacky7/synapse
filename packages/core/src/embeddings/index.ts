/**
 * MODUL: Embedding Service
 * ZWECK: Einheitlicher Zugriff auf alle Embedding-Provider — Ollama, OpenAI, Google, Cohere.
 *
 * INPUT:
 *   - EMBEDDING_PROVIDER (via config) - Provider-Name (ollama | openai | mistral | jina | voyage | google | cohere)
 *   - EMBEDDING_API_KEY / provider-spezifischer Key - API-Authentifizierung
 *   - text: string - Zu embeddender Text
 *   - texts: string[] - Batch-Texte
 *   - data: Buffer + mimeType: string - Medien-Datei (nur multimodale Provider)
 *
 * OUTPUT:
 *   - EmbeddingProvider: Aktiver Provider (Singleton)
 *   - number[]: Embedding-Vektor
 *   - number[][]: Batch-Vektoren
 *   - number: Vektor-Dimension des Modells (gecached)
 *   - boolean: Multimodal-Support-Flag
 *
 * NEBENEFFEKTE:
 *   - Cached den Provider und die Dimension im Prozess-Speicher (_provider, _cachedDimension)
 *   - Fallback: Ollama nicht erreichbar → OpenAI wird automatisch versucht
 *   - Netzwerk: Ruft je nach Provider externe APIs auf
 */

import { getConfig } from '../config.js';
import { SynapseConfig } from '../types/index.js';
import { EmbeddingProvider } from './types.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OpenAICompatibleProvider, PROVIDER_PRESETS } from './openai-compatible.js';
import { GoogleEmbeddingProvider } from './google.js';
import { CohereEmbeddingProvider } from './cohere.js';

export * from './types.js';
export { OllamaEmbeddingProvider } from './ollama.js';
export { OpenAICompatibleProvider } from './openai-compatible.js';
export { OpenAICompatibleProvider as OpenAIEmbeddingProvider } from './openai-compatible.js';
export { GoogleEmbeddingProvider } from './google.js';
export { CohereEmbeddingProvider } from './cohere.js';

let _provider: EmbeddingProvider | null = null;
let _cachedDimension: number | null = null;

/** ENV-Variablen-Mapping fuer provider-spezifische API-Keys */
const API_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  jina: 'JINA_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  google: 'GOOGLE_API_KEY',
  cohere: 'COHERE_API_KEY',
};

/**
 * Loest den API-Key fuer einen Provider auf
 * Kaskade: Provider-spezifisch > EMBEDDING_API_KEY > OPENAI_API_KEY
 */
function resolveApiKey(provider: string, config: SynapseConfig): string {
  const envVar = API_KEY_ENV[provider];
  const key = (envVar ? process.env[envVar] : undefined)
    || config.embeddings.apiKey
    || config.embeddings.openai.apiKey;

  if (!key) {
    throw new Error(
      `API Key fuer "${provider}" nicht konfiguriert. ` +
      `Setze ${envVar || 'EMBEDDING_API_KEY'} in der .env Datei.`
    );
  }
  return key;
}

/**
 * Erstellt einen Provider basierend auf dem Namen
 */
function createProvider(name: string, config: SynapseConfig): EmbeddingProvider {
  switch (name) {
    case 'ollama':
      return new OllamaEmbeddingProvider();

    case 'openai':
    case 'mistral':
    case 'jina':
    case 'voyage': {
      const preset = PROVIDER_PRESETS[name];
      const apiKey = resolveApiKey(name, config);
      const model = config.embeddings.model || preset.defaultModel;
      const baseURL = config.embeddings.baseUrl || preset.baseURL;
      return new OpenAICompatibleProvider({ name, apiKey, model, baseURL });
    }

    case 'google': {
      const apiKey = resolveApiKey('google', config);
      const model = config.embeddings.model || undefined;
      return new GoogleEmbeddingProvider(apiKey, model);
    }

    case 'cohere': {
      const apiKey = resolveApiKey('cohere', config);
      const model = config.embeddings.model || undefined;
      return new CohereEmbeddingProvider(apiKey, model);
    }

    default:
      throw new Error(`Unbekannter Embedding Provider: ${name}`);
  }
}

/**
 * Gibt den konfigurierten Embedding Provider zurueck
 * Versucht Fallback auf OpenAI wenn Ollama nicht erreichbar
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (_provider) {
    return _provider;
  }

  const config = getConfig();
  const providerName = config.embeddings.provider;

  // Ollama mit Fallback-Logik
  if (providerName === 'ollama') {
    const ollama = new OllamaEmbeddingProvider();
    if (await ollama.testConnection()) {
      _provider = ollama;
      return _provider;
    }

    console.error('[Synapse] Ollama nicht erreichbar, versuche OpenAI Fallback...');
    if (config.embeddings.openai.apiKey) {
      const preset = PROVIDER_PRESETS['openai'];
      const openai = new OpenAICompatibleProvider({
        name: 'openai',
        apiKey: config.embeddings.openai.apiKey,
        model: config.embeddings.model || preset.defaultModel,
        baseURL: preset.baseURL,
      });
      if (await openai.testConnection()) {
        _provider = openai;
        return _provider;
      }
    }

    throw new Error('Kein Embedding Provider erreichbar (Ollama und OpenAI fehlgeschlagen)');
  }

  // Alle anderen Provider
  const provider = createProvider(providerName, config);
  if (!(await provider.testConnection())) {
    throw new Error(`Embedding Provider "${providerName}" nicht erreichbar`);
  }

  _provider = provider;
  return _provider;
}

/**
 * Generiert Embedding fuer einen Text
 */
export async function embed(text: string): Promise<number[]> {
  const provider = await getEmbeddingProvider();
  return provider.embed(text);
}

/**
 * Generiert Embeddings fuer mehrere Texte
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const provider = await getEmbeddingProvider();
  return provider.embedBatch(texts);
}

/**
 * Prueft ob der aktuelle Provider Multimodal-Embeddings unterstuetzt
 */
export async function supportsMultimodal(): Promise<boolean> {
  const provider = await getEmbeddingProvider();
  return typeof provider.embedMedia === 'function';
}

/**
 * Generiert Embedding fuer eine Medien-Datei (Bild/Video)
 * Nur verfuegbar bei multimodalen Providern (Google Gemini)
 */
export async function embedMedia(data: Buffer, mimeType: string): Promise<number[]> {
  const provider = await getEmbeddingProvider();
  if (!provider.embedMedia) {
    throw new Error(
      `Provider "${provider.name}" unterstuetzt keine Multimodal-Embeddings. ` +
      `Setze EMBEDDING_PROVIDER=google fuer Bild/Video-Support.`
    );
  }
  return provider.embedMedia(data, mimeType);
}

/**
 * Ermittelt die Vektor-Dimension des aktuellen Embedding-Modells
 * Ergebnis wird gecached fuer die Prozess-Lebensdauer
 */
export async function getEmbeddingDimension(): Promise<number> {
  if (_cachedDimension !== null) return _cachedDimension;

  const provider = await getEmbeddingProvider();
  const testVector = await provider.embed('synapse dimension detection');
  _cachedDimension = testVector.length;
  console.error(`[Synapse] Erkannte Embedding-Dimension: ${_cachedDimension}`);
  return _cachedDimension;
}

/**
 * Setzt den Provider zurueck (fuer Tests)
 */
export function resetEmbeddingProvider(): void {
  _provider = null;
  _cachedDimension = null;
}
