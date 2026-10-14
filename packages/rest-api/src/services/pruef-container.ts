/**
 * MODUL: Pruef-Container (P16-T5, Stufe S3, 11.10.2026)
 *
 * Syntaxpruefung fuer Sprachen, die im Node-Prozess der API nicht pruefbar sind (E1: Rust; E2: Python, Shell, Go;
 * E3a: PHP, Ruby, Lua; E3b: Kotlin, Java). E3a: Kaltstart-Budget, Vorwaermen beim Anmelden, Diagnose an intern(status).
 *
 * ERSTPRUEFUNG (Deploy t61 Probe 1): auch im WARMEN Container braucht die erste Pruefung einer Sprache laenger (Werkzeug
 * zum ersten Mal starten, Grammatik laden; Unraid: erstes php -l 50 ms > 30-ms-Budget -> kaputte Datei geschrieben).
 * Deshalb gilt das Kaltbudget je Sprache, bis diese Sprache seit dem Containerstart einmal geantwortet hat
 * (erstGeprueft). JVM-Sprachen haben dafuer ihr eigenes Budget (jvmWarm, E3b).
 *
 * E3b JVM: Kotlin und Java prueft ein JVM-Hilfsprozess IM SELBEN Container (pruefer_jvm.py, jvm/JvmPruefer.java).
 * pruefserver.py startet ihn traege (erste Kotlin-/Java-Anfrage oder Vorwaermen) und nach einem Absturz neu; er
 * lebt mit dem Container (gleicher Start, Idle-Stop, Diagnose). Hier gibt es dafuer keinen eigenen Verwaltungsweg,
 * nur: Sprachen mit jvm:true bekommen ein eigenes Kaltbudget (PRUEFCONTAINER_JVM_KALT_BUDGET_MS) und das lange
 * Startlimit, solange die JVM nicht nachweislich laeuft; Vorwaermen waermt die JVM mit. Ein JVM-Ausfall liefert nur
 * fuer Kotlin/Java ok:false (Schreiben geht ungeprueft durch), alle anderen Sprachen laufen weiter.
 * Die Werkzeuge laufen im Container synapse-pruefcontainer (Dockerfile docker/synapse-pruefcontainer/); diese Datei
 * verwaltet ihn ueber docker.sock - wie der Workspace-Orchestrator - und meldet je Container-Sprache einen
 * Syntaxpruefer an
 * (registriereSyntaxPruefer aus core, also derselbe Weg wie Stufe 1: Befund an Op, quittieren, Sperre).
 *
 * VERBINDUNG: KEIN Netz. Der Container laeuft mit NetworkMode none; PID 1 (pruefserver.py) spricht JSON-Zeilen
 * ueber stdin/stdout, die API haengt sich per docker attach an (hijack, demux).
 *   rein  {id, sprache, inhalt, pfad} | {id, info:true}
 *   raus  {id, ok:true, meldungen:[{zeile, spalte, code, meldung}], ms} | {id, ok:false, fehler} | {id, ok:true, info}
 *
 * LEBENSZYKLUS: Start bei Bedarf (erster Auftrag), bereit = Antwort auf info. Idle-Stop nach PRUEFCONTAINER_IDLE_MIN.
 * Absturz (Stream-Ende) -> offene Auftraege scheitern, der naechste startet neu. Mehr als PRUEFCONTAINER_MAX_STARTS
 * Starts in 5 min -> Pause PRUEFCONTAINER_PAUSE_MS, in der jeder Auftrag sofort 'nicht verfuegbar' ist.
 * Reissleine PRUEFCONTAINER_TIMEOUT_MS erst ab 'bereit' (das Aufwaermen hat PRUEFCONTAINER_START_MS);
 * 3 Timeouts in Folge -> Container neu.
 *
 * KEIN PRUEFER VERFUEGBAR: pruefe() wirft; pruefeSyntaxEinzelweg (core) protokolliert und schreibt trotzdem.
 *
 * NACHLIEFERUNG: Ergebnis-Cache je (Sprache, Pfad, Inhalt-Hash) + geteilte gleichzeitige Laeufe. Reisst ein Auftrag
 * das Budget FEHLERPRUEFUNG_BUDGET_MS, laeuft er weiter; die naechste Pruefung desselben Inhalts (commit nach plan,
 * plan_status) bekommt das Ergebnis sofort - wie im Syntax-Pool der Stufe 1.
 *
 * LIMITS (Env, Standard): PRUEFCONTAINER_MEM_MB (384, ohne Swap; E3b gemessen: memory.peak 206-215 MB unter Last mit allen
 * 9 Sprachen gleichzeitig inkl. JVM -Xmx160m, Rest = Reserve fuer volle Heap-Nutzung), PRUEFCONTAINER_CPUS (1), PRUEFCONTAINER_PIDS (64),
 * PRUEFCONTAINER_TMPFS_MB (64). SICHERHEIT: read-only rootfs, User 65532, cap_drop ALL, no-new-privileges, keine Binds.
 * Schalter: PRUEFCONTAINER=0 (aus), SYNTAXPRUEFUNG=0 (alle Syntaxpruefer aus). Image: PRUEFCONTAINER_IMAGE.
 *
 * BUILD-PRUEFUNG (P16-T16 E1, 14.10.2026): derselbe Container prueft auf Auftrag ein TS-Monorepo projektweit
 * ({build:{dateien, projekte, zeitlimit_s, heap_mb}} -> pruefer_tsbuild.py, tsc --noEmit, nur tmpfs). Logik, Cache,
 * Schalter und Warteschlange in core build-pruefung.ts; hier nur der Transport (pruefeBuild) und das Speicherbudget
 * (setzeBudget: Speicher/tmpfs aus code_check build_einstellungen; ein laufender Container wird neu gestartet).
 * Fuer die Build-Pruefung reicht das Syntax-Budget (384 MB) nicht: Budget ueber build_einstellungen anheben.
 */

import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { registriereSyntaxPruefer, registriereWorker, workerPausiert, meldeWorkerArbeit, registriereInternQuelle, type SyntaxMeldung } from '@synapse/core';
import { registriereBuildPruefer, synchronisiereBuildBudget, buildPruefungZustand, type BuildAuftrag, type BuildLaufErgebnis } from '@synapse/core';
import { TREESITTER_SPRACHEN } from './pruef-container-treesitter.js';

