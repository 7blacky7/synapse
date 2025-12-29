/**
 * Synapse Core - Embedding Service
 * Automatische Provider-Auswahl mit Fallback
 */

import { getConfig } from '../config.js';
import { EmbeddingProvider } from './types.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OpenAIEmbeddingProvider } from './openai.js';

export * from './types.js';
export { OllamaEmbeddingProvider } from './ollama.js';
export { OpenAIEmbeddingProvider } from './openai.js';

let _provider: EmbeddingProvider | null = null;

/**
 * Gibt den konfigurierten Embedding Provider zurueck
 * Versucht Fallback auf OpenAI wenn Ollama nicht erreichbar
 */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (_provider) {
    return _provider;
  }

  const config = getConfig();

  // Primaeren Provider versuchen
  if (config.embeddings.provider === 'ollama') {
    const ollama = new OllamaEmbeddingProvider();

    if (await ollama.testConnection()) {
      _provider = ollama;
      return _provider;
    }

    // Fallback auf OpenAI wenn Ollama nicht erreichbar
    console.warn('[Synapse] Ollama nicht erreichbar, versuche OpenAI Fallback...');

    if (config.embeddings.openai.apiKey) {
      const openai = new OpenAIEmbeddingProvider();

      if (await openai.testConnection()) {
        _provider = openai;
        return _provider;
      }
    }

    throw new Error('Kein Embedding Provider erreichbar (Ollama und OpenAI fehlgeschlagen)');
  }

  // OpenAI als primaerer Provider
  if (config.embeddings.provider === 'openai') {
    if (!config.embeddings.openai.apiKey) {
      throw new Error('OpenAI API Key nicht konfiguriert');
    }

    const openai = new OpenAIEmbeddingProvider();

    if (await openai.testConnection()) {
      _provider = openai;
      return _provider;
    }

    throw new Error('OpenAI nicht erreichbar');
  }

  throw new Error(`Unbekannter Embedding Provider: ${config.embeddings.provider}`);
}

/**
 * Generiert Embedding fuer einen Text
 * Convenience-Funktion
 */
export async function embed(text: string): Promise<number[]> {
  const provider = await getEmbeddingProvider();
  return provider.embed(text);
}

/**
 * Generiert Embeddings fuer mehrere Texte
 * Convenience-Funktion
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const provider = await getEmbeddingProvider();
  return provider.embedBatch(texts);
}

/**
 * Setzt den Provider zurueck (fuer Tests)
 */
export function resetEmbeddingProvider(): void {
  _provider = null;
}
