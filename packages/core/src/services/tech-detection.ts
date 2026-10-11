/**
 * MODUL: Technology Detection
 * ZWECK: Erkennt verwendete Frameworks und Bibliotheken in einem Projekt fuer automatische Docs-Indexierung
 *
 * ZWEI WEGE, EINE REGEL (P12-T17):
 *   - detectTechnologiesAusInhalten(manifeste, importe) — der eigentliche Erkenner. Arbeitet NUR auf
 *     uebergebenen Inhalten, kennt kein Dateisystem. Damit laeuft er auch in der REST-API auf Unraid,
 *     wo der PC-Pfad des Projekts nicht existiert (Quelle dort: code_files.content + code_symbols,
 *     siehe context7-automatik.ts).
 *   - detectTechnologies(projectPath) — duenner FS-Wrapper fuer den lokalen MCP-Server: liest die
 *     Manifeste von der Platte und gibt sie an den Inhalts-Erkenner weiter.
 *
 * FILTER: Erkannt wird NUR, was in den Listen bekannter Pakete steht (KNOWN_NODE, KNOWN_PYTHON,
 *   KONFIG_DATEIEN). Builtins (fs, path, os, sys, node:*), @types/*, beliebige Plugins usw. kommen
 *   deshalb nie heraus. Eine Bibliothek, die NUR als devDependency steht, bekommt confidence 'low'.
 *
 * INPUT:
 *   - projectPath: string - Absoluter Pfad zum Projektverzeichnis (nur FS-Wrapper)
 *   - manifeste: ManifestInhalt[] - { pfad, inhalt } der Manifest-/Konfigurationsdateien
 *   - importe?: ImportQuelle[] - { modul, endung } aus den Import-Symbolen des Parsers
 *
 * OUTPUT:
 *   - DetectedTechnology[]: Liste mit { name, version?, type, confidence, source }
 *     — type: 'framework' | 'library' | 'language' | 'tool'
 *     — confidence: 'high' (Manifest/Konfig) | 'medium' (nur Import) | 'low' (nur devDependency)
 *     — source: Datei wo gefunden (z.B. "package.json", "requirements.txt", "imports")
 *
 * NEBENEFFEKTE:
 *   - Filesystem: NUR der Wrapper detectTechnologies liest package.json, requirements.txt usw.
 *
 * ABHAENGIGKEITEN: keine externen
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

/** Inhalt einer Manifest- oder Konfigurationsdatei (Pfad relativ, nur der Dateiname zaehlt). */
export interface ManifestInhalt {
  pfad: string;
  inhalt: string;
}

/** Ein Import aus code_symbols: Modul-Bezeichner (value) + Dateiendung der importierenden Datei. */
export interface ImportQuelle {
  modul: string;
  endung: string;
}

type TechInfo = { type: DetectedTechnology['type']; displayName?: string };

/** Dateinamen, deren INHALT ausgewertet wird. */
export const MANIFEST_DATEINAMEN: readonly string[] = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
];

/** Dateinamen, deren blosses VORHANDENSEIN eine Technologie belegt. */
const KONFIG_DATEIEN: Record<string, { name: string; type: DetectedTechnology['type']; source: string }> = {
  'tailwind.config.js': { name: 'Tailwind CSS', type: 'library', source: 'tailwind.config' },
  'tailwind.config.ts': { name: 'Tailwind CSS', type: 'library', source: 'tailwind.config' },
  'vite.config.js': { name: 'Vite', type: 'tool', source: 'vite.config' },
  'vite.config.ts': { name: 'Vite', type: 'tool', source: 'vite.config' },
  'next.config.js': { name: 'Next.js', type: 'framework', source: 'next.config' },
  'next.config.mjs': { name: 'Next.js', type: 'framework', source: 'next.config' },
  'tsconfig.json': { name: 'TypeScript', type: 'language', source: 'tsconfig.json' },
  'eslintrc.js': { name: 'ESLint', type: 'tool', source: 'eslintrc.js' },
  '.eslintrc.json': { name: 'ESLint', type: 'tool', source: '.eslintrc.json' },
  '.eslintrc.yml': { name: 'ESLint', type: 'tool', source: '.eslintrc.yml' },
  'eslint.config.js': { name: 'ESLint', type: 'tool', source: 'eslint.config.js' },
  'Dockerfile': { name: 'Docker', type: 'tool', source: 'Dockerfile' },
};

/** Alle Dateinamen, die der Erkenner braucht (Manifeste + Konfig) — fuer die PG-Abfrage. */
export const ERKENNUNGS_DATEINAMEN: readonly string[] = [
  ...MANIFEST_DATEINAMEN,
  ...Object.keys(KONFIG_DATEIEN),
];