/** Sprachen, die der Container prueft. sperrfaehig nur nach Falsch-Positiv-Test auf echten Index-Dateien. */
export interface ContainerSprache {
  sprache: string;
  endungen: string[];
  /** P16-T14: exakte Dateinamen ohne Pfad, klein (makefile, dockerfile, build ...) - zusaetzlich zu endungen. */
  dateinamen?: string[];
  sperrfaehig: boolean;
  werkzeug: string;
  /** E3b: geprueft vom JVM-Hilfsprozess im Container (eigenes Kaltbudget, traeger Start). */
  jvm?: boolean;
}

export const CONTAINER_SPRACHEN: ContainerSprache[] = [
  // P16-T5 E1: rustfmt als reiner Parser, FP 0/1136 echte Index-Dateien, gemma rust_1/rust_5 erkannt.
  { sprache: 'rust', endungen: ['rs'], sperrfaehig: true, werkzeug: 'rustfmt' },
  // P16-T5 E2: compile(PyCF_ONLY_AST) mit Python 3.14 + Python-2-Rueckfall (fissix). FP 0 auf den Index-Dateien,
  // die 3 Meldungen dort sind echte Fehler (Messwerte im Bericht). Python 2 gueltig -> kein Befund.
  { sprache: 'python', endungen: ['py', 'pyw', 'pyi'], sperrfaehig: true, werkzeug: 'python-ast' },
  // P16-T5 E2: bash -n, nur Bourne-Shells (fremde Shebangs wie zsh/fish/tcsh/ksh werden nicht geprueft).
  // .zsh/.fish bewusst nicht: zsh nennt ueber stdin keine Zeilen, fish-Syntax ist versionsabhaengig.
  { sprache: 'shell', endungen: ['sh', 'bash'], sperrfaehig: true, werkzeug: 'bash' },
  // P16-T5 E2: gofmt -e (go/parser), liest keine Imports.
  { sprache: 'go', endungen: ['go'], sperrfaehig: true, werkzeug: 'gofmt' },
  // P16-T5 E3a: php -l (Parse error + Compile-Fatal), FP 0/513 Index-Dateien. .inc bewusst nicht (auch C/Pascal/BitBake).
  { sprache: 'php', endungen: ['php', 'phtml'], sperrfaehig: true, werkzeug: 'php' },
  // P16-T5 E3a: ruby -c (Ruby 3.3), FP 0/3505. Rakefile/Gemfile ohne Endung erreicht die Endungs-Zuordnung nicht.
  { sprache: 'ruby', endungen: ['rb', 'rake', 'gemspec', 'ru'], sperrfaehig: true, werkzeug: 'ruby' },
  // P16-T5 E3a: luac -p (Lua 5.4), FP 0/94; Lua-5.1/LuaJIT-Abweichungen (Escapes, 1ULL) nur weich.
  { sprache: 'lua', endungen: ['lua'], sperrfaehig: true, werkzeug: 'luac' },
  // P16-T5 E3b: Kotlin-PSI-Parser (kotlin-compiler-embeddable 2.4), nur Parsen, kein Classpath; .kts als Skript.
  { sprache: 'kotlin', endungen: ['kt', 'kts'], sperrfaehig: true, werkzeug: 'kotlin-psi', jvm: true },
  // P16-T5 E3b: javac-API parse() (JDK 25), Preview-Meldungen nur weich.
  { sprache: 'java', endungen: ['java'], sperrfaehig: true, werkzeug: 'javac', jvm: true },
  // P16-T13: scalameta 4.17 (Scala213Source3, Rueckfall Scala3; .sbt als Sbt1), FP src 0/1282, ausserhalb der
  // absichtlich kaputten neg-/presentation-Tests 4/7900 Randfaelle des scala-Compiler-Testkorpus.
  { sprache: 'scala', endungen: ['scala', 'sbt'], sperrfaehig: true, werkzeug: 'scalameta', jvm: true },
  // P16-T13: Groovy-Compiler bis Phase CONVERSION (keine Klassenaufloesung, Grab abgeschaltet), FP 0/17 (.gradle/.groovy).
  { sprache: 'groovy', endungen: ['groovy', 'gradle', 'gvy', 'gy', 'gsh'], sperrfaehig: true, werkzeug: 'groovy', jvm: true },
  // P16-T13: naga-cli 30 (nur Parsefehler, --validate 0), FP 0/546 echte .wgsl (4 Meldungen = 2 echte Fehler, je
  // doppelt im Index); Vorlagen mit #-Praeprozessor (llama.cpp ggml-webgpu, 79 Dateien) werden nicht geprueft.
  { sprache: 'wgsl', endungen: ['wgsl'], sperrfaehig: true, werkzeug: 'naga' },
  // P16-T14 (Modul pruefer_build.py, Messwerte im Bericht zu P16-T14). Dockerfile: buildkit-Parser + instructions,
  // FP 0/102 (Dockerfile.<x>-Varianten bewusst nicht: darunter ERB-Vorlagen wie Dockerfile.tt).
  { sprache: 'dockerfile', endungen: ['dockerfile'], dateinamen: ['dockerfile', 'containerfile'], sperrfaehig: true, werkzeug: 'pruefgo' },
  // HCL (hclsyntax, Terraform/Packer/Nomad), FP 0/10.
  { sprache: 'hcl', endungen: ['tf', 'tfvars', 'hcl'], sperrfaehig: true, werkzeug: 'pruefgo' },
  // Starlark (Parser von buildifier), FP 0/4 (+0/18 weitere BUILD/.bzl).
  { sprache: 'starlark', endungen: ['bzl', 'star', 'bazel'], dateinamen: ['build', 'workspace'], sperrfaehig: true, werkzeug: 'pruefgo' },
  // Jsonnet (Parser von jsonnetfmt), 0 Fehlalarme auf 302: Meldungen nur in absichtlich kaputten Testdateien.
  { sprache: 'jsonnet', endungen: ['jsonnet', 'libsonnet'], sperrfaehig: true, werkzeug: 'pruefgo' },
  // GNU make -n mit SHELL=/bin/true, nur Syntaxmeldungen; FP 0/321 (1 echter GNU-make-Fehler). .mak/Makefile.<x>
  // bewusst nicht: dort stehen nmake-/Watcom-/Amiga-Dialekte.
  { sprache: 'make', endungen: ['mk'], dateinamen: ['makefile', 'gnumakefile'], sperrfaehig: true, werkzeug: 'make' },
  // Meson-Parser (mesonbuild.mparser), FP 0/5 (+0/20 weitere), Positivkontrolle 25/25.
  { sprache: 'meson', endungen: [], dateinamen: ['meson.build', 'meson_options.txt', 'meson.options'], sperrfaehig: true, werkzeug: 'meson-mparser' },
  // GNU ld -T (Umgebungs-Befehle wie OUTPUT_ARCH geleert), FP 0/12 (+0/15 weitere), Positivkontrolle 52/52.
  { sprache: 'linkerscript', endungen: ['ld', 'lds'], sperrfaehig: true, werkzeug: 'ld' },
  // P16-T11: tree-sitter-Sprachen (je Sprache eine Zeile in pruef-container-treesitter.ts + Modul ts_sprachen/).
  ...TREESITTER_SPRACHEN,
];

