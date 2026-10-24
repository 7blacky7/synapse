/**
 * P22-T117 (User 24.10.2026), korrigiert nach Abnahme 4bc05815: Modell-/CLI-Anbieter-Wechsel fuer Koordinatoren und alle
 * Plattform-Agenten (nicht Main; Main behaelt /api/main-agent/wechsel).
 * - Wer: User (Web-UI, nur interaktive Session), Main, Koordinator im eigenen Projekt (specialist runtime_modellwechsel, stdio+REST).
 * - KOSTEN/UMFANG (User-Entscheidung): nur Abo-Runtimes der CLI-Anbieter (claude, codex). API-Runtimes fuer Plattform-Agenten
 *   gibt es NICHT (api_runtime_nicht_verfuegbar) - auch nicht mit Kostenbestaetigung.
 * - Ausfuehrung: stop (falls laeuft, an die Wrapper-PID der Lage gebunden) -> Ende bestaetigt (Status nachgelesen) -> spawn mit dem
 *   letzten Spawn-Rezept, model/effort/target_runtime ersetzt. Erfolg nur, wenn beide Jobs FACHLICH erfolgreich waren
 *   (jobErfolgreich packt die MCP-Huelle aus) UND der neue Wrapper laeuft. Sonst bleibt die alte Modellangabe stehen.
 *   Je Identitaet hoechstens ein Wechsel gleichzeitig (wechsel_laeuft).
 * - AUSWEIS-MODELL (Korrektur 24.10.): Modell/CLI gehoeren zum LAUF auf der Plattform. Geschrieben wird erst NACH bestaetigtem
 *   Start (completeSpecialistJob -> merkeAusweisModellNachStart, auch Namens- und Batch-Starts), gebunden an die Laufgeneration
 *   (Wrapper-PID + Hash des Lauf-Nachweises, den der Container-Start als Header x-synapse-plattform-lauf in die MCP-Config des
 *   Laufs legt). Die Startabsicht steht getrennt unter startrezept.plattform_modell_absicht. chat(anmelden) zeigt das Modell
 *   NUR, wenn die Anmeldung diesen Nachweis traegt UND der Wrapper dieser Generation lebt (Socket unter .synapse/agent-runs/<id>/).
 *   Ausweis extern uebernommen (chatgpt.com, Desktop-CLI) -> kein Nachweis -> ausgeblendet, ohne Hinweistext.
 * SCHALTER: plattform_agent_modellwechsel (Produkt, je Projekt/global, Standard AUS, nur ausdruecklich).
 * AUDIT: agent_identitaet_audit aktion plattform_modellwechsel. DEBUG: jede Antwort traegt debug.
 */
import { createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import { enqueueSpecialistJob, waitForSpecialistJob, SPECIALIST_ZIEL_RUNTIMES } from './specialist-queue.js';
import { runtimeProjektPfad } from './runtime-daemon-zugang.js';
import { listWrapperStatus } from './wrapper-status.js';
import { leseRuntimeAgentenGrenzen } from './runtime-agenten-grenzen.js';
import { ladeSteuerZiel, pruefeSteuerRecht, jobErfolgreich, jobInhalt, wartenBisGestoppt, type SteuerAkteur } from './runtime-agenten-steuerung.js';

export const PLATTFORM_MODELLWECHSEL_FUNKTION = 'plattform_agent_modellwechsel' as const;
/** Abo-Runtimes (CLI-Login, keine API-Abrechnung). */
export const ABO_RUNTIMES = ['claude', 'codex'] as const;
/** Header/Env des Lauf-Nachweises (Container-Start legt ihn in die MCP-Config des Laufs). */
export const PLATTFORM_LAUF_HEADER = 'x-synapse-plattform-lauf' as const;
export const PLATTFORM_LAUF_ENV = 'SYNAPSE_PLATTFORM_LAUF' as const;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

export async function plattformModellwechselAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(PLATTFORM_MODELLWECHSEL_FUNKTION, project)).aktiv; } catch { return false; }
}

/** Abo (frei) vs. API (kostenpflichtig). Rein, testbar. */
export function kostenArt(runtime: string): 'abo' | 'api' {
  return (ABO_RUNTIMES as readonly string[]).includes(runtime) ? 'abo' : 'api';
}

/** Umfang (User-Entscheidung): Plattform-Agenten nur auf Abo-Runtimes. null = erlaubt. Rein, testbar. */
export function kostenEntscheidung(runtime: string): string | null {
  return kostenArt(runtime) === 'abo' ? null : 'api_runtime_nicht_verfuegbar';
}

