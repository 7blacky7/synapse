import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/auth';
import { getMainAgentModelle, type MainAgentModelle } from '../api/agent-runtime';
import '../hauptagent-steuerung.css';

/**
 * P22-T7 (W2d, User c4361edd): Steuerung des Hauptagenten als ZUSATZ im bestehenden Hauptagent-Chat (aufklappbar ueber
 * "Steuerung" im Chatkopf). Der Chat selbst bleibt unveraendert; keine Kacheln auf der Einstellungsseite.
 * Echt angeschlossen (nur interaktive User-Session):
 *   GET/PUT /api/main-agent/schalter     Produkt-Schalter hauptagent (Standard AUS)
 *   GET     /api/main-agent/status       Identitaet, gewuenscht vs. tatsaechlich, Heartbeat, offene Auftraege
 *   PUT     /api/main-agent/heartbeat    Heartbeat ein/aus + Takt (nur User, Standard AUS)
 *   GET     /api/main-agent/runtimes     eingerichtete Runtimes, getrennt nach Art (cli = Abo, api = Schluessel)
 *   POST    /api/main-agent/wechsel      Runtime-/Modellwechsel (Auftrag an die Identitaet bzw. Altweg Zuweisung)
 *   GET     /api/main-agent/modelle      P22-T62: Modelle BEIDER CLI-Runtimes (Gruppen Claude Code / Codex), Standard je Runtime;
 *                                        ein Klick wechselt Runtime + Modell (POST /api/main-agent/wechsel {runtime, modell})
 *   GET     /api/main-agent/verbrauch    Abo-Tokens des Hauptagenten im laufenden Monat
 *   GET/PUT /api/main-agent/ueberwachung(/schalter)  P22-T58: Ueberwachung der Runtime-Container (Zustand, letzte Ereignisse)
 *   POST    /api/main-agent/ueberwachung/takt        P22-T58: sofort pruefen (trocken = nur bewerten)
 * Tatsaechlich gilt erst nach bestaetigtem Neustart (Ausfuehrer P22-T6).
 */
interface Status {
  schalter: { aktiv: boolean; quelle: string };
  identitaet: null | { runtime_gewuenscht: string | null; runtime_tatsaechlich: string | null; modell_gewuenscht: string | null; modell_tatsaechlich: string | null };
  heartbeat?: {
    gewuenscht: { aktiv: boolean; intervall_ms: number | null };
    tatsaechlich: { lauf: boolean; status: string; aktiv: boolean | null };
  };
  auftraege_offen: Array<{ auftrag_id: string; art: string; status: string; ausfuehrung?: string }>;
}
interface RuntimeEintrag { runtime: string; label: string; art: 'cli' | 'api'; bereit: boolean; zugewiesen: boolean; modell?: string | null }
interface Verbrauch { je_agent: Array<{ agent_id: string; zugang: string; tokens_gesamt: number }>; schalter: { aktiv: boolean } }
interface Ueberwachung {
  schalter: { aktiv: boolean; quelle: string };
  runtimes: Array<{ runtime: string; zustand: string; ursache: string | null; seit: string }>;
  ereignisse: Array<{ id: string; zeit: string; runtime: string; art: string; ursache: string | null }>;
  umzuege?: Array<{ id: string; project: string; agent_name: string | null; ursprung_runtime: string; nach_runtime: string; status: string }>;
  free_stufe?: string;
}
const CLI_GRUPPE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const STANDARD_QUELLE: Record<string, string> = { user_wahl: 'deine Wahl', profil: 'gespeichertes Modell', kleinstes: 'kleinstes Modell', schalter_aus: 'Altstandard', keins: 'keins' };
const uhrzeit = (iso: string): string => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

