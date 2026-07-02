// KIOS — Signatur-Buehne. Mock-Director der die EINE Signatur-Flaeche zwischen den
// Aktivitaeten des Agenten "umformatiert":
//   PULS/SUCHE  (SignaturePulse searchDemo) — der Agent denkt/sucht semantisch.
//   SHELL-LAUF  (ShellCast)                 — der Agent setzt ein Shell-Kommando ab.
// Spaeter ersetzt echtes Aktivitaets-Signal (shell-Tool-Event / search-Event) den Timer:
// dann formatiert sich die Flaeche live um, sobald der Agent das jeweilige Tool nutzt.
import { useEffect, useState } from 'react';
import SignaturePulse, { type SignatureNode } from './SignaturePulse';
import ShellCast, { type ShellCastProps } from './ShellCast';

export interface SignatureStageProps {
  nodes?: SignatureNode[];
}

// Wie lange der Puls-/Such-Modus laeuft, bevor ein Shell-Lauf eingeblendet wird.
const PULSE_MS = 19000;

// Mock-Shell-Szenen (Original-artige Synapse-Jobs), rotierend.
const SHELL_SCENES: Pick<ShellCastProps, 'command' | 'lines' | 'exitCode'>[] = [
  {
    command: 'pnpm --filter @synapse/web-ui build',
    lines: [
      'vite v5.0.0 building for production...',
      'transforming...',
      '✓ 342 modules transformed.',
      'dist/assets/index-a3f9c1.css     24.1 kB │ gzip:  5.2 kB',
      'dist/assets/index-9c2e07.js     198.4 kB │ gzip: 63.8 kB',
      '✓ built in 3.41s',
    ],
    exitCode: 0,
  },
  {
    command: 'git status --short',
    lines: [
      ' M packages/web-ui/src/overview/sections/SignaturePulse.tsx',
      '?? packages/web-ui/src/overview/sections/ShellCast.tsx',
      '?? packages/web-ui/src/overview/sections/SignatureStage.tsx',
    ],
    exitCode: 0,
  },
  {
    command: 'node scripts/reindex.mjs --project synapse',
    lines: [
      '↻ parse 1.284 Dateien …',
      '✓ 8.391 Chunks embedded (Qdrant)',
      '✓ Index aktuell · 0 Drift',
    ],
    exitCode: 0,
  },
];

const STAGE_CSS = `
.kios-stage { position: relative; width: 100%; height: 100%; min-height: 240px; }
.kios-stage-layer { position: absolute; inset: 0; animation: kios-stage-in 0.5s ease both; }
@keyframes kios-stage-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .kios-stage-layer { animation: none; }
}
`;

export default function SignatureStage({ nodes = [] }: SignatureStageProps) {
  const [mode, setMode] = useState<'pulse' | 'shell'>('pulse');
  const [shellIdx, setShellIdx] = useState(0);

  useEffect(() => {
    if (mode !== 'pulse') return;
    const t = setTimeout(() => setMode('shell'), PULSE_MS);
    return () => clearTimeout(t);
  }, [mode]);

  const scene = SHELL_SCENES[shellIdx % SHELL_SCENES.length];

  return (
    <div className="kios-stage">
      <style>{STAGE_CSS}</style>
      {mode === 'pulse' ? (
        <div className="kios-stage-layer" key="pulse">
          <SignaturePulse searchDemo liveGraph nodes={nodes} />
        </div>
      ) : (
        <div className="kios-stage-layer" key={`shell-${shellIdx}`}>
          <ShellCast
            command={scene.command}
            lines={scene.lines}
            exitCode={scene.exitCode}
            onDone={() => {
              setShellIdx((i) => i + 1);
              setMode('pulse');
            }}
          />
        </div>
      )}
    </div>
  );
}
