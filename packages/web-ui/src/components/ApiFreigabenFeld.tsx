import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/auth';
import { LaufHerkunftMarke } from './LaufHerkunftMarke';
import {
  formularAus, freigabeKoerper, freigabeZeile, kandidatLabel, rolleText, schalterText,
  type ApiFreigabeFormular, type ApiFreigabeZeile, type ApiFreigabenStand,
} from './api-freigaben-logik';

/**
 * P22-T180 (Folge aus P22-T179, thought 42fe86c8): Freigaben je Agent in Einstellungen > API-Agenten (Teil von ApiBudgetPanel).
 *   Liste je Freigabe (Agent mit Lauf-Herkunft aus P22-T178, Rolle, Projekt, Modelle, eigene Grenze, Verbrauch, Rest, Heartbeat), Schalter
 *   api_agenten je Projekt, Freigabe setzen/aendern/entziehen NUR durch den User mit dem Grund des Panels (Pflicht). Kostenpflichtig nie
 *   automatisch: ohne Klick keine Freigabe; Heartbeat Standard AUS (jeder Weckruf kostet).
 *   Routen (core api-agent-freigabe.ts): GET /api/main-agent/api/freigaben?kandidaten=1, PUT/DELETE /api/main-agent/api/freigaben.
 * DEBUG: data-api-freigaben (Anzahl), data-api-freigabe=<identity_id>, data-api-freigabe-aktiv, data-api-agenten-schalter (ein|aus).
 */
