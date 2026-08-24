/**
 * Kennzeichnung des Ausbaustands einer Ansicht.
 *
 * Der Anlass: In der Oberflaeche liessen sich fertige und erfundene Bereiche
 * nicht auseinanderhalten. Eine Tabelle mit erdachten Zeilen sieht genauso aus
 * wie eine mit echten — und wer das nicht weiss, sucht Fehler an Stellen, an
 * denen es noch gar keine Anbindung gibt.
 *
 * Drei Stufen, mehr braucht es nicht:
 *   live      — die Ansicht zeigt Daten aus der Datenbank oder der API.
 *   teilweise — ein Teil ist echt, ein Teil erfunden. Der Text sagt welcher.
 *   demo      — alles auf dieser Seite ist erfunden.
 *
 * Zur Stufe gehoert bei allem, was noch nicht fertig ist, ein PlanungsHinweis:
 * er sagt, WAS zu tun ist und GEGEN WELCHEN Endpunkt. Die dort genannten
 * Routen sind gegen packages/rest-api/src/routes geprueft — steht dort eine,
 * existiert sie auch. Fehlt die Anbindung nur noch in der Oberflaeche, sagt
 * der Hinweis das ausdruecklich, denn das ist ein ganz anderer Aufwand als
 * ein fehlendes Backend.
 */
import '../status-kennzeichnung.css';

export type Ausbaustand = 'live' | 'teilweise' | 'demo';

const BESCHRIFTUNG: Record<Ausbaustand, string> = {
  live: 'LIVE-DATEN',
  teilweise: 'TEILWEISE LIVE',
  demo: 'DEMO',
};

const TITEL: Record<Ausbaustand, string> = {
  live: 'Diese Ansicht zeigt echte Daten aus Synapse.',
  teilweise: 'Ein Teil dieser Ansicht ist echt, ein Teil erfunden.',
  demo: 'Alle Werte auf dieser Seite sind erfunden und ohne Anbindung.',
};

/** Kurzes Schild fuer die Kopfzeile einer Ansicht. */
export function StatusChip({ stand }: { stand: Ausbaustand }) {
  return (
    <span className={'status-chip status-chip--' + stand} title={TITEL[stand]}>
      {BESCHRIFTUNG[stand]}
    </span>
  );
}

export interface PlanungsHinweisProps {
  /** Was hier zu tun ist — ein Satz, in der Sprache der Sache, nicht des Codes. */
  aufgabe: string;
  /**
   * Vorhandene Endpunkte, an die angeschlossen werden kann. Leer lassen, wenn
   * es noch keine gibt — dann fehlt auch das Backend, und das steht in `fehlt`.
   */
  endpunkte?: string[];
  /** Was ausser der Oberflaeche noch fehlt (Tabelle, Dienst, Konzept). */
  fehlt?: string;
}

/**
 * Hinweiskasten unter einer unfertigen Ansicht.
 *
 * Bewusst immer sichtbar und nicht aufklappbar: ein zugeklappter Hinweis wird
 * uebersehen, und genau das Uebersehen war das Problem.
 */
export function PlanungsHinweis({ aufgabe, endpunkte, fehlt }: PlanungsHinweisProps) {
  return (
    <aside className="planungs-hinweis">
      <header>
        <span>PLANUNG</span>
        <p>{aufgabe}</p>
      </header>
      {endpunkte && endpunkte.length > 0 && (
        <div className="planungs-hinweis__endpunkte">
          <b>Vorhanden, nur nicht angeschlossen:</b>
          <ul>
            {endpunkte.map((pfad) => (
              <li key={pfad}>
                <code>{pfad}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fehlt && (
        <p className="planungs-hinweis__fehlt">
          <b>Fehlt noch ganz:</b> {fehlt}
        </p>
      )}
    </aside>
  );
}
