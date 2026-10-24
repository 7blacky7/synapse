import { useCallback, useEffect, useState } from 'react';
import { getRuntimeAgenten, getRuntimeAgentLog, getRuntimeProzesse, steuereRuntimeAgentUi, wechsleAgentModellUi, type RuntimeAgentenStand } from '../api/agent-runtime';

/**
 * P22-T116: Debug-Uebersicht ALLER Runtime-Agenten eines Projekts je Ort (Container/PC) mit Warnungen, Log, Prozessliste und
 * Steuerung (stop/start/restart/wake mit Grund). Unsichtbar, solange der Schalter runtime_agenten_uebersicht AUS ist.
 * Steuern scheitert sichtbar mit funktion_aus, solange runtime_agenten_steuerung AUS ist.
 */
export function RuntimeAgentenPanel({ project }: { project: string }) {
  const [stand, setStand] = useState<RuntimeAgentenStand | null>(null);
  const [offen, setOffen] = useState(false);
  const [ausgabe, setAusgabe] = useState('');
  const [fehler, setFehler] = useState('');

  const laden = useCallback(async () => {
    if (!project) return;
    try { setStand(await getRuntimeAgenten(project)); setFehler(''); }
    catch (e) { setFehler(e instanceof Error ? e.message : String(e)); }
  }, [project]);
  useEffect(() => { void laden(); }, [laden]);

  const zeige = async (p: Promise<unknown>) => {
    setAusgabe('lädt …');
    try { setAusgabe(JSON.stringify(await p, null, 2)); } catch (e) { setAusgabe(e instanceof Error ? e.message : String(e)); }
  };
  const steuern = (id: string, aktion: 'stop' | 'start' | 'restart' | 'wake') => {
    const grund = window.prompt('Grund für ' + aktion + ' (mind. 10 Zeichen, steht im Audit):') ?? '';
    if (grund.trim().length < 10) return;
    void zeige(steuereRuntimeAgentUi(id, aktion, grund.trim()).finally(() => void laden()));
  };

  // P22-T117: Modell/CLI-Anbieter wechseln (Schalter plattform_agent_modellwechsel; AUS -> funktion_aus in der Ausgabe).
  const modellWechseln = (id: string, bisher: string | null) => {
    const eingabe = window.prompt('Neues Modell als runtime|modell (claude|codex = Abo, z. B. claude|sonnet oder codex|codex/gpt-6-luna). Bisher: ' + (bisher ?? '?')) ?? '';
    const [runtime, ...rest] = eingabe.trim().split('|');
    const modell = rest.join('|').trim();
    if (!runtime || !modell) return;
    const abo = runtime === 'claude' || runtime === 'codex';
    if (!abo && !window.confirm('Runtime ' + runtime + ' rechnet über die API ab (kostenpflichtig, kein Abo). Trotzdem wechseln?')) return;
    const grund = window.prompt('Grund für den Modellwechsel (mind. 10 Zeichen, steht im Audit):') ?? '';
    if (grund.trim().length < 10) return;
    void zeige(wechsleAgentModellUi(id, runtime, modell, grund.trim(), !abo).finally(() => void laden()));
  };

  if (!stand?.aktiv) return null;
  return (
    <section className="runtime-agenten-panel" aria-label="Runtime-Agenten">
      <header>
        <button type="button" onClick={() => setOffen(v => !v)}>{offen ? '▾' : '▸'} Runtime-Agenten ({stand.anzahl ?? 0}{stand.warnungen_gesamt ? ' · ' + stand.warnungen_gesamt + ' Warnungen' : ''})</button>
        <button type="button" onClick={() => void laden()}>Aktualisieren</button>
        <button type="button" onClick={() => void zeige(getRuntimeProzesse(project))}>Prozesse lesen</button>
      </header>
      {fehler && <small className="inline-error">{fehler}</small>}
      {offen && Object.entries(stand.orte ?? {}).map(([ort, zeilen]) => (
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
                  {(['wake', 'stop', 'start', 'restart'] as const).map(a => <button type="button" key={a} onClick={() => steuern(z.identity_id!, a)}>{a}</button>)}
                  <button type="button" title="Modell/CLI-Anbieter wechseln (P22-T117)" onClick={() => modellWechseln(z.identity_id!, z.modell)}>Modell</button>
                </>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {offen && ausgabe && <pre className="runtime-agenten-ausgabe">{ausgabe}</pre>}
      {offen && stand.debug && <small>Debug: {JSON.stringify(stand.debug)}</small>}
    </section>
  );
}
