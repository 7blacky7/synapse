import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/auth';

/**
 * P22-T44: Agenten-Ausweis fuer mehrere Projekte. Zeigt Agenten ANDERER Projekte mit Visum/Einwanderung in diesem Projekt,
 * erteilt/entzieht die Arbeitsfreigabe und schaltet den Produkt-Schalter 'mehrprojekt' (wirkt fuer Agenten, deren HEIMAT dieses
 * Projekt ist; Standard AUS). Echt angeschlossen (derselbe Core-Dispatcher wie admin):
 *   GET  /api/projects/:project/agent-profile/ausweis-visa
 *   POST /api/projects/:project/agent-profile/ausweis-visa/:identity_id/arbeitsfreigabe | /entziehen  {grund}
 *   GET/PUT /api/projects/:project/agent-profile/schalter  {profil_funktion:'mehrprojekt', aktiv, grund, ebene}
 */
type Zugang = 'frei' | 'visum' | 'arbeitsfreigabe' | 'abgelaufen';
interface VisumAgent {
  identity_id: string;
  agent_id: string;
  heimat: string;
  rolle: string;
  zugang: Zugang;
  zuletzt_aufruf: string | null;
  visum_bis: string | null;
  visa_anzahl: number;
  arbeitsfreigabe_bis: string | null;
  arbeitsfreigabe_von: string | null;
}
interface VisaStand { project: string; koordinator_vorhanden: boolean; agenten: VisumAgent[]; hinweis: string }
interface SchalterStand { funktion: string; aktiv: boolean; quelle: string; ebene: string | null; gesetzt_von: string | null; letzter_fehler: string | null }

const ZUGANG: Record<Zugang, string> = { frei: 'frei (kein Koordinator)', visum: 'Visum (lesen + Channels)', arbeitsfreigabe: 'Einwanderung (Arbeitsfreigabe)', abgelaufen: 'abgelaufen' };
const zeit = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '–');

function fehlerText(daten: unknown, status: number): string {
  const e = (daten as { error?: { code?: string } | string } | null)?.error;
  const code = typeof e === 'string' ? e : e?.code;
  return (code ?? 'fehler') + ' (HTTP ' + status + ')';
}

export function AusweisVisaPanel({ project }: { project: string }) {
  const basis = '/api/projects/' + encodeURIComponent(project) + '/agent-profile';
  const [stand, setStand] = useState<VisaStand | null>(null);
  const [schalter, setSchalter] = useState<SchalterStand | null>(null);
  const [grund, setGrund] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const laden = useCallback(async () => {
    try {
      const [rv, rs] = await Promise.all([apiFetch(basis + '/ausweis-visa'), apiFetch(basis + '/schalter')]);
      const dv = await rv.json().catch(() => null);
      const ds = await rs.json().catch(() => null);
      if (!rv.ok) throw new Error(fehlerText(dv, rv.status));
      setStand(dv as VisaStand);
      if (rs.ok) setSchalter(((ds as { schalter?: SchalterStand[] }).schalter ?? []).find(s => s.funktion === 'mehrprojekt') ?? null);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [basis]);

  useEffect(() => { void laden(); }, [laden]);

  const senden = async (pfad: string, methode: 'POST' | 'PUT', body: Record<string, unknown>, meldung: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await apiFetch(basis + pfad, { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, grund }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setNotice(meldung);
      await laden();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const grundOk = grund.trim().length >= 5;
  const agenten = stand?.agenten ?? [];
  return <div className="cp-fields">
    <div className="cp-setting-field wide">
      <span>
        <b>Mehrere Projekte (Schalter mehrprojekt): {schalter ? (schalter.aktiv ? 'EIN' : 'AUS') : '…'}</b>
        <small>Gilt fuer Agenten, deren Heimat {project} ist: Visum (lesen + Channels) in anderen Projekten, Arbeitsfreigabe durch deren Koordinator. Standard AUS; "alle" schaltet ihn nicht mit.{schalter ? ' Quelle: ' + schalter.quelle + (schalter.ebene ? ' (' + schalter.ebene + ')' : '') + (schalter.gesetzt_von ? ' · gesetzt von ' + schalter.gesetzt_von : '') : ''}</small>
      </span>
      <button type="button" disabled={busy || !grundOk || !schalter} onClick={() => void senden('/schalter', 'PUT', { profil_funktion: 'mehrprojekt', aktiv: !schalter?.aktiv, ebene: 'projekt' }, 'Schalter mehrprojekt ' + (schalter?.aktiv ? 'AUS' : 'EIN') + ' (Projekt ' + project + ').')}>
        {schalter?.aktiv ? 'Ausschalten' : 'Einschalten'}
      </button>
    </div>
    <div className="scope-warning wide"><b>Gaeste in {project}{stand ? (stand.koordinator_vorhanden ? '' : ' (kein Koordinator: Gaeste duerfen alles)') : ''}</b><span>{stand?.hinweis ?? 'wird geladen'}</span></div>
    {agenten.length === 0 && <div className="wide"><small>Keine Agenten anderer Projekte mit Eintrag in diesem Projekt.</small></div>}
    {agenten.map(a => <div key={a.identity_id} className="cp-setting-field wide">
      <span>
        <b>{a.agent_id} · Heimat {a.heimat} · {ZUGANG[a.zugang]}</b>
        <small>Rolle {a.rolle} · zuletzt {zeit(a.zuletzt_aufruf)} · Visum bis {zeit(a.visum_bis)} ({a.visa_anzahl}×) · Arbeitsfreigabe bis {zeit(a.arbeitsfreigabe_bis)}{a.arbeitsfreigabe_von ? ' von ' + a.arbeitsfreigabe_von : ''}</small>
      </span>
      <div className="split-field">
        <button type="button" disabled={busy || !grundOk} onClick={() => void senden('/ausweis-visa/' + encodeURIComponent(a.identity_id) + '/arbeitsfreigabe', 'POST', {}, 'Arbeitsfreigabe fuer ' + a.agent_id + ' erteilt.')}>{a.zugang === 'arbeitsfreigabe' ? 'Verlaengern' : 'Arbeitsfreigabe'}</button>
        {a.zugang === 'arbeitsfreigabe' && <button type="button" disabled={busy || !grundOk} onClick={() => void senden('/ausweis-visa/' + encodeURIComponent(a.identity_id) + '/entziehen', 'POST', {}, 'Arbeitsfreigabe fuer ' + a.agent_id + ' entzogen.')}>Entziehen</button>}
      </div>
    </div>)}
    <div className="cp-setting-field wide"><span><b>Grund</b><small>Pflicht fuer Schalter und Freigaben, mindestens 5 Zeichen.</small></span>
      <input value={grund} onChange={(event) => setGrund(event.target.value)} placeholder="z. B. hilft bei P22" />
    </div>
    <div className="scope-warning wide"><b>Status</b><span>{error ? 'Fehler: ' + error : notice || 'Bereit'}</span></div>
    <div className="wide"><button type="button" disabled={busy} onClick={() => void laden()}>Neu laden</button></div>
  </div>;
}
