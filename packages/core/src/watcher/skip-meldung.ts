/**
 * MODUL: Skip-Meldungen des PG->FS-Pollers
 * ZWECK: Jede uebersprungene Datei je Grund nur EINMAL ins Log schreiben. Erneut gemeldet wird erst,
 *        wenn sich der Stand aendert (neuer Inhalt in PG oder ein anderer Plattenstand).
 *
 * WARUM: Der Poller laeuft alle 2 s. Vorher stand fuer jede uebersprungene Zeile in JEDER Runde dieselbe
 *        Logzeile im daemon.log - am 11.10.2026 15,2 Mio von 25,6 Mio Zeilen (Befund 929b5b10).
 *
 * INPUT:  pfad (projektrelativ), grund (kurzer Schluessel), stand (alles, dessen Aenderung eine neue
 *         Meldung rechtfertigt, z. B. "<pg-hash>|<platten-hash>").
 * OUTPUT: sollMelden() -> true genau beim ersten Mal bzw. nach einer Aenderung des Stands.
 * NEBENEFFEKTE: keine (nur Speicher; Umfang = Zahl der aktuell uebersprungenen Pfade).
 */
export class SkipMeldungen {
  private readonly gemeldet = new Map<string, Map<string, string>>();

  /** true = jetzt melden; danach fuer denselben (pfad, grund, stand) false. */
  sollMelden(pfad: string, grund: string, stand: string): boolean {
    let jePfad = this.gemeldet.get(pfad);
    if (!jePfad) {
      jePfad = new Map();
      this.gemeldet.set(pfad, jePfad);
    }
    if (jePfad.get(grund) === stand) return false;
    jePfad.set(grund, stand);
    return true;
  }

  /** Pfad ist konvergiert oder geschrieben: ein spaeterer Skip meldet sich wieder. */
  vergessen(pfad: string): void {
    this.gemeldet.delete(pfad);
  }

  /** Zahl der Pfade mit offener Meldung (fuer Diagnose/Tests). */
  get anzahl(): number {
    return this.gemeldet.size;
  }
}
