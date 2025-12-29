/**
 * Synapse Core - Qdrant Client
 * Wrapper fuer Qdrant Vektor-Datenbank
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { getConfig } from '../config.js';

let _client: QdrantClient | null = null;

/**
 * Gibt den Qdrant Client zurueck (Singleton)
 * Erstellt Verbindung beim ersten Aufruf
 */
export function getQdrantClient(): QdrantClient {
  if (!_client) {
    const config = getConfig();

    _client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
    });

    console.log(`[Synapse] Qdrant Client verbunden mit ${config.qdrant.url}`);
  }

  return _client;
}

/**
 * Testet die Verbindung zu Qdrant
 * @returns true wenn Verbindung erfolgreich
 */
export async function testQdrantConnection(): Promise<boolean> {
  try {
    const client = getQdrantClient();
    const result = await client.getCollections();
    console.log(`[Synapse] Qdrant erreichbar - ${result.collections.length} Collections gefunden`);
    return true;
  } catch (error) {
    console.error('[Synapse] Qdrant nicht erreichbar:', error);
    return false;
  }
}

/**
 * Setzt den Client zurueck (fuer Tests)
 */
export function resetQdrantClient(): void {
  _client = null;
}
