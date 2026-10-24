/**
 * P22-T117 (User 24.10.2026): Modell-/CLI-Anbieter-Wechsel wie beim Main auch fuer Koordinatoren und alle Plattform-Agenten.
 * - Wer: User (Web-UI/Channel), Main, Koordinator im eigenen Projekt (Tool specialist runtime_modellwechsel).
 * - Ziel: Identitaets-Agent mit Rolle != main (Main behaelt seinen eigenen Weg /api/main-agent/wechsel).
 * - KOSTEN: Abo-Runtimes der CLI-Anbieter (claude, codex) frei waehlbar. Jede andere Runtime rechnet ueber API ab ->
 *   nur mit Rueckfrage beim User: Main/Koordinator bekommen kosten_rueckfrage_user, der User muss kosten_bestaetigt:true senden.
 * - Ausfuehrung wie Main-modellwechsel: stop (falls laeuft) + spawn mit dem letzten Spawn-Rezept derselben Identitaet,
 *   model/effort/target_runtime ersetzt -> Ausweis, Identitaet und Verlauf bleiben. Runtime-Wechsel nur im Container.
 * - Zusatz User (Korrektur 24.10.): Ausweise sind uebertragbar; Modell/CLI-Anbieter gehoeren zum LAUF auf der Plattform. Bei jedem
 *   Container-Start und Wechsel in startrezept.plattform_modell festhalten; chat(anmelden) liefert es NUR, wenn die Identitaet
 *   tatsaechlich auf der Plattform laeuft (start_ort container + lebender Wrapper unter /projects). Sonst (Ausweis extern
 *   uebernommen, z. B. chatgpt.com, Desktop-CLI) wird es ausgeblendet, ohne Hinweistext.
 * SCHALTER: plattform_agent_modellwechsel (Produkt, je Projekt/global, Standard AUS, nur ausdruecklich) - gilt fuer alles hier.
 * AUDIT: agent_identitaet_audit aktion plattform_modellwechsel. DEBUG: jede Antwort traegt debug.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import { enqueueSpecialistJob, waitForSpecialistJob, SPECIALIST_ZIEL_RUNTIMES } from './specialist-queue.js';
import { runtimeProjektPfad } from './runtime-daemon-zugang.js';
import { ladeSteuerZiel, pruefeSteuerRecht, type SteuerAkteur } from './runtime-agenten-steuerung.js';

export const PLATTFORM_MODELLWECHSEL_FUNKTION = 'plattform_agent_modellwechsel' as const;
/** Abo-Runtimes (CLI-Login, keine API-Abrechnung). */
export const ABO_RUNTIMES = ['claude', 'codex'] as const;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

export async function plattformModellwechselAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(PLATTFORM_MODELLWECHSEL_FUNKTION, project)).aktiv; } catch { return false; }
}

/** Abo (frei) vs. API (kostenpflichtig, Rueckfrage beim User). Rein, testbar. */
export function kostenArt(runtime: string): 'abo' | 'api' {
  return (ABO_RUNTIMES as readonly string[]).includes(runtime) ? 'abo' : 'api';
}

/** Kostenregel: Abo frei; API nur User mit kosten_bestaetigt. Liefert null (erlaubt) oder den Fehlercode. Rein, testbar. */
export function kostenEntscheidung(runtime: string, akteur: SteuerAkteur | null, kostenBestaetigt: boolean): string | null {
  if (kostenArt(runtime) === 'abo') return null;
  if (akteur?.art !== 'user') return 'kosten_rueckfrage_user';
  return kostenBestaetigt ? null : 'kosten_bestaetigung_fehlt';
}

export interface AusweisModell { modell: string | null; runtime: string | null; effort: string | null; start_ort: string | null; start_ziel: string | null; am: string | null; quelle: string | null }

