/**
 * P22-T61: Modelllisten der CLI-Container (synapse-runtime-claude / -codex) AUSLESEN statt fester Listen.
 * Weg: derselbe docker exec wie Status/Version (captureRuntimeProbe, Watchdog im Container). Ein kleines node-Skript im
 * Container liest NUR die Modellquellen und gibt eine knappe Auswahl der Felder aus - nie Konten-/Identitaetsfelder
 * (models_cache.json 'identity'/'etag', Login-Dateien bleiben ungelesen).
 *   claude: Modellkatalog der CLI (~/.claude/cache/model-catalog/*.json, catalog.surface 'cc'; staleAt wird angezeigt,
 *           nicht verworfen). Claude Code bietet keine Abfrage-Schnittstelle fuer die Liste.
 *   codex:  zuerst die CLI selbst ('codex app-server', JSON-RPC model/list), Rueckfall models_cache.json. Meldet die CLI
 *           Fehler beim Laden/Erneuern ihres Caches, steht das als Hinweis dabei: dann liefert die CLI ihre eingebaute Liste.
 * Kein Rueckfall auf feste Listen: ohne Quelle -> modelle leer + grund.
 * Reines Lesen/Anzeigen ohne Wirkung auf Spawn oder Wechsel, deshalb kein Produkt-Schalter; Diagnose steht in
 * quelle/quelle_detail/hinweise/grund der Antwort.
 */
import type Docker from 'dockerode';
import { captureRuntimeProbe } from './probe.js';
import { istAgentRuntimeImage, AGENT_RUNTIME_IMAGE_LABEL } from './runtime-container-spez.js';
import type { RuntimeConfiguration } from './types.js';

export interface CliModell {
  id: string;
  name: string;
  beschreibung: string | null;
  standard_effort: string | null;
  effort_stufen: string[];
  kontext_ein: number | null;
  kontext_aus: number | null;
  sichtbar: boolean;
  /** claude: section (main/overflow); codex: null. */
  gruppe: string | null;
  /** codex: von der CLI als Standard markiert. */
  standard: boolean;
}

export interface CliModellListe {
  runtime: 'claude' | 'codex';
  quelle: 'cli' | 'datei' | null;
  quelle_detail: string | null;
  /** Zeitpunkt, zu dem die CLI die Liste geholt hat (fetchedAt), ISO. */
  stand: string | null;
  /** claude: staleAt des Katalogs (ISO); liegt er in der Vergangenheit, steht ein Hinweis dabei. */
  veraltet_ab: string | null;
  cli_version: string | null;
  modelle: CliModell[];
  hinweise: string[];
  /** Gesetzt, wenn keine Liste gelesen werden konnte (Container aus, Datei fehlt, ...). */
  grund: string | null;
  abgefragt_am: string;
}