/** Hash des Lauf-Nachweises (nie der Rohwert in PG). Rein. */
export function plattformLaufHash(nachweis: unknown): string | null {
  return typeof nachweis === 'string' && /^[a-f0-9]{32,128}$/.test(nachweis.trim()) ? createHash('sha256').update(nachweis.trim()).digest('hex') : null;
}

/** Echter Identitaets-Laufpfad (packages/agents agentLaufPfad: <home>/.synapse/agent-runs/<identity>/). Rein. */
export function istIdentitaetsLaufSocket(socket: string | null | undefined, identity_id: string): boolean {
  return typeof socket === 'string' && socket.includes('/.synapse/agent-runs/' + identity_id + '/');
}

export interface AusweisModell { modell: string | null; runtime: string | null; effort: string | null; start_ort: string | null; start_ziel: string | null; am: string | null; quelle: string | null;
  wrapper_pid?: number | null; lauf_hash?: string | null; job_id?: string | null }

function text(v: unknown, max = 128): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** startrezept.<schluessel> schreiben (plattform_modell = bestaetigter Lauf, plattform_modell_absicht = Startabsicht). Wirft nie. */
async function schreibeProfil(identity_id: string, schluessel: 'plattform_modell' | 'plattform_modell_absicht', eintrag: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await getPool().query(
      `UPDATE agent_identitaeten SET startrezept = jsonb_set(COALESCE(startrezept, '{}'::jsonb), $3::text[], $2::jsonb), profil_revision = profil_revision + 1
        WHERE id::text = $1 AND rolle <> 'main'`, [identity_id, JSON.stringify(eintrag), [schluessel]]);
    return (r.rowCount ?? 0) > 0;
  } catch { return false; }
}

function identitaetAusSpawnArgs(a: Record<string, unknown>, target?: string | null): string | null {
  const name = text(a?.name, 256);
  return text(target, 64) ?? text(a?.identity_id, 64) ?? (name?.startsWith('identity:') ? name.slice(9) : null);
}

/** Startabsicht (beim Enqueue eines Container-Spawns) - getrennt vom bestaetigten Laufmodell. Wirft nie. */
export async function merkeModellAbsicht(j: { project: string; action: string; args: Record<string, unknown>; target_identity_id?: string | null }): Promise<boolean> {
  try {
    if (j.action !== 'spawn' || !text(j.args?.target_runtime, 32)) return false;
    const id = identitaetAusSpawnArgs(j.args, j.target_identity_id) ?? (text(j.args.name, 256) ? await identitaetZuName(j.project, text(j.args.name, 256)!) : null);
    if (!id || !(await plattformModellwechselAktiv(j.project))) return false;
    const modell = text(j.args.model);
    if (!modell) return false;
    return schreibeProfil(id, 'plattform_modell_absicht', { modell, runtime: text(j.args.target_runtime, 32), effort: text(j.args.effort, 32), am: new Date().toISOString() });
  } catch { return false; }
}

/** Identitaet zu einem Namensstart (agent_id im Projekt, aktiv, eindeutig) - fuer normale Namens- und Batch-Starts. */
async function identitaetZuName(project: string, name: string): Promise<string | null> {
  if (name.startsWith('identity:')) return name.slice(9);
  try {
    const r = await getPool().query<{ id: string }>(
      "SELECT id::text AS id FROM agent_identitaeten WHERE project = $1 AND agent_id = $2 AND status = 'aktiv' AND rolle <> 'main'", [project, name]);
    return r.rows.length === 1 ? r.rows[0].id : null;
  } catch { return null; }
}

export interface BestaetigterStart { name: string | null; modell: string | null; effort: string | null; wrapper_pid: number | null; lauf_hash: string | null; identity_id: string | null }

/** Einzelne Starts aus einem abgeschlossenen spawn/spawn_batch-Job (nur fachlich erfolgreiche). Rein, testbar. */
export function bestaetigteStarts(action: string, args: Record<string, unknown>, result: unknown): BestaetigterStart[] {
  const einzel = (inhalt: Record<string, unknown> | null, spec: Record<string, unknown>): BestaetigterStart | null => {
    if (!inhalt || inhalt.success !== true) return null;
    const s = (inhalt.specialist ?? {}) as Record<string, unknown>;
    const pid = Number(s.wrapperPid);
    return { name: text(s.name, 256) ?? text(spec.name, 256), modell: text(s.model) ?? text(spec.model), effort: text(s.effort, 32) ?? text(spec.effort, 32),
      wrapper_pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, lauf_hash: text(s.plattform_lauf_hash, 128), identity_id: text(spec.identity_id, 64) };
  };
  if (action === 'spawn') { const e = einzel(jobInhalt(result), args); return e ? [e] : []; }
  if (action !== 'spawn_batch') return [];
  const r = jobInhalt(result);
  const liste = Array.isArray(r?.results) ? r!.results as unknown[] : [];
  const specs = Array.isArray(args.specialists) ? args.specialists as Array<Record<string, unknown>> : [];
  return liste.map((x, i) => einzel(jobInhalt(x), specs[i] ?? {})).filter((x): x is BestaetigterStart => !!x);
}

