import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from '../api/auth';
import { apiKeyAnzeige, apiKeyStandZeile, budgetFormular, budgetZeile, usd, API_BUDGET_VORSCHLAG, type ApiBudgetStand, type ApiKeyStand } from './api-budget-logik';
import { API_BASIS, type ApiAuswahlStand } from './api-laufwahl-logik';
import { ApiAgentLaeufe } from './ApiAgentLaufwahl';
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
 * P22-T281 (User 08.11.2026): gleiche Bausteine wie Container-Agenten (cp-fields, cp-setting-field, settings-switch, scope-warning,
 *   cp-aktionen); Schalter api_agenten_auswahl (API-Gruppen im Modell-Chip) hier als Umschalter; Debug nur als data-Attribut.
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
  max_tokens_obergrenze: 'Höchstes max_tokens je Aufruf',
  reservierung_minuten: 'Offene Reservierung verfällt nach (Minuten, zählt dann voll)',
  toolrunden_max: 'Toolrunden je Nachricht',
  laufzeit_minuten: 'Laufzeit je Nachricht (Minuten)',
  cache_schreib_faktor: 'Aufschlag für Cache-Schreiben auf den Eingabepreis',
};

function fehlerText(daten: unknown, status: number): string {
  const e = (daten as { error?: { code?: string; message?: string } | string } | null)?.error;
  const code = typeof e === 'string' ? e : e?.code;
  return (code ?? 'fehler') + ' (HTTP ' + status + ')';
}

/** Umschalter im Stil der übrigen Einstellungen (cp-setting-field toggle + settings-switch). */
function Umschalter({ titel, text, an, gesperrt, onUmschalten, daten }: { titel: string; text: string; an: boolean | null; gesperrt: boolean; onUmschalten: () => void; daten?: string }) {
  return <div className="cp-setting-field toggle" data-api-schalter={daten}>
    <span><b>{titel}: {an === null ? '…' : an ? 'EIN' : 'AUS'}</b><small>{text}</small></span>
    <button type="button" className={'settings-switch' + (an ? ' on' : '')} aria-label={titel} aria-pressed={!!an} disabled={gesperrt || an === null} onClick={onUmschalten}><i /></button>
  </div>;
}

/** P22-T281: einklappbarer Abschnitt der Einstellungen (cp-karte); im Kopf Titel und Kurzstand, innen dieselben cp-Felder. */
function Karte({ titel, stand, offen = false, daten, children }: { titel: string; stand: string; offen?: boolean; daten?: string; children: ReactNode }) {
  return <details className="cp-karte" open={offen} data-api-karte={titel} data-stand={daten}>
    <summary><span><b>{titel}</b><small>{stand}</small></span></summary>
    <div className="cp-fields">{children}</div>
  </details>;
}

