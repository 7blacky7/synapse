import { AgentRuntimeRepository } from './repository.js';
import { CodexRuntimeDriver } from './codex-driver.js';
import { ClaudeRuntimeDriver } from './claude-driver.js';
import { FreeModelPoolDriver } from './free-pool-driver.js';
import { TerminalSessionRegistry } from './terminal-sessions.js';
import type { AgentRuntimeDriver, MainAgentSession, RuntimeName, RuntimeStatus } from './types.js';
import { leseHauptagentSchalter, stelleMainIdentitaetSicher, fuehreRuntimeWechselAus, fuehreZustellungAus, hauptagentIdentitaetsId, istMainLaufRuntime } from '@synapse/core';
import { fuehreMainWarteschlangeAus, warteschlangeAktiv } from '@synapse/core';
import { fuehreStartOrtZustellungenAus } from '@synapse/core';
import { registriereCliModellKatalog, standardModellFuerRuntime, type CliModellRuntime, type StandardModellWahl } from '@synapse/core';
import {
  fuehreUeberwachungsTaktAus, leseRuntimeUeberwachungWerte, registriereUeberwachungsDienste, fuehreCliUpdatesAus, type UeberwachungsDienste, type UeberwachungTaktBericht,
} from '@synapse/core';

/**
 * P22-T58 F5: Pruefraster fuer faellige CLI-Updates; ob eins faellig ist, entscheidet die Einstellung cli_update_stunden.
 * P22-T60: laeuft unabhaengig vom Schalter runtime_ueberwachung (abschaltbar nur ueber cli_update_automatisch).
 */
const CLI_UPDATE_PRUEF_MS = 10 * 60_000;

/** P22-T58: erster Ueberwachungstakt nach dem Start; danach Einstellung takt_sekunden (Schalter runtime_ueberwachung, Standard AUS). */
const UEBERWACHUNG_START_MS = 15_000;

/** P22-T6: Takt der Nachrichten-Zustellung an den Hauptagenten im Container (Ledger agent_zustellungen). */
const ZUSTELL_TAKT_MS = Math.max(500, Number(process.env.SYNAPSE_HAUPTAGENT_ZUSTELL_MS) || 2_000);

/** P22-T6c: Takt des Runtime-Wechsel-Ausfuehrers (runtime_wechsel-Auftraege des Hauptagenten). */
const RUNTIME_WECHSEL_TAKT_MS = 10_000;

/** P22-T73: Takt der Warteschlange des Main-Chats (Schalter main_warteschlange; ohne wartende Zeile nur eine Abfrage). */
const WARTESCHLANGE_TAKT_MS = Math.max(1_000, Number(process.env.SYNAPSE_HAUPTAGENT_WARTESCHLANGE_MS) || 3_000);

export class AgentRuntimeManager {
  readonly terminals = new TerminalSessionRegistry();
  private readonly repository = new AgentRuntimeRepository();
  private readonly drivers = new Map<RuntimeName, AgentRuntimeDriver>();

  constructor() {
    const codex = new CodexRuntimeDriver(this.repository);
    const claude = new ClaudeRuntimeDriver(this.repository);
    // Dritte Runtime ohne Container: reine HTTP-Aufrufe gegen den Modell-Pool.
    const freePool = new FreeModelPoolDriver(this.repository);
    this.drivers.set(codex.runtime, codex);
    this.drivers.set(claude.runtime, claude);
    this.drivers.set(freePool.runtime, freePool);
    // P22-T6c: runtime_wechsel braucht beide Container-Daemons (alte Runtime stoppt, neue startet) - die API fuehrt ihn aus.
    this.wechselTimer = setInterval(() => { void this.runtimeWechselTakt(); }, RUNTIME_WECHSEL_TAKT_MS);
    this.wechselTimer.unref();
    this.zustellTimer = setInterval(() => { void this.zustellTakt(); }, ZUSTELL_TAKT_MS);
    this.zustellTimer.unref();
    this.warteschlangeTimer = setInterval(() => { void this.warteschlangeTakt(); }, WARTESCHLANGE_TAKT_MS);
    this.warteschlangeTimer.unref();
    // P22-T58: Ueberwachung der Runtime-Container (Container nur Prozesshalter, Entscheidungen hier in der API).
    registriereUeberwachungsDienste(this.ueberwachungsDienste);
    // P22-T62: core prueft/waehlt Main-Modelle an den ausgelesenen CLI-Listen (Schalter hauptagent_cli_modelle).
    registriereCliModellKatalog(async (runtime) => {
      const l = await this.driver(runtime).modelle!();
      return { grund: l.grund, alias_ziele: l.alias_ziele, modelle: l.modelle.map((m) => ({ id: m.id, name: m.name, beschreibung: m.beschreibung, sichtbar: m.sichtbar,
        gruppe: m.gruppe, familie: m.familie, standard: m.standard, effort_stufen: m.effort_stufen, standard_effort: m.standard_effort })) };
    });
    this.planeUeberwachung(UEBERWACHUNG_START_MS);
    this.cliUpdateTimer = setInterval(() => { void fuehreCliUpdatesAus(this.ueberwachungsDienste).catch(() => undefined); }, CLI_UPDATE_PRUEF_MS);
    this.cliUpdateTimer.unref();
  }

