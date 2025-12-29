/**
 * Synapse Core - Technology Detection
 * Erkennt verwendete Technologien in einem Projekt
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DetectedTechnology {
  name: string;
  version?: string;
  type: 'framework' | 'library' | 'language' | 'tool';
  confidence: 'high' | 'medium' | 'low';
  source: string; // Wo gefunden (package.json, imports, etc.)
}

/**
 * Erkennt Technologien in einem Projekt
 */
export async function detectTechnologies(projectPath: string): Promise<DetectedTechnology[]> {
  const technologies: DetectedTechnology[] = [];

  // 1. package.json analysieren (Node.js Projekte)
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    technologies.push(...detectFromPackageJson(packageJson));
  }

  // 2. requirements.txt analysieren (Python Projekte)
  const requirementsPath = path.join(projectPath, 'requirements.txt');
  if (fs.existsSync(requirementsPath)) {
    const requirements = fs.readFileSync(requirementsPath, 'utf-8');
    technologies.push(...detectFromRequirements(requirements));
  }

  // 3. Cargo.toml analysieren (Rust Projekte)
  const cargoPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    technologies.push({
      name: 'rust',
      type: 'language',
      confidence: 'high',
      source: 'Cargo.toml',
    });
  }

  // 4. go.mod analysieren (Go Projekte)
  const goModPath = path.join(projectPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    technologies.push({
      name: 'go',
      type: 'language',
      confidence: 'high',
      source: 'go.mod',
    });
  }

  // 5. Konfigurationsdateien pruefen
  technologies.push(...detectFromConfigFiles(projectPath));

  // Duplikate entfernen
  return deduplicateTechnologies(technologies);
}

/**
 * Erkennt Technologien aus package.json
 */
function detectFromPackageJson(packageJson: any): DetectedTechnology[] {
  const technologies: DetectedTechnology[] = [];
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // Bekannte Frameworks/Libraries
  const knownTech: Record<string, { type: DetectedTechnology['type']; displayName?: string }> = {
    // Frontend Frameworks
    'react': { type: 'framework' },
    'vue': { type: 'framework' },
    'angular': { type: 'framework' },
    'svelte': { type: 'framework' },
    'next': { type: 'framework', displayName: 'Next.js' },
    'nuxt': { type: 'framework', displayName: 'Nuxt' },
    'gatsby': { type: 'framework' },
    'remix': { type: 'framework' },
    'astro': { type: 'framework' },

    // Backend Frameworks
    'express': { type: 'framework' },
    'fastify': { type: 'framework' },
    'koa': { type: 'framework' },
    'hono': { type: 'framework' },
    'nestjs': { type: 'framework', displayName: 'NestJS' },

    // Styling
    'tailwindcss': { type: 'library', displayName: 'Tailwind CSS' },
    'styled-components': { type: 'library' },
    '@emotion/react': { type: 'library', displayName: 'Emotion' },
    'sass': { type: 'tool' },

    // State Management
    'redux': { type: 'library' },
    'zustand': { type: 'library' },
    'jotai': { type: 'library' },
    'recoil': { type: 'library' },
    'mobx': { type: 'library' },
    'pinia': { type: 'library' },

    // Testing
    'jest': { type: 'tool' },
    'vitest': { type: 'tool' },
    'playwright': { type: 'tool' },
    'cypress': { type: 'tool' },
    'mocha': { type: 'tool' },

    // Build Tools
    'vite': { type: 'tool' },
    'webpack': { type: 'tool' },
    'esbuild': { type: 'tool' },
    'rollup': { type: 'tool' },
    'turbo': { type: 'tool', displayName: 'Turborepo' },

    // Datenbank/ORM
    'prisma': { type: 'library' },
    'drizzle-orm': { type: 'library', displayName: 'Drizzle' },
    'typeorm': { type: 'library', displayName: 'TypeORM' },
    'mongoose': { type: 'library' },
    'sequelize': { type: 'library' },

    // API/GraphQL
    'graphql': { type: 'library', displayName: 'GraphQL' },
    '@apollo/client': { type: 'library', displayName: 'Apollo Client' },
    'trpc': { type: 'library', displayName: 'tRPC' },

    // Utilities
    'zod': { type: 'library' },
    'lodash': { type: 'library' },
    'date-fns': { type: 'library' },
    'axios': { type: 'library' },
  };

  for (const [dep, version] of Object.entries(allDeps)) {
    const depName = dep.replace('@', '').split('/')[0];

    for (const [techKey, techInfo] of Object.entries(knownTech)) {
      if (dep === techKey || dep.startsWith(`@${techKey}/`) || depName === techKey) {
        technologies.push({
          name: techInfo.displayName || techKey,
          version: cleanVersion(version as string),
          type: techInfo.type,
          confidence: 'high',
          source: 'package.json',
        });
        break;
      }
    }
  }

  // TypeScript erkennen
  if (allDeps['typescript']) {
    technologies.push({
      name: 'TypeScript',
      version: cleanVersion(allDeps['typescript']),
      type: 'language',
      confidence: 'high',
      source: 'package.json',
    });
  }

  return technologies;
}