function text(v: unknown, max = 128): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Modell/Runtime/Startort im Profil festhalten (startrezept.plattform_modell). Wirft nie; Schalter AUS -> false. */
export async function merkeAusweisModell(e: { identity_id: string; project: string; modell: unknown; runtime?: unknown; effort?: unknown; start_ort?: unknown; start_ziel?: unknown; quelle: string }): Promise<boolean> {
  try {
    if (!e.identity_id || !(await plattformModellwechselAktiv(e.project))) return false;
    const modell = text(e.modell);
    if (!modell) return false;
    const eintrag = { modell, runtime: text(e.runtime, 32), effort: text(e.effort, 32), start_ort: text(e.start_ort, 32), start_ziel: text(e.start_ziel, 200), am: new Date().toISOString(), quelle: e.quelle.slice(0, 80) };
    const r = await getPool().query(
      `UPDATE agent_identitaeten SET startrezept = jsonb_set(COALESCE(startrezept, '{}'::jsonb), '{plattform_modell}', $2::jsonb), profil_revision = profil_revision + 1
        WHERE id::text = $1 AND rolle <> 'main'`, [e.identity_id, JSON.stringify(eintrag)]);
    return (r.rowCount ?? 0) > 0;
  } catch { return false; }
}

/** Aus einem Spawn-Job (Plattform-Start) das Modell ins Profil uebernehmen. Wirft nie. */
export async function merkeAusweisModellAusJob(j: { project: string; action: string; args: Record<string, unknown> }): Promise<boolean> {
  if (j.action !== 'spawn') return false;
  const a = j.args ?? {};
  const name = text(a.name, 256);
  const id = text(a.identity_id, 64) ?? (name?.startsWith('identity:') ? name.slice(9) : null);
  if (!id) return false;
  const rt = text(a.target_runtime, 32);
  // Nur Plattform-Laeufe (Container); PC-/externe Starts fuehren kein Modell im Ausweis.
  if (!rt) return false;
  return merkeAusweisModell({ identity_id: id, project: j.project, modell: a.model, runtime: rt, effort: a.effort, start_ort: 'container', start_ziel: rt, quelle: 'spawn_job' });
}

/** Rein, testbar: Modell nur zeigen, wenn der Lauf auf der Plattform ist (Container-Startort + lebender Container-Wrapper). */
export function modellSichtbarFuerLauf(z: { rolle: string; start_ort: string | null; wrapper_status: string | null; socket_path: string | null; m: AusweisModell | null }): boolean {
  if (z.rolle === 'main' || !z.m?.modell) return false;
  if (z.start_ort !== 'container') return false;
  if (z.wrapper_status !== 'running' && z.wrapper_status !== 'idle') return false;
  return typeof z.socket_path === 'string' && z.socket_path.startsWith('/projects/');
}

/** Fuer chat(anmelden): Modell des Plattform-Laufs oder null (ausgeblendet, kein Hinweis). Schalter AUS/Lesefehler -> null. */
export async function ausweisModellFuerAnmeldung(identity_id: string, project: string): Promise<{ modell: AusweisModell } | null> {
  try {
    if (!(await plattformModellwechselAktiv(project))) return null;
    const r = await getPool().query<{ m: AusweisModell | null; rolle: string; start_ort: string | null; wrapper_status: string | null; socket_path: string | null }>(
      `SELECT i.startrezept->'plattform_modell' AS m, i.rolle, i.start_ort, w.status AS wrapper_status, w.socket_path
         FROM agent_identitaeten i LEFT JOIN LATERAL (SELECT status, socket_path FROM agent_identitaet_wrapper_status
           WHERE identity_id = i.id::text ORDER BY (status IN ('running','idle')) DESC LIMIT 1) w ON TRUE
        WHERE i.id::text = $1`, [identity_id]);
    const z = r.rows[0];
    return z && modellSichtbarFuerLauf(z) ? { modell: z.m! } : null;
  } catch { return null; }
}

async function fuehreJob(project: string, action: 'stop' | 'spawn', args: Record<string, unknown>, warteMs: number) {
  const job = await enqueueSpecialistJob({ project, action, args });
  const r = await waitForSpecialistJob(job.id, warteMs);
  return { job_id: job.id, status: r.status, error: r.error ?? null, message: r.message ?? null };
}

