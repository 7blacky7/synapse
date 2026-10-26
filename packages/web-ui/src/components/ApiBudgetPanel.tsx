import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/auth';
import { apiKeyAnzeige, apiKeyStandZeile, budgetFormular, budgetZeile, usd, API_BUDGET_VORSCHLAG, type ApiBudgetStand, type ApiKeyStand } from './api-budget-logik';
import { ApiKeyFeld } from './ApiKeyFeld';
import { ApiFreigabenFeld } from './ApiFreigabenFeld';

/**
 * P22-T8 (W2-API): API-Zugang des Hauptagenten (Claude per API-Key, kostenpflichtig). Nur der User setzt Werte.
 *   Funktion api (Produkt-Schalter hauptagent, Standard AUS), EIN globales Budget (Grenze je Zeitraum, erlaubte Modelle),
 *   Einstellwerte (Quelle sichtbar), Kosten je Monat/Agent/Modell. Ohne Budget: keine kostenpflichtigen Aufrufe.
 * Echt angeschlossen (core api-agent-dienst.ts, derselbe Dienst wie admin api_*):
 *   GET /api/main-agent/api, PUT /api/main-agent/api/schalter, PUT|DELETE /api/main-agent/api/budget,
 *   PUT /api/main-agent/api/einstellungen, GET /api/main-agent/api/kosten
 * P22-T175: eigener Bereich Einstellungen > API-Agenten (ControlPlaneSettingsView.tsx). 'API-Key vorhanden: ja/nein' mit dem Ort zum
 *   Hinterlegen (nie der Wert), Budgetzeile gebucht/offen/verfallen/Rest; ohne Budget ist das Formular mit dem Vorschlag des Users
 *   vorbelegt (25 USD je Tag, Haiku + Sonnet), wirksam erst mit 'Budget setzen'. Logik: api-budget-logik.ts.
 * P22-T176: Key in der Web-UI hinterlegen/ersetzen/entfernen/testen (ApiKeyFeld.tsx, Stand api_key ohne Wert); Grund steht oben,
 *   weil jede Aenderung ihn braucht.
 * P22-T180: Freigaben je Agent (ApiFreigabenFeld.tsx): Arbeitsagenten/Koordinatoren kostenpflichtig nur mit Freigabe des Users (Grund
 *   oben), Verbrauch/Rest je Agent, Schalter api_agenten je Projekt; nur Modelle mit Preis waehlbar.
 */
interface Modell { alias: string; anbieter_modell: string; eingabe: number | null; ausgabe: number | null; cache_lesen: number | null }
type Einstellungen = Record<string, { wert: number; quelle: string }>;
interface Status {
  schalter: { aktiv: boolean; hauptagent: { aktiv: boolean; quelle: string }; api: { aktiv: boolean; quelle: string; letzter_fehler: string | null } };
  budget: ApiBudgetStand; einstellungen: Einstellungen; modelle: Modell[]; api_key_vorhanden: boolean; api_key?: ApiKeyStand;
}
interface KostenZeile { aufrufe: number; usd: number; monat?: string; agent_id?: string | null; modell?: string }
interface Kosten { gesamt: KostenZeile; je_monat: KostenZeile[]; je_agent: KostenZeile[]; je_modell: KostenZeile[] }

const EINSTELLUNG_TEXT: Record<string, string> = {
  max_tokens_obergrenze: 'Hoechstes max_tokens je Aufruf',
  reservierung_minuten: 'Offene Reservierung verfaellt nach (Minuten, zaehlt dann voll)',
  toolrunden_max: 'Toolrunden je Nachricht',
  laufzeit_minuten: 'Laufzeit je Nachricht (Minuten)',
  cache_schreib_faktor: 'Aufschlag Cache-Schreiben auf den Eingabepreis',
};

function fehlerText(daten: unknown, status: number): string {
  const e = (daten as { error?: { code?: string; message?: string } | string } | null)?.error;
  const code = typeof e === 'string' ? e : e?.code;
  return (code ?? 'fehler') + ' (HTTP ' + status + ')';
}

