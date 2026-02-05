/**
 * ============================================================================
 * MODUL: Chat Routes (Legacy Re-Export)
 * ============================================================================
 * ZWECK: Kompatibilitaets-Layer fuer bestehende Imports
 * HINWEISE: Diese Datei exportiert aus dem neuen modularen chat/ Verzeichnis
 *           Kann nach Migration aller Imports geloescht werden
 * ============================================================================
 */

// Re-export alles aus dem neuen modularen Aufbau
export { chatRoutes, sessionImages } from './chat/index.js';
export type { ChatRequest, ContextSource, GatheredContext } from './chat/index.js';

// Default export fuer Kompatibilitaet
export { chatRoutes as default } from './chat/index.js';