const JVM_SPRACHEN = new Set(CONTAINER_SPRACHEN.filter((s) => s.jvm).map((s) => s.sprache));

export interface PruefContainerConfig {
  socketPath: string;
  image: string;
  name: string;
  memMb: number;
  cpus: number;
  pids: number;
  tmpfsMb: number;
  idleMin: number;
  timeoutMs: number;
  startMs: number;
  pauseMs: number;
  maxStarts: number;
  warteschlangeMax: number;
  cacheEintraege: number;
  parallel: number;
  tickMs: number;
  /**
   * E3a: Budget fuer den Syntaxpruefer, solange der Container NICHT bereit ist (Kaltstart, gemessen 0,4-2 s).
   * Statt 'teilweise' + Nachlieferung wartet der erste Schreibvorgang nach einem Idle-Stop auf das Ergebnis
   * und wird bei Fehler gesperrt. 0 = aus (dann gilt FEHLERPRUEFUNG_BUDGET_MS auch beim Kaltstart).
   */
  kaltBudgetMs: number;
  /**
   * E3b: Budget fuer Kotlin/Java, solange die JVM im Container nicht nachweislich laeuft (Container- plus JVM-Start,
   * Kotlin-Umgebung). 0 = aus.
   */
  jvmKaltBudgetMs: number;
}

function envZahl(name: string, standard: number): number {
  const roh = process.env[name];
  const wert = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  return Number.isFinite(wert) && wert >= 0 ? wert : standard;
}

export function pruefContainerConfigAusEnv(): PruefContainerConfig {
  return {
    socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock',
    image: process.env.PRUEFCONTAINER_IMAGE || 'synapse-pruefcontainer:latest',
    name: process.env.PRUEFCONTAINER_NAME || 'synapse-pruefcontainer',
    memMb: Math.max(128, envZahl('PRUEFCONTAINER_MEM_MB', 384)),
    cpus: envZahl('PRUEFCONTAINER_CPUS', 1) || 1,
    pids: Math.max(16, envZahl('PRUEFCONTAINER_PIDS', 64)),
    tmpfsMb: Math.max(8, envZahl('PRUEFCONTAINER_TMPFS_MB', 64)),
    idleMin: envZahl('PRUEFCONTAINER_IDLE_MIN', 10),
    timeoutMs: envZahl('PRUEFCONTAINER_TIMEOUT_MS', 5000),
    startMs: envZahl('PRUEFCONTAINER_START_MS', 60_000) || 60_000,
    pauseMs: envZahl('PRUEFCONTAINER_PAUSE_MS', 60_000),
    maxStarts: Math.max(1, envZahl('PRUEFCONTAINER_MAX_STARTS', 3)),
    warteschlangeMax: envZahl('PRUEFCONTAINER_WARTESCHLANGE_MAX', 64) || 64,
    cacheEintraege: envZahl('PRUEFCONTAINER_CACHE_EINTRAEGE', 128),
    parallel: Math.max(1, envZahl('PRUEFCONTAINER_PARALLEL', 2)),
    tickMs: envZahl('PRUEFCONTAINER_TICK_MS', 60_000) || 60_000,
    kaltBudgetMs: envZahl('PRUEFCONTAINER_KALT_BUDGET_MS', 3000),
    jvmKaltBudgetMs: envZahl('PRUEFCONTAINER_JVM_KALT_BUDGET_MS', 4000),
  };
}

export class PruefContainerNichtVerfuegbar extends Error {
  constructor(grund: string) {
    super(`Pruef-Container nicht verfuegbar: ${grund}`);
    this.name = 'PruefContainerNichtVerfuegbar';
  }
}

export class PruefContainerTimeout extends Error {
  constructor(readonly sprache: string, readonly pfad: string, readonly limitMs: number) {
    super(`Pruef-Container: ${sprache} fuer ${pfad} nach ${limitMs} ms abgebrochen (Reissleine)`);
    this.name = 'PruefContainerTimeout';
  }
}

export interface PruefContainerInfo {
  werkzeuge: Record<string, string>;
  [k: string]: unknown;
}

interface Offen {
  resolve: (wert: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
}

type Antwort = { id?: number | null; ok?: boolean; meldungen?: SyntaxMeldung[]; fehler?: string; info?: PruefContainerInfo; bereit?: boolean; ms?: number; vorgewaermt?: Record<string, unknown>; build?: BuildLaufErgebnis };

const START_FENSTER_MS = 5 * 60_000;
const MAX_TIMEOUTS_IN_FOLGE = 3;
/** Diagnose: so viele Auftragsdauern fuer p50/p95, so viele letzte Fehler. */
const DAUERN_MAX = 200;
const FEHLER_MAX = 8;

export class PruefContainer {
  private zustandName: 'aus' | 'startet' | 'bereit' = 'aus';
  private start: Promise<void> | null = null;
  private stream: (NodeJS.ReadWriteStream & { destroy?: (e?: Error) => void }) | null = null;
  private containerId: string | null = null;
  private offen = new Map<number, Offen>();
  private naechsteId = 1;
  private letzteAktivitaet = Date.now();
  private starts: number[] = [];
  private pauseBis = 0;
  private pauseGrund = '';
  private timeoutsInFolge = 0;
  private stoppend = false;
  private info: PruefContainerInfo | null = null;
  private cache = new Map<string, SyntaxMeldung[]>();
  private laufend = new Map<string, Promise<SyntaxMeldung[]>>();
  private tick: NodeJS.Timeout | null = null;
  private z = { auftraege: 0, cache_treffer: 0, geteilt: 0, timeouts: 0, fehler: 0, abgelehnt: 0, starts: 0, abstuerze: 0, idle_stops: 0, ms_summe: 0 };
  /** Diagnose (E3a): Dauern der letzten Auftraege (ms, inkl. Warteschlange), letzte Fehler, Speicherlimit laut inspect. */
  private dauern: number[] = [];
  private letzteFehler: Array<{ zeit: string; text: string }> = [];
  private speicher: { memory: number; memory_swap: number; swap_begrenzt: boolean } | null = null;
  private letzterStartMs: number | null = null;
  /**
   * E3b: JVM-Sprachen, die seit dem letzten Containerstart erfolgreich geantwortet haben (sonst Kaltbudget/Startlimit).
   * Je Sprache, weil die JVM jeden Parser erst bei seiner ersten Anfrage initialisiert (Kotlin-Umgebung, javac).
   */
  private jvmWarm = new Set<string>();
  private jvm = { vorwaermungen: 0, letzte_vorwaermung_ms: null as number | null, fehler: 0, kalt_auftraege: 0 };
  /**
   * Erstpruefung: Sprachen, die seit dem letzten Containerstart einmal erfolgreich geantwortet haben. Fuer alle anderen
   * gilt auch im warmen Container das Kaltbudget (erster Werkzeugstart bzw. Grammatik laden, t61: php 50 ms).
   */
  private erstGeprueft = new Set<string>();
  /** Wird nach jedem erfolgreichen Start mit den Werkzeugversionen aufgerufen. */
  onInfo?: (info: PruefContainerInfo) => void;

