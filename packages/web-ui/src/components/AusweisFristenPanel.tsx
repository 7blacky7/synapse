import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/auth';

/**
 * P22-T45: Fristen des Agenten-Ausweises (Schatten, Erstnutzung, Visum, Arbeitsfreigabe) lesen und setzen.
 * Echt angeschlossen: GET/PUT /api/projects/:project/agent-profile/ausweis-fristen (derselbe Core-Dispatcher wie
 * admin ausweis_fristen). Projektebene oder global (User und Koordinator); Wert + Quelle (standard|global|projekt) je Frist.
 */
type FristName = 'schatten_stunden' | 'erstnutzung_minuten' | 'visum_minuten' | 'arbeitsfreigabe_stunden' | 'anmeldung_plaene_minuten' | 'files_plan_stunden' | 'shell_hinweis_minuten' | 'coedit_aktiv_sekunden';
interface FristWert {
  name: FristName;
  wert: number;
  einheit: 'stunden' | 'minuten' | 'sekunden';
  quelle: 'standard' | 'global' | 'projekt';
  standard: number;
  global: number | null;
  projekt: number | null;
  bereich: { min: number; max: number };
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  wirkung: string;
}
interface FristenStand { project: string | null; fristen: Record<FristName, FristWert>; letzter_fehler: string | null; hinweis: string }
/** P6-T49 Nachtrag: Produkt-Schalter Fristablauf offener files-Plaene (Standard EIN), kommt in derselben Antwort. */
interface AblaufSchalter { aktiv: boolean; quelle: 'standard' | 'global' | 'projekt'; global: boolean | null; projekt: boolean | null; letzter_fehler: string | null }

const NAMEN: Array<{ name: FristName; label: string }> = [
  { name: 'schatten_stunden', label: 'Schattenprofil' },
  { name: 'erstnutzung_minuten', label: 'Erstnutzung vorbereiteter Ausweise' },
  { name: 'visum_minuten', label: 'Visum' },
  { name: 'arbeitsfreigabe_stunden', label: 'Arbeitsfreigabe' },
  { name: 'anmeldung_plaene_minuten', label: 'Eigene offene Pläne in der Anmeldung' },
  { name: 'files_plan_stunden', label: 'Offene files-Pläne laufen ab nach (ohne Aktivität)' },
  { name: 'shell_hinweis_minuten', label: 'Beendete Shell-Jobs in shell_activity zeigen bis' },
  { name: 'coedit_aktiv_sekunden', label: 'Co-Edit: commit wartet auf aktive Beitragende hoechstens (nur Schalter coedit_ohne_gate AUS)' },
];
const QUELLE: Record<FristWert['quelle'], string> = { standard: 'Standard', global: 'global', projekt: 'Projekt' };
const einheit = (f: FristWert) => (f.einheit === 'stunden' ? 'Std.' : f.einheit === 'sekunden' ? 'Sek.' : 'Min.');

function fehlerText(daten: unknown, status: number): string {
  const e = (daten as { error?: { code?: string } | string } | null)?.error;
  const code = typeof e === 'string' ? e : e?.code;
  return (code ?? 'fehler') + ' (HTTP ' + status + ')';
}