/**
 * Nach bestaetigtem Start (completeSpecialistJob, Status done): Modell an die Laufgeneration binden. Nur Container-Starts
 * (target_runtime), auch Namens-/Batch-Starts. Ohne Lauf-Nachweis/Wrapper-PID nichts. Wirft nie; Schalter AUS -> 0.
 */
export async function merkeAusweisModellNachStart(j: { id: string; project: string; action: string; args: Record<string, unknown>; target_identity_id: string | null; result: unknown }): Promise<number> {
  try {
    const rt = text(j.args?.target_runtime, 32);
    if (!rt || (j.action !== 'spawn' && j.action !== 'spawn_batch')) return 0;
    if (!(await plattformModellwechselAktiv(j.project))) return 0;
    let n = 0;
    for (const s of bestaetigteStarts(j.action, j.args ?? {}, j.result)) {
      const id = (j.action === 'spawn' ? identitaetAusSpawnArgs(j.args, j.target_identity_id) : s.identity_id) ?? (s.name ? await identitaetZuName(j.project, s.name) : null);
      if (!id || !s.modell || !s.wrapper_pid || !s.lauf_hash) continue;
      const eintrag: AusweisModell = { modell: s.modell, runtime: rt, effort: s.effort, start_ort: 'container', start_ziel: rt,
        am: new Date().toISOString(), quelle: 'spawn_bestaetigt', wrapper_pid: s.wrapper_pid, lauf_hash: s.lauf_hash, job_id: j.id };
      if (await schreibeProfil(id, 'plattform_modell', eintrag as unknown as Record<string, unknown>)) n++;
    }
    return n;
  } catch { return 0; }
}

/** Rein, testbar: Modell nur fuer den AKTUELLEN Plattform-Lauf (Nachweis + Generation + lebender Wrapper im Laufpfad). */
export function modellSichtbarFuerLauf(z: { identity_id: string; rolle: string; wrapper_status: string | null; wrapper_pid: number | null; socket_path: string | null; m: AusweisModell | null; lauf_hash: string | null }): boolean {
  if (z.rolle === 'main' || !z.m?.modell || !z.m.lauf_hash || !z.lauf_hash) return false;
  if (z.m.lauf_hash !== z.lauf_hash) return false;
  if (z.wrapper_status !== 'running' && z.wrapper_status !== 'idle') return false;
  if (!z.m.wrapper_pid || z.wrapper_pid !== z.m.wrapper_pid) return false;
  return istIdentitaetsLaufSocket(z.socket_path, z.identity_id);
}

/** Fuer chat(anmelden): Modell des Plattform-Laufs oder null (ausgeblendet, kein Hinweis). nachweis = Header/Env des Laufs. */
export async function ausweisModellFuerAnmeldung(identity_id: string, project: string, nachweis?: unknown): Promise<{ modell: AusweisModell } | null> {
  try {
    const lauf_hash = plattformLaufHash(nachweis);
    if (!lauf_hash || !(await plattformModellwechselAktiv(project))) return null;
    const r = await getPool().query<{ m: AusweisModell | null; rolle: string }>(
      "SELECT i.startrezept->'plattform_modell' AS m, i.rolle FROM agent_identitaeten i WHERE i.id::text = $1", [identity_id]);
    const z = r.rows[0];
    if (!z) return null;
    const w = (await listWrapperStatus(project)).find(x => x.identityId === identity_id && x.wrapperPid === (z.m?.wrapper_pid ?? -1)) ?? null;
    const sichtbar = modellSichtbarFuerLauf({ identity_id, rolle: z.rolle, m: z.m, lauf_hash, wrapper_status: w?.status ?? null, wrapper_pid: w?.wrapperPid ?? null, socket_path: w?.socketPath ?? null });
    if (!sichtbar) return null;
    const { lauf_hash: _h, ...m } = z.m!;
    return { modell: m };
  } catch { return null; }
}

