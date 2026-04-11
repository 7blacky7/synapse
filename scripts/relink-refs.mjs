#!/usr/bin/env node
// relink-refs.mjs — Cross-File References fuer ein Projekt neu aufbauen
// Nutzung: node scripts/relink-refs.mjs <project>

import { linkCrossFileReferences } from '../packages/core/dist/services/code.js';

const project = process.argv[2];
if (!project) {
  console.error('Usage: node scripts/relink-refs.mjs <project>');
  process.exit(1);
}

try {
  const count = await linkCrossFileReferences(project);
  console.log(`[relink-refs] ${count} Cross-File-Referenzen fuer "${project}" erstellt.`);
  process.exit(0);
} catch (err) {
  console.error('[relink-refs] Fehler:', err);
  process.exit(1);
}
