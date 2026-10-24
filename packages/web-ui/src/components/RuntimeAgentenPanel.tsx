import { useCallback, useEffect, useRef, useState } from 'react';
import { getRuntimeAgenten, getRuntimeAgentLog, getRuntimeProzesse, steuereRuntimeAgentUi, wechsleAgentModellUi, PLATTFORM_AGENT_RUNTIMES, type RuntimeAgentenStand } from '../api/agent-runtime';

/**
 * P22-T116: Debug-Uebersicht ALLER Runtime-Agenten eines Projekts je Ort (Container/PC) mit Warnungen, Log, Prozessliste und
 * Steuerung (stop/start/restart/wake). Unsichtbar, solange der Schalter runtime_agenten_uebersicht AUS ist.
 * Steuern ist zweistufig (Vorschau + Bestaetigung mit Grund). Abnahme 20a1192a/da3d601a R6: strikt je Projekt UND Instanz getrennt -
 * key={project} beim Aufrufer, Generationszaehler bei Projektwechsel UND beim Aushaengen (Unmount). Vor confirm, vor dem zweiten
 * Request und vor jeder Zustandsuebernahme wird geprueft, dass diese Instanz noch aktiv ist; die Bestaetigung traegt Projekt +
 * Identitaet der Vorschau (Server lehnt Abweichung ab).
 * P22-T117: Modellknopf (Schalter plattform_agent_modellwechsel) - nur Abo-Runtimes claude|codex, keine API-Option (User-Entscheidung).
 */

/** Rein: gehoert eine asynchrone Antwort noch zu dieser aktiven Instanz/Generation? */
export function instanzGueltig(aktiv: boolean, gStart: number, gJetzt: number): boolean {
  return aktiv && gStart === gJetzt;
}

export function RuntimeAgentenPanel({ project }: { project: string }) {
  const [stand, setStand] = useState<{ project: string; daten: RuntimeAgentenStand } | null>(null);
  const [offen, setOffen] = useState(false);
  const [ausgabe, setAusgabe] = useState('');
  const [fehler, setFehler] = useState('');
  const generation = useRef(0);
  const aktiv = useRef(true);
  const gilt = (g: number) => instanzGueltig(aktiv.current, g, generation.current);

  useEffect(() => {
    aktiv.current = true;
    generation.current++; setStand(null); setAusgabe(''); setFehler('');
    // Aushaengen/Projektwechsel: alle laufenden Antworten dieser Instanz verwerfen.
    return () => { aktiv.current = false; generation.current++; };
  }, [project]);

  const laden = useCallback(async () => {
    if (!project) return;
    const g = generation.current;
    try { const d = await getRuntimeAgenten(project); if (instanzGueltig(aktiv.current, g, generation.current)) { setStand({ project, daten: d }); setFehler(''); } }
    catch (e) { if (instanzGueltig(aktiv.current, g, generation.current)) setFehler(e instanceof Error ? e.message : String(e)); }
  }, [project]);
  useEffect(() => { void laden(); }, [laden]);

  const zeige = async (p: Promise<unknown>) => {
    const g = generation.current;
    setAusgabe('lädt …');
    try { const r = await p; if (gilt(g)) setAusgabe(JSON.stringify(r, null, 2)); }
    catch (e) { if (gilt(g)) setAusgabe(e instanceof Error ? e.message : String(e)); }
  };
  const steuern = async (id: string, aktion: 'stop' | 'start' | 'restart' | 'wake') => {
    const g = generation.current;
    const zielProjekt = project;
    const grund = (window.prompt('Grund für ' + aktion + ' (mind. 10 Zeichen, steht im Audit):') ?? '').trim();
    if (grund.length < 10 || !gilt(g)) return;
    try {
      const vorschau = await steuereRuntimeAgentUi(id, aktion, grund);
      if (!gilt(g)) return;
      const v = (vorschau.vorschau ?? {}) as Record<string, unknown>;
      const bid = typeof vorschau.bestaetigung_id === 'string' ? vorschau.bestaetigung_id : '';
      setAusgabe(JSON.stringify(vorschau, null, 2));
      if (!bid || v.project !== zielProjekt || v.identity_id !== id) return;
      if (!window.confirm('Ausführen?\n' + JSON.stringify(v, null, 2))) return;
      if (!gilt(g)) return;
      const r = await steuereRuntimeAgentUi(id, aktion, grund, { id: bid, grund, project: zielProjekt, identity_id: id });
      if (gilt(g)) { setAusgabe(JSON.stringify(r, null, 2)); void laden(); }
    } catch (e) { if (gilt(g)) setAusgabe(e instanceof Error ? e.message : String(e)); }
  };
  const modellWechseln = async (id: string, modellBisher: string | null) => {
    const g = generation.current;
    const rt = (window.prompt('CLI-Anbieter (' + PLATTFORM_AGENT_RUNTIMES.join(' | ') + '):', 'claude') ?? '').trim();
    if (!(PLATTFORM_AGENT_RUNTIMES as readonly string[]).includes(rt) || !gilt(g)) { if (rt && gilt(g)) setAusgabe('Nur ' + PLATTFORM_AGENT_RUNTIMES.join(' oder ') + ' (Abo).'); return; }
    const modell = (window.prompt('Modell (wie in der Modellliste der CLI):', modellBisher ?? '') ?? '').trim();
    if (!modell || !gilt(g)) return;
    const grund = (window.prompt('Grund für den Modellwechsel (mind. 10 Zeichen, steht im Audit):') ?? '').trim();
    if (grund.length < 10 || !gilt(g)) return;
    try {
      const r = await wechsleAgentModellUi(id, rt as typeof PLATTFORM_AGENT_RUNTIMES[number], modell, grund);
      if (gilt(g)) { setAusgabe(JSON.stringify(r, null, 2)); void laden(); }
    } catch (e) { if (gilt(g)) setAusgabe(e instanceof Error ? e.message : String(e)); }
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
                  <button type="button" onClick={() => void modellWechseln(z.identity_id!, z.modell ?? null)}>Modell</button>
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