export function ApiBudgetPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [kosten, setKosten] = useState<Kosten | null>(null);
  const [auswahl, setAuswahl] = useState<ApiAuswahlStand | null>(null);
  // P22-T281: Grund vorbelegt (mindestens 5 Zeichen), klein am Seitenende änderbar.
  const [grund, setGrund] = useState('Änderung in Einstellungen › API-Agenten');
  const [grenze, setGrenze] = useState('');
  const [zeitraum, setZeitraum] = useState('monat');
  const [resetTag, setResetTag] = useState('1');
  const [modelle, setModelle] = useState<string[]>([]);
  const [vorschlag, setVorschlag] = useState(false);
  const [werte, setWerte] = useState<Record<string, string>>({});
  // P22-T278 C: Rueckfall-Kette bei Tageslimit (GET/PUT /api/main-agent/api/rueckfall).
  const [rueckfall, setRueckfall] = useState<{ modelle: string[]; effort: string | null; quelle: string; standard: { modelle: string[]; effort: string } } | null>(null);
  const [rueckfallText, setRueckfallText] = useState('');
  const [rueckfallEffort, setRueckfallEffort] = useState('');
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
      // Befund f2bf5cbb (c): ohne Budget bleibt die Grenze leer; der Vorschlag steht nur als Text an den Budget-Knöpfen.
      setGrenze(f.vorschlag ? '' : f.grenze);
      setZeitraum(f.zeitraum);
      setResetTag(f.resetTag);
      setModelle(f.modelle);
      setVorschlag(f.vorschlag);
      setWerte(Object.fromEntries(Object.entries(s.einstellungen).map(([n, v]) => [n, String(v.wert)])));
      const kd = await k.json().catch(() => null);
      setKosten(k.ok ? (kd as Kosten) : null);
      const rf = await apiFetch('/api/main-agent/api/rueckfall').then(x => x.ok ? x.json() : null).catch(() => null);
      if (rf?.rueckfall) { setRueckfall(rf.rueckfall); setRueckfallText(rf.rueckfall.modelle.join(', ')); setRueckfallEffort(rf.rueckfall.effort ?? ''); }
      // P22-T281: Schalter api_agenten_auswahl und Anbieter-Stand (DeepSeek) aus demselben Vertrag wie der Modell-Chip.
      const a = await apiFetch(API_BASIS + '/auswahl?identity_id=main').then(x => x.ok ? x.json() : null).catch(() => null);
      setAuswahl(a as ApiAuswahlStand | null);
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
  const auswahlAn = auswahl ? auswahl.schalter.aktiv : null;
  // Befund f2bf5cbb (b): Schalter auf der Ebene setzen, die gerade wirkt (Projektzeile hat Vorrang vor global).
  const auswahlSchalter = auswahl?.schalter as (ApiAuswahlStand['schalter'] & { ebene?: string; project?: string }) | undefined;
  const auswahlEbene = auswahlSchalter?.ebene === 'projekt' ? 'projekt' : 'global';
  const auswahlProjekt = auswahlSchalter?.project ?? 'synapse-hauptagent';
  const ds = auswahl?.anbieter?.['deepseek-api'];
  const zugang = (a: string): string => { const z = auswahl?.anbieter?.[a]; return z ? (z.vorhanden ? 'Key vorhanden' : 'Key fehlt') : 'unbekannt'; };
  const zugangKurz = 'Claude ' + (key ? (key.wert === 'ja' ? 'Key vorhanden' : 'Key fehlt') : '…') + ' · OpenRouter ' + zugang('openrouter-api') + ' · DeepSeek ' + zugang('deepseek-api')
    + (ds ? ' (Schalter ' + (ds.schalter_aktiv ? 'EIN' : 'AUS') + ')' : '');
  return <div className="cp-fields" aria-label="API-Agenten">
    <Karte titel="Funktion und Schalter" stand={(s ? 'Funktion api ' + (s.schalter.api.aktiv ? 'EIN' : 'AUS') : '…') + ' · Modell-Chip ' + (auswahlAn === null ? '…' : auswahlAn ? 'EIN' : 'AUS')} offen>
      <Umschalter titel="Funktion api" daten={s ? (s.schalter.api.aktiv ? 'ein' : 'aus') : undefined} an={s ? s.schalter.api.aktiv : null} gesperrt={busy || !grundOk}
        text={s ? 'Wirksam: ' + (s.schalter.aktiv ? 'ja' : 'nein') + ' · Hauptagent ' + (s.schalter.hauptagent.aktiv ? 'EIN' : 'AUS') + ' · Quelle ' + s.schalter.api.quelle
          + (s.schalter.api.letzter_fehler ? ' · Fehler: ' + s.schalter.api.letzter_fehler : '') : 'wird geladen'}
        onUmschalten={() => void senden('/api/main-agent/api/schalter', 'PUT', { aktiv: !s?.schalter.api.aktiv }, 'Funktion api ' + (s?.schalter.api.aktiv ? 'AUS' : 'EIN') + '.')} />
      <Umschalter titel="API-Modelle im Modell-Chip" daten={auswahlAn === null ? undefined : auswahlAn ? 'ein' : 'aus'} an={auswahlAn} gesperrt={busy || !grundOk}
        text={'Schalter api_agenten_auswahl: Gruppen API · Claude, OpenRouter und DeepSeek im Modell-Chip. Wirksam auf Ebene '
          + (auswahlEbene === 'projekt' ? 'Projekt ' + auswahlProjekt : 'global') + ' (Quelle ' + (auswahl?.schalter.quelle ?? '…') + '); der Umschalter setzt genau diese Ebene.'}
        onUmschalten={() => void senden('/api/projects/' + encodeURIComponent(auswahlProjekt) + '/agent-profile/schalter', 'PUT', { profil_funktion: 'api_agenten_auswahl', aktiv: !auswahlAn, ebene: auswahlEbene },
          'API-Modelle im Modell-Chip ' + (auswahlAn ? 'AUS' : 'EIN') + '.')} />
    </Karte>
    <Karte titel="Budget" stand={s ? budgetZeile(s.budget) : '…'} offen daten={s ? (s.budget.gesetzt ? 'gesetzt' : 'fehlt') : undefined}>
      <label className="cp-setting-field"><span><b>Grenze (USD)</b><small>je Zeitraum, größer als 0</small></span><input type="number" min="0" step="0.01" value={grenze} onChange={(event) => setGrenze(event.target.value)} /></label>
      <label className="cp-setting-field"><span><b>Zeitraum</b><small>Monat beginnt am Reset-Tag (unter „Erweitert“)</small></span>
        <select value={zeitraum} onChange={(event) => setZeitraum(event.target.value)}><option value="tag">Tag</option><option value="woche">Woche</option><option value="monat">Monat</option></select></label>
      <div className="cp-setting-field wide"><span><b>Erlaubte Modelle</b><small>Preis je 1 Mio. Tokens (Eingabe / Ausgabe / Cache-Lesen) aus der Modell-Registry</small></span>
        <div>{(s?.modelle ?? []).map(m => <label key={m.alias} className="cp-haken">
          <input type="checkbox" checked={modelle.includes(m.alias)} onChange={(event) => setModelle(event.target.checked ? [...modelle, m.alias] : modelle.filter(x => x !== m.alias))} />
          {' '}{m.alias} ({m.anbieter_modell}) · {m.eingabe ?? '?'} / {m.ausgabe ?? '?'} / {m.cache_lesen ?? '?'} USD
        </label>)}</div>
      </div>
      <div className="cp-aktionen wide">
        <button type="button" className="primary" disabled={busy || !grundOk || !(Number(grenze) > 0) || !modelle.length} onClick={() => void senden('/api/main-agent/api/budget', 'PUT',
          { grenze_usd: Number(grenze), zeitraum, reset_tag: Number(resetTag), erlaubte_modelle: modelle }, 'Budget gesetzt.')}>Budget setzen</button>
        <button type="button" disabled={busy || !grundOk || !s?.budget.gesetzt} onClick={() => void senden('/api/main-agent/api/budget', 'DELETE', {}, 'Budget entfernt – keine kostenpflichtigen Aufrufe mehr.')}>Budget entfernen</button>
        <small data-api-budget-vorschlag={vorschlag ? '' : undefined}>{vorschlag ? 'Vorschlag: ' + API_BUDGET_VORSCHLAG.grenze_usd + ' USD je Tag, Haiku + Sonnet, wirksam mit „Budget setzen“.'
          : kosten ? 'Kosten gesamt ' + usd(kosten.gesamt.usd) + ' in ' + kosten.gesamt.aufrufe + ' Aufrufen' : ''}</small>
      </div>
    </Karte>
    <Karte titel="Zugänge" stand={zugangKurz} daten={key?.wert}>
      {s?.api_key && <ApiKeyFeld stand={s.api_key} grundOk={grundOk} busy={busy} senden={senden} />}
    </Karte>
    <Karte titel="Freigaben je Agent" stand="Arbeitsagenten und Koordinatoren arbeiten kostenpflichtig nur mit Freigabe des Users.">
      {s && <ApiFreigabenFeld modelle={s.modelle.filter(m => (m.eingabe ?? 0) > 0 && (m.ausgabe ?? 0) > 0).map(m => m.alias)} grundOk={grundOk} busy={busy} senden={senden} />}
    </Karte>
    <Karte titel="Rückfall bei Tageslimit" stand={rueckfall ? (rueckfall.modelle.length ? rueckfall.modelle : rueckfall.standard.modelle).join(' → ') + ' (' + rueckfall.quelle + ')' : '…'} daten={rueckfall?.quelle}>
      <label className="cp-setting-field wide"><span><b>CLI-Modelle in Reihenfolge</b>
        <small>Durch Komma getrennt; das erste verfügbare startet, für alle API-Anbieter. Standard {rueckfall?.standard.modelle.join(' → ') ?? '…'}, Codex-Effort {rueckfall?.standard.effort ?? '…'}. Tageslimit = Budget mit Zeitraum „Tag“ und Grenze je Agent.</small></span>
        <input value={rueckfallText} onChange={(event) => setRueckfallText(event.target.value)} placeholder="haiku, codex/gpt-6.1-terra, codex/gpt-6.1-luna" /></label>
      <label className="cp-setting-field"><span><b>Codex-Effort im Rückfall</b><small>nur für Codex-Modelle</small></span>
        <select value={rueckfallEffort} onChange={(event) => setRueckfallEffort(event.target.value)}><option value="">CLI-Standard</option>
          {['minimal', 'low', 'medium', 'high', 'xhigh'].map(x => <option key={x} value={x}>{x}</option>)}</select></label>
      <div className="cp-aktionen"><button type="button" className="primary" disabled={busy || !grundOk || !rueckfallText.trim()} onClick={() => void senden('/api/main-agent/api/rueckfall', 'PUT',
        { modelle: rueckfallText.split(',').map(x => x.trim()).filter(Boolean), effort: rueckfallEffort }, 'Rückfall-Kette gespeichert.')}>Rückfall speichern</button>
        <button type="button" disabled={busy || !grundOk || rueckfall?.quelle !== 'einstellung'} onClick={() => void senden('/api/main-agent/api/rueckfall', 'PUT', { modelle: [] }, 'Rückfall-Kette auf Standard.')}>Standard</button></div>
    </Karte>
    <Karte titel="API-Läufe und Kosten" stand={kosten ? 'Gesamt ' + usd(kosten.gesamt.usd) + ' in ' + kosten.gesamt.aufrufe + ' Aufrufen' : 'Laufende API-Agenten, Stop'}>
      <ApiAgentLaeufe />
      <div className="scope-warning wide"><b>Kosten</b><span>{kosten
        ? 'Gesamt ' + usd(kosten.gesamt.usd) + ' in ' + kosten.gesamt.aufrufe + ' Aufrufen · je Monat: ' + (kosten.je_monat.map(z => z.monat + ' ' + usd(z.usd)).join(', ') || '–')
          + ' · je Agent: ' + (kosten.je_agent.map(z => (z.agent_id ?? '?') + ' ' + usd(z.usd)).join(', ') || '–')
          + ' · je Modell: ' + (kosten.je_modell.map(z => z.modell + ' ' + usd(z.usd)).join(', ') || '–')
        : '–'}</span></div>
    </Karte>
    <Karte titel="Erweitert" stand="Reset-Tag des Monatsbudgets und Grenzwerte je Aufruf">
      <label className="cp-setting-field"><span><b>Reset-Tag</b><small>1 bis 28, nur bei Zeitraum Monat; wirkt mit „Budget setzen“</small></span><input type="number" min="1" max="28" value={resetTag} disabled={zeitraum !== 'monat'} onChange={(event) => setResetTag(event.target.value)} /></label>
      {s && Object.entries(s.einstellungen).map(([name, v]) => <label key={name} className="cp-setting-field"><span><b>{EINSTELLUNG_TEXT[name] ?? name}</b><small>{name} · Quelle {v.quelle}</small></span>
        <input type="number" value={werte[name] ?? ''} onChange={(event) => setWerte({ ...werte, [name]: event.target.value })} /></label>)}
      <div className="cp-aktionen wide"><button type="button" className="primary" disabled={busy || !grundOk || !Object.keys(geaenderteWerte).length} onClick={() => void senden('/api/main-agent/api/einstellungen', 'PUT', { werte: geaenderteWerte }, 'Einstellwerte gespeichert.')}>Einstellwerte speichern</button></div>
    </Karte>
    <div className="cp-aktionen wide">
      <label className="cp-grund" title="Wird bei jeder Änderung auf dieser Seite mitgespeichert (mindestens 5 Zeichen).">Grund<input value={grund} onChange={(event) => setGrund(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void laden()}>Neu laden</button>
      <small role="status">{error ? 'Fehler: ' + error : notice || (!s ? 'Lädt den API-Stand …' : grundOk ? 'Bereit.' : 'Grund fehlt (mindestens 5 Zeichen).')}</small></div>
  </div>;
}
