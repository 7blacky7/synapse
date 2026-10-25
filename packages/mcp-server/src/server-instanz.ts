/**
 * P25-T9: Eindeutige ID dieser Server-Instanz als Blattmodul (nur crypto).
 * Lag frueher in server.ts; tools/onboarding.ts importierte sie dort und schloss damit den Zyklus
 * consolidated/<tool>.js -> tools/index.js -> onboarding -> server -> consolidated/index.js
 * (TDZ beim Laden: 'memoryTool' before initialization, seit dem Top-Level-Aufruf ergaenzeAgentTokenParameter P22-T11).
 * server.ts re-exportiert den Wert.
 */
import { randomUUID } from 'crypto';

/** Eindeutige ID dieser Server-Instanz — bei Neustart neu generiert.
 *  Wird fuer Session-basiertes Onboarding verwendet: neue Instance = neues Onboarding. */
export const SERVER_INSTANCE_ID = randomUUID();
