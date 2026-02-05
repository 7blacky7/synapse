/**
 * ============================================================================
 * MODUL: Chat Types
 * ============================================================================
 * ZWECK: Gemeinsame Types und Interfaces fuer alle Chat-Module
 * INPUT: -
 * OUTPUT: TypeScript Types/Interfaces
 * ABHÄNGIGKEITEN: Keine
 * HINWEISE: Wird von allen Chat-Submodulen importiert
 * ============================================================================
 */

/**
 * Request-Body fuer den Haupt-Chat-Endpoint
 */
export interface ChatRequest {
  message: string;
  project?: string;
  image?: string;  // Base64 encoded
  sessionId?: string;
}

/**
 * Einzelne Kontext-Quelle (Memory, Thought oder Code)
 */
export interface ContextSource {
  source: string;
  preview: string;
}

/**
 * Gesammelter Kontext aus allen Quellen
 */
export interface GatheredContext {
  memories: ContextSource[];
  thoughts: ContextSource[];
  code: ContextSource[];
}

/**
 * Request fuer Bildanalyse
 */
export interface ImageAnalyzeRequest {
  image: string;
  sessionId?: string;
}

/**
 * Request fuer Bildverarbeitung
 */
export interface ImageProcessRequest {
  sessionId: string;
  action: string;
  params?: Record<string, unknown>;
}

/**
 * Session-Informationen
 */
export interface SessionInfo {
  id: string;
  preview: string;
  hasImage: boolean;
}

// ============================================================================
// Session-Storage (global fuer alle Chat-Module)
// ============================================================================

/**
 * Speichert temporaere Bildpfade pro Session
 * Wird von mehreren Modulen verwendet
 */
export const sessionImages = new Map<string, string>();