// Bekannte Frameworks/Libraries (npm-Paketnamen)
const KNOWN_NODE: Record<string, TechInfo> = {
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

  // Datenbank/ORM — Client-Bibliotheken unter ihrem PAKETNAMEN, nicht dem des Servers: sonst holt
  // die Context7-Automatik die Server-Doku (PostgreSQL, MySQL, SQLite) fuer ein Projekt, das nur
  // den Client benutzt (P12-T17-Fix 11.10.2026)
  'prisma': { type: 'library' },
  'drizzle-orm': { type: 'library', displayName: 'Drizzle' },
  'typeorm': { type: 'library', displayName: 'TypeORM' },
  'mongoose': { type: 'library' },
  'sequelize': { type: 'library' },
  'pg': { type: 'library', displayName: 'node-postgres' },
  'mysql2': { type: 'library' },
  'better-sqlite3': { type: 'library' },
  'redis': { type: 'library', displayName: 'Redis' },
  'ioredis': { type: 'library' },

  // Vektor-Datenbanken
  '@qdrant/js-client-rest': { type: 'library', displayName: 'Qdrant' },
  'chromadb': { type: 'library', displayName: 'ChromaDB' },
  '@pinecone-database/pinecone': { type: 'library', displayName: 'Pinecone' },
  'weaviate-ts-client': { type: 'library', displayName: 'Weaviate' },

  // AI/LLM SDKs
  '@anthropic-ai/sdk': { type: 'library', displayName: 'Anthropic SDK' },
  'openai': { type: 'library', displayName: 'OpenAI SDK' },
  '@google/generative-ai': { type: 'library', displayName: 'Google AI SDK' },
  'langchain': { type: 'library', displayName: 'LangChain' },
  '@modelcontextprotocol/sdk': { type: 'library', displayName: 'MCP SDK' },

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

// Bekannte Python-Pakete (Distributions- bzw. Importname)
const KNOWN_PYTHON: Record<string, TechInfo> = {
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

// Endungen, deren Importe npm-Pakete sind bzw. Python-Module
const NODE_ENDUNGEN = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro']);
const PYTHON_ENDUNGEN = new Set(['py', 'pyi']);

/**
 * Erkennt Technologien in einem Projekt (FS-Wrapper).
 * Liest die Manifeste von der Platte und reicht sie an detectTechnologiesAusInhalten weiter.
 */
export async function detectTechnologies(projectPath: string): Promise<DetectedTechnology[]> {
  const manifeste: ManifestInhalt[] = [];
  const lies = (relativ: string): void => {
    const voll = path.join(projectPath, relativ);
    try {
      if (fs.existsSync(voll) && fs.statSync(voll).isFile()) {
        manifeste.push({ pfad: relativ, inhalt: fs.readFileSync(voll, 'utf-8') });
      }
    } catch {
      // Datei nicht lesbar — ueberspringen
    }
  };

  for (const name of ERKENNUNGS_DATEINAMEN) lies(name);

  // Monorepo: Workspace-Packages scannen (nur der FS-Weg braucht das — in PG liegen alle package.json)
  const root = manifeste.find((m) => m.pfad === 'package.json');
  if (root) {
    let workspaces: unknown = [];
    try { workspaces = JSON.parse(root.inhalt).workspaces || []; } catch { workspaces = []; }
    for (const ws of Array.isArray(workspaces) ? workspaces : []) {
      if (typeof ws !== 'string') continue;
      const wsBase = ws.replace(/\/\*$/, '');
      const wsDir = path.join(projectPath, wsBase);
      try {
        if (fs.existsSync(wsDir) && fs.statSync(wsDir).isDirectory()) {
          for (const entry of fs.readdirSync(wsDir)) {
            lies(path.join(wsBase, entry, 'package.json'));
          }
        }
      } catch {
        // Workspace-Verzeichnis nicht lesbar
      }
    }
  }

  return detectTechnologiesAusInhalten(manifeste);
}

/**
 * Erkennt Technologien aus Datei-INHALTEN — ohne Dateisystem.
 * Manifeste werden am Dateinamen erkannt (egal in welchem Unterordner), Importe ergaenzen mit
 * confidence 'medium' (Bibliothek wird benutzt, steht aber in keinem gefundenen Manifest).
 */
export function detectTechnologiesAusInhalten(
  manifeste: ManifestInhalt[],
  importe: ImportQuelle[] = [],
): DetectedTechnology[] {
  const technologies: DetectedTechnology[] = [];

  for (const m of manifeste) {
    const name = m.pfad.split(/[/\\]/).pop() ?? m.pfad;
    switch (name) {
      case 'package.json': {
        try {
          technologies.push(...detectFromPackageJson(JSON.parse(m.inhalt)));
        } catch {
          // Kaputtes package.json — nicht abbrechen, restliche Manifeste zaehlen weiter
        }
        break;
      }
      case 'requirements.txt':
        technologies.push(...detectFromRequirements(m.inhalt));
        break;
      case 'pyproject.toml':
        technologies.push(...detectFromPyproject(m.inhalt));
        break;
      case 'Cargo.toml':
        technologies.push({ name: 'rust', type: 'language', confidence: 'high', source: 'Cargo.toml' });
        break;
      case 'go.mod':
        technologies.push({ name: 'go', type: 'language', confidence: 'high', source: 'go.mod' });
        break;
      default: {
        const konfig = KONFIG_DATEIEN[name];
        if (konfig) {
          technologies.push({ name: konfig.name, type: konfig.type, confidence: 'high', source: konfig.source });
        }
      }
    }
  }

  technologies.push(...detectFromImports(importe));

  // Duplikate entfernen
  return deduplicateTechnologies(technologies);
}

/** Ordnet einen npm-Paketnamen einem bekannten Eintrag zu (gleiche Regel wie fuer package.json). */
function ordneNodePaketZu(dep: string): { key: string; info: TechInfo } | null {
  const depName = dep.replace('@', '').split('/')[0];
  for (const [techKey, techInfo] of Object.entries(KNOWN_NODE)) {
    if (dep === techKey || dep.startsWith(`@${techKey}/`) || depName === techKey) {
      return { key: techKey, info: techInfo };
    }
  }
  return null;
}

/**
 * Erkennt Technologien aus package.json
 */
function detectFromPackageJson(packageJson: any): DetectedTechnology[] {
  const technologies: DetectedTechnology[] = [];
  const deps: Record<string, unknown> = packageJson?.dependencies ?? {};
  const allDeps: Record<string, unknown> = {
    ...packageJson?.devDependencies,
    ...deps,
  };

  for (const [dep, version] of Object.entries(allDeps)) {
    const treffer = ordneNodePaketZu(dep);
    if (treffer) {
      // Eine Bibliothek, die NUR als devDependency auftaucht (Typen, Test-Helfer, Build-Zubehoer),
      // gehoert nicht zur Laufzeit -> confidence 'low' (die Context7-Automatik ignoriert sie).
      // Frameworks und Tools zaehlen auch als devDependency voll.
      const nurDev = !(dep in deps);
      technologies.push({
        name: treffer.info.displayName || treffer.key,
        version: typeof version === 'string' ? cleanVersion(version) : undefined,
        type: treffer.info.type,
        confidence: nurDev && treffer.info.type === 'library' ? 'low' : 'high',
        source: 'package.json',
      });
    }
  }

  // TypeScript erkennen
  const typescript = allDeps['typescript'];
  if (typeof typescript === 'string') {
    technologies.push({
      name: 'TypeScript',
      version: cleanVersion(typescript),
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

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith('#')) continue;

    for (const [techKey, techInfo] of Object.entries(KNOWN_PYTHON)) {
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
 * Erkennt Technologien aus pyproject.toml (PEP 621 dependencies und Poetry-Tabellen).
 * Bewusst ohne TOML-Parser: es reicht, bekannte Paketnamen als Abhaengigkeit zu finden.
 */
function detectFromPyproject(inhalt: string): DetectedTechnology[] {
  const technologies: DetectedTechnology[] = [];
  const text = inhalt.toLowerCase();

  for (const [techKey, techInfo] of Object.entries(KNOWN_PYTHON)) {
    // "fastapi>=0.110" bzw. "fastapi" in einer Liste oder fastapi = "^0.110" in einer Poetry-Tabelle
    const muster = new RegExp(
      `(?:^|["'\\s])${techKey}(?:\\[[^\\]]*\\])?(?=[\\s"',=<>~!\\]]|$)\\s*(?:([=<>~!^]=?\\s*[^"',\\s\\]]+)|=\\s*["']([^"']+)["'])?`,
      'm',
    );
    const treffer = text.match(muster);
    if (treffer) {
      const roh = (treffer[1] ?? treffer[2] ?? '').replace(/^[=<>~!^]+/, '').trim();
      technologies.push({
        name: techInfo.displayName || techKey,
        version: roh || undefined,
        type: techInfo.type,
        confidence: 'high',
        source: 'pyproject.toml',
      });
    }
  }

  technologies.push({ name: 'Python', type: 'language', confidence: 'high', source: 'pyproject.toml' });
  return technologies;
}

/**
 * Erkennt Technologien aus Import-Symbolen (code_symbols, symbol_type 'import', value = Modul).
 * Relative Importe und node:-Builtins zaehlen nicht. Nur bekannte Pakete, damit die Liste begrenzt bleibt.
 */
function detectFromImports(importe: ImportQuelle[]): DetectedTechnology[] {
  const technologies: DetectedTechnology[] = [];

  for (const imp of importe) {
    const modul = imp.modul.trim();
    if (!modul || modul.startsWith('.') || modul.startsWith('/')) continue;
    const endung = imp.endung.toLowerCase();

    if (NODE_ENDUNGEN.has(endung)) {
      if (modul.startsWith('node:')) continue;
      // Paketname: "@scope/name/unterpfad" -> "@scope/name", "name/unterpfad" -> "name"
      const teile = modul.split('/');
      const paket = modul.startsWith('@') ? teile.slice(0, 2).join('/') : teile[0];
      const treffer = ordneNodePaketZu(paket);
      if (treffer) {
        technologies.push({
          name: treffer.info.displayName || treffer.key,
          type: treffer.info.type,
          confidence: 'medium',
          source: 'imports',
        });
      }
    } else if (PYTHON_ENDUNGEN.has(endung)) {
      const paket = modul.split('.')[0].toLowerCase();
      const info = KNOWN_PYTHON[paket];
      if (info) {
        technologies.push({ name: info.displayName || paket, type: info.type, confidence: 'medium', source: 'imports' });
      }
    }
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
