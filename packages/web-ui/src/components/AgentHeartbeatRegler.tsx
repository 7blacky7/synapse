import { useEffect, useState } from 'react';
import { getAgentHeartbeat, setzeAgentHeartbeat, type AgentHeartbeatStand } from '../api/agent-runtime';
import './agent-heartbeat-regler.css';

function taktText(ms: number | null | undefined): string {
  return ms == null ? 'adaptiv' : (ms / 1000) + ' s';
}
function wertText(aktiv: boolean | null | undefined, ms: number | null | undefined): string {
  return aktiv == null ? 'unbekannt' : (aktiv ? 'EIN · ' + taktText(ms) : 'AUS');
}

/** P22-T188: Nur explizites Speichern schreibt; API entscheidet Rechte und Produktschalter. */
export function AgentHeartbeatRegler({ identityId }: { identityId: string }) {
  const [stand, setStand] = useState<AgentHeartbeatStand | null>(null);
  const [aktiv, setAktiv] = useState(false);
  const [takt, setTakt] = useState('');
  const [busy, setBusy] = useState(true);
  const [fehler, setFehler] = useState('');
  const [meldung, setMeldung] = useState('');
  const [version, setVersion] = useState(0);
  const uebernehme = (s: AgentHeartbeatStand) => {
    setStand(s);
    const wert = s.gewuenscht ?? s.tatsaechlich;
    setAktiv(wert.aktiv === true);
    setTakt(wert.intervall_ms == null ? '' : String(wert.intervall_ms / 1000));
  };
  useEffect(() => {
    let aktuell = true;
    setBusy(true); setFehler(''); setMeldung('');
    getAgentHeartbeat(identityId).then((s) => {
      if (aktuell) uebernehme(s);
    }).catch((e: unknown) => {
      if (aktuell) setFehler(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (aktuell) setBusy(false); });
    return () => { aktuell = false; };
  }, [identityId, version]);

  const sek = takt.trim() === '' ? null : Number(takt);
  const gueltig = sek === null || (Number.isFinite(sek) && Number.isInteger(sek) && sek >= 5 && sek <= 86400);
  const gesperrt = busy || !!fehler || !stand?.verstellbar;
  const speichern = async () => {
    if (gesperrt || !gueltig) return;
    setBusy(true); setFehler(''); setMeldung('');
    try {
      const neu = await setzeAgentHeartbeat(identityId, aktiv, sek === null ? null : sek * 1000);
      uebernehme(neu);
      setMeldung(neu.weg === 'wrapper' ? 'Für diesen Lauf gespeichert; beim Neustart gilt der Spawn-Standard.' : 'Gespeichert.');
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const ist = stand?.tatsaechlich;
  return <details className="agent-heartbeat-regler" data-heartbeat-identity={identityId}>
    <summary>Heartbeat <span>{stand ? '· Wunsch ' + (stand.gewuenscht ? (stand.gewuenscht.aktiv ? 'EIN' : 'AUS') : 'nur Lauf')
      + ' · Ist ' + (!ist?.lauf ? 'kein Lauf' : ist.aktiv == null ? '?' : ist.aktiv ? 'EIN' : 'AUS') : busy ? '· lädt …' : '· Fehler'}</span></summary>
    <section className="agent-heartbeat-inhalt" aria-label="Heartbeat einstellen" aria-busy={busy}>
      <p><b>Gewünscht:</b> {stand?.gewuenscht ? wertText(stand.gewuenscht.aktiv, stand.gewuenscht.intervall_ms) : 'Nur im laufenden Wrapper; nicht für Neustarts gespeichert.'}</p>
      <p><b>Tatsächlich:</b> {ist?.lauf ? wertText(ist.aktiv, ist.intervall_ms) + (ist.status ? ' · ' + ist.status : '') : stand ? 'Kein Lauf' : 'Noch nicht geladen'}</p>
      {stand?.hinweis && <p role="status">{stand.hinweis}</p>}
      <label><input type="checkbox" checked={aktiv} disabled={gesperrt} onChange={(e) => setAktiv(e.target.checked)} /> Heartbeat ein</label>
      <label>Intervall in Sekunden <input type="number" min="5" max="86400" step="1" placeholder="adaptiv" value={takt}
        disabled={gesperrt} onChange={(e) => setTakt(e.target.value)} /></label>
      <p>Leer = adaptiv. Fester Takt: 5 bis 86400 Sekunden.</p>
      {!gueltig && <p role="alert">Bitte ganze Sekunden von 5 bis 86400 eingeben oder das Feld leeren.</p>}
      <div className="agent-heartbeat-aktionen">
        <button type="button" disabled={gesperrt || !gueltig} onClick={() => void speichern()}>Speichern</button>
        <button type="button" disabled={busy} onClick={() => setVersion((v) => v + 1)}>Aktualisieren</button>
      </div>
      {fehler && <p role="alert">{fehler}</p>}
      {meldung && <p role="status">{meldung}</p>}
      {stand && <details><summary>Heartbeat-Debug</summary><pre>{JSON.stringify({
        identity_id: stand.identity_id, project: stand.project, weg: stand.weg, schalter: stand.schalter,
        gewuenscht: stand.gewuenscht, tatsaechlich: stand.tatsaechlich, wrapper_nachgezogen: stand.wrapper_nachgezogen,
      }, null, 2)}</pre></details>}
    </section>
  </details>;
}
