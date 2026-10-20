/**
 * MODUL: daemon-kern.ts (P22-T4, W2a; Zuschnitt W0c-Bericht 502500cd Abschn. 3)
 * ZWECK: Gemeinsamer Lebenszyklus der Daemon-Startprofile (startprofile/pc.ts, startprofile/runtime.ts):
 *        Komponenten starten und ihren Zustand festhalten, Stopp-Schritte in fester Reihenfolge,
 *        Signal-/Fehlerbehandlung, geordneter Shutdown mit hartem Exit nach 5 s.
 *
 * GRENZEN: Der Kern importiert KEINE PC- oder Runtime-Dienste (kein WatcherManager, kein Fastify) – jedes
 *   Profil bringt seine Komponenten selbst mit. Ein Shutdown beendet nur den Daemon-Prozess; er ist kein
 *   User-Abbruch laufender Agentenaufgaben (Runtime: Wrapper-Wiederanbindung kommt mit W3).
 *
 * STATUS: status() liefert Profil, PID, Startzeit und je Komponente gestartet | aus (mit Grund) | fehler
 *   (mit Meldung). Keine Zugangsdaten.
 */

export type DaemonProfil = 'pc' | 'runtime';
export const DAEMON_PROFILE: readonly DaemonProfil[] = ['pc', 'runtime'];

export type KomponentenZustand = 'gestartet' | 'aus' | 'fehler';

export interface KomponentenStatus {
  name: string;
  zustand: KomponentenZustand;
  /** aus: warum nicht gestartet; fehler: Startfehler. */
  grund: string | null;
  seit: string;
}

export interface DaemonKernStatus {
  profil: DaemonProfil;
  pid: number;
  gestartet_am: string;
  komponenten: KomponentenStatus[];
}

interface StoppSchritt {
  name: string;
  stop: () => unknown;
}

export interface DaemonKernOptionen {
  /** Harter Exit, falls ein Stopp-Schritt haengt (Standard 5 s, wie bisher in main.ts). */
  hardExitMs?: number;
  /** Testnaht: Prozessende. */
  exit?: (code: number) => void;
  log?: (...teile: unknown[]) => void;
}

/**
 * Startprofil aus SYNAPSE_DAEMON_PROFIL (pc | runtime). Leer = pc (bisheriges Verhalten).
 * Unbekannte Werte werfen laut – ein Daemon, der ein anderes Profil faehrt als bestellt, waere unsichtbar.
 */
export function leseStartprofil(roh: string | undefined = process.env.SYNAPSE_DAEMON_PROFIL): DaemonProfil {
  const wert = (roh ?? '').trim().toLowerCase();
  if (wert === '') return 'pc';
  if ((DAEMON_PROFILE as readonly string[]).includes(wert)) return wert as DaemonProfil;
  throw new Error(`SYNAPSE_DAEMON_PROFIL="${roh}" ist unbekannt – erlaubt: ${DAEMON_PROFILE.join(', ')}.`);
}

export class DaemonKern {
  private readonly komponenten = new Map<string, KomponentenStatus>();
  private readonly stoppSchritte: StoppSchritt[] = [];
  private readonly gestartetAm = new Date().toISOString();
  private shuttingDown = false;
  private readonly hardExitMs: number;
  private readonly exit: (code: number) => void;
  private readonly log: (...teile: unknown[]) => void;

  constructor(readonly profil: DaemonProfil, opt: DaemonKernOptionen = {}) {
    this.hardExitMs = opt.hardExitMs ?? 5_000;
    this.exit = opt.exit ?? ((code) => process.exit(code));
    this.log = opt.log ?? ((...teile) => console.error(...teile));
  }

  /**
   * Startet eine Komponente. Ein Startfehler wird protokolliert und als 'fehler' vermerkt; der Daemon laeuft
   * weiter (wie bisher je Worker in main.ts). pflicht:true wirft den Fehler weiter.
   */
  async starte<T>(name: string, start: () => T | Promise<T>, opt: { pflicht?: boolean; label?: string } = {}): Promise<T | null> {
    try {
      const handle = await start();
      this.setze(name, 'gestartet', null);
      return handle;
    } catch (err) {
      this.setze(name, 'fehler', (err as Error)?.message ?? String(err));
      this.log(`[daemon] ${opt.label ?? name} konnte nicht gestartet werden:`, err);
      if (opt.pflicht) throw err;
      return null;
    }
  }

  /** Komponente bewusst nicht gestartet (Schalter, fehlender Zugang, spaeteres Paket). */
  markiereAus(name: string, grund: string): void {
    this.setze(name, 'aus', grund);
  }

  /** Komponente zur Laufzeit ausgefallen bzw. wieder gesund. */
  markiereFehler(name: string, grund: string): void {
    this.setze(name, 'fehler', grund);
  }

  markiereGestartet(name: string): void {
    this.setze(name, 'gestartet', null);
  }

  /** Stopp-Schritte laufen beim Shutdown in Registrierungsreihenfolge; ein Fehler haelt die Kette nicht an. */
  beimStopp(name: string, stop: () => unknown): void {
    this.stoppSchritte.push({ name, stop });
  }

  status(): DaemonKernStatus {
    return {
      profil: this.profil,
      pid: process.pid,
      gestartet_am: this.gestartetAm,
      komponenten: [...this.komponenten.values()].map((k) => ({ ...k })),
    };
  }

  get beendetSich(): boolean {
    return this.shuttingDown;
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log(`[daemon] ${signal} empfangen — graceful Shutdown...`);

    // Hard-Exit-Fallback: haengt ein stop() (z.B. blockierter PG-Client), lebte der Prozess sonst ewig weiter
    // (User-Report 2026-06-06: Tray-"Deaktivieren" ohne Wirkung). Nach hardExitMs harter Exit.
    const hardExit = setTimeout(() => {
      this.log(`[daemon] Shutdown haengt (>${Math.round(this.hardExitMs / 1000)}s) — harter Exit.`);
      this.exit(1);
    }, this.hardExitMs);
    hardExit.unref();

    for (const schritt of this.stoppSchritte) {
      try {
        await schritt.stop();
      } catch (err) {
        this.log(`[daemon] ${schritt.name} stop Fehler:`, err);
      }
    }

    clearTimeout(hardExit);
    this.log('[daemon] Shutdown abgeschlossen.');
    this.exit(0);
  }

  /** SIGTERM/SIGINT/uncaughtException -> shutdown; unhandledRejection nur protokollieren (wie bisher). */
  installiereSignale(): void {
    process.on('SIGTERM', () => { void this.shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void this.shutdown('SIGINT'); });
    process.on('uncaughtException', (err) => {
      this.log('[daemon] Uncaught Exception:', err);
      void this.shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      this.log('[daemon] Unhandled Rejection:', reason);
    });
  }

  private setze(name: string, zustand: KomponentenZustand, grund: string | null): void {
    this.komponenten.set(name, { name, zustand, grund, seit: new Date().toISOString() });
  }
}