export interface ModellwechselEingabe { identity_id: unknown; runtime?: unknown; modell: unknown; effort?: unknown; grund: unknown; kosten_bestaetigt?: unknown }

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
  // Runtime-Wechsel nur im Container (am PC laeuft die CLI des Rechners; dort nur Modellwechsel).
  if (z.ort !== 'container' && !rezept.target_runtime && text(e.runtime, 32) && runtime !== (z.runtime ?? runtime)) fehler('runtime_wechsel_nur_container', { ort: z.ort });
  const kosten = kostenEntscheidung(runtime, akteur, e.kosten_bestaetigt === true);
  if (kosten) fehler(kosten, { runtime, kosten_art: kostenArt(runtime), hinweis: 'Kostenpflichtige Modelle ohne Abo nur nach Rueckfrage beim User' });
  const imContainer = !!rezept.target_runtime || z.ort === 'container';
  if (imContainer && !(SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(runtime)) fehler('runtime_ungueltig', { erlaubt: SPECIALIST_ZIEL_RUNTIMES });
  // Modell/Effort gegen die ausgelesene CLI-Liste (gleiche Pruefung wie beim Main, Schalter hauptagent_cli_modelle).
  const hm = await import('./hauptagent-modelle.js');
  const p = await hm.pruefeModellFuerRuntime(modell, runtime);
  if (!p.passt) fehler(p.grund?.startsWith('modellliste_fehlt') ? 'modellliste_fehlt' : (p.grund ?? 'modell_passt_nicht'), { modell, runtime, gelistet: p.gelistet });
  modell = p.modell;
  let effort = text(e.effort, 32);
  if (effort && (runtime === 'claude' || runtime === 'codex') && p.quelle !== 'schalter_aus') {
    const pe = await hm.pruefeEffortFuerModell(runtime, modell!, effort);
    if (!pe.ok) fehler(pe.grund ?? 'effort_ungueltig', { effort, modell, stufen: pe.stufen });
    effort = pe.effort;
  }
  const audit = { wer, grund, am: new Date().toISOString(), von: { modell: rezept.model ?? null, runtime: bisherRt }, nach: { modell, runtime, effort }, ort: z.ort, kosten_art: kostenArt(runtime) };
  const name = 'identity:' + z.identity_id;
  const schritte: Array<Record<string, unknown>> = [];
  const laeuft = z.wrapper?.status === 'running' || z.wrapper?.status === 'idle';
  if (laeuft) {
    const stopZiel = z.ort === 'container' && z.runtime ? { target_runtime: z.runtime, project_path: runtimeProjektPfad(z.project) }
      : rezept.target_hostname ? { target_hostname: rezept.target_hostname } : {};
    schritte.push({ schritt: 'stop', ...(await fuehreJob(z.project, 'stop', { name, ...stopZiel, audit }, 20_000)) });
  } else schritte.push({ schritt: 'stop', uebersprungen: 'laeuft_nicht' });
  const stopOk = schritte[0].uebersprungen || schritte[0].status === 'done';
  if (stopOk) {
    const { audit: _a, effort: _e, ...rest } = rezept as Record<string, unknown>;
    const spawnArgs: Record<string, unknown> = { ...rest, name, identity_id: z.identity_id, model: modell, ...(effort ? { effort } : {}), audit };
    if (imContainer) { spawnArgs.target_runtime = runtime; spawnArgs.project_path = runtimeProjektPfad(z.project); delete spawnArgs.target_hostname; }
    schritte.push({ schritt: 'spawn', ...(await fuehreJob(z.project, 'spawn', spawnArgs, 90_000)) });
  }
  const ok = stopOk && schritte[1]?.status === 'done';
  if (ok) {
    await getPool().query('UPDATE agent_identitaeten SET modell_bestaetigt = $2 WHERE id::text = $1', [z.identity_id, modell]).catch(() => undefined);
    await merkeAusweisModell({ identity_id: z.identity_id, project: z.project, modell, runtime, effort, start_ort: imContainer ? 'container' : 'daemon',
      start_ziel: imContainer ? runtime : text(rezept.target_hostname, 200), quelle: 'modellwechsel' });
  }
  let auditiert = false;
  try {
    await getPool().query('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, neu, grund) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [z.identity_id, wer, 'plattform_modellwechsel', JSON.stringify({ ...audit, ok, schritte: schritte.map(s => ({ schritt: s.schritt, status: s.status ?? null, job_id: s.job_id ?? null })) }), grund.slice(0, 500)]);
    auditiert = true;
  } catch { auditiert = false; }
  return { success: ok, identity_id: z.identity_id, agent: z.agent_id, project: z.project, modell, runtime, effort, kosten_art: kostenArt(runtime), schritte,
    debug: { schalter: PLATTFORM_MODELLWECHSEL_FUNKTION, ort: z.ort, bisher: audit.von, wrapper_status: z.wrapper?.status ?? null, modell_pruefung: p.quelle, auditiert } };
}
