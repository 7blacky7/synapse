/**
 * P22-T264 (U1, User-Vorgabe thought 2d18aa69): Web-Editor-Entwurf -> gezielte files-Ops genau an den geaenderten Stellen, so wie ein
 * Agent sie schreibt (search_replace mit eindeutigem Suchtext je Aenderungsstelle), nie die ganze Datei ersetzen.
 * Bereiche aus aenderungsBereiche (file-diff.ts, derselbe Zeilen-Diff wie plan_status). Reine Textverarbeitung, weder PG noch FS.
 * Reihenfolge von unten nach oben: jede Op ist auf dem Stand nach den vorherigen Ops eindeutig (files wendet search_replace in
 * Plan-Reihenfolge an). Der Kontext waechst zeilenweise, bis der Suchtext genau einmal vorkommt (Grundlage codex-rea3, Plan 31258).
 * Leere Basis: eine create-Op mit upsert (ohne Inhalt gibt es keinen Suchanker).
 * DEBUG: editor_diff_anker_mehrdeutig | editor_diff_nicht_reproduzierbar nennen den Pfad; der Editor speichert dann nichts.
 */
import { aenderungsBereiche } from './file-diff.js';
import type { FileBatchOp } from './file-batch.js';

export function editorDiffOps(filePath: string, basis: string, entwurf: string): FileBatchOp[] {
  if (basis === entwurf) return [];
  if (basis === '') return [{ action: 'create', upsert: true, file_path: filePath, content: entwurf }];
  const alt = basis.split('\n'), neu = entwurf.split('\n');
  const laufend = [...alt];
  const ops: FileBatchOp[] = [];
  for (const b of [...aenderungsBereiche(alt, neu)].reverse()) {
    const vorher = laufend.join('\n');
    laufend.splice(b.a0, b.a1 - b.a0, ...neu.slice(b.b0, b.b1));
    const nachher = laufend.join('\n');
    if (vorher === nachher) continue;
    let links = 0;
    while (links < vorher.length && links < nachher.length && vorher[links] === nachher[links]) links++;
    let rechts = 0;
    while (rechts < vorher.length - links && rechts < nachher.length - links
      && vorher[vorher.length - 1 - rechts] === nachher[nachher.length - 1 - rechts]) rechts++;
    let start = links, ende = vorher.length - rechts, nachLinks = true;
    const eindeutig = (s: string) => s.length > 0 && vorher.indexOf(s) === vorher.lastIndexOf(s);
    // Abwechselnd eine Zeile davor bzw. danach dazunehmen, bis der Suchtext eindeutig ist (immer Fortschritt, endet spaetestens bei der ganzen Datei).
    while (!eindeutig(vorher.slice(start, ende))) {
      const kannLinks = start > 0, kannRechts = ende < vorher.length;
      if (!kannLinks && !kannRechts) throw new Error(`editor_diff_anker_mehrdeutig: ${filePath}`);
      if (kannLinks && (nachLinks || !kannRechts)) start = start <= 1 ? 0 : vorher.lastIndexOf('\n', start - 2) + 1;
      else { const n = vorher.indexOf('\n', ende + 1); ende = n < 0 ? vorher.length : n; }
      nachLinks = !nachLinks;
    }
    const search = vorher.slice(start, ende);
    const replace = vorher.slice(start, links) + nachher.slice(links, nachher.length - rechts) + vorher.slice(vorher.length - rechts, ende);
    if (vorher.slice(0, start) + replace + vorher.slice(ende) !== nachher) throw new Error(`editor_diff_nicht_reproduzierbar: ${filePath}`);
    ops.push({ action: 'search_replace', file_path: filePath, search, replace });
  }
  if (laufend.join('\n') !== entwurf || ops.length === 0) throw new Error(`editor_diff_nicht_reproduzierbar: ${filePath}`);
  return ops;
}
