import { useState } from 'react';
import { apiFetch } from '../api/auth';
import { apiKeyFormOk, apiKeyTestText, API_KEY_NAME, type ApiKeyStand, type ApiKeyTest } from './api-budget-logik';

/**
 * P22-T176: API-Key in der Web-UI hinterlegen, ersetzen, entfernen und testen (Einstellungen > API-Agenten, nur User).
 *   Der Wert geht genau einmal per PUT /api/main-agent/api/key an den Server (verschluesselt im Server-Tresor) und wird nach dem
 *   Speichern aus dem Feld geloescht; die Web-UI bekommt ihn nie zurueck (nur vorhanden, Quelle, gesetzt am, letzte 4 Zeichen).
 *   Kein Browser-Speicher. Schalter hauptagent_api_key_webui (Standard AUS): AUS = nur Env, kein Eingabefeld.
 *   Routen: PUT/DELETE /api/main-agent/api/key, PUT /api/main-agent/api/key/schalter, POST /api/main-agent/api/key/testen.
 */
export function ApiKeyFeld({ stand, grundOk, busy, senden }: {
  stand: ApiKeyStand; grundOk: boolean; busy: boolean;
  senden: (pfad: string, methode: string, koerper: Record<string, unknown>, erfolg: string) => Promise<boolean>;
}) {
  const [eingabe, setEingabe] = useState('');
  const [test, setTest] = useState('');
  const [pruefe, setPruefe] = useState(false);
  const s = stand.schalter;

  const hinterlegen = async () => {
    if (await senden('/api/main-agent/api/key', 'PUT', { key: eingabe }, stand.webui.gespeichert ? 'API-Key ersetzt.' : 'API-Key hinterlegt.')) setEingabe('');
  };
  const testen = async () => {
    setPruefe(true);
    setTest('');
    try {
      const r = await apiFetch('/api/main-agent/api/key/testen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => null) as { test?: ApiKeyTest } | null;
      setTest(r.ok && d?.test ? apiKeyTestText(d.test) : 'Key-Test fehlgeschlagen (HTTP ' + r.status + ').');
    } catch (reason) {
      setTest('Key-Test fehlgeschlagen: ' + (reason instanceof Error ? reason.message : String(reason)));
    } finally {
      setPruefe(false);
    }
  };

  return <div className="cp-setting-field wide" data-api-key-feld="" data-api-key-schalter={s.aktiv ? 'ein' : 'aus'}>
    <span>
      <b>API-Key hinterlegen</b>
      <small>{s.aktiv
        ? 'Eingabe in der Web-UI: EIN. Ein hier hinterlegter Key hat Vorrang vor ' + API_KEY_NAME + ' (Env); Entfernen fällt auf Env zurück.'
        : 'Eingabe in der Web-UI: AUS. Es gilt nur ' + API_KEY_NAME + ' aus der Server-Umgebung.'}
        {' '}Server-Tresor: {stand.tresor.vorhanden ? 'bereit' : 'fehlt (SYNAPSE_AGENT_TOKEN_SCHLUESSEL), Hinterlegen nicht möglich'}.</small>
    </span>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {s.aktiv && <input type="password" autoComplete="new-password" spellCheck={false} aria-label="Anthropic-API-Key" placeholder="sk-ant-…"
        value={eingabe} onChange={(event) => setEingabe(event.target.value)} style={{ flex: '1 1 260px', minWidth: 0 }} />}
      {s.aktiv && <button type="button" disabled={busy || !grundOk || !apiKeyFormOk(eingabe)} onClick={() => void hinterlegen()}>
        {stand.webui.gespeichert ? 'Key ersetzen' : 'Key hinterlegen'}</button>}
      {stand.webui.gespeichert && <button type="button" disabled={busy || !grundOk}
        onClick={() => void senden('/api/main-agent/api/key', 'DELETE', {}, 'API-Key entfernt, es gilt wieder ' + API_KEY_NAME + ' (Env).')}>Key entfernen</button>}
      <button type="button" disabled={busy || pruefe || !stand.vorhanden} onClick={() => void testen()}>{pruefe ? 'Teste …' : 'Key testen'}</button>
      <button type="button" disabled={busy || !grundOk}
        onClick={() => void senden('/api/main-agent/api/key/schalter', 'PUT', { aktiv: !s.aktiv }, 'Key-Eingabe in der Web-UI ' + (s.aktiv ? 'AUS' : 'EIN') + '.')}>
        {s.aktiv ? 'Eingabe ausschalten' : 'Eingabe einschalten'}</button>
    </div>
    {test && <small data-api-key-test="">{test}</small>}
    <small data-api-key-debug="">Debug: {stand.debug}</small>
  </div>;
}