  constructor(private readonly docker: Docker, readonly cfg: PruefContainerConfig) {}

  /** Idle-Stop-Takt starten (als Worker 'pruefcontainer_idle_stop' pausier- und einzeln ausloesbar). */
  starteTakt(): void {
    if (this.tick) return;
    registriereWorker({
      name: 'pruefcontainer_idle_stop',
      beschreibung: `Pruef-Container nach ${this.cfg.idleMin} min ohne Auftrag stoppen (Tick ${this.cfg.tickMs} ms)`,
      durchlauf: () => this.idleTick(),
    });
    this.tick = setInterval(() => {
      if (workerPausiert('pruefcontainer_idle_stop')) return;
      this.idleTick().catch((err) => console.error(`[pruefcontainer] idleTick: ${(err as Error).message}`));
    }, this.cfg.tickMs);
    this.tick.unref();
  }

  async idleTick(): Promise<{ gestoppt: boolean; zustand: string }> {
    const idleMs = this.cfg.idleMin * 60_000;
    if (this.zustandName === 'bereit' && this.offen.size === 0 && idleMs > 0 && Date.now() - this.letzteAktivitaet >= idleMs) {
      this.z.idle_stops++;
      await this.stoppen(`idle > ${this.cfg.idleMin} min`);
      meldeWorkerArbeit('pruefcontainer_idle_stop');
      return { gestoppt: true, zustand: this.zustandName };
    }
    return { gestoppt: false, zustand: this.zustandName };
  }

  private merkeFehler(text: string): void {
    this.letzteFehler.push({ zeit: new Date().toISOString(), text: text.slice(0, 300) });
    while (this.letzteFehler.length > FEHLER_MAX) this.letzteFehler.shift();
  }

  /**
   * E3a: Mindestbudget fuer den Syntaxpruefer (SyntaxPruefer.mindestBudgetMs). Solange der Container nicht bereit
   * ist und keine Pause gilt, darf der Kaltstart abgewartet werden; warm gilt das normale Budget (undefined).
   * Erstpruefung: auch warm gilt das Kaltbudget, solange die Sprache seit dem Containerstart noch nicht geantwortet hat.
   */
  mindestBudgetMs(sprache?: string): number | undefined {
    if (Date.now() < this.pauseBis) return undefined;
    const warm = this.zustandName === 'bereit' && !!this.stream;
    const jvm = !!sprache && JVM_SPRACHEN.has(sprache);
    // E3b: Kotlin/Java warten auch bei warmem Container den JVM-Start bzw. die Parser-Initialisierung ab.
    if (jvm && this.cfg.jvmKaltBudgetMs > 0 && !(warm && this.jvmWarm.has(sprache!))) return Math.max(this.cfg.jvmKaltBudgetMs, warm ? 0 : this.cfg.kaltBudgetMs);
    if (this.cfg.kaltBudgetMs <= 0) return undefined;
    if (!warm) return this.cfg.kaltBudgetMs;
    // Erstpruefung (t61): erster Lauf einer Sprache im warmen Container. JVM-Sprachen regelt jvmWarm (oben).
    return sprache && !jvm && !this.erstGeprueft.has(sprache) ? this.cfg.kaltBudgetMs : undefined;
  }

  /** E3a: Container im Hintergrund starten (API-Start), damit der erste Schreibvorgang ihn warm vorfindet. Wirft nie. */
  vorwaermen(): void {
    if (Date.now() < this.pauseBis) return;
    this.letzteAktivitaet = Date.now();
    this.bereitMachen()
      .then(() => this.vorwaermenJvm())
      .catch((err) => console.error(`[pruefcontainer] Vorwaermen fehlgeschlagen: ${(err as Error).message}`));
  }

