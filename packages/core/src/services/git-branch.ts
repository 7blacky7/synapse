/** Gemeinsame Git-Branch-Pruefung fuer Plan-Ziele und Projekt-Einstellungen. */
export function pruefeGitBranchName(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0 || x !== x.trim()) {
    throw new Error('Ungueltiger git_branch: erwartet einen Git-Branchnamen.');
  }
  const teile = x.split('/');
  const ungueltigesZeichen = [...x].some((zeichen) => {
    const code = zeichen.charCodeAt(0);
    return code <= 32 || code === 127 || ['~', '^', ':', '?', '*', '[', '\\'].includes(zeichen);
  });
  if (x.startsWith('-') || x.startsWith('/') || x.endsWith('/') || x.endsWith('.') ||
      x.includes('..') || x.includes('@{') || x.includes('//') || ungueltigesZeichen ||
      teile.some((teil) => teil.startsWith('.') || teil.endsWith('.lock'))) {
    throw new Error('Ungueltiger git_branch "' + x + '"; Git-Branchnamen muessen git check-ref-format entsprechen.');
  }
  return x;
}

/** Prueft gueltigen Ref-Namen und sperrt genau den konfigurierten Projekt-Hauptbranch. */
export function pruefeGitBranch(x: unknown, geschuetzterHauptbranch = 'main'): string {
  const branch = pruefeGitBranchName(x);
  if (branch === geschuetzterHauptbranch) {
    throw new Error('Ungueltiger git_branch "' + branch + '": geschuetzter Hauptbranch darf kein Commit-Ziel sein.');
  }
  return branch;
}