/** Skript fuer 'node -e' im Container; argv[1] = runtime. Ausgabe: genau eine JSON-Zeile. */
export const CLI_MODELLE_SKRIPT = [
  "const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');",
  "const runtime = process.argv[1];",
  "const kurz = (e) => String((e && e.message) || e).slice(0, 300);",
  "const version = (bin) => { try { return cp.execFileSync(bin, ['--version'], { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 200) || null; } catch { return null; } };",
  "const aus = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };",
  "function claude() {",
  "  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cache', 'model-catalog');",
  "  const r = { runtime, cli_version: version('claude'), katalog: null, fehler: null, verzeichnis: dir };",
  "  let dateien = [];",
  "  try { dateien = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('published-')); } catch (e) { r.fehler = 'verzeichnis_fehlt: ' + kurz(e); return r; }",
  "  let best = null;",
  "  for (const f of dateien) {",
  "    try {",
  "      const k = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));",
  "      if (!k || !k.catalog || k.catalog.surface !== 'cc' || !k.catalog.config || !Array.isArray(k.catalog.config.models)) continue;",
  "      if (!best || Number(k.fetchedAt) > Number(best.k.fetchedAt)) best = { f, k };",
  "    } catch {}",
  "  }",
  "  if (!best) { r.fehler = 'kein_katalog_cc'; return r; }",
  "  r.katalog = { datei: best.f, version: best.k.version ?? null, fetchedAt: best.k.fetchedAt ?? null, staleAt: best.k.staleAt ?? null,",
  "    models: best.k.catalog.config.models.map((m) => ({ id: m.id, name: m.name, short_name: m.short_name, description: m.description, section: m.section,",
  "      effort_options: ((m.thinking && m.thinking.effort_options) || []).map((o) => o && o.id).filter(Boolean),",
  "      runtime: m.runtime ? { max_input_tokens: m.runtime.max_input_tokens, max_output_tokens: m.runtime.max_output_tokens, effort_levels: m.runtime.effort_levels, default_effort: m.runtime.default_effort } : null,",
  "      min_claude_code_version: m.min_claude_code_version })) };",
  "  return r;",
  "}",
  "function codexCache() {",
  "  const datei = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');",
  "  try {",
  "    const c = JSON.parse(fs.readFileSync(datei, 'utf8'));",
  "    return { datei, fetched_at: c.fetched_at ?? null, client_version: c.client_version ?? null, fehler: null,",
  "      models: (Array.isArray(c.models) ? c.models : []).map((m) => ({ slug: m.slug, display_name: m.display_name, description: m.description,",
  "        default_reasoning_level: m.default_reasoning_level, efforts: (m.supported_reasoning_levels || []).map((x) => x && x.effort).filter(Boolean),",
  "        visibility: m.visibility, priority: m.priority, context_window: m.context_window, max_context_window: m.max_context_window })) };",
  "  } catch (e) { return { datei, fehler: kurz(e), models: [] }; }",
  "}",
  "function codexCli(fertig) {",
  "  const r = { ok: false, data: [], fehler: null, cli_meldungen: [] };",
  "  let p; try { p = cp.spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { r.fehler = kurz(e); return fertig(r); }",
  "  let buf = '', err = '', ende = false;",
  "  const schluss = (fehler) => { if (ende) return; ende = true; clearTimeout(t); if (fehler) r.fehler = fehler;",
  "    r.cli_meldungen = err.replace(/\\u001b\\[[0-9;]*m/g, '').split('\\n').filter((z) => /models (cache|response)|available models/i.test(z)).map((z) => z.slice(0, 300)).slice(0, 5);",
  "    try { p.kill('SIGTERM'); } catch {} fertig(r); };",
  "  const t = setTimeout(() => schluss('zeitlimit'), 15000);",
  "  const senden = (o) => { try { p.stdin.write(JSON.stringify(o) + '\\n'); } catch {} };",
  "  let seite = 0;",
  "  p.on('error', (e) => schluss(kurz(e)));",
  "  p.on('exit', (code) => schluss('app-server beendet (' + code + ')'));",
  "  p.stderr.on('data', (c) => { if (err.length < 20000) err += c; });",
  "  p.stdout.on('data', (c) => {",
  "    buf += c; let i;",
  "    while ((i = buf.indexOf('\\n')) >= 0) {",
  "      const zeile = buf.slice(0, i); buf = buf.slice(i + 1);",
  "      let m; try { m = JSON.parse(zeile); } catch { continue; }",
  "      if (m.id === 0) {",
  "        if (m.error) return schluss('initialize: ' + kurz(m.error.message || JSON.stringify(m.error)));",
  "        senden({ method: 'initialized' });",
  "        senden({ method: 'model/list', id: 1, params: {} });",
  "      } else if (typeof m.id === 'number' && m.id >= 1) {",
  "        if (m.error) return schluss('model/list: ' + kurz(m.error.message || JSON.stringify(m.error)));",
  "        const d = (m.result && Array.isArray(m.result.data)) ? m.result.data : [];",
  "        for (const x of d) r.data.push({ id: x.id, model: x.model, displayName: x.displayName, description: x.description, hidden: x.hidden,",
  "          efforts: (x.supportedReasoningEfforts || []).map((e) => e && e.reasoningEffort).filter(Boolean), defaultReasoningEffort: x.defaultReasoningEffort, isDefault: x.isDefault });",
  "        const weiter = m.result && m.result.nextCursor;",
  "        if (weiter && ++seite < 10) senden({ method: 'model/list', id: seite + 1, params: { cursor: weiter } });",
  "        else { r.ok = true; return schluss(null); }",
  "      }",
  "    }",
  "  });",
  "  senden({ method: 'initialize', id: 0, params: { clientInfo: { name: 'synapse_modelle', title: 'Synapse', version: '1' } } });",
  "}",
  "if (runtime === 'claude') aus(claude());",
  "else if (runtime === 'codex') { const cache = codexCache(); const cli_version = version('codex'); codexCli((cli) => aus({ runtime, cli_version, cli, cache })); }",
  "else aus({ runtime, fehler: 'runtime_unbekannt' });",
].join('\n');

const zahlOderNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const textOderNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const textListe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
const isoOderNull = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Date.parse(String(v)));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function leer(runtime: 'claude' | 'codex', grund: string, jetzt: Date, extra: Partial<CliModellListe> = {}): CliModellListe {
  return {
    runtime, quelle: null, quelle_detail: null, stand: null, veraltet_ab: null, cli_version: null, modelle: [], hinweise: [], grund,
    abgefragt_am: jetzt.toISOString(), ...extra,
  };
}

/** Rohausgabe des Skripts (runtime claude) -> normalisierte Liste. Exportiert fuer Tests. */
export function normalisiereClaudeModelle(roh: Record<string, unknown>, jetzt = new Date()): CliModellListe {
  const cliVersion = textOderNull(roh.cli_version);
  const katalog = roh.katalog as Record<string, unknown> | null | undefined;
  if (!katalog || !Array.isArray(katalog.models)) {
    return leer('claude', textOderNull(roh.fehler) ?? 'kein_katalog', jetzt, { cli_version: cliVersion });
  }
  const modelle: CliModell[] = [];
  for (const m of katalog.models as Array<Record<string, unknown>>) {
    const id = textOderNull(m?.id);
    if (!id) continue;
    const rt = (m.runtime ?? {}) as Record<string, unknown>;
    const stufen = textListe(rt.effort_levels);
    modelle.push({
      id, name: textOderNull(m.name) ?? id, beschreibung: textOderNull(m.description),
      standard_effort: textOderNull(rt.default_effort), effort_stufen: stufen.length ? stufen : textListe(m.effort_options),
      kontext_ein: zahlOderNull(rt.max_input_tokens), kontext_aus: zahlOderNull(rt.max_output_tokens),
      sichtbar: true, gruppe: textOderNull(m.section), standard: false,
    });
  }
  const veraltetAb = isoOderNull(katalog.staleAt);
  const hinweise: string[] = [];
  if (veraltetAb && Date.parse(veraltetAb) < jetzt.getTime()) {
    hinweise.push('Katalog veraltet seit ' + veraltetAb + ' (die CLI erneuert ihn beim naechsten Lauf); angezeigt wird der letzte Stand.');
  }
  return {
    runtime: 'claude', quelle: 'datei', quelle_detail: 'model-catalog/' + String(katalog.datei ?? '?'),
    stand: isoOderNull(katalog.fetchedAt), veraltet_ab: veraltetAb, cli_version: cliVersion, modelle, hinweise,
    grund: modelle.length ? null : 'katalog_ohne_modelle', abgefragt_am: jetzt.toISOString(),
  };
}

/** Rohausgabe des Skripts (runtime codex) -> normalisierte Liste; CLI vor Cache-Datei. Exportiert fuer Tests. */
export function normalisiereCodexModelle(roh: Record<string, unknown>, jetzt = new Date()): CliModellListe {
  const cliVersion = textOderNull(roh.cli_version);
  const cli = (roh.cli ?? {}) as Record<string, unknown>;
  const cache = (roh.cache ?? {}) as Record<string, unknown>;
  const cacheModelle = Array.isArray(cache.models) ? cache.models as Array<Record<string, unknown>> : [];
  const kontextJeSlug = new Map<string, number | null>();
  for (const m of cacheModelle) if (typeof m?.slug === 'string') kontextJeSlug.set(m.slug, zahlOderNull(m.context_window));
  const hinweise: string[] = [];
  const meldungen = textListe(cli.cli_meldungen);
  const cliDaten = Array.isArray(cli.data) ? cli.data as Array<Record<string, unknown>> : [];
  const stand = isoOderNull(cache.fetched_at);

  if (cli.ok === true && cliDaten.length > 0) {
    if (meldungen.length) {
      hinweise.push('Die CLI meldet Fehler beim Laden/Erneuern ihres Modell-Caches und liefert dann ihre eingebaute Liste (CLI-Version pruefen): ' + meldungen.join(' | '));
    }
    const cacheVersion = textOderNull(cache.client_version);
    if (cacheVersion && cliVersion && !cliVersion.includes(cacheVersion)) {
      hinweise.push('models_cache.json stammt von CLI ' + cacheVersion + ', installiert ist ' + cliVersion + '.');
    }
    const modelle: CliModell[] = [];
    for (const m of cliDaten) {
      const id = textOderNull(m?.model) ?? textOderNull(m?.id);
      if (!id) continue;
      modelle.push({
        id, name: textOderNull(m.displayName) ?? id, beschreibung: textOderNull(m.description),
        standard_effort: textOderNull(m.defaultReasoningEffort), effort_stufen: textListe(m.efforts),
        kontext_ein: kontextJeSlug.get(id) ?? null, kontext_aus: null, sichtbar: m.hidden !== true, gruppe: null, standard: m.isDefault === true,
      });
    }
    return {
      runtime: 'codex', quelle: 'cli', quelle_detail: 'codex app-server model/list', stand: meldungen.length ? null : stand,
      veraltet_ab: null, cli_version: cliVersion, modelle, hinweise, grund: null, abgefragt_am: jetzt.toISOString(),
    };
  }

  const cliFehler = textOderNull(cli.fehler) ?? (cli.ok === true ? 'cli_liste_leer' : 'cli_ohne_antwort');
  if (cacheModelle.length > 0) {
    hinweise.push('CLI-Abfrage (codex app-server model/list) fehlgeschlagen: ' + cliFehler + '; Liste aus models_cache.json.');
    const sortiert = [...cacheModelle].sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
    const modelle: CliModell[] = [];
    for (const m of sortiert) {
      const id = textOderNull(m?.slug);
      if (!id) continue;
      modelle.push({
        id, name: textOderNull(m.display_name) ?? id, beschreibung: textOderNull(m.description),
        standard_effort: textOderNull(m.default_reasoning_level), effort_stufen: textListe(m.efforts),
        kontext_ein: zahlOderNull(m.context_window), kontext_aus: null, sichtbar: m.visibility !== 'hide', gruppe: null, standard: false,
      });
    }
    return {
      runtime: 'codex', quelle: 'datei', quelle_detail: 'models_cache.json', stand, veraltet_ab: null, cli_version: cliVersion,
      modelle, hinweise, grund: null, abgefragt_am: jetzt.toISOString(),
    };
  }
  const cacheFehler = textOderNull(cache.fehler);
  return leer('codex', 'cli: ' + cliFehler + (cacheFehler ? '; models_cache.json: ' + cacheFehler : '; models_cache.json leer'), jetzt, { cli_version: cliVersion });
}

