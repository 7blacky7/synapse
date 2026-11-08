import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/auth';
import { LaufHerkunftMarke } from './LaufHerkunftMarke';
import { API_BASIS, anbieterName, fehlerText, usd, verbrauchText, type ApiLauf } from './api-laufwahl-logik';

export { verbrauchText } from './api-laufwahl-logik';

/**
 * P22-T202 / P22-T281: Laufende API-Agenten in Einstellungen › API-Agenten, gebaut aus den vorhandenen Bausteinen
 * (cp-setting-field, settings-fleet-table wie „Alle Agenten“, cp-aktionen). Die Wahl CLI/API selbst sitzt im Modell-Chip
 * (HauptagentModellChip); der frühere Laufwahl-Dialog ist als Bedienweg entfallen (P22-T281).
 * Verträge unverändert: GET /api/main-agent/api/laeufe, POST /api/main-agent/api/laeufe/steuern.
 * DEBUG: data-api-laeufe (Anzahl), data-api-lauf=<identity_id>, data-api-lauf-status, data-api-lauf-fehler (Rohcode).
 */
async function anfrage<T>(url: string, body?: unknown): Promise<T> {
  const r = await apiFetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok || (d as { success?: boolean } | null)?.success === false) {
    const e = (d as { error?: { code?: string; message?: string } | string } | null)?.error;
    throw new Error(typeof e === 'string' ? e : e?.code ?? e?.message ?? 'Anfrage fehlgeschlagen');
  }
  return d as T;
}
const ton = (status: string): string => (['laeuft', 'aktiv', 'bereit', 'running'].includes(status) ? 'running' : ['pausiert', 'wartet'].includes(status) ? 'idle' : 'stopped');

export function ApiAgentLaeufe() {
  const [laeufe, setLaeufe] = useState<ApiLauf[]>([]);
  const [fehler, setFehler] = useState('');
  const [busy, setBusy] = useState(false);
  const aktiv = useRef(true);
  const laden = async () => {
    try {
      const l = await anfrage<{ laeufe: ApiLauf[] }>(API_BASIS);
      if (aktiv.current) { setLaeufe(l.laeufe ?? []); setFehler(''); }
    } catch (e) { if (aktiv.current) setFehler(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { aktiv.current = true; void laden(); return () => { aktiv.current = false; }; }, []);
  const stoppen = async (l: ApiLauf) => {
    setBusy(true);
    try { await anfrage(API_BASIS + '/steuern', { identity_id: l.identity_id, aktion: 'stoppen', grund: 'API-Lauf in Einstellungen › API-Agenten gestoppt' }); await laden(); }
    catch (e) { setFehler(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="cp-setting-field wide" data-api-laeufe={laeufe.length}>
    <span>
      <b>Laufende API-Agenten{laeufe.length ? ': ' + laeufe.length : ''}</b>
      <small>{fehler ? 'Nicht lesbar: ' + fehlerText(fehler)
        : laeufe.length ? 'Sitzung, letzter Turn und Cache je Agent. Modell wechseln: im Modell-Chip des Agenten.' : 'Kein API-Lauf vorhanden. Gestartet wird im Modell-Chip des Agenten.'}</small>
    </span>
    {laeufe.length > 0 && <div className="settings-fleet-table">
      {laeufe.map((l) => <article key={l.identity_id} data-api-lauf={l.identity_id} data-api-lauf-status={l.status} data-api-lauf-fehler={l.letzter_fehler ?? undefined}>
        <i className={ton(l.status)} />
        <div>
          <strong>{l.agent_id}<LaufHerkunftMarke project={l.project} identityId={l.identity_id} name={l.agent_id} /></strong>
          <small>{l.project} · {anbieterName(l.anbieter)} · {l.modell}{l.kontext_tokens ? ' · Kontext ' + l.kontext_tokens.toLocaleString('de-DE') + (l.kontext_fenster ? ' / ' + l.kontext_fenster.toLocaleString('de-DE') : '') : ''}</small>
          <small title={verbrauchText(l.verbrauch_sitzung)}>Letzter Turn: {verbrauchText(l.verbrauch_letzter_turn)}</small>
          {l.letzter_fehler && <small title={l.letzter_fehler}>{fehlerText(l.letzter_fehler)}</small>}
        </div>
        <b>{l.status}{l.offene_eingaenge ? ' · ' + l.offene_eingaenge + ' offen' : ''}</b>
        <em>Sitzung {usd(l.kosten_usd_sitzung)} · gesamt {usd(l.kosten_usd)}</em>
        <span className="cp-aktionen"><button type="button" disabled={busy || l.status === 'gestoppt'} onClick={() => void stoppen(l)}>Stoppen</button></span>
      </article>)}
    </div>}
  </div>;
}
