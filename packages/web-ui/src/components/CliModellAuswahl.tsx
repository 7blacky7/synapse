import { useCallback, useEffect, useState } from 'react';
import { getAgentRuntimeModelle, type AgentRuntimeName, type CliModell, type CliModellListe } from '../api/agent-runtime';
import '../cli-modelle.css';

/**
 * P22-T61: Modelle der CLI-Container aus der CLI selbst (GET /api/agent-runtimes/:runtime/modelle) statt fester Listen.
 * Zeigt Quelle, Stand und CLI-Version; ist nichts lesbar, steht der Grund da (kein Rueckfall auf feste Werte).
 * Freie Eingabe einer Modell-ID bleibt moeglich.
 */
export function useCliModelle(runtime: AgentRuntimeName | null) {
  const [liste, setListe] = useState<CliModellListe | null>(null);
  const [fehler, setFehler] = useState('');
  const [laedt, setLaedt] = useState(false);
  const laden = useCallback(async (neu = false) => {
    if (!runtime) return;
    setLaedt(true);
    try {
      setListe(await getAgentRuntimeModelle(runtime, neu));
      setFehler('');
    } catch (reason) {
      setFehler(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLaedt(false);
    }
  }, [runtime]);
  useEffect(() => {
    setListe(null);
    setFehler('');
    void laden();
  }, [laden]);
  return { liste, fehler, laedt, laden };
}

const tokens = (n: number | null): string => (n === null ? '' : n >= 1_000_000 ? (n / 1_000_000).toLocaleString('de-DE') + 'M' : Math.round(n / 1000) + 'k');
const zeit = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'unbekannt');

function effortText(m: CliModell): string {
  if (!m.effort_stufen.length) return 'ohne Effort-Stufen';
  return 'Effort ' + m.effort_stufen.map((s) => (s === m.standard_effort ? s + ' (Standard)' : s)).join(', ');
}

function modellZeile(m: CliModell): string {
  return [m.name !== m.id ? m.name : '', m.standard ? 'Standard der CLI' : '', m.gruppe ?? '', m.sichtbar ? '' : 'versteckt',
    m.kontext_ein ? 'Kontext ' + tokens(m.kontext_ein) + (m.kontext_aus ? ' / Ausgabe ' + tokens(m.kontext_aus) : '') : '']
    .filter(Boolean).join(' · ');
}

/** Quelle/Stand/Version und Hinweise einer Liste; bei leerer Liste der Grund. */
export function CliModellHerkunft({ liste, fehler, laedt, onNeu }: { liste: CliModellListe | null; fehler: string; laedt: boolean; onNeu: () => void }) {
  return <div className="cli-modelle-herkunft">
    <small>
      {laedt && !liste ? 'Modelle werden aus der CLI gelesen …'
        : fehler ? 'Modellliste nicht ladbar: ' + fehler
          : liste && liste.quelle ? liste.modelle.length + ' Modelle · Quelle ' + (liste.quelle === 'cli' ? 'CLI' : 'Datei') + (liste.quelle_detail ? ' (' + liste.quelle_detail + ')' : '')
            + ' · Stand ' + zeit(liste.stand) + (liste.cli_version ? ' · ' + liste.cli_version : '')
            : liste ? 'Keine Modellliste: ' + (liste.grund ?? 'unbekannt') : ''}
    </small>
    <button type="button" disabled={laedt} onClick={onNeu}>{laedt ? 'liest …' : 'neu lesen'}</button>
    {(liste?.hinweise ?? []).map((h) => <small key={h} className="cli-modelle-hinweis">{h}</small>)}
    {(liste?.registry_abgleich?.meldungen ?? []).map((h) => <small key={h} className="cli-modelle-hinweis">Abgleich Registry: {h}</small>)}
  </div>;
}

/** Eingabe mit Vorschlaegen aus der CLI-Liste; darunter Effort-Stufen und Kontext des gewaehlten Modells. */
export function CliModellAuswahl({ runtime, value, onChange, listId, placeholder }: {
  runtime: AgentRuntimeName; value: string; onChange: (value: string) => void; listId: string; placeholder?: string;
}) {
  const { liste, fehler, laedt, laden } = useCliModelle(runtime);
  const gewaehlt = liste?.modelle.find((m) => m.id === value.trim()) ?? null;
  return <div className="cli-modell-auswahl">
    <input list={listId} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder ?? 'Modell-ID aus der Liste oder frei'} />
    <datalist id={listId}>
      {(liste?.modelle ?? []).filter((m) => m.sichtbar || m.id === value).map((m) => <option key={m.id} value={m.id} label={m.name + ' · ' + effortText(m)} />)}
    </datalist>
    {gewaehlt
      ? <small>{[modellZeile(gewaehlt), effortText(gewaehlt)].filter(Boolean).join(' · ')}{gewaehlt.beschreibung ? ' – ' + gewaehlt.beschreibung : ''}</small>
      : value.trim() && liste?.modelle.length ? <small className="cli-modelle-hinweis">Nicht in der Liste der CLI – wird als freie Modell-ID übernommen.</small> : null}
    <CliModellHerkunft liste={liste} fehler={fehler} laedt={laedt} onNeu={() => void laden(true)} />
  </div>;
}

/** Nur-Lese-Liste aller Modelle der CLI (z. B. Codex, solange die Runtime-Konfiguration kein Modell speichert). */
export function CliModellUebersicht({ runtime }: { runtime: AgentRuntimeName }) {
  const { liste, fehler, laedt, laden } = useCliModelle(runtime);
  return <div className="cli-modell-uebersicht">
    <ul>
      {(liste?.modelle ?? []).map((m) => <li key={m.id} className={m.sichtbar ? '' : 'versteckt'} title={m.beschreibung ?? ''}>
        <code>{m.id}</code><span>{[modellZeile(m), effortText(m)].filter(Boolean).join(' · ')}</span>
      </li>)}
    </ul>
    <CliModellHerkunft liste={liste} fehler={fehler} laedt={laedt} onNeu={() => void laden(true)} />
  </div>;
}