  private cliUpdateTimer: NodeJS.Timeout | null = null;

  private ueberwachungTimer: NodeJS.Timeout | null = null;
  private beendet = false;

  /** P22-T58: Docker-Seite der Runtime-Ueberwachung (core fuehrt Bewertung, Stand und Ereignisse). */
  private readonly ueberwachungsDienste: UeberwachungsDienste = {
    beobachte: (runtime, o) => {
      const d = this.driver(runtime);
      if (!d.beobachte) throw new Error('Runtime ohne Container: ' + runtime);
      return d.beobachte(o);
    },
    starteContainer: async (runtime) => { await this.driver(runtime).start(); },
    neustartContainer: async (runtime) => {
      const d = this.driver(runtime);
      if (!d.neustart) throw new Error('Runtime ohne Container: ' + runtime);
      await d.neustart();
    },
    mainRuntime: async () => (await this.repository.getAssignedMain())?.runtime ?? null,
    standardModell: (runtime) => this.standardModell(runtime),
    stoppeContainer: async (runtime) => { await this.driver(runtime).stop(); },
    cliUpdate: async (runtime, o) => {
      const d = this.driver(runtime);
      if (!d.cliUpdate) throw new Error('Runtime ohne Container: ' + runtime);
      return d.cliUpdate(o);
    },
  };

  private planeUeberwachung(ms: number): void {
    if (this.beendet) return;
    this.ueberwachungTimer = setTimeout(() => { void this.ueberwachungTakt(); }, ms);
    this.ueberwachungTimer.unref();
  }

  private async ueberwachungTakt(): Promise<void> {
    let naechster = UEBERWACHUNG_START_MS;
    try {
      await fuehreUeberwachungsTaktAus(this.ueberwachungsDienste);
      naechster = (await leseRuntimeUeberwachungWerte()).takt_sekunden * 1000;
    } catch (error) {
      console.error('[agent-runtime] Runtime-Ueberwachung:', (error as Error).message);
    } finally {
      this.planeUeberwachung(naechster);
    }
  }

  /** P22-T58: Takt sofort (REST/Web-UI); trocken = nur bewerten. */
  ueberwachungJetzt(trocken: boolean): Promise<UeberwachungTaktBericht> {
    return fuehreUeberwachungsTaktAus(this.ueberwachungsDienste, { trocken });
  }

  /** Altstandard (Schalter hauptagent_cli_modelle AUS): codex = CLI-Standard, claude = Runtime-Modell bzw. 'sonnet'. */
  private async altStandardModell(runtime: string): Promise<string> {
    return runtime === 'codex' ? 'codex' : ((await this.repository.get('claude'))?.model ?? 'sonnet');
  }

  /** P22-T62: Standard ohne ausdrueckliches Modell; EIN = User-Wahl der Runtime bzw. kleinstes Modell der CLI-Liste. */
  standardModellWahl(runtime: CliModellRuntime): Promise<StandardModellWahl> {
    return standardModellFuerRuntime(runtime, () => this.altStandardModell(runtime));
  }

  private async standardModell(runtime: string): Promise<string> {
    if (runtime !== 'claude' && runtime !== 'codex') return this.altStandardModell(runtime);
    const w = await this.standardModellWahl(runtime);
    if (!w.modell) throw new Error('standardmodell_unbestimmt: ' + (w.grund ?? runtime));
    return w.modell;
  }

  private zustellTimer: NodeJS.Timeout | null = null;
  private zustellLaeuft = false;