/** Liest die Modellliste im eigenen, laufenden Container (Agent-Runtime- oder Basis-Image mit node). */
export async function leseCliModelleImContainer(
  docker: Docker, config: RuntimeConfiguration | null, runtime: 'claude' | 'codex',
  o: { env: string[]; istEigener: (info: Docker.ContainerInspectInfo) => boolean; timeout_ms?: number; jetzt?: () => Date },
): Promise<CliModellListe> {
  const jetzt = (o.jetzt ?? (() => new Date()))();
  if (!config) return leer(runtime, 'nicht_konfiguriert', jetzt);
  const container = docker.getContainer(config.containerName);
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch (error) {
    const text = (error as Error)?.message ?? String(error);
    return leer(runtime, /no such container/i.test(text) ? 'container_fehlt' : 'container_fehler: ' + text.slice(0, 200), jetzt);
  }
  if (!o.istEigener(info)) return leer(runtime, 'fremder_container', jetzt);
  if (!info.State?.Running) return leer(runtime, 'container_laeuft_nicht', jetzt);
  let r: { stdout: string; stderr: string; exitCode: number | null };
  try {
    r = await captureRuntimeProbe(docker, container, ['/usr/local/bin/node', '-e', CLI_MODELLE_SKRIPT, runtime], o.env, o.timeout_ms ?? 30_000);
  } catch (error) {
    return leer(runtime, 'abfrage_fehlgeschlagen: ' + ((error as Error)?.message ?? String(error)).slice(0, 200), jetzt);
  }
  const zeile = r.stdout.split('\n').map((z) => z.trim()).filter(Boolean).at(-1) ?? '';
  let roh: Record<string, unknown> | null = null;
  try { roh = JSON.parse(zeile) as Record<string, unknown>; } catch { roh = null; }
  if (!roh) return leer(runtime, 'abfrage_ohne_ergebnis (Exit ' + String(r.exitCode) + ')' + (r.stderr ? ': ' + r.stderr.slice(-200) : ''), jetzt);
  const liste = runtime === 'claude' ? normalisiereClaudeModelle(roh, jetzt) : normalisiereCodexModelle(roh, jetzt);
  const agentImage = info.Config?.Labels?.['synapse.runtime-image'] === AGENT_RUNTIME_IMAGE_LABEL || istAgentRuntimeImage(info.Config?.Image);
  if (!agentImage) liste.hinweise.push('Container laeuft ohne Agent-Runtime-Image (' + String(info.Config?.Image ?? '?') + ').');
  return liste;
}
