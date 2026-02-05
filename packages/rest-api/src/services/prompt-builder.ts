/**
 * ============================================================================
 * MODUL: prompt-builder.ts
 * ============================================================================
 * ZWECK: Modularer Prompt-Builder für Claude CLI Responses
 *
 * INPUT:
 *   - ContextSource[] für memories, thoughts, code
 *   - Projekt-Name (optional)
 *   - hasImage Flag für Bildverarbeitung
 *
 * OUTPUT:
 *   - Fertig zusammengebauter System-Prompt String
 *
 * ABHÄNGIGKEITEN:
 *   - @synapse/core: getConfig() für CLI-Arbeitsverzeichnis
 *
 * HINWEISE:
 *   - Jede Funktion max 30 LOC
 *   - Umlaute escaped für CLI-Kompatibilität
 * ============================================================================
 */

import { getConfig } from '@synapse/core';

// ============================================================================
// TYPEN
// ============================================================================

export interface ContextSource {
  source: string;
  preview: string;
}

export interface PromptContext {
  memories: ContextSource[];
  thoughts: ContextSource[];
  code: ContextSource[];
}

// ============================================================================
// BASIS-PROMPT SEKTION
// ============================================================================

/**
 * Baut den Basis-System-Prompt (Persoenlichkeit & Memory-System)
 */
export function buildBasePrompt(): string {
  return `Du bist ein hilfreicher Assistent mit Zugriff auf das Synapse-Gedaechtnis-System.
Du hast Zugang zu gespeicherten Memories, Gedanken und Code-Fragmenten des Benutzers.

Antworte freundlich und hilfreich auf Deutsch, es sei denn der Benutzer schreibt auf Englisch.
Beziehe dich auf den bereitgestellten Kontext wenn relevant.

## Deine Faehigkeiten:

### 1. Synapse Memory-System
- Memories durchsuchen und abrufen
- Gedanken (Thoughts) finden
- Code-Fragmente suchen
- "Erinnerst du dich an..." Anfragen beantworten`;
}

// ============================================================================
// BILDBEARBEITUNG SEKTION
// ============================================================================

/**
 * Baut den CLI-Befehle Block für Bildbearbeitung
 */
function buildImageCliCommands(): string {
  return `
**CLI-Befehle (fuehre mit Bash aus):**
\`\`\`bash
# Bild laden (IMMER zuerst!)
python -m ai_photoshop.cli load "BILDPFAD"

# Bild analysieren - gibt Objekte als JSON zurueck
python -m ai_photoshop.cli analyze --method auto

# Objekt auswaehlen (nach analyze)
python -m ai_photoshop.cli select-object 0

# Text/Beschriftung zeichnen
python -m ai_photoshop.cli draw text --params '{"text":"Beschriftung","x":100,"y":50,"color":"red","size":24}'

# Pfeil zeichnen
python -m ai_photoshop.cli draw arrow --params '{"x1":100,"y1":100,"x2":200,"y2":200,"color":"red","thickness":3}'

# Kreis zeichnen
python -m ai_photoshop.cli draw circle --params '{"x":150,"y":150,"radius":50,"color":"yellow","thickness":2}'

# Rechteck zeichnen
python -m ai_photoshop.cli draw rectangle --params '{"x":50,"y":50,"width":100,"height":80,"color":"green","thickness":2}'

# Filter anwenden
python -m ai_photoshop.cli filter grayscale
python -m ai_photoshop.cli filter blur --strength 5

# Als Base64 exportieren (WICHTIG am Ende!)
python -m ai_photoshop.cli to-base64 --format PNG

# Bild speichern
python -m ai_photoshop.cli save "OUTPUT_PFAD"
\`\`\``;
}

/**
 * Baut den Workflow-Block für Bildbearbeitung
 */
function buildImageWorkflow(): string {
  return `
**WORKFLOW fuer Bildbearbeitung:**
1. \`load\` - Bild laden
2. \`analyze\` - Optional: Objekte erkennen
3. \`draw\` - Zeichnen (text, arrow, circle, rectangle)
4. \`to-base64\` - Exportieren

**KRITISCH - Bild-Rueckgabe:**
Am Ende MUSST du:
1. \`python -m ai_photoshop.cli to-base64 --format PNG\` ausfuehren
2. Das Base64-Ergebnis in deine Antwort einbetten als: \`[BILD_BASE64:data:image/png;base64,<DATEN>]\`
Damit zeigt der Chat das bearbeitete Bild direkt an.`;
}

