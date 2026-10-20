import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/auth';
import { getMainAgentModelle, type MainAgentModelle } from '../api/agent-runtime';
import '../hauptagent-modell-chip.css';

/**
 * P22-T62 (User 20.10. ~12:20): Modell-/Runtime-Wahl DIREKT im Kopf des Hauptagent-Chats als kompakter Chip
 * ('Claude Code · <modell>') mit Dropdown. Gruppen 'Claude Code' / 'Codex' aus GET /api/main-agent/modelle (nur bereite
 * Runtimes mit Liste, die andere mit ehrlichem Grund); ein Klick wechselt Runtime + Modell (POST /api/main-agent/wechsel).
 * Anzeige: gewaehlt (gewuenscht) vs. tatsaechlich laufend (GET /api/main-agent/status). Auch in der Steuerung genutzt.
 */
interface StatusKurz {
  identitaet: null | { runtime_gewuenscht: string | null; runtime_tatsaechlich: string | null; modell_gewuenscht: string | null; modell_tatsaechlich: string | null };
  auftraege_offen: Array<{ art: string; status: string }>;
}

export const CLI_GRUPPE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const STANDARD_QUELLE: Record<string, string> = { user_wahl: 'deine Wahl', profil: 'gespeichertes Modell', kleinstes: 'kleinstes Modell', schalter_aus: 'Altstandard', keins: 'keins' };

async function anfrage<T>(pfad: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(pfad, init);
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const e = (d as { error?: { code?: string; message?: string } | string } | null)?.error;
    throw new Error((typeof e === 'string' ? e : (e?.code ?? e?.message ?? 'fehler')) + ' (HTTP ' + r.status + ')');
  }
  return d as T;
}