async function anfrage<T>(pfad: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(pfad, init);
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const e = (d as { error?: { code?: string; message?: string } | string } | null)?.error;
    throw new Error((typeof e === 'string' ? e : (e?.code ?? e?.message ?? 'fehler')) + ' (HTTP ' + r.status + ')');
  }
  return d as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** P22-T7: Abo-Tokens je Agent eines Projekts im laufenden Monat (agent_id -> Tokens); null = nicht ladbar. */
export function useAgentVerbrauch(project: string): Record<string, number> | null {
  const [werte, setWerte] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let aktiv = true;
    setWerte(null);
    if (!project) return;
    anfrage<Verbrauch>('/api/main-agent/verbrauch?project=' + encodeURIComponent(project)).then((vb) => {
      if (!aktiv) return;
      const aus: Record<string, number> = {};
      for (const a of vb.je_agent) if (a.zugang === 'abo') aus[a.agent_id] = (aus[a.agent_id] ?? 0) + a.tokens_gesamt;
      setWerte(aus);
    }).catch(() => { if (aktiv) setWerte(null); });
    return () => { aktiv = false; };
  }, [project]);
  return werte;
}

export function HauptagentSteuerung() {
  const [status, setStatus] = useState<Status | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeEintrag[]>([]);
  const [tokens, setTokens] = useState<number | null>(null);
  const [zaehlung, setZaehlung] = useState<boolean | null>(null);
  const [ueberwachung, setUeberwachung] = useState<Ueberwachung | null>(null);
  const [ziel, setZiel] = useState('');
  const [modelle, setModelle] = useState<MainAgentModelle | null>(null);
  const [modellWahl, setModellWahl] = useState('');
  const [takt, setTakt] = useState('');
  const [grund, setGrund] = useState('Steuerung im Hauptagent-Chat');
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState('');
  const [fehler, setFehler] = useState(false);

  const laden = useCallback(async () => {
    try {
      const [st, rt, vb] = await Promise.all([
        anfrage<Status>('/api/main-agent/status'),
        anfrage<{ runtimes: RuntimeEintrag[] }>('/api/main-agent/runtimes'),
        anfrage<Verbrauch>('/api/main-agent/verbrauch?project=synapse-hauptagent'),
      ]);
      setStatus(st);
      setRuntimes(rt.runtimes);
      setTokens(vb.je_agent.filter(a => a.agent_id === 'hauptagent' && a.zugang === 'abo').reduce((s, a) => s + a.tokens_gesamt, 0));
      setZaehlung(vb.schalter.aktiv);
      setTakt(st.heartbeat?.gewuenscht.intervall_ms ? String(Math.round(st.heartbeat.gewuenscht.intervall_ms / 1000)) : '');
      // P22-T58: eigene Anfrage, damit ein Fehler hier den Rest der Steuerung nicht blockiert.
      setUeberwachung(await anfrage<Ueberwachung>('/api/main-agent/ueberwachung?ereignisse=5').catch(() => null));
      setModelle(await getMainAgentModelle().catch(() => null));
    } catch (reason) { setFehler(true); setMeldung(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  useEffect(() => { void laden(); }, [laden]);

  const ausfuehren = async (text: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); setFehler(false); setMeldung(text); await laden(); } catch (reason) { setFehler(true); setMeldung(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  const grundOk = grund.trim().length >= 5;
  const s = status?.schalter;
  const i = status?.identitaet ?? null;
  const hb = status?.heartbeat;
  const heartbeatSetzen = (aktiv: boolean) => ausfuehren('Heartbeat ' + (aktiv ? 'EIN' : 'AUS') + ' gespeichert.', () => {
    const sek = takt.trim() ? Number(takt.trim()) : null;
    return anfrage('/api/main-agent/heartbeat', json('PUT', { aktiv, intervall_ms: sek === null ? null : Math.round(sek * 1000), grund }));
  });

  return <div className="hauptagent-steuerung">
    <div><span>Hauptagent <b>{s ? (s.aktiv ? 'EIN' : 'AUS') : '…'}</b></span>
      <button type="button" disabled={busy || !grundOk || !s} className={s?.aktiv ? 'on' : ''} onClick={() => void ausfuehren('Schalter gesetzt.', () => anfrage('/api/main-agent/schalter', json('PUT', { aktiv: !s?.aktiv, grund })))}>{s?.aktiv ? 'Ausschalten' : 'Einschalten'}</button></div>
    <div><span>Heartbeat <b>{hb ? (hb.gewuenscht.aktiv ? 'EIN' : 'AUS') : 'AUS (Standard)'}</b>{hb && <>laufend {hb.tatsaechlich.lauf ? (hb.tatsaechlich.aktiv ? 'EIN' : 'AUS') : 'kein Lauf'}</>}</span>
      <span><input className="takt" value={takt} inputMode="numeric" placeholder="adaptiv" title="Takt in Sekunden (mindestens 5), leer = adaptiv" onChange={(event) => setTakt(event.target.value.replace(/[^0-9]/g, ''))} />s
        <button type="button" disabled={busy || !grundOk || !i} className={hb?.gewuenscht.aktiv ? 'on' : ''} title={i ? '' : 'Erst nach dem ersten Main-Chat mit eingeschaltetem Hauptagenten; bis dahin AUS'} onClick={() => void heartbeatSetzen(!hb?.gewuenscht.aktiv)}>{hb?.gewuenscht.aktiv ? 'Heartbeat aus' : 'Heartbeat ein'}</button></span></div>
    <div><span>Runtime <b>{i ? (i.runtime_gewuenscht ?? '–') : (runtimes.find(r => r.zugewiesen)?.label ?? '–')}</b>{i && <>tatsächlich {i.runtime_tatsaechlich ?? 'unbestätigt'}</>}{(status?.auftraege_offen ?? []).map(a => <span key={a.auftrag_id}>· {a.art} {a.ausfuehrung ?? a.status}</span>)}</span>
      <span><select value={ziel} onChange={(event) => setZiel(event.target.value)}>
        <option value="">wechseln zu …</option>
        {(['cli', 'api'] as const).map(art => <optgroup key={art} label={art === 'cli' ? 'CLI (Abo)' : 'API (Schlüssel)'}>
          {runtimes.filter(r => r.art === art).map(r => <option key={r.runtime} value={r.runtime} disabled={!r.bereit}>{r.label}{r.bereit ? '' : ' (nicht bereit)'}</option>)}
        </optgroup>)}
      </select>
        <button type="button" disabled={busy || !grundOk || !ziel} title="Ohne Modell: Standard der Runtime" onClick={() => void ausfuehren('Wechsel beauftragt.', () => anfrage('/api/main-agent/wechsel', json('POST', { runtime: ziel, grund })))}>Wechseln</button></span></div>
    <div><span>Modell <b>{i?.modell_gewuenscht ?? '–'}</b>{i?.modell_tatsaechlich && <>tatsächlich {i.modell_tatsaechlich}</>}
      {modelle && !modelle.schalter.aktiv && <>· Modellwahl aus den CLI-Listen AUS (Altverhalten)</>}</span>
      <span><select value={modellWahl} disabled={!modelle} onChange={(event) => setModellWahl(event.target.value)}>
        <option value="">{modelle ? 'Modell wählen …' : 'Modelllisten nicht ladbar'}</option>
        {(modelle?.runtimes ?? []).map(r => <optgroup key={r.runtime} label={(CLI_GRUPPE[r.runtime] ?? r.label) + (r.grund ? ' – ' + r.grund : '')}>
          {r.modelle.length === 0 && <option value="" disabled>{'keine Modelle: ' + (r.grund ?? 'unbekannt')}</option>}
          {r.modelle.filter(m => m.sichtbar || m.modell === r.user_wahl).map(m => <option key={m.modell} value={r.runtime + '|' + m.modell} disabled={!r.bereit} title={m.beschreibung ?? ''}>
            {m.name}{m.name !== m.id ? ' (' + m.id + ')' : ''}{m.modell === r.standard.modell ? ' · Standard' : ''}{m.modell === r.user_wahl ? ' · deine Wahl' : ''}</option>)}
        </optgroup>)}
      </select>
        <button type="button" disabled={busy || !grundOk || !modellWahl} onClick={() => {
          const [rt, ...rest] = modellWahl.split('|');
          const m = rest.join('|');
          void ausfuehren('Wechsel zu ' + (CLI_GRUPPE[rt] ?? rt) + ' / ' + m + ' beauftragt.', () => anfrage('/api/main-agent/wechsel', json('POST', { runtime: rt, modell: m, grund })));
        }}>Wechseln</button></span></div>
    {modelle && <div><span>{modelle.runtimes.map(r => <span key={r.runtime} title={(r.hinweise ?? []).join(' | ')}>· {CLI_GRUPPE[r.runtime] ?? r.label}: {r.bereit
      ? 'Standard ' + (r.standard.modell ?? 'keins') + ' (' + (STANDARD_QUELLE[r.standard.quelle] ?? r.standard.quelle) + (r.standard.grund ? ', ' + r.standard.grund : '') + ')'
      : 'nicht verfügbar (' + (r.grund ?? 'unbekannt') + ')'}</span>)}</span></div>}
    <div><span>Überwachung <b>{ueberwachung ? (ueberwachung.schalter.aktiv ? 'EIN' : 'AUS') : '…'}</b>
      {(ueberwachung?.runtimes ?? []).map(r => <span key={r.runtime} title={r.ursache ?? ''}>· {r.runtime} {r.zustand}{r.ursache ? ' (' + r.ursache + ')' : ''}</span>)}</span>
      <span><button type="button" disabled={busy || !ueberwachung} onClick={() => void ausfuehren('Geprüft (nur bewertet).', () => anfrage('/api/main-agent/ueberwachung/takt', json('POST', { trocken: true })))}>Prüfen</button>
        <button type="button" disabled={busy || !grundOk || !ueberwachung} className={ueberwachung?.schalter.aktiv ? 'on' : ''} onClick={() => void ausfuehren('Überwachung gesetzt.', () => anfrage('/api/main-agent/ueberwachung/schalter', json('PUT', { aktiv: !ueberwachung?.schalter.aktiv, grund })))}>{ueberwachung?.schalter.aktiv ? 'Ausschalten' : 'Einschalten'}</button></span></div>
    {(ueberwachung?.umzuege ?? []).some(u => u.status === 'aktiv' || u.status === 'zurueck_stop') && <div><span>Umgezogen
      {ueberwachung!.umzuege!.filter(u => u.status === 'aktiv' || u.status === 'zurueck_stop').map(u => <span key={u.id}>· {u.agent_name ?? '?'} ({u.project}) {u.ursprung_runtime} → {u.nach_runtime}{u.status === 'zurueck_stop' ? ' (zurück läuft)' : ''}</span>)}</span></div>}
    {(ueberwachung?.ereignisse ?? []).length > 0 && <div><span>{ueberwachung!.ereignisse.map(e => <span key={e.id}>{uhrzeit(e.zeit)} {e.runtime} {e.art}{e.ursache ? ' (' + e.ursache + ')' : ''}</span>)}</span></div>}
    <div><span>Verbrauch diesen Monat <b>{tokens === null ? '…' : tokens.toLocaleString('de-DE') + ' Tokens'}</b>{zaehlung === false && <>(Zählung aus)</>}</span></div>
    <div><input className="grund" value={grund} onChange={(event) => setGrund(event.target.value)} title="Grund, Pflicht (mindestens 5 Zeichen)" placeholder="Grund" />
      <button type="button" disabled={busy} onClick={() => void laden()}>Neu laden</button></div>
    {meldung && <div className={fehler ? 'fehler' : ''}>{meldung}</div>}
  </div>;
}