/**
 * Baut die komplette Bildbearbeitung-Capabilities Sektion
 */
export function buildImageCapabilitiesSection(): string {
  const workDir = getConfig().cliWorkDir.replace(/\\/g, '\\\\');
  const intro = `
### 2. Bildbearbeitung (ai_photoshop CLI)
Du kannst Bilder bearbeiten mit der Python CLI. Arbeitsverzeichnis: ${workDir}`;

  return intro + buildImageCliCommands() + buildImageWorkflow();
}

/**
 * Baut Hinweise wenn ein Bild hochgeladen wurde
 */
export function buildImageUploadHints(): string {
  const workDir = getConfig().cliWorkDir.replace(/\\/g, '\\\\');
  return `

**ACHTUNG: BILD VORHANDEN!**
Der User hat ein Bild hochgeladen. Der Pfad steht in der Nachricht.

**Wenn der User das Bild BESCHRIFTEN/MARKIEREN will:**
1. Schau dir das Bild an (Read Tool)
2. Lade es: \`python -m ai_photoshop.cli load "PFAD"\`
3. Zeichne Beschriftungen: \`python -m ai_photoshop.cli draw text --params '{"text":"Label","x":X,"y":Y,"color":"red","size":20}'\`
4. Zeichne Markierungen: \`python -m ai_photoshop.cli draw arrow/circle/rectangle ...\`
5. Exportiere: \`python -m ai_photoshop.cli to-base64 --format PNG\`
6. Fuege das Base64-Ergebnis in deine Antwort ein: [BILD_BASE64:data:image/png;base64,...]

**Wenn der User nur eine BESCHREIBUNG will:**
Beschreibe einfach was du siehst, ohne Tools zu nutzen.

**WICHTIG:** Arbeitsverzeichnis fuer CLI ist ${workDir}`;
}

// ============================================================================
// KONTEXT SEKTIONEN
// ============================================================================

/**
 * Baut die Memories-Sektion aus dem Kontext
 */
export function buildMemoriesSection(memories: ContextSource[]): string {
  if (memories.length === 0) return '';

  const lines = ['\n## Relevante Memories:'];
  for (const m of memories) {
    lines.push(`- ${m.source}: ${m.preview}`);
  }
  return lines.join('\n');
}

/**
 * Baut die Thoughts-Sektion aus dem Kontext
 */
export function buildThoughtsSection(thoughts: ContextSource[]): string {
  if (thoughts.length === 0) return '';

  const lines = ['\n## Relevante Gedanken:'];
  for (const t of thoughts) {
    lines.push(`- ${t.source}: ${t.preview}`);
  }
  return lines.join('\n');
}

/**
 * Baut die Code-Sektion aus dem Kontext
 */
export function buildCodeSection(code: ContextSource[]): string {
  if (code.length === 0) return '';

  const lines = ['\n## Relevanter Code:'];
  for (const c of code) {
    lines.push(`- ${c.source}: ${c.preview}`);
  }
  return lines.join('\n');
}

/**
 * Kombiniert alle Kontext-Sektionen
 */
export function buildContextSection(context: PromptContext): string {
  const parts: string[] = [];

  const memories = buildMemoriesSection(context.memories);
  const thoughts = buildThoughtsSection(context.thoughts);
  const code = buildCodeSection(context.code);

  if (memories) parts.push(memories);
  if (thoughts) parts.push(thoughts);
  if (code) parts.push(code);

  if (parts.length === 0) return '';

  return '\n\n--- KONTEXT AUS SYNAPSE ---' + parts.join('');
}

// ============================================================================
// HAUPTFUNKTION
// ============================================================================

/**
 * Baut den kompletten System-Prompt zusammen
 *
 * @param context - Memories, Thoughts und Code aus Synapse
 * @param project - Optionaler Projektname
 * @param hasImage - Ob ein Bild hochgeladen wurde
 * @returns Fertiger System-Prompt String
 */
export function buildSystemPrompt(
  context: PromptContext,
  project?: string,
  hasImage?: boolean
): string {
  // Basis-Prompt mit Memory-System
  let prompt = buildBasePrompt();

  // Bildbearbeitung-Capabilities
  prompt += buildImageCapabilitiesSection();

  // Bild-Upload Hinweise wenn relevant
  if (hasImage) {
    prompt += buildImageUploadHints();
  }

  // Projekt-Info
  if (project) {
    prompt += `\n\nAktuelles Projekt: ${project}`;
  }

  // Kontext aus Synapse
  prompt += buildContextSection(context);

  return prompt + '\n\n';
}
