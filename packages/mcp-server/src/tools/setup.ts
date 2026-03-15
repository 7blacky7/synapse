/**
 * Synapse MCP - Setup Wizard
 * Interaktiver Projekt-Setup fuer neue Projekte ohne bestehende Regeln
 */

import * as fs from 'fs';
import * as path from 'path';
import { setProjectStatus } from '@synapse/core';
import type { DetectedTechnology } from '@synapse/core';

/** Eine Setup-Frage die dem User gestellt wird */
export interface SetupQuestion {
  id: string;
  question: string;
  memoryName: string;
  category: 'documentation' | 'rules' | 'architecture' | 'decision';
  tags: string[];
  hint?: string;
  default?: string;
}

/**
 * Liest die ersten 500 Zeichen einer README.md im Projekt
 */
export function readReadmeExcerpt(projectPath: string): string | null {
  const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];

  for (const candidate of candidates) {
    const readmePath = path.join(projectPath, candidate);
    try {
      if (fs.existsSync(readmePath)) {
        const content = fs.readFileSync(readmePath, 'utf-8');
        return content.slice(0, 500);
      }
    } catch {
      // Datei nicht lesbar - weiter
    }
  }

  return null;
}

/** Return-Typ von buildSetupWizard */
export interface SetupWizardResult {
  phase: 'initial' | 'post-indexing';
  questions: SetupQuestion[];
  detectedContext: {
    technologies: DetectedTechnology[];
    readmeExcerpt: string | null;
  };
  instructions: string;
}

/**
 * Baut den Setup-Wizard fuer eine bestimmte Phase
 */
export function buildSetupWizard(
  phase: 'initial' | 'post-indexing',
  technologies: DetectedTechnology[],
  readmeExcerpt: string | null
): SetupWizardResult {
  const techList = technologies.map(t => t.name).join(', ');
  const techHint = techList ? `Erkannte Technologien: ${techList}` : undefined;

  const questions: SetupQuestion[] = [];

  if (phase === 'initial') {
    questions.push({
      id: 'purpose',
      question: 'Was ist der Zweck dieses Projekts?',
      memoryName: 'projekt-beschreibung',
      category: 'documentation',
      tags: ['setup'],
      hint: readmeExcerpt
        ? `Aus README: "${readmeExcerpt.slice(0, 200)}..."`
        : undefined,
      default: readmeExcerpt
        ? readmeExcerpt.split('\n').filter(l => l.trim()).slice(0, 3).join(' ')
        : undefined,
    });

    questions.push({
      id: 'standards',
      question: 'Welche Coding-Standards gelten?',
      memoryName: 'projekt-regeln',
      category: 'rules',
      tags: ['setup'],
      hint: techHint,
    });

    questions.push({
      id: 'commits',
      question: 'Welche Commit-Konventionen?',
      memoryName: 'commit-konventionen',
      category: 'rules',
      tags: ['setup'],
      hint: 'z.B. Conventional Commits, Deutsch/Englisch, Prefix-Schema',
    });

    questions.push({
      id: 'skills',
      question: 'Relevante Skills/Frameworks?',
      memoryName: 'verfuegbare-skills',
      category: 'rules',
      tags: ['setup', 'coordinator-only'],
      hint: techHint,
    });
  } else {
    // post-indexing
    questions.push({
      id: 'architecture',
      question: 'Architektur-Uebersicht?',
      memoryName: 'architektur-uebersicht',
      category: 'architecture',
      tags: ['setup'],
      hint: techHint,
    });

    questions.push({
      id: 'decisions',
      question: 'Design-Entscheidungen?',
      memoryName: 'design-entscheidungen',
      category: 'decision',
      tags: ['setup'],
    });

    questions.push({
      id: 'agent-rules',
      question: 'Agenten-spezifische Regeln?',
      memoryName: 'agenten-regeln',
      category: 'rules',
      tags: ['setup'],
      hint: 'z.B. Naming, Kommunikation, Verbotene Aktionen',
    });
  }

  const phaseLabel = phase === 'initial' ? 'Ersteinrichtung' : 'Nach-Indexierung';
  const instructions = `# Projekt-Setup: ${phaseLabel}

Dieses Projekt hat noch keine gespeicherten Regeln. Bitte beantworte die folgenden Fragen,
damit zukuenftige Agenten die Projekt-Konventionen kennen.

${techHint ? `**${techHint}**\n` : ''}${readmeExcerpt ? `**README-Auszug:** ${readmeExcerpt.slice(0, 150)}...\n` : ''}
Fuer jede beantwortete Frage wird ein Memory mit write_memory gespeichert.
Wenn alle Fragen beantwortet sind, rufe \`complete_setup\` auf.`;

  return {
    phase,
    questions,
    detectedContext: {
      technologies,
      readmeExcerpt,
    },
    instructions,
  };
}

/**
 * Schliesst eine Setup-Phase ab und setzt den Status
 */
export function completeSetup(
  projectPath: string,
  phase: 'initial' | 'post-indexing'
): { success: boolean; message: string; nextPhase: string } {
  if (phase === 'initial') {
    setProjectStatus(projectPath, { setupPhase: 'initial-done' });
    return {
      success: true,
      message: 'Initial-Setup abgeschlossen. Nach der Code-Indexierung kann das Post-Indexing-Setup gestartet werden.',
      nextPhase: 'initial-done',
    };
  } else {
    setProjectStatus(projectPath, { setupPhase: 'complete' });
    return {
      success: true,
      message: 'Projekt-Setup vollstaendig abgeschlossen. Alle Regeln sind gespeichert.',
      nextPhase: 'complete',
    };
  }
}

/**
 * MCP-Tool Wrapper fuer complete_setup
 */
export async function completeSetupTool(
  project: string,
  phase: 'initial' | 'post-indexing',
  projectPath: string
): Promise<{ success: boolean; message: string; nextPhase: string }> {
  return completeSetup(projectPath, phase);
}