  /** P22-T6: Nachrichten an den Main (inbox/chat/channel/event) ueber den Container-Daemon zustellen. */
  private async zustellTakt(): Promise<void> {
    // P22-T113 Stufe 2: alle uebrigen Agenten ueber den Daemon ihres Startorts (Schalter agent_start_ort, eigene Drossel,
    // je Identitaet nie parallel). Ohne await: lange Modell-Zuege halten die Main-Zustellung nicht auf. Wirft nie.
    void fuehreStartOrtZustellungenAus();
    if (this.zustellLaeuft) return;
    this.zustellLaeuft = true;
    try {
      if (!(await leseHauptagentSchalter()).aktiv) return;
      const identityId = await hauptagentIdentitaetsId();
      const runtime = (await this.repository.getAssignedMain())?.runtime;
      if (!identityId || !istMainLaufRuntime(runtime)) return;
      await fuehreZustellungAus({ identity_id: identityId, runtime });
    } catch (error) {
      console.error('[agent-runtime] Zustellung:', (error as Error).message);
    } finally {
      this.zustellLaeuft = false;
    }
  }

  private warteschlangeTimer: NodeJS.Timeout | null = null;
  private warteschlangeLaeuft = false;

  /** P22-T73: wartende Main-Chat-Nachrichten nach der Wiederherstellung zustellen (einzeln bzw. als Buendel). */
  private async warteschlangeTakt(): Promise<void> {
    if (this.warteschlangeLaeuft) return;
    this.warteschlangeLaeuft = true;
    try {
      if (!(await leseHauptagentSchalter()).aktiv) return;
      const identityId = await hauptagentIdentitaetsId();
      if (!identityId) return;
      await fuehreMainWarteschlangeAus({
        identity_id: identityId, runtime: (await this.repository.getAssignedMain())?.runtime ?? null,
        dienste: { standardModell: (runtime) => this.standardModell(runtime) },
      });
    } catch (error) {
      console.error('[agent-runtime] Warteschlange:', (error as Error).message);
    } finally {
      this.warteschlangeLaeuft = false;
    }
  }

  /** P22-T71: zugewiesene Main-Runtime ohne Container-Status (fuer die Chat-Route). */
  async zugewieseneMainRuntime(): Promise<RuntimeName | null> {
    return (await this.repository.getAssignedMain())?.runtime ?? null;
  }

  private wechselTimer: NodeJS.Timeout | null = null;
  private wechselLaeuft = false;

  private async runtimeWechselTakt(): Promise<void> {
    if (this.wechselLaeuft) return;
    this.wechselLaeuft = true;
    try {
      if (!(await leseHauptagentSchalter()).aktiv) return;
      await fuehreRuntimeWechselAus({
        weiseMainZu: (runtime) => this.repository.assignMain(runtime),
        zugewiesen: async () => (await this.repository.getAssignedMain())?.runtime ?? null,
        standardModell: (runtime) => this.standardModell(runtime),
        // P22-T71: ueberlebt der alte Wrapper den Stop (Prozesstod nicht nachweisbar), wird sein Container neu gestartet.
        erzwingeStop: (runtime) => this.ueberwachungsDienste.neustartContainer(runtime),
      });
    } catch (error) {
      console.error('[agent-runtime] Runtime-Wechsel-Ausfuehrer:', (error as Error).message);
    } finally {
      this.wechselLaeuft = false;
    }
  }

  driver(runtime: string): AgentRuntimeDriver {
    const driver = this.drivers.get(runtime as RuntimeName);
    if (!driver) throw new Error('Unbekannte Agent-Runtime: ' + runtime);
    return driver;
  }

  listDrivers(): Array<{ runtime: RuntimeName; label: string }> {
    return [...this.drivers.values()].map((driver) => ({ runtime: driver.runtime, label: driver.label }));
  }

  async listStatuses(): Promise<RuntimeStatus[]> {
    return Promise.all([...this.drivers.values()].map((driver) => driver.status()));
  }

  async assignMain(runtime: RuntimeName | null): Promise<{ runtime: RuntimeName | null; status: RuntimeStatus | null }> {
    if (runtime) await this.assertMainRuntimeReady(runtime, false);
    await this.repository.assignMain(runtime);
    return this.mainAssignment();
  }

  async mainAssignment(): Promise<{ runtime: RuntimeName | null; status: RuntimeStatus | null }> {
    const config = await this.repository.getAssignedMain();
    if (!config) return { runtime: null, status: null };
    return { runtime: config.runtime, status: await this.driver(config.runtime).status() };
  }

