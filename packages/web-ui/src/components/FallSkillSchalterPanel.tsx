import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/auth';

/**
 * P23-T5: Produkt-Schalter der Fall-Skills (Standard AUS bis User-Freigabe, 'alle' schaltet sie nicht mit):
 *   fall_skill_hinweis       - Fehlerantworten nennen beim ersten Auftreten je Sitzung den passenden Fall-Skill (je Weg Ausweis/Legacy).
 *   tool_beschreibungen_kurz - tools/list liefert kurze Tool-Beschreibungen, die auf die Fall-Skills verweisen.
 * Echt angeschlossen (derselbe Core-Dispatcher wie admin profil_schalter_status/_setzen):
 *   GET/PUT /api/projects/:project/agent-profile/schalter  {profil_funktion, aktiv, grund, ebene}
 */
interface SchalterStand { funktion: string; aktiv: boolean; quelle: string; ebene: string | null; gesetzt_von: string | null; letzter_fehler: string | null }

const FUNKTIONEN: Array<{ funktion: string; titel: string; text: string }> = [
  { funktion: 'fall_skill_hinweis', titel: 'Fall-Skill bei Fehlbedienung', text: 'Fehlerantworten nennen einmal je Sitzung den passenden Fall-Skill (Feld fall_skill), getrennt nach Ausweis- und Legacy-Agenten.' },
  { funktion: 'tool_beschreibungen_kurz', titel: 'Kurze Tool-Beschreibungen', text: 'tools/list liefert nur Zweck und Ausloeser; Details stehen in den Fall-Skills (Seed: mise run skills-seed). Wirkt ab der naechsten Verbindung des Clients.' },
];

function fehlerText(daten: unknown, status: number): string {
  const e = (daten as { error?: { code?: string } | string } | null)?.error;
  const code = typeof e === 'string' ? e : e?.code;
  return (code ?? 'fehler') + ' (HTTP ' + status + ')';
}

export function FallSkillSchalterPanel({ project }: { project: string }) {
  const basis = '/api/projects/' + encodeURIComponent(project) + '/agent-profile';
  const [schalter, setSchalter] = useState<SchalterStand[]>([]);
  const [grund, setGrund] = useState('');
  const [ebene, setEbene] = useState<'projekt' | 'global'>('projekt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const laden = useCallback(async () => {
    try {
      const r = await apiFetch(basis + '/schalter');
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setSchalter((d as { schalter?: SchalterStand[] }).schalter ?? []);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [basis]);

  useEffect(() => { void laden(); }, [laden]);

  const schalten = async (funktion: string, aktiv: boolean) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await apiFetch(basis + '/schalter', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profil_funktion: funktion, aktiv, ebene, grund }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(fehlerText(d, r.status));
      setNotice(funktion + ' ' + (aktiv ? 'EIN' : 'AUS') + ' (' + (ebene === 'global' ? 'global' : 'Projekt ' + project) + ').');
      await laden();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const grundOk = grund.trim().length >= 5;
  return <div className="cp-fields">
    <div className="scope-warning wide"><b>Fall-Skills</b><span>Produkt-Schalter, Standard AUS bis zur Freigabe durch den User. "alle" schaltet sie nicht mit.</span></div>
    {FUNKTIONEN.map(f => {
      const s = schalter.find(x => x.funktion === f.funktion) ?? null;
      return <div key={f.funktion} className="cp-setting-field wide">
        <span>
          <b>{f.titel} ({f.funktion}): {s ? (s.aktiv ? 'EIN' : 'AUS') : '…'}</b>
          <small>{f.text}{s ? ' Quelle: ' + s.quelle + (s.ebene ? ' (' + s.ebene + ')' : '') + (s.gesetzt_von ? ' · gesetzt von ' + s.gesetzt_von : '') + (s.letzter_fehler ? ' · Fehler: ' + s.letzter_fehler : '') : ''}</small>
        </span>
        <button type="button" disabled={busy || !grundOk || !s} onClick={() => void schalten(f.funktion, !s?.aktiv)}>{s?.aktiv ? 'Ausschalten' : 'Einschalten'}</button>
      </div>;
    })}
    <div className="cp-setting-field wide"><span><b>Ebene</b><small>global nur fuer den User.</small></span>
      <select value={ebene} onChange={(event) => setEbene(event.target.value === 'global' ? 'global' : 'projekt')}>
        <option value="projekt">Projekt {project}</option>
        <option value="global">global</option>
      </select>
    </div>
    <div className="cp-setting-field wide"><span><b>Grund</b><small>Pflicht, mindestens 5 Zeichen.</small></span>
      <input value={grund} onChange={(event) => setGrund(event.target.value)} placeholder="z. B. Freigabe P23-T5" />
    </div>
    <div className="scope-warning wide"><b>Status</b><span>{error ? 'Fehler: ' + error : notice || 'Bereit'}</span></div>
    <div className="wide"><button type="button" disabled={busy} onClick={() => void laden()}>Neu laden</button></div>
  </div>;
}
