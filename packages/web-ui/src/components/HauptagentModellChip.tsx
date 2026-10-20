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

export function HauptagentModellChip({ kompakt = true }: { kompakt?: boolean }) {
  const [modelle, setModelle] = useState<MainAgentModelle | null>(null);
  const [status, setStatus] = useState<StatusKurz | null>(null);
  const [offen, setOffen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [meldung, setMeldung] = useState<{ text: string; fehler: boolean } | null>(null);
  const wurzel = useRef<HTMLDivElement>(null);

  const laden = useCallback(async () => {
    const [m, s] = await Promise.all([
      getMainAgentModelle().catch(() => null),
      anfrage<StatusKurz>('/api/main-agent/status').catch(() => null),
    ]);
    setModelle(m);
    setStatus(s);
  }, []);
  useEffect(() => { void laden(); }, [laden]);
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
  const wechselOffen = (status?.auftraege_offen ?? []).some((a) => a.art === 'runtime_wechsel' || a.art === 'modellwechsel');
  const titel = 'Gewählt: ' + (rt ? (CLI_GRUPPE[rt] ?? rt) + ' · ' + (gewaehlt ?? 'Standard') : 'keine Runtime')
    + ' · läuft: ' + (i?.runtime_tatsaechlich ? (CLI_GRUPPE[i.runtime_tatsaechlich] ?? i.runtime_tatsaechlich) + ' · ' + (laeuft ?? '?') : 'unbestätigt')
    + (wechselOffen ? ' · Wechsel läuft' : '');

  const waehle = async (runtime: string, modell: string) => {
    setBusy(true);
    try {
      await anfrage('/api/main-agent/wechsel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime, modell, grund: 'Modellwahl im Hauptagent-Chat' }) });
      setMeldung({ text: 'Wechsel zu ' + (CLI_GRUPPE[runtime] ?? runtime) + ' · ' + kurz(modell) + ' beauftragt.', fehler: false });
      setOffen(false);
      await laden();
    } catch (reason) {
      setMeldung({ text: reason instanceof Error ? reason.message : String(reason), fehler: true });
    } finally {
      setBusy(false);
    }
  };

  return <div className={'hauptagent-modell-chip' + (kompakt ? ' kompakt' : '')} ref={wurzel} onPointerDown={(event) => event.stopPropagation()}>
    <button type="button" className={'chip' + (offen ? ' offen' : '') + (wechselOffen ? ' wechselt' : '')} title={titel} disabled={busy} onClick={() => setOffen(!offen)}>
      {rt ? (CLI_GRUPPE[rt] ?? rt) : 'Modell'} · {kurz(gewaehlt)}{laeuft && laeuft !== gewaehlt ? ' (läuft ' + kurz(laeuft) + ')' : ''}{wechselOffen ? ' …' : ''} ▾
    </button>
    {meldung && !offen && <small className={'chip-meldung' + (meldung.fehler ? ' fehler' : '')} title={meldung.text}>{meldung.fehler ? '⚠ ' : '✓ '}{meldung.text}</small>}
    {offen && <div className="chip-menue" role="menu">
      {!modelle && <p>Modelllisten nicht ladbar.</p>}
      {modelle && !modelle.schalter.aktiv && <p className="hinweis">Modellwahl aus den CLI-Listen ist AUS (Schalter hauptagent_cli_modelle): Altverhalten, keine Listenprüfung.</p>}
      {(modelle?.runtimes ?? []).map((r) => <div key={r.runtime} className="gruppe">
        <strong>{CLI_GRUPPE[r.runtime] ?? r.label}</strong>
        <small>{r.bereit
          ? 'Standard ' + kurz(r.standard.modell) + ' (' + (STANDARD_QUELLE[r.standard.quelle] ?? r.standard.quelle) + ')'
          : 'nicht verfügbar: ' + (r.grund ?? 'unbekannt')}</small>
        {r.bereit && r.modelle.length === 0 && <small className="hinweis">keine Modelle: {r.grund ?? 'unbekannt'}</small>}
        {r.bereit && r.modelle.filter((m) => m.sichtbar || m.modell === r.user_wahl).map((m) => {
          const aktiv = r.runtime === rt && m.modell === gewaehlt;
          return <button key={m.modell} type="button" role="menuitem" className={aktiv ? 'aktiv' : ''} disabled={busy || aktiv} title={m.beschreibung ?? ''}
            onClick={() => void waehle(r.runtime, m.modell)}>
            <span>{m.name}</span><code>{m.id}</code>
            <em>{[m.modell === r.standard.modell ? 'Standard' : '', m.modell === r.user_wahl ? 'deine Wahl' : '',
              r.runtime === i?.runtime_tatsaechlich && m.modell === laeuft ? 'läuft' : ''].filter(Boolean).join(' · ')}</em>
          </button>;
        })}
      </div>)}
      {!kompakt && modelle && <small>Schalter {modelle.schalter.aktiv ? 'EIN' : 'AUS'} ({modelle.schalter.quelle})</small>}
    </div>}
  </div>;
}