  async createMainSession(runtime?: RuntimeName): Promise<MainAgentSession> {
    const assigned = (await this.repository.getAssignedMain())?.runtime;
    if (!assigned) throw new Error('Dem Main-Agenten ist noch keine Runtime zugewiesen');
    if (runtime && runtime !== assigned) throw new Error('Nur die aktuell zugewiesene Main-Agent-Runtime darf Sessions starten');
    try {
      await this.assertMainRuntimeReady(assigned);
    } catch (error) {
      // P22-T73: mit Warteschlange darf der Chat auch ohne bereite Runtime beginnen (die erste Nachricht wartet dann).
      const hauptagent = await leseHauptagentSchalter().then((s) => s.aktiv, () => false);
      if (!hauptagent || !(await warteschlangeAktiv())) throw error;
    }
    // P22-T36: Schalter hauptagent EIN -> Erstkontakt legt die Main-Identitaet an bzw. findet sie (Akteur User: diese
    // Route ist nur fuer den interaktiven User offen). AUS -> unveraendert.
    const haupt = await this.hauptagentFuerSession(assigned);
    const session = await this.repository.createSession(assigned, haupt.identityId);
    return haupt.info ? { ...session, hauptagent: haupt.info } : session;
  }

  private async hauptagentFuerSession(runtime: RuntimeName): Promise<{ identityId: string | null; info?: MainAgentSession['hauptagent'] }> {
    try {
      if (!(await leseHauptagentSchalter()).aktiv) return { identityId: null };
    } catch {
      return { identityId: null };
    }
    // P1: nur der Claude-Treiber nutzt den Identitaetsweg; free-pool bleibt Altweg (benannter Rest).
    // P22-T6b: Codex-Main laeuft ueber denselben dauerhaften Container-Weg (codex-runtime im Wrapper).
    if (runtime !== 'claude' && runtime !== 'codex') return { identityId: null, info: { weg: 'altweg', fehler: 'runtime_nicht_umgestellt' } };
    try {
      const cfg = await this.repository.get(runtime);
      const r = await stelleMainIdentitaetSicher({ art: 'user' }, { modell: cfg?.model ?? null, runtime });
      return { identityId: r.identity_id, info: { weg: 'identitaet', identity_id: r.identity_id, outcome: r.outcome } };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return { identityId: null, info: { weg: 'altweg', fehler: typeof code === 'string' ? code : 'hauptagent_fehler' } };
    }
  }

  async assertMainRuntimeReady(runtime: RuntimeName, requireAssigned = true): Promise<RuntimeStatus> {
    const assigned = (await this.repository.getAssignedMain())?.runtime;
    if (requireAssigned && assigned !== runtime) throw new Error('Runtime ist dem Main-Agenten nicht zugewiesen');
    const status = await this.driver(runtime).status();
    if (!status.installed || status.container.status !== 'running' || status.authentication.status !== 'authenticated') {
      throw new Error('Main-Agent-Runtime ist nicht installiert, laufend und authentifiziert');
    }
    return status;
  }

  async getMainSession(id: string): Promise<MainAgentSession> {
    const session = await this.repository.getSession(id);
    if (!session) throw new Error('Main-Agent-Sitzung nicht gefunden');
    return session;
  }

  async markSessionRunning(id: string): Promise<void> {
    if (!await this.repository.claimSession(id)) {
      throw new Error('Main-Agent-Sitzung verarbeitet bereits eine Nachricht');
    }
  }

  async completeSession(id: string, runtimeSessionId: string | null, context: Record<string, unknown> | null): Promise<void> {
    await this.repository.updateSession(id, { runtimeSessionId, context, status: 'completed', lastError: null });
  }

  async failSession(id: string, error: Error): Promise<void> {
    await this.repository.updateSession(id, { status: 'error', lastError: error.message });
  }

  shutdown(): void {
    if (this.wechselTimer) clearInterval(this.wechselTimer);
    if (this.zustellTimer) clearInterval(this.zustellTimer);
    if (this.warteschlangeTimer) clearInterval(this.warteschlangeTimer);
    this.beendet = true;
    if (this.ueberwachungTimer) clearTimeout(this.ueberwachungTimer);
    if (this.cliUpdateTimer) clearInterval(this.cliUpdateTimer);
    registriereUeberwachungsDienste(null);
    registriereCliModellKatalog(null);
    this.terminals.closeAll();
  }
}

let singleton: AgentRuntimeManager | null = null;

export function getAgentRuntimeManager(): AgentRuntimeManager {
  if (!singleton) singleton = new AgentRuntimeManager();
  return singleton;
}

export function shutdownAgentRuntimeManager(): void {
  singleton?.shutdown();
  singleton = null;
}
