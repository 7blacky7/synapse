import { useCallback, useEffect, useRef, useState } from 'react';
import { getRuntimeAgenten, getRuntimeAgentLog, getRuntimeProzesse, steuereRuntimeAgentUi, type RuntimeAgentenStand } from '../api/agent-runtime';

/**
 * P22-T116: Debug-Uebersicht ALLER Runtime-Agenten eines Projekts je Ort (Container/PC) mit Warnungen, Log, Prozessliste und
 * Steuerung (stop/start/restart/wake). Unsichtbar, solange der Schalter runtime_agenten_uebersicht AUS ist.
 * Steuern ist zweistufig (Vorschau + Bestaetigung mit Grund). Abnahme 20a1192a R6: strikt je Projekt getrennt - der Aufrufer
 * bindet das Panel mit key={project}; zusaetzlich verwirft ein Generationszaehler Antworten, die nach einem Wechsel eintreffen.
 */
export function RuntimeAgentenPanel({ project }: { project: string }) {
  const [stand, setStand] = useState<{ project: string; daten: RuntimeAgentenStand } | null>(null);
  const [offen, setOffen] = useState(false);
  const [ausgabe, setAusgabe] = useState('');
  const [fehler, setFehler] = useState('');
  const generation = useRef(0);

  useEffect(() => { generation.current++; setStand(null); setAusgabe(''); setFehler(''); }, [project]);

  const laden = useCallback(async () => {
    if (!project) return;
    const g = generation.current;
    try { const d = await getRuntimeAgenten(project); if (g === generation.current) { setStand({ project, daten: d }); setFehler(''); } }
    catch (e) { if (g === generation.current) setFehler(e instanceof Error ? e.message : String(e)); }
  }, [project]);
  useEffect(() => { void laden(); }, [laden]);

  const zeige = async (p: Promise<unknown>) => {
    const g = generation.current;
    setAusgabe('lädt …');
    try { const r = await p; if (g === generation.current) setAusgabe(JSON.stringify(r, null, 2)); }
    catch (e) { if (g === generation.current) setAusgabe(e instanceof Error ? e.message : String(e)); }
  };
  const steuern = async (id: string, aktion: 'stop' | 'start' | 'restart' | 'wake') => {
    const g = generation.current;
    const grund = (window.prompt('Grund für ' + aktion + ' (mind. 10 Zeichen, steht im Audit):') ?? '').trim();
    if (grund.length < 10) return;
    try {
      const vorschau = await steuereRuntimeAgentUi(id, aktion, grund);
      if (g !== generation.current) return;
      const bid = typeof vorschau.bestaetigung_id === 'string' ? vorschau.bestaetigung_id : '';
      setAusgabe(JSON.stringify(vorschau, null, 2));
      if (!bid || !window.confirm('Ausführen?\n' + JSON.stringify(vorschau.vorschau, null, 2))) return;
      const r = await steuereRuntimeAgentUi(id, aktion, grund, { id: bid, grund });
      if (g === generation.current) { setAusgabe(JSON.stringify(r, null, 2)); void laden(); }
    } catch (e) { if (g === generation.current) setAusgabe(e instanceof Error ? e.message : String(e)); }
  };

  const daten = stand && stand.project === project ? stand.daten : null;
  if (!daten?.aktiv) return null;
  return (
    <section className="runtime-agenten-panel" aria-label={'Runtime-Agenten ' + project}>
      <header>
        <button type="button" onClick={() => setOffen(v => !v)}>{offen ? '▾' : '▸'} Runtime-Agenten ({daten.anzahl ?? 0}{daten.warnungen_gesamt ? ' · ' + daten.warnungen_gesamt + ' Warnungen' : ''})</button>
        <button type="button" onClick={() => void laden()}>Aktualisieren</button>
        <button type="button" onClick={() => void zeige(getRuntimeProzesse(project))}>Prozesse lesen</button>
      </header>
      {fehler && <small className="inline-error">{fehler}</small>}
      {offen && Object.entries(daten.orte ?? {}).map(([ort, zeilen]) => (
        <div key={ort}>
          <h4>{ort}</h4>
          <table>
            <thead><tr><th>Agent</th><th>Status</th><th>Inaktiv</th><th>Heartbeat</th><th>Tokens</th><th>Warnungen</th><th /></tr></thead>
            <tbody>{zeilen.map(z => (
              <tr key={(z.identity_id ?? z.name) + ort} className={z.warnungen.length ? 'mit-warnung' : ''}>
                <td title={z.auftrag ?? ''}>{z.name}<small>{z.quelle}{z.modell ? ' · ' + z.modell : ''}</small></td>
                <td>{z.status}{z.busy ? ' · busy' : ''}</td>
                <td>{Math.round(z.inaktiv_sekunden / 60)} min</td>
                <td>{z.heartbeat.an ? 'an' : 'aus'}</td>
                <td>{z.tokens.prozent}%</td>
                <td>{z.warnungen.join(', ') || '–'}</td>
                <td>{z.identity_id && <>
                  <button type="button" onClick={() => void zeige(getRuntimeAgentLog(z.identity_id!))}>Log</button>
                  {(['wake', 'stop', 'start', 'restart'] as const).map(a => <button type="button" key={a} onClick={() => void steuern(z.identity_id!, a)}>{a}</button>)}
                </>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {offen && ausgabe && <pre className="runtime-agenten-ausgabe">{ausgabe}</pre>}
      {offen && daten.debug && <small>Debug: {JSON.stringify(daten.debug)}</small>}
    </section>
  );
}
