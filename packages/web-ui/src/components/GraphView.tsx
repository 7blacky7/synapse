/**
 * GRAPH-2: GraphView — duenner React-Wrapper um die GraphEngine.
 *
 * React fasst nur das aeussere host-<div> an (ref). Beim Mount erzeugt die
 * Engine ihr komplettes eigenes DOM + Cytoscape + Canvas darin und raeumt es
 * beim Unmount sauber wieder ab. Cytoscape lebt also in einem von React
 * NICHT verwalteten Container -> keine Kollision mit dem virtuellen DOM.
 *
 * Daten kommen ausschliesslich ueber graph/api.ts (apiFetch) -> Auth (Bearer +
 * synapse_session-Cookie) wird same-origin transparent mitgeschickt.
 */

import { useEffect, useRef } from 'react';
import { GraphEngine } from '../graph/engine';
import '../graph/graph.css';

interface GraphViewProps {
  project: string;
}

function GraphView({ project }: GraphViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GraphEngine | null>(null);

  // Engine genau einmal mounten (kein Re-Mount bei Projektwechsel).
  useEffect(() => {
    if (!hostRef.current) return;
    const engine = new GraphEngine(hostRef.current, project);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Projektwechsel von aussen an die laufende Engine weiterreichen.
  useEffect(() => {
    engineRef.current?.setProject(project);
  }, [project]);

  return <div ref={hostRef} style={{ height: '100%', width: '100%' }} />;
}

export default GraphView;
