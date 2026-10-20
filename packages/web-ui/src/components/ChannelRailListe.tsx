import { Fragment, useMemo, useState } from 'react';
import type { ChannelViewModel } from '../control-plane/view-model';
import '../channel-rail-liste.css';

/**
 * P8-T29: sortierbare Channel-Liste der Seitenleiste.
 * Reine Anzeige (Sortierung im Browser, Auswahl per localStorage) - kein Produkt-Schalter noetig.
 * Rendert die Knoepfe als direkte Kinder (Fragment), damit die Regeln `.channel-rail>button` greifen.
 */
export type ChannelSortierung = 'aktivitaet_neu' | 'aktivitaet_alt' | 'name_az' | 'name_za';

const SORTIERUNGEN: Array<{ id: ChannelSortierung; label: string }> = [
  { id: 'aktivitaet_neu', label: 'Letzte Aktivität (neueste zuerst)' },
  { id: 'aktivitaet_alt', label: 'Letzte Aktivität (älteste zuerst)' },
  { id: 'name_az', label: 'Name A–Z' },
  { id: 'name_za', label: 'Name Z–A' },
];

const SPEICHER_SCHLUESSEL = 'synapse.channelSortierung';

function ladeSortierung(): ChannelSortierung {
  try {
    const wert = window.localStorage.getItem(SPEICHER_SCHLUESSEL);
    if (SORTIERUNGEN.some((s) => s.id === wert)) return wert as ChannelSortierung;
  } catch {
    // localStorage nicht verfuegbar: Standard
  }
  return 'aktivitaet_neu';
}

function zeitwert(zeit?: string): number {
  if (!zeit) return NaN;
  return Date.parse(zeit);
}

/** Channels ohne Nachricht stehen in beiden Aktivitaets-Richtungen am Ende. */
export function sortiereChannels(channels: ChannelViewModel[], modus: ChannelSortierung): ChannelViewModel[] {
  const nachName = (a: ChannelViewModel, b: ChannelViewModel) => a.name.localeCompare(b.name, 'de');
  const kopie = [...channels];
  if (modus === 'name_az') return kopie.sort(nachName);
  if (modus === 'name_za') return kopie.sort((a, b) => nachName(b, a));
  const richtung = modus === 'aktivitaet_neu' ? -1 : 1;
  return kopie.sort((a, b) => {
    const za = zeitwert(a.letzteAktivitaet);
    const zb = zeitwert(b.letzteAktivitaet);
    const hatA = !Number.isNaN(za);
    const hatB = !Number.isNaN(zb);
    if (hatA && hatB && za !== zb) return (za - zb) * richtung;
    if (hatA !== hatB) return hatA ? -1 : 1;
    return nachName(a, b);
  });
}

function relativeZeit(zeit: string | undefined, jetzt: number): string {
  const t = zeitwert(zeit);
  if (Number.isNaN(t)) return 'keine Nachricht';
  const sek = Math.max(0, Math.round((jetzt - t) / 1000));
  if (sek < 60) return 'gerade eben';
  const min = Math.round(sek / 60);
  if (min < 60) return 'vor ' + min + ' Min';
  const std = Math.round(min / 60);
  if (std < 48) return 'vor ' + std + ' Std';
  return 'vor ' + Math.round(std / 24) + ' Tagen';
}

export function ChannelRailListe({
  channels,
  selectedChannel,
  onSelectChannel,
}: {
  channels: ChannelViewModel[];
  selectedChannel: string;
  onSelectChannel: (channel: string) => void;
}) {
  const [modus, setModus] = useState<ChannelSortierung>(ladeSortierung);
  const sortiert = useMemo(() => sortiereChannels(channels, modus), [channels, modus]);
  const jetzt = Date.now();

  const waehle = (wert: ChannelSortierung) => {
    setModus(wert);
    try {
      window.localStorage.setItem(SPEICHER_SCHLUESSEL, wert);
    } catch {
      // nur Komfort, kein Fehler
    }
  };

  return (
    <Fragment>
      <div className="channel-rail-sort">
        <label>
          <span>Sortierung</span>
          <select value={modus} onChange={(event) => waehle(event.target.value as ChannelSortierung)} aria-label="Channel-Sortierung">
            {SORTIERUNGEN.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {sortiert.map((item) => (
        <button
          type="button"
          className={selectedChannel === item.name ? 'active' : ''}
          key={item.name}
          onClick={() => onSelectChannel(item.name)}
        >
          <b>#</b>
          <div>
            <strong>{item.name}</strong>
            <small>{item.description}</small>
            <time
              className="channel-rail-zeit"
              dateTime={item.letzteAktivitaet || undefined}
              title={item.letzteAktivitaet ? new Date(item.letzteAktivitaet).toLocaleString('de-DE') : 'Noch keine Nachricht'}
            >
              {relativeZeit(item.letzteAktivitaet, jetzt)}
            </time>
          </div>
        </button>
      ))}
    </Fragment>
  );
}
