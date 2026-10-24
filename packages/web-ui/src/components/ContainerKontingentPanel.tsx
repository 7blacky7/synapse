import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/auth';

/**
 * P22-T109: Regler fuer das Container-Kontingent je Projekt (container_agenten_max 0..100).
 * Echt angeschlossen: GET/PUT /api/projects/:project/agent-profile/container-kontingent (derselbe Core-Dispatcher wie
 * admin container_kontingent). Setzen: User; Koordinator/Main nur mit Produkt-Schalter kontingent_delegiert und User-Auftrag.
 */
interface Kontingent { container_agenten_max: number; quelle: 'standard' | 'gesetzt'; gesetzt_von: string | null; gesetzt_am: string | null; grund: string | null }
interface Stand {
  schalter: { aktiv: boolean; quelle: string };
  kontingent_delegiert?: { aktiv: boolean; quelle: string; wer_setzt: string };
  kontingent: Kontingent;
  belegt: number;
  runtime_daemon: { claude: boolean; codex: boolean };
}

function fehlerText(daten: unknown, status: number): string {
  const e = (daten as { error?: { code?: string } | string } | null)?.error;
  const code = typeof e === 'string' ? e : e?.code;
  return (code ?? 'fehler') + ' (HTTP ' + status + ')';
}

export function ContainerKontingentPanel({ project }: { project: string }) {
  // Jeder Projektwechsel bekommt einen eigenen Entwurf und eigene Anfrage-Identitäten.
  return <ContainerKontingentProjekt key={project} project={project} />;
}

function ContainerKontingentProjekt({ project }: { project: string }) {
  const basis = '/api/projects/' + encodeURIComponent(project) + '/agent-profile/container-kontingent';
  const [stand, setStand] = useState<Stand | null>(null);
  const [wert, setWert] = useState<number | null>(null);
  const [grund, setGrund] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [laedt, setLaedt] = useState(true);
  const aktiv = useRef(false);
  const anfrage = useRef(0);

  const laden = useCallback(async () => {
    if (!aktiv.current) return;
    const id = ++anfrage.current;
    const gueltig = () => aktiv.current && anfrage.current === id;
    setLaedt(true);
    setStand(null);
    setWert(null);
    setError('');
    try {
      const r = await apiFetch(basis);
      const d = await r.json().catch(() => null);
      if (!gueltig()) return;
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setStand(d as Stand);
    } catch (reason) {
      if (gueltig()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (gueltig()) setLaedt(false);
    }
  }, [basis]);

  useEffect(() => {
    aktiv.current = true;
    void laden();
    return () => { aktiv.current = false; anfrage.current += 1; };
  }, [laden]);

  const aktuell = stand?.kontingent.container_agenten_max ?? 0;
  const anzeige = wert ?? aktuell;
  const grundOk = grund.trim().length >= 5;
  const speicherbar = !!stand && !laedt && !busy && grundOk && anzeige !== aktuell;

  const speichern = async () => {
    if (!aktiv.current || !speicherbar) return;
    const id = ++anfrage.current;
    const gueltig = () => aktiv.current && anfrage.current === id;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await apiFetch(basis, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ container_agenten_max: anzeige, grund }) });
      const d = await r.json().catch(() => null);
      if (!gueltig()) return;
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setStand(d as Stand);
      setWert(null);
      setNotice('Gespeichert: höchstens ' + anzeige + ' Container-Agenten in ' + project + '.');
    } catch (reason) {
      if (gueltig()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (gueltig()) setBusy(false);
    }
  };

  const k = stand?.kontingent;
  return <div className="cp-fields">
    <div className="cp-setting-field wide">
      <span>
        <b>Container-Agenten gleichzeitig: {stand ? anzeige : '…'}{wert !== null && wert !== aktuell ? ' (bisher ' + aktuell + ')' : ''}</b>
        <small>{stand ? 'Belegt: ' + stand.belegt + ' · Quelle: ' + (k?.quelle === 'gesetzt' ? 'gesetzt von ' + (k.gesetzt_von ?? '?') + (k.gesetzt_am ? ' am ' + new Date(k.gesetzt_am).toLocaleString() : '') : 'Standard 0') + (k?.grund ? ' · Grund: ' + k.grund : '') : 'wird geladen'}</small>
      </span>
      <div className="split-field">
        <input type="range" min={0} max={100} step={1} value={anzeige} disabled={!stand || busy} onChange={(event) => setWert(Number(event.target.value))} aria-label={'Container-Kontingent ' + project} />
        <input type="number" min={0} max={100} value={anzeige} disabled={!stand || busy} onChange={(event) => setWert(Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))))} aria-label={'Container-Kontingent Zahl ' + project} />
      </div>
    </div>
    <div className="cp-setting-field">
      <span>
        <b>Spezialisten im Container: {stand ? (stand.schalter.aktiv ? 'EIN' : 'AUS') : '…'}</b>
        <small>Produkt-Schalter spezialisten_container (Quelle {stand?.schalter.quelle ?? '…'}). Container-Daemon claude: {stand ? (stand.runtime_daemon.claude ? 'angemeldet' : 'fehlt') : '…'}, codex: {stand ? (stand.runtime_daemon.codex ? 'angemeldet' : 'fehlt') : '…'}.</small>
      </span>
    </div>
    <div className="cp-setting-field">
      <span>
        <b>Wer darf setzen: {stand?.kontingent_delegiert?.wer_setzt ?? 'nur user'}</b>
        <small>Produkt-Schalter kontingent_delegiert (Quelle {stand?.kontingent_delegiert?.quelle ?? 'standard'}): EIN erlaubt Koordinator und Main das Setzen nach User-Entscheidung, mit User-Zitat im Audit.</small>
      </span>
    </div>
    <div className="cp-setting-field wide"><span><b>Grund</b><small>Pflicht, mindestens 5 Zeichen; wird mit dem Wert gespeichert.</small></span>
      <input value={grund} onChange={(event) => setGrund(event.target.value)} placeholder="z. B. mehr Spezialisten parallel" />
    </div>
    <div className="scope-warning wide"><b>Projekt {project}</b><span>{error ? 'Fehler: ' + error : notice || 'Wirkt sofort auf neue Spawns im Container.'}</span></div>
    <div className="wide"><button type="button" className="primary" disabled={!speicherbar} onClick={() => void speichern()}>Kontingent speichern</button> <button type="button" disabled={busy || laedt} onClick={() => void laden()}>Neu laden</button></div>
  </div>;
}
