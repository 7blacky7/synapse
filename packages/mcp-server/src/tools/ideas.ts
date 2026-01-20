/**
 * Synapse MCP - Projekt-Ideen
 * Automatische Namensgenerierung und Bestaetigungs-Workflow
 */

import { writeMemory, getMemoryByName } from '@synapse/core';
import type { Memory } from '@synapse/core';

/** Temporaerer Speicher fuer unbestaetigte Ideen */
interface PendingIdea {
  content: string;
  project: string;
  suggestedName: string;
  tags: string[];
  createdAt: Date;
}

const pendingIdeas = new Map<string, PendingIdea>();

// Cleanup alte Ideen nach 30 Minuten
setInterval(() => {
  const now = Date.now();
  for (const [id, idea] of pendingIdeas.entries()) {
    if (now - idea.createdAt.getTime() > 30 * 60 * 1000) {
      pendingIdeas.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Generiert einen eindeutigen Namen aus dem Content
 */
function generateIdeaName(content: string): string {
  // Keywords extrahieren (wichtigste Woerter)
  const stopwords = new Set([
    'und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'fuer', 'mit', 'von', 'zu', 'auf',
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'on', 'in', 'is', 'are', 'be',
    'that', 'this', 'it', 'as', 'at', 'by', 'from', 'into', 'of', 'about', 'should',
    'could', 'would', 'will', 'can', 'may', 'might', 'must', 'shall', 'need', 'want',
    'ich', 'du', 'wir', 'sie', 'er', 'es', 'man', 'kann', 'soll', 'will', 'wird',
  ]);

  // Woerter extrahieren
  const words = content
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\u00E4\u00F6\u00FC\u00C4\u00D6\u00DC\u00DF\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));

  // Top Keywords nehmen (max 3)
  const keywords = words.slice(0, 3);

  // Datum hinzufuegen
  const date = new Date().toISOString().split('T')[0];

  // Name generieren
  const namePart = keywords.length > 0 ? keywords.join('-') : 'idea';
  return `idea-${namePart}-${date}`;
}

/**
 * Generiert eine kurze Vorschau des Contents
 */
function generatePreview(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.substring(0, maxLength).trim() + '...';
}

/**
 * Generiert eine eindeutige temporaere ID
 */
function generateTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Speichert eine Projektidee temporaer und schlaegt Namen vor
 */
export async function saveProjectIdea(
  content: string,
  project: string = 'ideas',
  tags: string[] = []
): Promise<{
  success: boolean;
  tempId: string;
  suggestedName: string;
  preview: string;
  project: string;
  confirmationRequired: true;
  message: string;
}> {
  if (!content || content.trim().length === 0) {
    return {
      success: false,
      tempId: '',
      suggestedName: '',
      preview: '',
      project,
      confirmationRequired: true,
      message: 'Content darf nicht leer sein',
    };
  }

  const suggestedName = generateIdeaName(content);
  const tempId = generateTempId();
  const preview = generatePreview(content);

  // Temporaer speichern
  pendingIdeas.set(tempId, {
    content,
    project,
    suggestedName,
    tags,
    createdAt: new Date(),
  });

  return {
    success: true,
    tempId,
    suggestedName,
    preview,
    project,
    confirmationRequired: true,
    message: `Idee vorgemerkt. Name: "${suggestedName}". Bitte mit confirm_idea bestaetigen oder eigenen Namen angeben.`,
  };
}

/**
 * Bestaetigt eine vorgemerkte Idee und speichert sie persistent
 */
export async function confirmIdea(
  tempId: string,
  customName?: string
): Promise<{
  success: boolean;
  memory?: Memory;
  name: string;
  project: string;
  message: string;
}> {
  const pendingIdea = pendingIdeas.get(tempId);

  if (!pendingIdea) {
    return {
      success: false,
      name: '',
      project: '',
      message: `Keine vorgemerkte Idee mit ID "${tempId}" gefunden. Ideen werden nach 30 Minuten automatisch geloescht.`,
    };
  }

  const finalName = customName?.trim() || pendingIdea.suggestedName;

  // Pruefen ob Name schon existiert
  const existing = await getMemoryByName(pendingIdea.project, finalName);
  if (existing) {
    return {
      success: false,
      name: finalName,
      project: pendingIdea.project,
      message: `Ein Memory mit dem Namen "${finalName}" existiert bereits. Bitte anderen Namen waehlen.`,
    };
  }

  // Als Memory speichern
  const memory = await writeMemory(
    pendingIdea.project,
    finalName,
    pendingIdea.content,
    'note',
    [...pendingIdea.tags, 'idea']
  );

  // Aus temporaerem Speicher entfernen
  pendingIdeas.delete(tempId);

  return {
    success: true,
    memory,
    name: finalName,
    project: pendingIdea.project,
    message: `Idee "${finalName}" erfolgreich gespeichert in Projekt "${pendingIdea.project}".`,
  };
}

/**
 * Listet alle vorgemerkten Ideen auf
 */
export function listPendingIdeas(): Array<{
  tempId: string;
  suggestedName: string;
  project: string;
  preview: string;
  createdAt: string;
}> {
  return Array.from(pendingIdeas.entries()).map(([tempId, idea]) => ({
    tempId,
    suggestedName: idea.suggestedName,
    project: idea.project,
    preview: generatePreview(idea.content, 100),
    createdAt: idea.createdAt.toISOString(),
  }));
}

/**
 * Loescht eine vorgemerkte Idee
 */
export function discardIdea(tempId: string): boolean {
  return pendingIdeas.delete(tempId);
}