  /** E3b: JVM im laufenden Container starten und anwaermen (pruefserver {vorwaermen:['jvm']}). */
  async vorwaermenJvm(): Promise<void> {
    if (JVM_SPRACHEN.size === 0 || [...JVM_SPRACHEN].every((s) => this.jvmWarm.has(s))) return;
    const t0 = Date.now();
    try {
      const a = await this.schicke({ vorwaermen: ['jvm'] }, this.cfg.startMs) as Antwort;
      for (const s of JVM_SPRACHEN) this.jvmWarm.add(s);
      this.jvm.vorwaermungen++;
      this.jvm.letzte_vorwaermung_ms = Date.now() - t0;
      this.letzteAktivitaet = Date.now();
      console.error(`[pruefcontainer] JVM vorgewaermt nach ${Date.now() - t0} ms: ${JSON.stringify(a.vorgewaermt ?? {})}`);
    } catch (err) {
      this.jvm.fehler++;
      this.merkeFehler(`JVM-Vorwaermen fehlgeschlagen: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Prueft inhalt im Container. Wirft PruefContainerNichtVerfuegbar/PruefContainerTimeout, wenn nicht pruefbar. */
  pruefe(sprache: string, inhalt: string, pfad: string): Promise<SyntaxMeldung[]> {
    const schluessel = `${sprache}|${pfad}|${createHash('sha1').update(inhalt).digest('hex')}`;
    const treffer = this.cache.get(schluessel);
    if (treffer) {
      this.z.cache_treffer++;
      this.cache.delete(schluessel);
      this.cache.set(schluessel, treffer);
      return Promise.resolve(treffer);
    }
    const laeuft = this.laufend.get(schluessel);
    if (laeuft) { this.z.geteilt++; return laeuft; }
    if (Date.now() < this.pauseBis) {
      this.z.abgelehnt++;
      return Promise.reject(new PruefContainerNichtVerfuegbar(`${this.pauseGrund} (Pause bis ${new Date(this.pauseBis).toISOString()})`));
    }
    if (this.offen.size >= this.cfg.warteschlangeMax) {
      this.z.abgelehnt++;
      return Promise.reject(new PruefContainerNichtVerfuegbar('Warteschlange voll'));
    }
    this.z.auftraege++;
    this.letzteAktivitaet = Date.now();
    const p = (async () => {
      await this.bereitMachen();
      const t0 = Date.now();
      // E3b: solange die JVM nicht laeuft, startet pruefserver sie in diesem Auftrag - dafuer gilt das Startlimit.
      const jvm = JVM_SPRACHEN.has(sprache);
      const jvmKalt = jvm && !this.jvmWarm.has(sprache);
      if (jvmKalt) this.jvm.kalt_auftraege++;
      let antwort: Antwort;
      try {
        antwort = await this.schicke({ sprache, inhalt, pfad }, jvmKalt ? Math.max(this.cfg.timeoutMs, this.cfg.startMs) : this.cfg.timeoutMs, { sprache, pfad }) as Antwort;
      } catch (err) {
        if (jvm) { this.jvmWarm.clear(); this.jvm.fehler++; }
        throw err;
      }
      if (jvm) this.jvmWarm.add(sprache);
      this.erstGeprueft.add(sprache);
      this.z.ms_summe += Date.now() - t0;
      this.dauern.push(Date.now() - t0);
      if (this.dauern.length > DAUERN_MAX) this.dauern.shift();
      this.letzteAktivitaet = Date.now();
      return (Array.isArray(antwort.meldungen) ? antwort.meldungen : []).map((m) => ({
        zeile: m.zeile,
        ...(typeof m.spalte === 'number' ? { spalte: m.spalte } : {}),
        ...(m.code ? { code: m.code } : {}),
        meldung: m.meldung,
        // E2: Werkzeug-Warnungen (z. B. bash "here-document ... delimited by end-of-file") sperren nie.
        ...(m.weich ? { weich: true } : {}),
      }));
    })();
    this.laufend.set(schluessel, p);
    p.then((m) => {
      if (this.cfg.cacheEintraege > 0) {
        this.cache.set(schluessel, m);
        while (this.cache.size > this.cfg.cacheEintraege) this.cache.delete(this.cache.keys().next().value as string);
      }
    }, () => { this.z.fehler++; }).finally(() => { this.laufend.delete(schluessel); });
    return p;
  }

  private bereitMachen(): Promise<void> {
    if (this.zustandName === 'bereit' && this.stream) return Promise.resolve();
    if (!this.start) this.start = this.starten().finally(() => { this.start = null; });
    return this.start;
  }

  private pausieren(grund: string): void {
    this.pauseBis = Date.now() + this.cfg.pauseMs;
    this.pauseGrund = grund;
    this.merkeFehler(`Pause ${this.cfg.pauseMs} ms: ${grund}`);
    console.error(`[pruefcontainer] Pause ${this.cfg.pauseMs} ms: ${grund} - bis dahin kein Container-Pruefer verfuegbar (Schreiben laeuft ungeprueft weiter)`);
  }

  private async starten(): Promise<void> {
    if (Date.now() < this.pauseBis) throw new PruefContainerNichtVerfuegbar(this.pauseGrund);
    const jetzt = Date.now();
    this.starts = this.starts.filter((t) => jetzt - t < START_FENSTER_MS);
    if (this.starts.length >= this.cfg.maxStarts) {
      this.pausieren(`${this.starts.length} Starts in ${START_FENSTER_MS / 60_000} min`);
      this.starts = [];
      throw new PruefContainerNichtVerfuegbar(this.pauseGrund);
    }
    this.starts.push(jetzt);
    this.z.starts++;
    this.zustandName = 'startet';
    this.jvmWarm.clear();
    this.erstGeprueft.clear();
    const t0 = Date.now();
    try {
      await this.entferneContainer();
      let container: Docker.Container;
      try {
        try {
          container = await this.docker.createContainer(this.containerOptionen());
        } catch (err) {
          // 409: ein gleichnamiger Container ist zwischen Entfernen und Anlegen (wieder) aufgetaucht, z. B. Rest eines
          // gerade beendeten Starts. Einmal entfernen und neu anlegen statt den Start scheitern zu lassen.
          if ((err as { statusCode?: number }).statusCode !== 409) throw err;
          await this.docker.getContainer(this.cfg.name).remove({ force: true }).catch(() => {});
          container = await this.docker.createContainer(this.containerOptionen());
        }
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404) {
          const grund = `Image ${this.cfg.image} fehlt (docker build -t ${this.cfg.image} docker/synapse-pruefcontainer)`;
          this.pausieren(grund);
          throw new PruefContainerNichtVerfuegbar(grund);
        }
        throw err;
      }
      this.containerId = container.id;
      const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true }) as unknown as NodeJS.ReadWriteStream;
      this.verbinde(stream);
      await container.start();
      const antwort = await this.schicke({ info: true }, this.cfg.startMs) as Antwort;
      this.info = antwort.info ?? { werkzeuge: {} };
      this.zustandName = 'bereit';
      this.timeoutsInFolge = 0;
      this.letzterStartMs = Date.now() - t0;
      // E3a: Speicherlimit am laufenden Container nachlesen. Ohne Swap-Accounting im Kernel setzt Docker
      // MemorySwap still auf -1 (Unraid t60) - dann ist nur der RAM begrenzt; das soll sichtbar sein.
      try {
        const ins = await container.inspect();
        const memory = Number(ins.HostConfig?.Memory ?? 0);
        const memorySwap = Number(ins.HostConfig?.MemorySwap ?? 0);
        this.speicher = { memory, memory_swap: memorySwap, swap_begrenzt: memorySwap === memory };
        if (memorySwap !== memory) {
          const text = `MemorySwap ${memorySwap} statt ${memory} (Kernel ohne Swap-Accounting?) - begrenzt ist nur der RAM`;
          console.error(`[pruefcontainer] WARNUNG ${text}`);
          this.merkeFehler(text);
        }
      } catch { /* Diagnose best effort */ }
      console.error(`[pruefcontainer] bereit nach ${Date.now() - t0} ms (${container.id.slice(0, 12)}, ${this.cfg.image}): ${JSON.stringify(this.info.werkzeuge)}`);
      try { this.onInfo?.(this.info); } catch { /* Anmeldung best effort */ }
    } catch (err) {
      console.error(`[pruefcontainer] Start fehlgeschlagen: ${(err as Error).message}`);
      this.merkeFehler(`Start fehlgeschlagen: ${(err as Error).message}`);
      await this.stoppen('Start fehlgeschlagen').catch(() => {});
      throw err instanceof PruefContainerNichtVerfuegbar ? err : new PruefContainerNichtVerfuegbar(`Start fehlgeschlagen: ${(err as Error).message}`);
    }
  }

  private containerOptionen(): Docker.ContainerCreateOptions {
    const werkzeugTimeoutS = Math.max(1, Math.floor((this.cfg.timeoutMs || 5000) / 1000) - 1);
    return {
      name: this.cfg.name,
      Image: this.cfg.image,
      Labels: { 'synapse.pruefcontainer': '1' },
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      NetworkDisabled: true,
      User: '65532:65532',
      Env: [`PRUEF_PARALLEL=${this.cfg.parallel}`, `PRUEF_WERKZEUG_TIMEOUT_S=${werkzeugTimeoutS}`],
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': `size=${this.cfg.tmpfsMb}m,noexec,nosuid,nodev,mode=1777` },
        Memory: this.cfg.memMb * 1024 * 1024,
        MemorySwap: this.cfg.memMb * 1024 * 1024,
        NanoCpus: Math.round(this.cfg.cpus * 1e9),
        PidsLimit: this.cfg.pids,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        AutoRemove: false,
        RestartPolicy: { Name: 'no' },
      },
    };
  }

  /** Haengt sich an stdout/stderr des Containers und verteilt die JSON-Antworten an die offenen Auftraege. */
  private verbinde(stream: NodeJS.ReadWriteStream): void {
    this.stream = stream;
    const aus = new PassThrough();
    const err = new PassThrough();
    this.docker.modem.demuxStream(stream, aus, err);
    const decoder = new StringDecoder('utf8');
    let rest = '';
    aus.on('data', (chunk: Buffer) => {
      rest += decoder.write(chunk);
      let i: number;
      while ((i = rest.indexOf('\n')) >= 0) {
        const zeile = rest.slice(0, i).trim();
        rest = rest.slice(i + 1);
        if (zeile) this.antwort(zeile);
      }
    });
    err.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.error(`[pruefcontainer] stderr: ${text.slice(0, 500)}`);
    });
    const ende = (grund: string) => {
      if (this.stream !== stream) return;
      this.stream = null;
      const warBereit = this.zustandName === 'bereit';
      this.zustandName = 'aus';
      this.jvmWarm.clear();
      this.erstGeprueft.clear();
      if (!this.stoppend && warBereit) {
        this.z.abstuerze++;
        console.error(`[pruefcontainer] Verbindung beendet (${grund}) - naechster Auftrag startet neu`);
        this.merkeFehler(`Absturz/Verbindung beendet: ${grund}`);
      }
      this.alleAbweisen(`Pruef-Container beendet (${grund})`);
    };
    stream.on('end', () => ende('Stream-Ende'));
    stream.on('close', () => ende('Stream geschlossen'));
    stream.on('error', (e: Error) => ende(`Stream-Fehler: ${e.message}`));
  }

  private antwort(zeile: string): void {
    let msg: Antwort;
    try { msg = JSON.parse(zeile) as Antwort; } catch {
      console.error(`[pruefcontainer] keine JSON-Zeile: ${zeile.slice(0, 200)}`);
      return;
    }
    if (typeof msg.id !== 'number') return; // z. B. {"bereit":true}
    const o = this.offen.get(msg.id);
    if (!o) return;
    this.offen.delete(msg.id);
    if (o.timer) clearTimeout(o.timer);
    if (msg.ok) { this.timeoutsInFolge = 0; o.resolve(msg); }
    else {
      this.merkeFehler(`Auftrag abgelehnt: ${msg.fehler ?? 'unbekannter Fehler'}`);
      o.reject(new Error(`Pruef-Container: ${msg.fehler ?? 'unbekannter Fehler'}`));
    }
  }

  /** Schickt eine Nachricht und wartet auf die Antwort mit derselben id (limitMs 0 = ohne Limit). */
  private schicke(nachricht: Record<string, unknown>, limitMs: number, timeoutInfo?: { sprache: string; pfad: string }): Promise<unknown> {
    const stream = this.stream;
    if (!stream) return Promise.reject(new PruefContainerNichtVerfuegbar('keine Verbindung'));
    const id = this.naechsteId++;
    return new Promise((resolve, reject) => {
      const o: Offen = { resolve, reject, timer: null };
      if (limitMs > 0) {
        o.timer = setTimeout(() => {
          if (!this.offen.delete(id)) return;
          if (timeoutInfo) {
            this.z.timeouts++;
            this.timeoutsInFolge++;
            console.error(`[pruefcontainer] TIMEOUT nach ${limitMs} ms: ${timeoutInfo.sprache} ${timeoutInfo.pfad} (${this.timeoutsInFolge} in Folge)`);
            this.merkeFehler(`Timeout ${limitMs} ms: ${timeoutInfo.sprache} ${timeoutInfo.pfad}`);
            if (this.timeoutsInFolge >= MAX_TIMEOUTS_IN_FOLGE) {
              this.timeoutsInFolge = 0;
              void this.stoppen(`${MAX_TIMEOUTS_IN_FOLGE} Timeouts in Folge`);
            }
            reject(new PruefContainerTimeout(timeoutInfo.sprache, timeoutInfo.pfad, limitMs));
          } else {
            reject(new PruefContainerNichtVerfuegbar(`keine Antwort nach ${limitMs} ms`));
          }
        }, limitMs);
        o.timer.unref();
      }
      this.offen.set(id, o);
      try {
        stream.write(JSON.stringify({ id, ...nachricht }) + '\n');
      } catch (err) {
        this.offen.delete(id);
        if (o.timer) clearTimeout(o.timer);
        reject(new PruefContainerNichtVerfuegbar(`Schreiben fehlgeschlagen: ${(err as Error).message}`));
      }
    });
  }

  private alleAbweisen(grund: string): void {
    for (const [id, o] of this.offen) {
      this.offen.delete(id);
      if (o.timer) clearTimeout(o.timer);
      o.reject(new PruefContainerNichtVerfuegbar(grund));
    }
  }

  private async entferneContainer(): Promise<void> {
    try {
      await this.docker.getContainer(this.containerId ?? this.cfg.name).remove({ force: true });
    } catch { /* nicht vorhanden */ }
    if (this.containerId) {
      try { await this.docker.getContainer(this.cfg.name).remove({ force: true }); } catch { /* nicht vorhanden */ }
    }
    this.containerId = null;
  }

  /** Stoppt und entfernt den Container; offene Auftraege scheitern. Der naechste Auftrag startet neu. */
  async stoppen(grund: string): Promise<void> {
    this.stoppend = true;
    try {
      const s = this.stream;
      this.stream = null;
      if (this.zustandName === 'bereit') console.error(`[pruefcontainer] Stop: ${grund}`);
      this.zustandName = 'aus';
      this.jvmWarm.clear();
      this.erstGeprueft.clear();
      this.alleAbweisen(`Pruef-Container gestoppt (${grund})`);
      if (s) { try { s.end(); } catch { /* ignore */ } try { s.destroy?.(); } catch { /* ignore */ } }
      await this.entferneContainer();
    } finally {
      this.stoppend = false;
    }
  }

  /** P16-T16 E1: Zaehler der Build-Pruefung (Diagnose). */
  private buildZ = { auftraege: 0, fehler: 0, letzte_ms: null as number | null, letzter_status: null as string | null, budget_neustarts: 0 };

  /**
   * P16-T16 E1: projektweite TS-Build-Pruefung im selben Container (pruefer_tsbuild.py). Kein Ergebnis-Cache hier
   * (der liegt in core). Wirft PruefContainerNichtVerfuegbar, wenn der Container nicht pruefen kann.
   */
  async pruefeBuild(auftrag: BuildAuftrag): Promise<BuildLaufErgebnis> {
    if (Date.now() < this.pauseBis) throw new PruefContainerNichtVerfuegbar(`${this.pauseGrund} (Pause bis ${new Date(this.pauseBis).toISOString()})`);
    this.buildZ.auftraege++;
    this.letzteAktivitaet = Date.now();
    const t0 = Date.now();
    try {
      await this.bereitMachen();
      // Zeitlimit des Laufs plus Reserve fuer Dateien schreiben/aufraeumen; ohne timeoutInfo (kein Neustart-Zaehler).
      const antwort = await this.schicke({
        build: { dateien: auftrag.dateien, projekte: auftrag.projekte, zeitlimit_s: Math.max(1, Math.round(auftrag.zeitlimit_ms / 1000)), heap_mb: auftrag.heap_mb },
      }, auftrag.zeitlimit_ms + 30_000) as Antwort;
      this.letzteAktivitaet = Date.now();
      if (!antwort.build) throw new PruefContainerNichtVerfuegbar('Antwort ohne build (Image ohne Build-Pruefung? neu bauen: docker/synapse-pruefcontainer)');
      const ergebnis = { ...antwort.build, dauer_ms: antwort.build.dauer_ms || Date.now() - t0 };
      this.buildZ.letzte_ms = Date.now() - t0;
      this.buildZ.letzter_status = ergebnis.status;
      return ergebnis;
    } catch (err) {
      this.buildZ.fehler++;
      this.merkeFehler(`Build-Pruefung: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * P16-T16 E1: Speicher/tmpfs zur Laufzeit (code_check build_einstellungen). Bei Aenderung wird ein laufender Container
   * gestoppt (offene Auftraege scheitern), der naechste Auftrag startet ihn mit den neuen Grenzen. true = geaendert.
   */
  async setzeBudget(b: { speicher_mb?: number; tmpfs_mb?: number }): Promise<boolean> {
    const mem = typeof b.speicher_mb === 'number' && Number.isFinite(b.speicher_mb) ? Math.max(128, Math.round(b.speicher_mb)) : this.cfg.memMb;
    const tmp = typeof b.tmpfs_mb === 'number' && Number.isFinite(b.tmpfs_mb) ? Math.max(8, Math.round(b.tmpfs_mb)) : this.cfg.tmpfsMb;
    if (mem === this.cfg.memMb && tmp === this.cfg.tmpfsMb) return false;
    console.error(`[pruefcontainer] Speicherbudget ${this.cfg.memMb}/${this.cfg.tmpfsMb} MB -> ${mem}/${tmp} MB (Speicher/tmpfs), Container startet neu`);
    this.cfg.memMb = mem;
    this.cfg.tmpfsMb = tmp;
    this.buildZ.budget_neustarts++;
    if (this.zustandName !== 'aus' || this.stream) await this.stoppen('Speicherbudget geaendert');
    return true;
  }

  /** Werkzeugversionen aus dem letzten erfolgreichen Start (null = noch nie gestartet). */
  werkzeugInfo(): PruefContainerInfo | null {
    return this.info;
  }

  /**
   * Diagnose (intern status -> quellen.pruefcontainer). lage: laeuft | startet | kalt (aus, startet beim naechsten
   * Auftrag) | fehler (Pause nach Startfehlern/fehlendem Image, Auftraege sofort 'nicht verfuegbar').
   */
  zustand(): Record<string, unknown> {
    const pause = this.pauseBis > Date.now();
    const d = [...this.dauern].sort((a, b) => a - b);
    const q = (x: number) => (d.length ? d[Math.min(d.length - 1, Math.floor(d.length * x))] : null);
    return {
      lage: pause ? 'fehler' : this.zustandName === 'bereit' ? 'laeuft' : this.zustandName === 'startet' ? 'startet' : 'kalt',
      sprachen: CONTAINER_SPRACHEN.map((s) => s.sprache),
      latenz_ms: { anzahl: d.length, p50: q(0.5), p95: q(0.95), max: d.length ? d[d.length - 1] : null, letzter_start: this.letzterStartMs },
      letzte_fehler: [...this.letzteFehler].reverse(),
      speicher: this.speicher,
      kalt_budget_ms: this.cfg.kaltBudgetMs,
      // Erstpruefung: Sprachen, die seit dem Containerstart geantwortet haben (fuer die uebrigen gilt kalt_budget_ms).
      erst_geprueft: [...this.erstGeprueft],
      // E3b: JVM-Hilfsprozess im Container (Kotlin/Java). bereit = hat seit dem Containerstart geantwortet.
      jvm: { bereit: [...JVM_SPRACHEN].every((s) => this.jvmWarm.has(s)), warm: [...this.jvmWarm], kalt_budget_ms: this.cfg.jvmKaltBudgetMs, ...this.jvm, beim_start: (this.info as { jvm?: unknown } | null)?.jvm ?? null },
      zustand: this.zustandName,
      container: this.containerId?.slice(0, 12) ?? null,
      image: this.cfg.image,
      werkzeuge: this.info?.werkzeuge ?? null,
      offen: this.offen.size,
      cache: this.cache.size,
      pause_bis: this.pauseBis > Date.now() ? new Date(this.pauseBis).toISOString() : null,
      pause_grund: this.pauseBis > Date.now() ? this.pauseGrund : null,
      letzte_aktivitaet: new Date(this.letzteAktivitaet).toISOString(),
      limits: { mem_mb: this.cfg.memMb, cpus: this.cfg.cpus, pids: this.cfg.pids, tmpfs_mb: this.cfg.tmpfsMb, timeout_ms: this.cfg.timeoutMs, idle_min: this.cfg.idleMin },
      // P16-T16 E1: projektweite Build-Pruefung
      build: { ...this.buildZ, werkzeug: (this.info as { tsbuild?: unknown } | null)?.tsbuild ?? null },
      zaehler: { ...this.z },
    };
  }

  async beenden(): Promise<void> {
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    await this.stoppen('Herunterfahren');
  }
}

// ─── Anmeldung als Syntaxpruefer ─────────────────────────────────────────────

let instanz: PruefContainer | null = null;
/** Warum keine Container-Pruefer angemeldet sind (Diagnose); null = angemeldet bzw. noch nicht versucht. */
let anmeldeGrund: string | null = 'noch nicht angemeldet';

function versionAus(info: PruefContainerInfo | null, s: ContainerSprache): string {
  const roh = info?.werkzeuge?.[s.sprache];
  if (!roh) return `${s.werkzeug}@pruefcontainer`;
  // "rustfmt 1.9.0-stable (31fca3adb2 2026-06-26)" -> "rustfmt-1.9.0-stable"; "python-ast 3.14.8" -> "python-ast-3.14.8"
  return roh.split(' (')[0].trim().replace(/\s+/g, '-');
}

function melde(pc: PruefContainer): void {
  for (const s of CONTAINER_SPRACHEN) {
    registriereSyntaxPruefer({
      name: s.sprache,
      // Getter: die Werkzeugversion steht erst nach dem ersten Start fest; ein Befund entsteht immer erst danach.
      get version() { return versionAus(pc.werkzeugInfo(), s); },
      endungen: s.endungen,
      ...(s.dateinamen ? { dateinamen: s.dateinamen } : {}),
      sperrfaehig: s.sperrfaehig,
      pruefe: (inhalt, pfad) => pc.pruefe(s.sprache, inhalt, pfad),
      // E3a: Kaltstart abwarten statt Nachlieferung (PRUEFCONTAINER_KALT_BUDGET_MS); auch die erste Pruefung je Sprache.
      mindestBudgetMs: () => pc.mindestBudgetMs(s.sprache),
    });
  }
}

/**
 * Meldet die Container-Pruefer an (nur in der API, die den Container verwaltet). Rueckgabe: angemeldete Namen,
 * leer wenn ausgeschaltet, Docker nicht erreichbar oder das Image fehlt (dann je eine Logzeile, kein Fehler).
 * opt.docker/opt.cfg fuer Tests. opt.vorwaermen (Standard: PRUEFCONTAINER_VORWAERMEN != '0'): Container gleich im
 * Hintergrund starten. Der Zustand haengt als Quelle 'pruefcontainer' an intern(status), auch ohne Anmeldung (mit Grund).
 */
export async function registriereContainerSyntaxPruefer(opt: { docker?: Docker; cfg?: Partial<PruefContainerConfig>; takt?: boolean; vorwaermen?: boolean } = {}): Promise<string[]> {
  registriereInternQuelle('pruefcontainer', () => pruefContainerZustand() ?? { lage: 'nicht_angemeldet', grund: anmeldeGrund });
  if (process.env.SYNTAXPRUEFUNG === '0' || process.env.PRUEFCONTAINER === '0') {
    anmeldeGrund = 'ausgeschaltet (SYNTAXPRUEFUNG=0 oder PRUEFCONTAINER=0)';
    return [];
  }
  const cfg = { ...pruefContainerConfigAusEnv(), ...opt.cfg };
  const docker = opt.docker ?? new Docker({ socketPath: cfg.socketPath });
  try {
    await docker.ping();
  } catch (err) {
    anmeldeGrund = `Docker nicht erreichbar: ${(err as Error).message}`;
    console.error(`[pruefcontainer] Docker nicht erreichbar (${(err as Error).message}) - keine Container-Pruefer (${CONTAINER_SPRACHEN.map((s) => s.sprache).join(', ')})`);
    return [];
  }
  try {
    await docker.getImage(cfg.image).inspect();
  } catch {
    anmeldeGrund = `Image ${cfg.image} fehlt`;
    console.error(`[pruefcontainer] Image ${cfg.image} fehlt - keine Container-Pruefer. Bauen: docker build -t ${cfg.image} docker/synapse-pruefcontainer, danach API neu starten`);
    return [];
  }
  anmeldeGrund = null;
  if (instanz) await instanz.beenden().catch(() => {});
  // Rest eines frueheren API-Prozesses (kein SIGTERM-Abbau): weg damit, sonst liefe er ohne Idle-Stop weiter.
  await docker.getContainer(cfg.name).remove({ force: true }).catch(() => {});
  const pc = new PruefContainer(docker, cfg);
  melde(pc);
  // P16-T16 E1: Build-Pruefung ueber denselben Container; gespeichertes Budget vor dem ersten Start uebernehmen.
  registriereBuildPruefer({
    pruefe: (a) => pc.pruefeBuild(a),
    setzeBudget: (b) => pc.setzeBudget(b),
    budget: () => ({ speicher_mb: pc.cfg.memMb, tmpfs_mb: pc.cfg.tmpfsMb }),
  });
  registriereInternQuelle('build_pruefung', () => buildPruefungZustand());
  await synchronisiereBuildBudget(true).catch(() => false);
  if (opt.takt !== false) pc.starteTakt();
  instanz = pc;
  if (opt.vorwaermen ?? process.env.PRUEFCONTAINER_VORWAERMEN !== '0') pc.vorwaermen();
  return CONTAINER_SPRACHEN.map((s) => s.sprache);
}

/** Diagnose: Zustand des Pruef-Containers (null = nicht angemeldet). */
export function pruefContainerZustand(): Record<string, unknown> | null {
  return instanz ? instanz.zustand() : null;
}

/** Herunterfahren (SIGTERM, Tests). */
export async function beendePruefContainer(): Promise<void> {
  const p = instanz;
  instanz = null;
  registriereBuildPruefer(null);
  if (p) await p.beenden();
}
