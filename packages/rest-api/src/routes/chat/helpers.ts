/**
 * MODUL: Chat Helpers
 * ZWECK: Hilfsfunktionen fuer Intent-Erkennung, Kontextsuche und Fallbacks
 * ABHÄNGIGKEITEN: @synapse/core (searchCode, searchMemories, searchThoughts)
 */

import { searchCode, searchMemories, searchThoughts } from '@synapse/core';
import type { ContextSource, GatheredContext } from './types.js';

// Recall-Patterns fuer "Erinnerst du dich" Anfragen
const RECALL_PATTERNS = [
  /erinnerst du dich/i, /weisst du noch/i, /was weisst du ueber/i,
  /was war das mit/i, /remember/i, /recall/i, /do you know about/i,
];

// Intent-Patterns fuer Bildverarbeitung
const IMAGE_INTENTS: { pattern: RegExp; action: string }[] = [
  { pattern: /analys/i, action: 'analyze' },
  { pattern: /schneide.*aus|ausschneiden|cut|extract/i, action: 'smart-cut' },
  { pattern: /filter|effekt|schwarz.?wei|grau|sepia|blur|scharf/i, action: 'filter' },
  { pattern: /zeig|schau|sieh|look|show/i, action: 'view' },
  { pattern: /beschreib|erklaer|explain|describe|was ist|what is|was siehst|what do you see/i, action: 'describe' },
  { pattern: /hervorheb|markier|beschrift|highlight|label|annotate|zeichne|draw|pfeil|arrow|kreis|circle|text/i, action: 'edit' },
  { pattern: /organ|herz|lunge|leber|niere|magen|gehirn|heart|lung|liver|kidney|stomach|brain/i, action: 'analyze-organs' },
  { pattern: /bild|image|foto|photo|picture/i, action: 'reference' },
];

/** Erkennt ob eine Nachricht eine "Erinnerst du dich" Anfrage ist */
export function isRecallQuery(message: string): boolean {
  return RECALL_PATTERNS.some((p) => p.test(message));
}

/** Erkennt Bildbearbeitungs-Intent aus der Nachricht */
export function detectImageIntent(message: string): string | null {
  for (const { pattern, action } of IMAGE_INTENTS) {
    if (pattern.test(message)) return action;
  }
  return null;
}

/** Extrahiert Suchbegriffe aus einer Recall-Nachricht */
export function extractSearchTerms(message: string): string {
  return message
    .replace(/erinnerst du dich an/i, '')
    .replace(/weisst du noch/i, '')
    .replace(/was weisst du ueber/i, '')
    .replace(/was war das mit/i, '')
    .replace(/do you remember/i, '')
    .replace(/do you recall/i, '')
    .replace(/what do you know about/i, '')
    .replace(/\?/g, '')
    .trim();
}

/** Sammelt Kontext aus Memories, Thoughts und Code */
export async function gatherContext(query: string, project?: string): Promise<GatheredContext> {
  const memories: ContextSource[] = [];
  const thoughts: ContextSource[] = [];
  const code: ContextSource[] = [];

  try {
    const results = await searchMemories(query, project, 3);
    for (const m of results) {
      memories.push({ source: `Memory: ${m.payload.name}`, preview: m.payload.content.substring(0, 200) });
    }
  } catch { /* ignore */ }

  try {
    const results = await searchThoughts(query, project, 3);
    for (const t of results) {
      thoughts.push({ source: `Thought (${t.payload.source})`, preview: t.payload.content.substring(0, 200) });
    }
  } catch { /* ignore */ }

  if (project) {
    try {
      const results = await searchCode(query, project, undefined, 3);
      for (const c of results) {
        code.push({ source: `Code: ${c.payload.file_name}:${c.payload.line_start}`, preview: c.payload.content.substring(0, 200) });
      }
    } catch { /* ignore */ }
  }

  return { memories, thoughts, code };
}

/** Generiert eine Fallback-Antwort wenn Claude nicht verfuegbar ist */
export function generateFallbackResponse(message: string, context: GatheredContext, isRecall: boolean): string {
  const allContext = [...context.memories, ...context.thoughts, ...context.code];

  if (allContext.length === 0) {
    return isRecall
      ? 'Ich habe leider keine Erinnerungen zu diesem Thema gefunden.'
      : 'Ich habe keinen relevanten Kontext zu dieser Anfrage gefunden.';
  }

  const parts: string[] = [
    isRecall ? 'Ja, ich erinnere mich! Hier ist was ich gefunden habe:\n' : 'Hier ist der relevante Kontext:\n'
  ];

  if (context.memories.length > 0) {
    parts.push('\n**Memories:**');
    context.memories.forEach(m => parts.push(`\n- ${m.source}: ${m.preview}...`));
  }
  if (context.thoughts.length > 0) {
    parts.push('\n\n**Gedanken:**');
    context.thoughts.forEach(t => parts.push(`\n- ${t.source}: ${t.preview}...`));
  }
  if (context.code.length > 0) {
    parts.push('\n\n**Code:**');
    context.code.forEach(c => parts.push(`\n- ${c.source}`));
  }

  return parts.join('');
}