export function ApiFreigabenFeld({ modelle, grundOk, busy, senden }: {
  /** API-Modelle mit Preis (Registry), Auswahl der Freigabe. */
  modelle: string[];
  grundOk: boolean; busy: boolean;
  senden: (pfad: string, methode: string, koerper: Record<string, unknown>, erfolg: string) => Promise<boolean>;
}) {
  const [stand, setStand] = useState<ApiFreigabenStand | null>(null);
  const [fehler, setFehler] = useState('');
  const [form, setForm] = useState<ApiFreigabeFormular>(() => formularAus(null, modelle));

  const laden = useCallback(async () => {
    try {
      const r = await apiFetch('/api/main-agent/api/freigaben?kandidaten=1');
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(((d as { error?: { code?: string } } | null)?.error?.code ?? 'fehler') + ' (HTTP ' + r.status + ')');
      setStand(d as ApiFreigabenStand);
      setFehler('');
    } catch (reason) {
      setFehler(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => { void laden(); }, [laden]);
  // Vorschlag Haiku, sobald die Modelle da sind (nur solange noch nichts gewaehlt ist).
  useEffect(() => {
    setForm(f => {
      if (f.identity_id || f.modelle.length) return f;
      const neu = formularAus(null, modelle);
      return neu.modelle.length ? neu : f;
    });
  }, [modelle]);

  const kandidat = stand?.kandidaten?.find(k => k.identity_id === form.identity_id) ?? null;
  const schalter = kandidat ? schalterText(kandidat.project, stand?.schalter_je_projekt?.[kandidat.project]) : null;
  const pruefung = freigabeKoerper(form);
  const setzen = async () => {
    if (!pruefung.ok) return;
    if (await senden('/api/main-agent/api/freigaben', 'PUT', pruefung.koerper, 'Freigabe für ' + (kandidat?.agent_id ?? form.identity_id) + ' gesetzt.')) {
      setForm(formularAus(null, modelle));
      await laden();
    }
  };
  const entziehen = async (f: ApiFreigabeZeile) => {
    if (await senden('/api/main-agent/api/freigaben', 'DELETE', { identity_id: f.identity_id }, 'Freigabe für ' + f.agent_id + ' entzogen.')) await laden();
  };

  const freigaben = stand?.freigaben ?? [];
  return <div className="cp-setting-field wide" data-api-freigaben={freigaben.length}>
    <span>
      <b>Freigaben je Agent (Arbeitsagenten und Koordinatoren)</b>
      <small>Kostenpflichtig nur mit Freigabe des Users, nie automatisch. Wirksam erst mit Funktion api EIN, Schalter api_agenten EIN im
        Projekt und globalem Budget. Heartbeat eines API-Agenten ist Standard AUS (jeder Weckruf kostet).
        {stand?.schalter ? ' Schalter api_agenten (global): ' + (stand.schalter.aktiv ? 'EIN' : 'AUS') + ' (' + stand.schalter.quelle + ').' : ''}
        {fehler ? ' Fehler: ' + fehler : ''}</small>
    </span>
    <div>
      {!freigaben.length && <div className="scope-warning" data-api-freigaben-leer=""><b>Keine Freigaben</b><span>Kein Arbeitsagent und kein Koordinator darf kostenpflichtig arbeiten.</span></div>}
      {freigaben.map(f => <div key={f.identity_id} className="scope-warning" data-api-freigabe={f.identity_id} data-api-freigabe-aktiv={f.aktiv ? 'ja' : 'nein'}
        data-api-agenten-schalter={f.api_agenten_aktiv ? 'ein' : 'aus'}>
        <b>{f.agent_id}<LaufHerkunftMarke project={f.project} identityId={f.identity_id} name={f.agent_id} /> · {rolleText(f.rolle)} · {f.project}</b>
        <span data-api-freigabe-zeile="">{freigabeZeile(f)}{f.api_agenten_aktiv === false ? ' · Schalter api_agenten im Projekt AUS (Freigabe wirkt nicht)' : ''}</span>
        <span>
          <button type="button" disabled={busy} onClick={() => setForm(formularAus(f, modelle))}>Bearbeiten</button>
          {' '}<button type="button" disabled={busy || !grundOk} onClick={() => void entziehen(f)}>Entziehen</button>
        </span>
      </div>)}
      <div className="scope-warning" data-api-freigabe-formular="">
        <b>Freigabe setzen oder ändern</b>
        <label className="cp-feld">Agent{' '}
          <select value={form.identity_id} onChange={(event) => {
            const id = event.target.value;
            const vorhanden = freigaben.find(f => f.identity_id === id) ?? null;
            setForm(vorhanden ? formularAus(vorhanden, modelle) : { ...formularAus(null, modelle), identity_id: id });
          }}>
            <option value="">– Agent wählen –</option>
            {(stand?.kandidaten ?? []).map(k => <option key={k.identity_id} value={k.identity_id}>{kandidatLabel(k)}</option>)}
          </select>
        </label>
        {schalter && <span data-api-agenten-schalter={schalter.aktiv ? 'ein' : 'aus'}>{schalter.text}</span>}
        <span className="cp-haken">Modelle:{' '}{modelle.map(m => <label key={m} className="cp-haken">
          <input type="checkbox" checked={form.modelle.includes(m)} onChange={(event) => setForm({ ...form, modelle: event.target.checked ? [...form.modelle, m] : form.modelle.filter(x => x !== m) })} />
          {' '}{m}</label>)}</span>
        <label className="cp-feld">Eigene Grenze (USD, leer = nur globales Budget){' '}
          <input type="number" min="0" step="0.01" value={form.grenze} onChange={(event) => setForm({ ...form, grenze: event.target.value })} /></label>
        <label className="cp-haken"><input type="checkbox" checked={form.heartbeat} onChange={(event) => setForm({ ...form, heartbeat: event.target.checked })} />
          {' '}Heartbeat (jeder Weckruf kostet; Standard aus)</label>
        <label className="cp-haken"><input type="checkbox" checked={form.aktiv} onChange={(event) => setForm({ ...form, aktiv: event.target.checked })} />
          {' '}aktiv</label>
        <span>
          <button type="button" disabled={busy || !grundOk || !pruefung.ok || schalter?.aktiv === false} onClick={() => void setzen()}>Freigabe setzen</button>
          {!pruefung.ok && form.identity_id && <small>{' '}{pruefung.grund}</small>}
          {!grundOk && <small>{' '}Grund oben eintragen (mindestens 5 Zeichen).</small>}
        </span>
      </div>
    </div>
  </div>;
}