/**
 * Erkennt Technologien aus requirements.txt
 */
function detectFromRequirements(requirements: string): DetectedTechnology[] {
  const technologies: DetectedTechnology[] = [];
  const lines = requirements.split('\n');

  const knownPython: Record<string, { type: DetectedTechnology['type']; displayName?: string }> = {
    'django': { type: 'framework', displayName: 'Django' },
    'flask': { type: 'framework', displayName: 'Flask' },
    'fastapi': { type: 'framework', displayName: 'FastAPI' },
    'pytorch': { type: 'library', displayName: 'PyTorch' },
    'torch': { type: 'library', displayName: 'PyTorch' },
    'tensorflow': { type: 'library', displayName: 'TensorFlow' },
    'numpy': { type: 'library', displayName: 'NumPy' },
    'pandas': { type: 'library', displayName: 'Pandas' },
    'sqlalchemy': { type: 'library', displayName: 'SQLAlchemy' },
    'pytest': { type: 'tool' },
  };

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith('#')) continue;

    for (const [techKey, techInfo] of Object.entries(knownPython)) {
      if (trimmed.startsWith(techKey)) {
        const versionMatch = trimmed.match(/[=<>]+(.+)/);
        technologies.push({
          name: techInfo.displayName || techKey,
          version: versionMatch ? versionMatch[1].trim() : undefined,
          type: techInfo.type,
          confidence: 'high',
          source: 'requirements.txt',
        });
        break;
      }
    }
  }

  // Python als Sprache hinzufuegen
  if (technologies.length > 0) {
    technologies.push({
      name: 'Python',
      type: 'language',
      confidence: 'high',
      source: 'requirements.txt',
    });
  }

  return technologies;
}

/**
 * Erkennt Technologien aus Konfigurationsdateien
 */
function detectFromConfigFiles(projectPath: string): DetectedTechnology[] {
  const technologies: DetectedTechnology[] = [];

  // tailwind.config.js/ts
  if (
    fs.existsSync(path.join(projectPath, 'tailwind.config.js')) ||
    fs.existsSync(path.join(projectPath, 'tailwind.config.ts'))
  ) {
    technologies.push({
      name: 'Tailwind CSS',
      type: 'library',
      confidence: 'high',
      source: 'tailwind.config',
    });
  }

  // vite.config.js/ts
  if (
    fs.existsSync(path.join(projectPath, 'vite.config.js')) ||
    fs.existsSync(path.join(projectPath, 'vite.config.ts'))
  ) {
    technologies.push({
      name: 'Vite',
      type: 'tool',
      confidence: 'high',
      source: 'vite.config',
    });
  }

  // next.config.js/mjs
  if (
    fs.existsSync(path.join(projectPath, 'next.config.js')) ||
    fs.existsSync(path.join(projectPath, 'next.config.mjs'))
  ) {
    technologies.push({
      name: 'Next.js',
      type: 'framework',
      confidence: 'high',
      source: 'next.config',
    });
  }

  // tsconfig.json
  if (fs.existsSync(path.join(projectPath, 'tsconfig.json'))) {
    technologies.push({
      name: 'TypeScript',
      type: 'language',
      confidence: 'high',
      source: 'tsconfig.json',
    });
  }

  // .eslintrc*
  const eslintFiles = ['eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js'];
  for (const file of eslintFiles) {
    if (fs.existsSync(path.join(projectPath, file))) {
      technologies.push({
        name: 'ESLint',
        type: 'tool',
        confidence: 'high',
        source: file,
      });
      break;
    }
  }

  // Dockerfile
  if (fs.existsSync(path.join(projectPath, 'Dockerfile'))) {
    technologies.push({
      name: 'Docker',
      type: 'tool',
      confidence: 'high',
      source: 'Dockerfile',
    });
  }

  return technologies;
}

/**
 * Bereinigt Versionsstrings
 */
function cleanVersion(version: string): string {
  return version.replace(/[\^~>=<]/g, '').trim();
}

/**
 * Entfernt Duplikate und behaelt die mit hoechster Confidence
 */
function deduplicateTechnologies(technologies: DetectedTechnology[]): DetectedTechnology[] {
  const map = new Map<string, DetectedTechnology>();

  for (const tech of technologies) {
    const key = tech.name.toLowerCase();
    const existing = map.get(key);

    if (!existing || getConfidenceScore(tech.confidence) > getConfidenceScore(existing.confidence)) {
      map.set(key, tech);
    }
  }

  return Array.from(map.values());
}

function getConfidenceScore(confidence: DetectedTechnology['confidence']): number {
  switch (confidence) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}