export function ApiBudgetPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [kosten, setKosten] = useState<Kosten | null>(null);
  const [grund, setGrund] = useState('');
  const [grenze, setGrenze] = useState('');
  const [zeitraum, setZeitraum] = useState('monat');
  const [resetTag, setResetTag] = useState('1');
  const [modelle, setModelle] = useState<string[]>([]);
  const [vorschlag, setVorschlag] = useState(false);
  const [werte, setWerte] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const laden = useCallback(async () => {
    try {
      const [r, k] = await Promise.all([apiFetch('/api/main-agent/api'), apiFetch('/api/main-agent/api/kosten')]);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      const s = d as Status;
      setStatus(s);
      const f = budgetFormular(s.budget, s.modelle.map(m => m.alias));
      setGrenze(f.grenze);
      setZeitraum(f.zeitraum);
      setResetTag(f.resetTag);
      setModelle(f.modelle);
      setVorschlag(f.vorschlag);
      setWerte(Object.fromEntries(Object.entries(s.einstellungen).map(([n, v]) => [n, String(v.wert)])));
      const kd = await k.json().catch(() => null);
      setKosten(k.ok ? (kd as Kosten) : null);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => { void laden(); }, [laden]);

  const senden = async (pfad: string, methode: string, koerper: Record<string, unknown>, erfolg: string): Promise<boolean> => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await apiFetch(pfad, { method: methode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...koerper, grund }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setNotice(erfolg);
      await laden();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const grundOk = grund.trim().length >= 5;
  const s = status;
  const key = s ? (s.api_key ? apiKeyStandZeile(s.api_key) : apiKeyAnzeige(s.api_key_vorhanden)) : null;
  const geaenderteWerte = s ? Object.fromEntries(Object.entries(werte).filter(([n, v]) => Number(v) !== s.einstellungen[n]?.wert).map(([n, v]) => [n, Number(v)])) : {};
  return <section aria-label="API-Zugang des Hauptagenten">
    <h3>API-Zugang (Claude per API-Key) · kostenpflichtig</h3>
    <p>Getrennt vom CLI-Abo. Ohne gesetztes Budget gibt es keine kostenpflichtigen Aufrufe und keinen bezahlten Ersatz. Werte setzt nur der User.</p>
    <div className="cp-fields">
      <div className="cp-setting-field wide"><span><b>Grund</b><small>Pflicht fuer jede Aenderung, mindestens 5 Zeichen.</small></span>
        <input value={grund} onChange={(event) => setGrund(event.target.value)} placeholder="z. B. Tageslimit 25 USD für den API-Hauptagenten" />
      </div>
      <div className="scope-warning wide" data-api-key-vorhanden={key?.wert ?? ''}><b>API-Key vorhanden: {key?.wert ?? '…'}</b><span>{key?.text ?? ''}</span></div>
      {s?.api_key && <ApiKeyFeld stand={s.api_key} grundOk={grundOk} busy={busy} senden={senden} />}
      <div className="cp-setting-field wide">
        <span>
          <b>Funktion api: {s ? (s.schalter.api.aktiv ? 'EIN' : 'AUS') : '…'} · wirksam: {s ? (s.schalter.aktiv ? 'ja' : 'nein') : '…'}</b>
          <small>{s ? 'Hauptagent ' + (s.schalter.hauptagent.aktiv ? 'EIN' : 'AUS') + ' (' + s.schalter.hauptagent.quelle + ') · Funktion api Quelle ' + s.schalter.api.quelle
            + (s.schalter.api.letzter_fehler ? ' · Fehler: ' + s.schalter.api.letzter_fehler : '') : ''}</small>
        </span>
        <button type="button" disabled={busy || !grundOk || !s} onClick={() => void senden('/api/main-agent/api/schalter', 'PUT', { aktiv: !s?.schalter.api.aktiv }, 'Funktion api ' + (s?.schalter.api.aktiv ? 'AUS' : 'EIN') + '.')}>{s?.schalter.api.aktiv ? 'Ausschalten' : 'Einschalten'}</button>
      </div>
      <div className="scope-warning wide" data-api-budget={s ? (s.budget.gesetzt ? 'gesetzt' : 'fehlt') : ''}><b>Budget</b><span data-budget-zeile="">{s ? budgetZeile(s.budget) : '…'}</span></div>
      {vorschlag && <div className="scope-warning wide" data-api-budget-vorschlag=""><b>Vorschlag</b><span>{API_BUDGET_VORSCHLAG.grenze_usd} USD je Tag (bleibt unter 25 €), Modelle Haiku + Sonnet. Wirksam erst mit „Budget setzen“.</span></div>}
      <label className="cp-setting-field"><span><b>Grenze (USD)</b><small>je Zeitraum, &gt; 0</small></span><input type="number" min="0" step="0.01" value={grenze} onChange={(event) => setGrenze(event.target.value)} /></label>
      <label className="cp-setting-field"><span><b>Zeitraum</b><small>monat ab Reset-Tag</small></span>
        <select value={zeitraum} onChange={(event) => setZeitraum(event.target.value)}><option value="tag">tag</option><option value="woche">woche</option><option value="monat">monat</option></select></label>
      <label className="cp-setting-field"><span><b>Reset-Tag</b><small>1..28 (nur monat)</small></span><input type="number" min="1" max="28" value={resetTag} disabled={zeitraum !== 'monat'} onChange={(event) => setResetTag(event.target.value)} /></label>
      <div className="cp-setting-field wide"><span><b>Erlaubte Modelle</b><small>Preis je 1 Mio. Tokens (Eingabe / Ausgabe / Cache-Lesen) aus der Modell-Registry</small></span>
        <div>{(s?.modelle ?? []).map(m => <label key={m.alias} className="cp-haken">
          <input type="checkbox" checked={modelle.includes(m.alias)} onChange={(event) => setModelle(event.target.checked ? [...modelle, m.alias] : modelle.filter(x => x !== m.alias))} />
          {' '}{m.alias} ({m.anbieter_modell}) · {m.eingabe ?? '?'} / {m.ausgabe ?? '?'} / {m.cache_lesen ?? '?'} USD
        </label>)}</div>
      </div>
      <div className="wide">
        <button type="button" disabled={busy || !grundOk || !(Number(grenze) > 0) || !modelle.length} onClick={() => void senden('/api/main-agent/api/budget', 'PUT',
          { grenze_usd: Number(grenze), zeitraum, reset_tag: Number(resetTag), erlaubte_modelle: modelle }, 'Budget gesetzt.')}>Budget setzen</button>
        {' '}<button type="button" disabled={busy || !grundOk || !s?.budget.gesetzt} onClick={() => void senden('/api/main-agent/api/budget', 'DELETE', {}, 'Budget entfernt - keine kostenpflichtigen Aufrufe mehr.')}>Budget entfernen</button>
      </div>
      {s && Object.entries(s.einstellungen).map(([name, v]) => <label key={name} className="cp-setting-field"><span><b>{EINSTELLUNG_TEXT[name] ?? name}</b><small>{name} · Quelle {v.quelle}</small></span>
        <input type="number" value={werte[name] ?? ''} onChange={(event) => setWerte({ ...werte, [name]: event.target.value })} /></label>)}
      <div className="wide"><button type="button" disabled={busy || !grundOk || !Object.keys(geaenderteWerte).length} onClick={() => void senden('/api/main-agent/api/einstellungen', 'PUT', { werte: geaenderteWerte }, 'Einstellwerte gespeichert.')}>Einstellwerte speichern</button></div>
      {s && <ApiFreigabenFeld modelle={s.modelle.filter(m => (m.eingabe ?? 0) > 0 && (m.ausgabe ?? 0) > 0).map(m => m.alias)} grundOk={grundOk} busy={busy} senden={senden} />}
      <div className="scope-warning wide"><b>Kosten</b><span>{kosten
        ? 'Gesamt ' + usd(kosten.gesamt.usd) + ' in ' + kosten.gesamt.aufrufe + ' Aufrufen · je Monat: ' + (kosten.je_monat.map(z => z.monat + ' ' + usd(z.usd)).join(', ') || '–')
          + ' · je Agent: ' + (kosten.je_agent.map(z => (z.agent_id ?? '?') + ' ' + usd(z.usd)).join(', ') || '–')
          + ' · je Modell: ' + (kosten.je_modell.map(z => z.modell + ' ' + usd(z.usd)).join(', ') || '–')
        : '–'}</span></div>
      <div className="scope-warning wide"><b>Status</b><span>{error ? 'Fehler: ' + error : notice || 'Bereit'}</span></div>
      <div className="wide"><button type="button" disabled={busy} onClick={() => void laden()}>Neu laden</button></div>
    </div>
  </section>;
}