export function AusweisFristenPanel({ project }: { project: string }) {
  const basis = '/api/projects/' + encodeURIComponent(project) + '/agent-profile/ausweis-fristen';
  const [stand, setStand] = useState<FristenStand | null>(null);
  const [ablauf, setAblauf] = useState<AblaufSchalter | null>(null);
  const [ebene, setEbene] = useState<'projekt' | 'global'>('projekt');
  const [eingaben, setEingaben] = useState<Partial<Record<FristName, string>>>({});
  const [grund, setGrund] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const laden = useCallback(async () => {
    try {
      const r = await apiFetch(basis);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setStand((d as { ausweis_fristen: FristenStand }).ausweis_fristen);
      setAblauf((d as { files_plan_ablauf?: AblaufSchalter }).files_plan_ablauf ?? null);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [basis]);

  useEffect(() => { void laden(); }, [laden]);

  const senden = async (body: Record<string, unknown>, meldung: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await apiFetch(basis, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ebene, grund }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setStand((d as { ausweis_fristen: FristenStand }).ausweis_fristen);
      setAblauf((d as { files_plan_ablauf?: AblaufSchalter }).files_plan_ablauf ?? null);
      setEingaben({});
      setNotice(meldung);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const ziel = ebene === 'global' ? 'global' : 'Projekt ' + project;
  const grundOk = grund.trim().length >= 5;
  const speichern = () => {
    const werte: Partial<Record<FristName, number>> = {};
    for (const { name } of NAMEN) {
      const v = eingaben[name];
      if (v !== undefined && v.trim() !== '') werte[name] = Number(v);
    }
    if (!Object.keys(werte).length) { setError('Keinen neuen Wert eingegeben.'); return; }
    void senden({ modus: 'setzen', ...werte }, 'Gespeichert (' + ziel + '). Gilt fuer neu beginnende Fristen.');
  };
  const entfernen = (name: FristName) => void senden({ modus: 'entfernen', frist_namen: [name] }, 'Wert entfernt (' + ziel + ').');

  return <div className="cp-fields">
    {stand?.letzter_fehler && <div className="scope-warning wide"><b>Einstellung nicht lesbar ({stand.letzter_fehler}).</b><span>Es gelten die Standardwerte.</span></div>}
    <div className="cp-setting-field"><span><b>Ebene</b><small>Projektwerte gehen globalen Werten vor; setzen duerfen User und Koordinator.</small></span>
      <select value={ebene} onChange={(event) => { setEbene(event.target.value as 'projekt' | 'global'); setEingaben({}); }}>
        <option value="projekt">Projekt {project}</option>
        <option value="global">Global</option>
      </select>
    </div>
    {NAMEN.map(({ name, label }) => {
      const f = stand?.fristen[name];
      const vorhanden = f ? (ebene === 'global' ? f.global : f.projekt) : null;
      return <div key={name} className="cp-setting-field">
        <span>
          <b>{label}: {f ? f.wert + ' ' + einheit(f) : '…'}</b>
          <small>{f ? 'Quelle: ' + QUELLE[f.quelle] + ' · Standard ' + f.standard + (f.global !== null ? ' · global ' + f.global : '') + (f.projekt !== null ? ' · Projekt ' + f.projekt : '') + ' · ' + f.wirkung : 'wird geladen'}</small>
        </span>
        <div className="split-field">
          <input type="number" min={f?.bereich.min ?? 1} max={f?.bereich.max} placeholder={vorhanden !== null ? String(vorhanden) : 'erbt'} value={eingaben[name] ?? ''} onChange={(event) => setEingaben({ ...eingaben, [name]: event.target.value })} aria-label={label + ' (' + ziel + ')'} />
          {vorhanden !== null && <button type="button" disabled={busy || !grundOk} onClick={() => entfernen(name)} title="Wert dieser Ebene entfernen; es gilt dann die naechste Ebene">Entfernen</button>}
        </div>
      </div>;
    })}
    <div className="cp-setting-field">
      <span>
        <b>Fristablauf offener files-Pläne: {ablauf ? (ablauf.aktiv ? 'EIN' : 'AUS') : '…'}</b>
        <small>{ablauf ? 'Quelle: ' + QUELLE[ablauf.quelle] + ' · Standard EIN' + (ablauf.global !== null ? ' · global ' + (ablauf.global ? 'EIN' : 'AUS') : '') + (ablauf.projekt !== null ? ' · Projekt ' + (ablauf.projekt ? 'EIN' : 'AUS') : '') + ' · Produkt-Schalter; AUS = offene Pläne laufen nicht ab' + (ablauf.letzter_fehler ? ' · Fehler: ' + ablauf.letzter_fehler : '') : 'wird geladen'}</small>
      </span>
      <div className="split-field">
        <button type="button" disabled={busy || !grundOk} onClick={() => void senden({ modus: 'setzen', files_plan_ablauf_aktiv: true }, 'Fristablauf EIN (' + ziel + ').')}>Ein</button>
        <button type="button" disabled={busy || !grundOk} onClick={() => void senden({ modus: 'setzen', files_plan_ablauf_aktiv: false }, 'Fristablauf AUS (' + ziel + ').')}>Aus</button>
        {(ebene === 'global' ? ablauf?.global : ablauf?.projekt) != null && <button type="button" disabled={busy || !grundOk} onClick={() => void senden({ modus: 'entfernen', files_plan_ablauf_aktiv: true }, 'Schalter dieser Ebene entfernt (' + ziel + ').')} title="Wert dieser Ebene entfernen; es gilt dann die naechste Ebene">Entfernen</button>}
      </div>
    </div>
    <div className="cp-setting-field wide"><span><b>Grund</b><small>Pflicht, mindestens 5 Zeichen; wird mit dem Wert gespeichert.</small></span>
      <input value={grund} onChange={(event) => setGrund(event.target.value)} placeholder="z. B. Start dauert laenger" />
    </div>
    <div className="scope-warning wide"><b>{stand?.hinweis ?? 'Rangfolge projekt > global > standard.'}</b><span>{error ? 'Fehler: ' + error : notice || 'Ziel: ' + ziel}</span></div>
    <div className="wide"><button type="button" className="primary" disabled={busy || !grundOk} onClick={speichern}>Fristen speichern</button> <button type="button" disabled={busy} onClick={() => void laden()}>Neu laden</button></div>
  </div>;
}