async function fuehreJob(project: string, action: 'stop' | 'spawn', args: Record<string, unknown>, warteMs: number) {
  const job = await enqueueSpecialistJob({ project, action, args });
  const r = await waitForSpecialistJob(job.id, warteMs);
  return { job_id: job.id, status: r.status, result: r.result ?? null, error: r.error ?? null, message: r.message ?? null };
}

export interface ModellwechselEingabe { identity_id: unknown; runtime?: unknown; modell: unknown; effort?: unknown; grund: unknown }

const LAUFENDE_WECHSEL = new Set<string>();

/** Wechsel von Modell und/oder CLI-Anbieter eines Plattform-Agenten (Identitaet bleibt). */
export async function wechslePlattformAgentModell(e: ModellwechselEingabe, akteur: SteuerAkteur | null): Promise<Record<string, unknown>> {
  const z = await ladeSteuerZiel(String(e.identity_id ?? ''));
  if (!(await plattformModellwechselAktiv(z.project))) fehler('funktion_aus', { schalter: PLATTFORM_MODELLWECHSEL_FUNKTION, project: z.project });
  const wer = await pruefeSteuerRecht(akteur, z.project);
  const grund = typeof e.grund === 'string' ? e.grund.trim() : '';
  if (grund.length < 10) fehler('grund_fehlt', { min_zeichen: 10 });
  if (z.rolle === 'main') fehler('ziel_ist_main', { hinweis: 'Main wechselt ueber /api/main-agent/wechsel bzw. Runtime-Auftrag' });
  let modell = text(e.modell);
  if (!modell) fehler('modell_fehlt');
  const rezeptRow = await getPool().query<{ args: Record<string, unknown> }>(
    "SELECT args FROM specialist_jobs WHERE target_identity_id = $1 AND action = 'spawn' ORDER BY created_at DESC LIMIT 1", [z.identity_id]);
  const rezept = rezeptRow.rows[0]?.args;
  if (!rezept) fehler('kein_startrezept', { hinweis: 'kein frueherer Spawn-Job dieser Identitaet (nur Plattform-Agenten)' });
  const bisherRt = text(rezept.target_runtime, 32) ?? z.runtime;
  const runtime = text(e.runtime, 32) ?? bisherRt ?? 'claude';
  if (z.ort !== 'container' && !rezept.target_runtime && text(e.runtime, 32) && runtime !== (z.runtime ?? runtime)) fehler('runtime_wechsel_nur_container', { ort: z.ort });
  const kosten = kostenEntscheidung(runtime);
  if (kosten) fehler(kosten, { runtime, kosten_art: kostenArt(runtime), erlaubt: ABO_RUNTIMES, hinweis: 'Plattform-Agenten laufen nur auf Abo-Runtimes (User-Entscheidung)' });
  const imContainer = !!rezept.target_runtime || z.ort === 'container';
  if (imContainer && !(SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(runtime)) fehler('runtime_ungueltig', { erlaubt: SPECIALIST_ZIEL_RUNTIMES });
  const hm = await import('./hauptagent-modelle.js');
  const p = await hm.pruefeModellFuerRuntime(modell, runtime);
  if (!p.passt) fehler(p.grund?.startsWith('modellliste_fehlt') ? 'modellliste_fehlt' : (p.grund ?? 'modell_passt_nicht'), { modell, runtime, gelistet: p.gelistet });
  modell = p.modell;
  let effort = text(e.effort, 32);
  if (effort && p.quelle !== 'schalter_aus') {
    const pe = await hm.pruefeEffortFuerModell(runtime as typeof ABO_RUNTIMES[number], modell!, effort);
    if (!pe.ok) fehler(pe.grund ?? 'effort_ungueltig', { effort, modell, stufen: pe.stufen });
    effort = pe.effort;
  }
  if (LAUFENDE_WECHSEL.has(z.identity_id)) fehler('wechsel_laeuft', { identity_id: z.identity_id });
  LAUFENDE_WECHSEL.add(z.identity_id);
  try {
    return await fuehreWechselAus({ z, rezept, wer, grund, modell: modell!, runtime, effort, bisherRt, imContainer, pruefQuelle: p.quelle });
  } finally { LAUFENDE_WECHSEL.delete(z.identity_id); }
}

async function fuehreWechselAus(w: { z: Awaited<ReturnType<typeof ladeSteuerZiel>>; rezept: Record<string, unknown>; wer: string; grund: string; modell: string; runtime: string;
  effort: string | null; bisherRt: string | null; imContainer: boolean; pruefQuelle: unknown }): Promise<Record<string, unknown>> {
  const { z, rezept, wer, grund, modell, runtime, effort, imContainer } = w;
  const grenzen = await leseRuntimeAgentenGrenzen();
  const audit = { wer, grund, am: new Date().toISOString(), von: { modell: rezept.model ?? null, runtime: w.bisherRt }, nach: { modell, runtime, effort }, ort: z.ort, kosten_art: kostenArt(runtime) };
  const name = 'identity:' + z.identity_id;
  const schritte: Array<Record<string, unknown>> = [];
  let abbruch: string | null = null;
  const altPid = z.wrapper?.wrapperPid ?? null;
  const laeuft = z.wrapper?.status === 'running' || z.wrapper?.status === 'idle';
  if (laeuft) {
    const stopZiel = z.ort === 'container' && z.runtime ? { target_runtime: z.runtime, project_path: runtimeProjektPfad(z.project) }
      : rezept.target_hostname ? { target_hostname: rezept.target_hostname } : {};
    const j = await fuehreJob(z.project, 'stop', { name, ...stopZiel, ...(altPid ? { wrapper_pid: altPid } : {}), audit }, grenzen.job_warte_ms);
    schritte.push({ schritt: 'stop', ...j });
    if (!jobErfolgreich(j)) abbruch = 'stop_fehlgeschlagen';
    else {
      const nachher = await wartenBisGestoppt(z.identity_id, z.project);
      if (nachher && (nachher.status === 'running' || nachher.status === 'idle') && nachher.wrapperPid === altPid) abbruch = 'stop_nicht_bestaetigt';
    }
  } else schritte.push({ schritt: 'stop', uebersprungen: 'laeuft_nicht' });
  let neuPid: number | null = null;
  if (!abbruch) {
    const { audit: _a, effort: _e, ...rest } = rezept as Record<string, unknown>;
    const spawnArgs: Record<string, unknown> = { ...rest, name, identity_id: z.identity_id, model: modell, ...(effort ? { effort } : {}), audit };
    if (imContainer) { spawnArgs.target_runtime = runtime; spawnArgs.project_path = runtimeProjektPfad(z.project); delete spawnArgs.target_hostname; }
    const j = await fuehreJob(z.project, 'spawn', spawnArgs, grenzen.modellwechsel_spawn_warte_ms);
    schritte.push({ schritt: 'spawn', ...j });
    if (!jobErfolgreich(j)) abbruch = 'spawn_fehlgeschlagen';
    else {
      const s = (jobInhalt(j.result)?.specialist ?? {}) as Record<string, unknown>;
      const pid = Number(s.wrapperPid);
      const lebt = (await listWrapperStatus(z.project)).find(r => r.identityId === z.identity_id && (r.status === 'running' || r.status === 'idle'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || !lebt || lebt.wrapperPid !== pid) abbruch = 'start_nicht_bestaetigt';
      else neuPid = pid;
    }
  }
  const ok = !abbruch;
  // Erst nach bestaetigtem Start: modell_bestaetigt (plattform_modell schreibt completeSpecialistJob an die Laufgeneration).
  if (ok) await getPool().query('UPDATE agent_identitaeten SET modell_bestaetigt = $2 WHERE id::text = $1', [z.identity_id, modell]).catch(() => undefined);
  let auditiert = false;
  try {
    await getPool().query('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, neu, grund) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [z.identity_id, wer, 'plattform_modellwechsel', JSON.stringify({ ...audit, ok, abbruch, neu_wrapper_pid: neuPid, schritte: schritte.map(s => ({ schritt: s.schritt, status: s.status ?? null, job_id: s.job_id ?? null, uebersprungen: s.uebersprungen ?? null })) }), grund.slice(0, 500)]);
    auditiert = true;
  } catch { auditiert = false; }
  return { success: ok, ...(abbruch ? { error: abbruch } : {}), identity_id: z.identity_id, agent: z.agent_id, project: z.project, modell, runtime, effort, kosten_art: kostenArt(runtime), schritte,
    debug: { schalter: PLATTFORM_MODELLWECHSEL_FUNKTION, ort: z.ort, bisher: audit.von, wrapper_status: z.wrapper?.status ?? null, alt_wrapper_pid: altPid, neu_wrapper_pid: neuPid, modell_pruefung: w.pruefQuelle, grenzen_quelle: grenzen.quelle, auditiert } };
}