/** Kurzname fuer den Chip: Codex ohne Praefix 'codex/'. */
const kurz = (modell: string | null | undefined): string => (modell ? modell.replace(/^codex\//, '') : '–');

/**
 * P22-T64: Mit status ersetzt der Chip die Statuspille im Chatkopf ('Claude · <modell> · bereit' mit Status-Punkt);
 * ohne status bleibt er der reine Modell-Chip (Steuerung).
 */
export interface ChipStatus { text: string; real: boolean; hinweis: string | null }

export function HauptagentModellChip({ kompakt = true, status: anzeige }: { kompakt?: boolean; status?: ChipStatus }) {
  const [modelle, setModelle] = useState<MainAgentModelle | null>(null);
  const [status, setStatus] = useState<StatusKurz | null>(null);
  const [offen, setOffen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ text: string; fehler: boolean } | null>(null);
  // P22-T65 Bugfix: letzter abgelehnter/fehlgeschlagener Wechsel-Auftrag (Daemon lehnt z. B. eine Stufe ab) sichtbar am Chip.
  const [abgelehnt, setAbgelehnt] = useState<{ id: string; text: string } | null>(null);
  const quittiertRef = useRef<string | null>(null);
  const wurzel = useRef<HTMLDivElement>(null);

  const laden = useCallback(async () => {
    const [m, s, a] = await Promise.all([
      getMainAgentModelle().catch(() => null),
      anfrage<StatusKurz>('/api/main-agent/status').catch(() => null),
      anfrage<{ auftraege?: Array<{ auftrag_id: string; art: string; status: string; offen?: boolean; letzter_fehler: string | null; gewuenscht?: Record<string, unknown>; erstellt_am: string; abgeschlossen_am: string | null }> }>('/api/main-agent/auftraege').catch(() => null),
    ]);
    setModelle(m);
    setStatus(s);
    // Neuester Wechsel-Auftrag: schlug er fehl (abgelehnt/fehlgeschlagen), zeigt der Chip den Grund, bis ein neuer Wechsel kommt oder quittiert wird.
    const wechsel = (a?.auftraege ?? []).filter((x) => x.art === 'modellwechsel' || x.art === 'runtime_wechsel')
      .sort((x, y) => Date.parse(y.erstellt_am) - Date.parse(x.erstellt_am))[0];
    const fehlgeschlagen = !!wechsel && !wechsel.offen && !['completed', 'cancelled'].includes(wechsel.status)
      && Date.now() - Date.parse(wechsel.abgeschlossen_am ?? wechsel.erstellt_am) < 30 * 60_000;
    if (wechsel && fehlgeschlagen && quittiertRef.current !== wechsel.auftrag_id) {
      const g = wechsel.gewuenscht ?? {};
      const was = [typeof g.modell === 'string' ? kurz(g.modell) : '', typeof g.effort === 'string' ? g.effort : ''].filter(Boolean).join(' · ');
      setAbgelehnt({ id: wechsel.auftrag_id, text: 'Wechsel' + (was ? ' zu ' + was : '') + ' ' + (wechsel.status === 'rejected' ? 'abgelehnt' : 'fehlgeschlagen') + ': ' + (wechsel.letzter_fehler ?? 'ohne Angabe') });
    } else {
      setAbgelehnt(null);
    }
  }, []);
  useEffect(() => {
    void laden();
    // Gewaehlt/laeuft aendert sich auch ohne Klick (Auftrag ausgefuehrt, Failover).
    const timer = window.setInterval(() => void laden(), 15_000);
    return () => window.clearInterval(timer);
  }, [laden]);
  useEffect(() => {
    if (!offen) return;
    void laden();
    const zu = (event: PointerEvent) => { if (!wurzel.current?.contains(event.target as Node)) setOffen(false); };
    document.addEventListener('pointerdown', zu);
    return () => document.removeEventListener('pointerdown', zu);
  }, [offen, laden]);

  const i = status?.identitaet ?? null;
  const zugewiesen = modelle?.runtimes.find((r) => r.zugewiesen)?.runtime ?? null;
  const rt = i?.runtime_gewuenscht ?? zugewiesen;
  const rtEintrag = modelle?.runtimes.find((r) => r.runtime === rt) ?? null;
  const gewaehlt = i?.modell_gewuenscht ?? rtEintrag?.standard.modell ?? null;
  const laeuft = i?.modell_tatsaechlich ?? null;
  // P22-T65: Effort des gewaehlten Modells = gespeicherte Stufe, sonst standard_effort aus dem Katalog.
  const effortVon = (m: { effort_wahl?: string | null; standard_effort: string | null }): string | null => m.effort_wahl ?? m.standard_effort ?? null;
  const gewaehltEintrag = rtEintrag?.modelle.find((m) => m.modell === gewaehlt) ?? null;
  const aktuellerEffort = gewaehltEintrag ? effortVon(gewaehltEintrag) : null;
  const wechselOffen = (status?.auftraege_offen ?? []).some((a) => a.art === 'runtime_wechsel' || a.art === 'modellwechsel');
  const titel = 'Gewählt: ' + (rt ? (CLI_GRUPPE[rt] ?? rt) + ' · ' + (gewaehlt ?? 'Standard') : 'keine Runtime')
    + ' · läuft: ' + (i?.runtime_tatsaechlich ? (CLI_GRUPPE[i.runtime_tatsaechlich] ?? i.runtime_tatsaechlich) + ' · ' + (laeuft ?? '?') : 'unbestätigt')
    + (wechselOffen ? ' · Wechsel läuft' : '');

  const waehle = async (runtime: string, modell: string, effort?: string) => {
    setBusy(true);
    try {
      await anfrage('/api/main-agent/wechsel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime, modell, ...(effort ? { effort } : {}), grund: 'Modellwahl im Hauptagent-Chat' }) });
      setMeldung({ text: 'Wechsel zu ' + (CLI_GRUPPE[runtime] ?? runtime) + ' · ' + kurz(modell) + (effort ? ' · ' + effort : '') + ' beauftragt.', fehler: false });
      setAbgelehnt(null);
      setOffen(false);
      await laden();
    } catch (reason) {
      setMeldung({ text: reason instanceof Error ? reason.message : String(reason), fehler: true });
    } finally {
      setBusy(false);
    }
  };

  type Gruppe = NonNullable<typeof modelle>['runtimes'][number];
  type ModellEintrag = Gruppe['modelle'][number];

  // P22-T65 Nachtrag: Modellwechsel. Gilt die bisherige Stufe beim neuen Modell nicht, wird dessen Standard gesetzt (mit Hinweis).
  const waehleModell = async (r: Gruppe, m: ModellEintrag) => {
    const bisher = r.runtime === rt ? aktuellerEffort : null;
    const ungueltig = !!bisher && m.effort_stufen.length > 0 && !m.effort_stufen.includes(bisher);
    await waehle(r.runtime, m.modell, ungueltig ? (m.standard_effort ?? undefined) : undefined);
    if (ungueltig) setMeldung({ text: 'Effort ' + bisher + ' gibt es bei ' + m.name + ' nicht, Standard ' + (m.standard_effort ?? '–') + ' gesetzt.', fehler: false });
  };

  // P22-T65 Nachtrag: EINE Effort-Leiste je Gruppe, direkt unter der Kopfzeile, fuer das gewaehlte bzw. (andere Gruppe) vorgemerkte
  // Modell, mit genau den Stufen dieses Modells laut CLI-Liste. Hinweise der CLI nur zur gewaehlten Stufe, sonst im Tooltip.
  const EffortLeiste = ({ r }: { r: Gruppe }) => {
    const modellId = r.runtime === rt ? gewaehlt : (r.user_wahl ?? r.standard.modell);
    const m = r.modelle.find((x) => x.modell === modellId);
    if (!m || m.effort_stufen.length === 0) return null;
    const aktivGruppe = r.runtime === rt;
    const jetzt = effortVon(m);
    const details = new Map((m.effort_details ?? []).map((d) => [d.stufe, d]));
    const hinweis = jetzt ? details.get(jetzt)?.hinweis : null;
    return <div className="effort-leiste">
      <div className="efforts" role="group" aria-label={'Effort ' + m.name}>
        <small>Effort · {m.name}</small>
        {m.effort_stufen.map((s) => {
          const d = details.get(s);
          const an = s === jetzt;
          return <button key={s} type="button" className={'effort' + (an ? ' an' : '') + (s === m.standard_effort ? ' std' : '')}
            disabled={busy || (aktivGruppe && an)} title={[d?.name, s === m.standard_effort ? 'Standard der CLI' : '', d?.hinweis].filter(Boolean).join(' – ')}
            onClick={() => void waehle(r.runtime, m.modell, s)}>{s}{d?.hinweis && /recommended/i.test(d.hinweis) ? ' ★' : ''}</button>;
        })}
      </div>
      {hinweis && <small className="effort-hinweise">{jetzt}: {hinweis}</small>}
    </div>;
  };

  return <div className={'hauptagent-modell-chip' + (kompakt ? ' kompakt' : '')} ref={wurzel} onPointerDown={(event) => event.stopPropagation()}>
    {anzeige
      ? <div role="button" tabIndex={0} aria-haspopup="menu" aria-expanded={offen}
        className={'agent-live chip-status' + (anzeige.real ? ' real' : '') + (offen ? ' offen' : '') + (wechselOffen ? ' wechselt' : '')}
        title={titel + (anzeige.hinweis ? ' · ' + anzeige.hinweis : '')}
        onClick={() => { if (!busy) setOffen(!offen); }}
        onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && !busy) { event.preventDefault(); setOffen(!offen); } }}>
        <i /> {rt ? (rt === 'claude' ? 'Claude' : CLI_GRUPPE[rt] ?? rt) + ' · ' + kurz(gewaehlt) + (aktuellerEffort ? ' · ' + aktuellerEffort : '') + ' · ' : ''}{anzeige.text}{anzeige.hinweis ? ' ⚠' : ''}{wechselOffen ? ' …' : ''} ▾
      </div>
      : <button type="button" className={'chip' + (offen ? ' offen' : '') + (wechselOffen ? ' wechselt' : '')} title={titel} disabled={busy} onClick={() => setOffen(!offen)}>
        {rt ? (CLI_GRUPPE[rt] ?? rt) : 'Modell'} · {kurz(gewaehlt)}{aktuellerEffort ? ' · ' + aktuellerEffort : ''}{laeuft && laeuft !== gewaehlt ? ' (läuft ' + kurz(laeuft) + ')' : ''}{wechselOffen ? ' …' : ''} ▾
      </button>}
    {abgelehnt && !meldung && <small className="chip-meldung fehler" title={abgelehnt.text}
      onClick={() => { quittiertRef.current = abgelehnt.id; setAbgelehnt(null); }}>⚠ {abgelehnt.text} (Klick blendet aus)</small>}
    {meldung && !offen && <small className={'chip-meldung' + (meldung.fehler ? ' fehler' : '')} title={meldung.text}>{meldung.fehler ? '⚠ ' : '✓ '}{meldung.text}</small>}
    {offen && <div className="chip-menue" role="menu">
      {!modelle && <p>Modelllisten nicht ladbar.</p>}
      {modelle && !modelle.schalter.aktiv && <p className="hinweis">Modellwahl aus den CLI-Listen ist AUS (Schalter hauptagent_cli_modelle): Altverhalten, keine Listenprüfung.</p>}
      {(modelle?.runtimes ?? []).map((r) => <div key={r.runtime} className="gruppe">
        <strong>{CLI_GRUPPE[r.runtime] ?? r.label}</strong>
        <small>{r.bereit
          ? 'Standard ' + kurz(r.standard.modell) + ' (' + (STANDARD_QUELLE[r.standard.quelle] ?? r.standard.quelle) + ')'
          : 'nicht verfügbar: ' + (r.grund ?? 'unbekannt')}</small>
        {r.pruefung && (r.pruefung.hinweis || !kompakt) && <small className={r.pruefung.haengt ? 'hinweis' : ''} title={r.pruefung.letzter_lauf.meldung ?? ''}>
          {'Prüfung: ' + r.pruefung.letzter_lauf.ergebnis + ', ' + r.pruefung.letzter_lauf.dauer_ms + ' ms'
            + (r.pruefung.alter_sekunden !== null ? ', bestätigt vor ' + r.pruefung.alter_sekunden + ' s' : '')
            + (r.pruefung.hinweis ? ' – ' + r.pruefung.hinweis : '') + (r.pruefung.schalter.aktiv ? '' : ' (Stabilisierung AUS)')}</small>}
        {r.bereit && r.modelle.length === 0 && <small className="hinweis">keine Modelle: {r.grund ?? 'unbekannt'}</small>}
        {r.bereit && modelle?.schalter.aktiv && <EffortLeiste r={r} />}
        {r.bereit && r.modelle.filter((m) => m.sichtbar || m.modell === r.user_wahl).map((m) => {
          const aktiv = r.runtime === rt && m.modell === gewaehlt;
          return <div key={m.modell} className={'modell-zeile' + (aktiv ? ' aktiv' : '')}>
            <button type="button" role="menuitem" className={aktiv ? 'aktiv' : ''} disabled={busy || aktiv} title={m.beschreibung ?? ''}
              onClick={() => void waehleModell(r, m)}>
              <span>{m.name}</span><code>{m.id}</code>
              <em>{[m.modell === r.standard.modell ? 'Standard' : '', m.modell === r.user_wahl ? 'deine Wahl' : '',
                r.runtime === i?.runtime_tatsaechlich && m.modell === laeuft ? 'läuft' : ''].filter(Boolean).join(' · ')}</em>
            </button>
          </div>;
        })}
      </div>)}
      {!kompakt && modelle && <small>Schalter {modelle.schalter.aktiv ? 'EIN' : 'AUS'} ({modelle.schalter.quelle})</small>}
    </div>}
  </div>;
}
