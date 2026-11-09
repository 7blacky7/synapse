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
 * P22-T326: modellwechsel_rezept_erzeugen (Std AUS) - Rezept erzeugen, externen Lauf nur mit Bestaetigung abloesen, Rueckfall.
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

/** P22-T119: Schalter modell_lauf_bindung (Produkt, Std AUS). Wirft nie. */
export const MODELL_LAUF_BINDUNG_FUNKTION = 'modell_lauf_bindung' as const;
export async function modellLaufBindungAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(MODELL_LAUF_BINDUNG_FUNKTION, project)).aktiv; } catch { return false; }
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
  wrapper_pid?: number | null; lauf_hash?: string | null; job_id?: string | null; job_erstellt?: string | null }

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

type LaufQuery = (sql: string, params: unknown[]) => Promise<{ rowCount?: number | null }>;

/**
 * P22-T119 R1c (Befund rea4 1d85243c): modell_bestaetigt nach Plattform-Modellwechsel. Schalter modell_lauf_bindung EIN ->
 * nur ueber bindeModellAnLauf (CAS auf genau den neu gestarteten Lauf: Spawn-Job + PID + Laufhash + Modell); ohne
 * vollstaendigen Laufnachweis nichts schreiben. AUS -> exakt Bestand (ungebundenes UPDATE). query injizierbar. Wirft nie.
 */
export async function bestaetigeWechselModell(bindung: boolean, identity_id: string, modell: string,
  lauf: { job_id: string | null; wrapper_pid: number | null; lauf_hash: string | null } | null,
  query: LaufQuery = (sql, p) => getPool().query(sql, p)): Promise<{ gesetzt: boolean; grund: string }> {
  if (!bindung) {
    try {
      const r = await query('UPDATE agent_identitaeten SET modell_bestaetigt = $2 WHERE id::text = $1', [identity_id, modell]);
      return { gesetzt: (r.rowCount ?? 0) > 0, grund: 'schalter_aus_bestand' };
    } catch { return { gesetzt: false, grund: 'fehler' }; }
  }
  if (!lauf?.job_id || !lauf.wrapper_pid || !lauf.lauf_hash) {
    console.debug('[modell-lauf-bindung] Modellwechsel ohne Laufnachweis, modell_bestaetigt nicht gesetzt', { identity_id, modell, lauf });
    return { gesetzt: false, grund: 'kein_laufnachweis' };
  }
  return bindeModellAnLauf(identity_id, { modell, job_id: lauf.job_id, wrapper_pid: lauf.wrapper_pid, lauf_hash: lauf.lauf_hash }, query);
}

/** Laufgeneration = Anlagezeit des Start-Jobs (specialist_jobs.created_at, UTC mit Mikrosekunden). null bei Fehler. */
async function jobGeneration(job_id: string): Promise<string | null> {
  try {
    const r = await getPool().query<{ g: string | null }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS g FROM specialist_jobs WHERE id::text = $1`, [job_id]);
    return r.rows[0]?.g ?? null;
  } catch { return null; }
}

/**
 * P22-T119 R1b: Laufprofil startrezept.plattform_modell atomar per CAS ueber die Laufgeneration schreiben. Greift nur, wenn
 * der vorhandene Eintrag keine Generation hat (Altbestand), derselbe Job ist oder eine aeltere/gleiche Generation traegt.
 * Ein spaeter Abschluss eines AELTEREN Jobs (A) ueberschreibt so nie das Profil eines neueren Laufs (B); Debug-Meldung.
 * query injizierbar fuer den PG-Test. Wirft nie.
 */
export async function schreibeLaufProfil(identity_id: string, eintrag: AusweisModell & { job_id: string; job_erstellt: string },
  query: LaufQuery = (sql, p) => getPool().query(sql, p)): Promise<{ geschrieben: boolean; grund: 'geschrieben' | 'neuerer_lauf_vorhanden' | 'fehler' }> {
  try {
    const r = await query(`UPDATE agent_identitaeten SET startrezept = jsonb_set(COALESCE(startrezept, '{}'::jsonb), '{plattform_modell}', $2::jsonb),
        profil_revision = profil_revision + 1
      WHERE id::text = $1 AND rolle <> 'main' AND (
        startrezept->'plattform_modell'->>'job_erstellt' IS NULL
        OR startrezept->'plattform_modell'->>'job_id' = $3
        OR (startrezept->'plattform_modell'->>'job_erstellt')::timestamptz <= $4::timestamptz)`,
      [identity_id, JSON.stringify(eintrag), eintrag.job_id, eintrag.job_erstellt]);
    if ((r.rowCount ?? 0) > 0) return { geschrieben: true, grund: 'geschrieben' };
    console.debug('[modell-lauf-bindung] Laufprofil nicht geschrieben: neuerer Lauf vorhanden', { identity_id, job_id: eintrag.job_id, job_erstellt: eintrag.job_erstellt, wrapper_pid: eintrag.wrapper_pid });
    return { geschrieben: false, grund: 'neuerer_lauf_vorhanden' };
  } catch (err) {
    console.error('[modell-lauf-bindung] Laufprofil nicht geschrieben:', (err as Error)?.message ?? err);
    return { geschrieben: false, grund: 'fehler' };
  }
}

/**
 * P22-T119 R1 (Befund 0c19c24c): modell_bestaetigt atomar per CAS an genau diesen Lauf binden. Ein einziges UPDATE, das nur
 * greift, wenn startrezept.plattform_modell noch GENAU dieser Lauf ist (job_id + wrapper_pid + lauf_hash + modell). Ein
 * aelterer Abschluss, der nach einem neueren bestaetigten Lauf ankommt, schreibt nichts (auch kein gesetzt-Flag) und meldet
 * das im Debug. query injizierbar fuer den PG-Test. Wirft nie.
 */
export async function bindeModellAnLauf(identity_id: string, lauf: { modell: string; job_id: string; wrapper_pid: number; lauf_hash: string },
  query: LaufQuery = (sql, p) => getPool().query(sql, p)): Promise<{ gesetzt: boolean; grund: 'gebunden' | 'lauf_nicht_mehr_aktuell' | 'fehler' }> {
  try {
    const r = await query(`UPDATE agent_identitaeten SET modell_bestaetigt = $2,
        startrezept = jsonb_set(startrezept, '{plattform_modell,modell_bestaetigt_gesetzt}', 'true'::jsonb)
      WHERE id::text = $1 AND rolle <> 'main'
        AND startrezept->'plattform_modell'->>'job_id' = $3
        AND startrezept->'plattform_modell'->>'wrapper_pid' = $4
        AND startrezept->'plattform_modell'->>'lauf_hash' = $5
        AND startrezept->'plattform_modell'->>'modell' = $2`,
      [identity_id, lauf.modell, lauf.job_id, String(lauf.wrapper_pid), lauf.lauf_hash]);
    if ((r.rowCount ?? 0) > 0) return { gesetzt: true, grund: 'gebunden' };
    console.debug('[modell-lauf-bindung] uebersprungen: Lauf nicht mehr aktuell', { identity_id, job_id: lauf.job_id, wrapper_pid: lauf.wrapper_pid, modell: lauf.modell });
    return { gesetzt: false, grund: 'lauf_nicht_mehr_aktuell' };
  } catch (err) {
    console.error('[modell-lauf-bindung] modell_bestaetigt nicht gesetzt:', (err as Error)?.message ?? err);
    return { gesetzt: false, grund: 'fehler' };
  }
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
    // P22-T119 R1b (Schalter modell_lauf_bindung): Laufprofil nur generationsgebunden (CAS) schreiben. AUS -> Bestand.
    const bindung = await modellLaufBindungAktiv(j.project);
    const generation = bindung ? await jobGeneration(j.id) : null;
    if (bindung && !generation) console.debug('[modell-lauf-bindung] keine Job-Generation, Laufprofil nicht geschrieben', { job_id: j.id });
    for (const s of bestaetigteStarts(j.action, j.args ?? {}, j.result)) {
      const id = (j.action === 'spawn' ? identitaetAusSpawnArgs(j.args, j.target_identity_id) : s.identity_id) ?? (s.name ? await identitaetZuName(j.project, s.name) : null);
      if (!id || !s.modell || !s.wrapper_pid || !s.lauf_hash) continue;
      const eintrag: AusweisModell = { modell: s.modell, runtime: rt, effort: s.effort, start_ort: 'container', start_ziel: rt,
        am: new Date().toISOString(), quelle: 'spawn_bestaetigt', wrapper_pid: s.wrapper_pid, lauf_hash: s.lauf_hash, job_id: j.id };
      if (bindung) {
        if (!generation) continue;
        if ((await schreibeLaufProfil(id, { ...eintrag, job_id: j.id, job_erstellt: generation })).geschrieben) {
          n++;
          // P22-T119: modell_bestaetigt = tatsaechlich gestartetes Modell desselben Laufs (CAS, Befund 5a7f6a07/0c19c24c).
          await bindeModellAnLauf(id, { modell: s.modell, job_id: j.id, wrapper_pid: s.wrapper_pid, lauf_hash: s.lauf_hash });
        }
      } else if (await schreibeProfil(id, 'plattform_modell', eintrag as unknown as Record<string, unknown>)) {
        n++;
      }
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

export interface ModellwechselEingabe { identity_id: unknown; runtime?: unknown; modell: unknown; effort?: unknown; grund: unknown;
  /** P22-T326 F2: true = einen extern aktiven Lauf (PC-CLI, Desktop, chatgpt.com) beim Container-Start bewusst abloesen. */
  uebernahme_bestaetigt?: unknown }

/**
 * P22-T326 (User 09.11.2026, Befund 1994b888): Schalter modellwechsel_rezept_erzeugen (Produkt, je Projekt/global, Standard AUS, nur
 * ausdruecklich). EIN: F1 Startrezept waehlen bzw. aus der Identitaet erzeugen (auch ohne frueheren Plattform-Spawn), F2 externer aktiver
 * Lauf nur mit uebernahme_bestaetigt abloesen, F3 Rueckfall auf das bisherige Rezept bzw. Profilstand vor dem Wechsel. AUS = Bestand.
 * DEBUG: debug.rezept_quelle (spawn_ok | spawn_letzter | erzeugt), debug.rueckfall, debug.profil_zurueckgesetzt, debug.abgeloest_extern.
 */
export const MODELLWECHSEL_REZEPT_FUNKTION = 'modellwechsel_rezept_erzeugen' as const;
export async function modellwechselRezeptAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(MODELLWECHSEL_REZEPT_FUNKTION, project)).aktiv; } catch { return false; }
}

export type RezeptQuelle = 'spawn_ok' | 'spawn_letzter' | 'erzeugt';
export interface SpawnJobZeile { args: Record<string, unknown> | null; status?: string | null; result?: unknown }
/** Auftrag eines erzeugten Startrezepts (wie die Koordinator-Starts der Plattform). */
export const ERZEUGTER_AUFTRAG = 'Anmelden, Posteingang lesen, auf Auftraege warten.';

/**
 * Rein, testbar (F1). jobs = Spawn-Jobs der Identitaet, juengste zuerst. erzeugen=false -> Bestand: juengster Spawn-Job oder null.
 * erzeugen=true -> juengster FACHLICH erfolgreicher Spawn (jobErfolgreich), sonst juengster beliebiger, sonst ein aus der Identitaet
 * erzeugtes Rezept (Container-Ziel und Modell setzt der Wechsel).
 */
export function waehleStartrezept(jobs: SpawnJobZeile[], i: { identity_id: string; agent_id: string; project: string; rolle: string }, erzeugen: boolean):
  { rezept: Record<string, unknown>; quelle: RezeptQuelle } | null {
  const mitArgs = jobs.filter(j => !!j.args && typeof j.args === 'object' && !Array.isArray(j.args));
  if (!erzeugen) return mitArgs[0] ? { rezept: mitArgs[0].args!, quelle: 'spawn_letzter' } : null;
  const ok = mitArgs.find(j => jobErfolgreich({ status: j.status ?? null, result: j.result }));
  if (ok) return { rezept: ok.args!, quelle: 'spawn_ok' };
  if (mitArgs[0]) return { rezept: mitArgs[0].args!, quelle: 'spawn_letzter' };
  return { quelle: 'erzeugt', rezept: { name: 'identity:' + i.identity_id, identity_id: i.identity_id, project: i.project, task: ERZEUGTER_AUFTRAG,
    expertise: (i.rolle === 'koordinator' ? 'Koordinator ' + i.project : i.agent_id + ' (' + i.rolle + ')').slice(0, 200), keep_alive: true } };
}

export interface AktiverLauf { herkunftsort: string | null; beginn_art: string | null; erstellt_am: string | Date | null; context_epoch: number | null; zuletzt_aktiv: string | Date | null }
export interface ExternerLauf { herkunftsort: string; beginn_art: string | null; context_epoch: number | null; zuletzt_aktiv: string; seit_ms: number }

/** Rein, testbar (F2): aktiver Lauf ohne Plattform-Wrapper, zuletzt aktiv innerhalb der Frist (runtime_veraltet_minuten)? null = nein. */
export function externerLaufAktiv(lauf: AktiverLauf | null, wrapperLaeuft: boolean, jetztMs: number, fristMs: number): ExternerLauf | null {
  if (wrapperLaeuft || !lauf) return null;
  const ms = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
  const zeiten = [ms(lauf.zuletzt_aktiv), ms(lauf.erstellt_am)].filter(Number.isFinite);
  if (!zeiten.length) return null;
  const zuletzt = Math.max(...zeiten);
  if (jetztMs - zuletzt > fristMs) return null;
  return { herkunftsort: lauf.herkunftsort ?? (lauf.beginn_art === 'uebernahme' ? 'uebernommen' : 'extern (Ort unbekannt)'), beginn_art: lauf.beginn_art,
    context_epoch: lauf.context_epoch ?? null, zuletzt_aktiv: new Date(zuletzt).toISOString(), seit_ms: Math.max(0, jetztMs - zuletzt) };
}

async function leseAktivenLauf(identity_id: string): Promise<AktiverLauf | null> {
  try {
    const r = await getPool().query<AktiverLauf>(
      `SELECT l.herkunftsort, l.beginn_art, l.erstellt_am, l.context_epoch, i.zuletzt_aktiv FROM agent_identitaet_laeufe l
         JOIN agent_identitaeten i ON i.id::text = l.identity_id WHERE l.identity_id = $1 AND l.status = 'aktiv' LIMIT 1`, [identity_id]);
    return r.rows[0] ?? null;
  } catch { return null; }
}

/** Rein, testbar (F3): warum kein Rueckfall-Start? null = Rueckfall starten. */
export function rueckfallHindernis(x: { stopOk: boolean; altModell: string | null; rezeptQuelle: RezeptQuelle; lebend: number }): string | null {
  if (!x.stopOk) return 'kein_stop';
  if (x.rezeptQuelle === 'erzeugt') return 'kein_altes_rezept';
  if (!x.altModell) return 'kein_altes_modell';
  if (x.lebend > 0) return 'anderer_lauf_aktiv';
  return null;
}

export interface ProfilStand { modell_bestaetigt: string | null; plattform_modell: unknown; plattform_modell_absicht: unknown }

async function leseProfilStand(identity_id: string): Promise<ProfilStand | null> {
  try {
    const r = await getPool().query<ProfilStand>(
      `SELECT modell_bestaetigt, startrezept->'plattform_modell' AS plattform_modell, startrezept->'plattform_modell_absicht' AS plattform_modell_absicht
         FROM agent_identitaeten WHERE id::text = $1`, [identity_id]);
    return r.rows[0] ?? null;
  } catch { return null; }
}

/** F3: Profilstand vor dem Wechsel wiederherstellen (modell_bestaetigt, startrezept.plattform_modell[_absicht]). query injizierbar. Wirft nie. */
export async function stelleProfilStandHer(identity_id: string, stand: ProfilStand,
  query: LaufQuery = (sql, p) => getPool().query(sql, p)): Promise<boolean> {
  const j = (v: unknown): string | null => v === null || v === undefined ? null : JSON.stringify(v);
  try {
    const r = await query(`UPDATE agent_identitaeten SET modell_bestaetigt = $2,
        startrezept = (COALESCE(startrezept, '{}'::jsonb) - 'plattform_modell' - 'plattform_modell_absicht')
          || CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('plattform_modell', $3::jsonb) END
          || CASE WHEN $4::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('plattform_modell_absicht', $4::jsonb) END,
        profil_revision = profil_revision + 1
      WHERE id::text = $1 AND rolle <> 'main'`, [identity_id, stand.modell_bestaetigt ?? null, j(stand.plattform_modell), j(stand.plattform_modell_absicht)]);
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    console.error('[modellwechsel-rezept] Profilstand nicht wiederhergestellt:', (err as Error)?.message ?? err);
    return false;
  }
}

const LAUFENDE_WECHSEL = new Set<string>();

/**
 * Rein, testbar (06068f63): vor dem Spawn darf fuer die Identitaet KEIN Wrapper laufen - weder die alte Generation (altPid)
 * noch ein anderer, der inzwischen ueber einen anderen Weg/Prozess gestartet wurde. Liefert den Abbruchgrund oder null.
 */
export function spawnSperreNachStop(altPid: number | null, zeilen: Array<{ status: string | null; wrapperPid: number | null }>): string | null {
  const lebend = zeilen.filter(r => r.status === 'running' || r.status === 'idle');
  if (!lebend.length) return null;
  return lebend.some(r => altPid !== null && r.wrapperPid === altPid) ? 'stop_nicht_bestaetigt' : 'anderer_lauf_aktiv';
}

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
  // P22-T326 F1: Schalter modellwechsel_rezept_erzeugen EIN -> juengster erfolgreicher Spawn, sonst juengster, sonst erzeugt. AUS = Bestand.
  const rezeptAn = await modellwechselRezeptAktiv(z.project);
  const rezeptRows = await getPool().query<SpawnJobZeile>(
    "SELECT args, status::text AS status, result FROM specialist_jobs WHERE target_identity_id = $1 AND action = 'spawn' ORDER BY created_at DESC LIMIT $2", [z.identity_id, rezeptAn ? 20 : 1]);
  const wahl = waehleStartrezept(rezeptRows.rows, z, rezeptAn);
  if (!wahl) fehler('kein_startrezept', { hinweis: 'kein frueherer Spawn-Job dieser Identitaet (nur Plattform-Agenten)', schalter: MODELLWECHSEL_REZEPT_FUNKTION, schalter_aktiv: rezeptAn });
  const rezept = wahl.rezept;
  const erzeugt = wahl.quelle === 'erzeugt';
  const bisherRt = text(rezept.target_runtime, 32) ?? z.runtime;
  const runtime = text(e.runtime, 32) ?? bisherRt ?? 'claude';
  if (z.ort !== 'container' && !rezept.target_runtime && text(e.runtime, 32) && runtime !== (z.runtime ?? runtime)) fehler('runtime_wechsel_nur_container', { ort: z.ort });
  const kosten = kostenEntscheidung(runtime);
  if (kosten) fehler(kosten, { runtime, kosten_art: kostenArt(runtime), erlaubt: ABO_RUNTIMES, hinweis: 'Plattform-Agenten laufen nur auf Abo-Runtimes (User-Entscheidung)' });
  const imContainer = erzeugt || !!rezept.target_runtime || z.ort === 'container';
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
    return await fuehreWechselAus({ z, rezept, wer, grund, modell: modell!, runtime, effort, bisherRt, imContainer, pruefQuelle: p.quelle,
      rezeptAn, rezeptQuelle: wahl.quelle, uebernahme: e.uebernahme_bestaetigt === true });
  } finally { LAUFENDE_WECHSEL.delete(z.identity_id); }
}

async function fuehreWechselAus(w: { z: Awaited<ReturnType<typeof ladeSteuerZiel>>; rezept: Record<string, unknown>; wer: string; grund: string; modell: string; runtime: string;
  effort: string | null; bisherRt: string | null; imContainer: boolean; pruefQuelle: unknown; rezeptAn: boolean; rezeptQuelle: RezeptQuelle; uebernahme: boolean }): Promise<Record<string, unknown>> {
  const { z, rezept, wer, grund, modell, runtime, effort, imContainer, rezeptAn } = w;
  const grenzen = await leseRuntimeAgentenGrenzen();
  const audit: Record<string, unknown> = { wer, grund, am: new Date().toISOString(), von: { modell: rezept.model ?? null, runtime: w.bisherRt }, nach: { modell, runtime, effort }, ort: z.ort, kosten_art: kostenArt(runtime),
    ...(rezeptAn ? { rezept_quelle: w.rezeptQuelle } : {}) };
  const name = 'identity:' + z.identity_id;
  const schritte: Array<Record<string, unknown>> = [];
  let abbruch: string | null = null;
  const altPid = z.wrapper?.wrapperPid ?? null;
  const laeuft = z.wrapper?.status === 'running' || z.wrapper?.status === 'idle';
  const debugRezept = { rezept_schalter: MODELLWECHSEL_REZEPT_FUNKTION, rezept_schalter_aktiv: rezeptAn, rezept_quelle: w.rezeptQuelle };
  // P22-T326 F2 (Schalter modellwechsel_rezept_erzeugen): ein extern laufender Lauf (PC-CLI, Desktop, chatgpt.com) wird nicht mehr
  // stillschweigend abgeloest. Ohne uebernahme_bestaetigt:true -> externer_lauf_aktiv (nichts gestoppt, nichts gestartet).
  let extern: ReturnType<typeof externerLaufAktiv> = null;
  if (rezeptAn && !laeuft) {
    extern = externerLaufAktiv(await leseAktivenLauf(z.identity_id), laeuft, Date.now(), grenzen.veraltet_ms);
    if (extern && !w.uebernahme) {
      return { success: false, error: 'externer_lauf_aktiv', identity_id: z.identity_id, agent: z.agent_id, project: z.project, modell, runtime, effort, extern,
        bestaetigung_noetig: 'uebernahme_bestaetigt',
        hinweis: 'Ein Lauf dieser Identitaet ist ausserhalb der Plattform aktiv (' + extern.herkunftsort + '). Mit uebernahme_bestaetigt:true wird er beim Container-Start abgeloest.',
        debug: { schalter: PLATTFORM_MODELLWECHSEL_FUNKTION, ...debugRezept, ort: z.ort, wrapper_status: z.wrapper?.status ?? null, frist_ms: grenzen.veraltet_ms, grenzen_quelle: grenzen.quelle } };
    }
    if (extern) audit.abgeloest_extern = extern;
  }
  // P22-T326 F3: Profilstand vor dem Wechsel (fuer die Wiederherstellung, wenn der Start scheitert und kein Rueckfall laeuft).
  const profilVorher = rezeptAn ? await leseProfilStand(z.identity_id) : null;
  let stopOk = false;
  if (laeuft) {
    const stopZiel = z.ort === 'container' && z.runtime ? { target_runtime: z.runtime, project_path: runtimeProjektPfad(z.project) }
      : rezept.target_hostname ? { target_hostname: rezept.target_hostname } : {};
    const j = await fuehreJob(z.project, 'stop', { name, ...stopZiel, ...(altPid ? { wrapper_pid: altPid } : {}), audit }, grenzen.job_warte_ms);
    schritte.push({ schritt: 'stop', ...j });
    if (!jobErfolgreich(j)) abbruch = 'stop_fehlgeschlagen';
    else { stopOk = true; await wartenBisGestoppt(z.identity_id, z.project); }
  } else schritte.push({ schritt: 'stop', uebersprungen: 'laeuft_nicht' });
  // Generationsbindung: unmittelbar vor dem Spawn alle Wrapper-Zeilen der Identitaet frisch lesen (alte PID oder fremder Lauf -> Abbruch).
  let vorSpawn: Array<{ status: string | null; wrapperPid: number | null }> = [];
  if (!abbruch) {
    vorSpawn = (await listWrapperStatus(z.project)).filter(r => r.identityId === z.identity_id).map(r => ({ status: r.status, wrapperPid: r.wrapperPid }));
    const sperre = spawnSperreNachStop(altPid, vorSpawn);
    if (sperre) { abbruch = sperre; schritte.push({ schritt: 'spawn', uebersprungen: sperre, laufend: vorSpawn.filter(r => r.status === 'running' || r.status === 'idle') }); }
  }
  let neuPid: number | null = null;
  let neuLauf: { job_id: string | null; wrapper_pid: number | null; lauf_hash: string | null } | null = null;
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
      else { neuPid = pid; neuLauf = { job_id: j.job_id ?? null, wrapper_pid: pid, lauf_hash: text(s.plattform_lauf_hash, 128) }; }
    }
  }
  // P22-T326 F3: Start gescheitert -> nach erfolgreichem Stop EINMAL mit dem bisherigen Rezept (altes Modell/Ort) neu starten, damit der
  // Agent ansprechbar bleibt. Ohne Rueckfall-Lauf: Profilstand vor dem Wechsel wiederherstellen (modell_bestaetigt, plattform_modell[_absicht]).
  let rueckfall: Record<string, unknown> | null = null;
  let profilZurueck: boolean | null = null;
  if (rezeptAn && (abbruch === 'spawn_fehlgeschlagen' || abbruch === 'start_nicht_bestaetigt')) {
    let rueckLauf: { job_id: string | null; wrapper_pid: number | null; lauf_hash: string | null } | null = null;
    const altModell = text(rezept.model);
    const lebend = (await listWrapperStatus(z.project)).filter(r => r.identityId === z.identity_id && (r.status === 'running' || r.status === 'idle'));
    const hindernis = rueckfallHindernis({ stopOk, altModell, rezeptQuelle: w.rezeptQuelle, lebend: lebend.length });
    if (hindernis) rueckfall = { status: 'uebersprungen', grund: hindernis };
    else {
      const { audit: _a, ...rest } = rezept as Record<string, unknown>;
      const altArgs: Record<string, unknown> = { ...rest, name, identity_id: z.identity_id, model: altModell, audit: { ...audit, rueckfall: true } };
      if (z.ort === 'container' && z.runtime) { altArgs.target_runtime = z.runtime; altArgs.project_path = runtimeProjektPfad(z.project); delete altArgs.target_hostname; }
      else if (text(rezept.target_runtime, 32)) altArgs.project_path = runtimeProjektPfad(z.project);
      const j = await fuehreJob(z.project, 'spawn', altArgs, grenzen.modellwechsel_spawn_warte_ms);
      schritte.push({ schritt: 'rueckfall', ...j });
      const s = (jobInhalt(j.result)?.specialist ?? {}) as Record<string, unknown>;
      const pid = Number(s.wrapperPid);
      const lebt = jobErfolgreich(j) && Number.isSafeInteger(pid) && pid > 0
        && (await listWrapperStatus(z.project)).some(r => r.identityId === z.identity_id && r.wrapperPid === pid && (r.status === 'running' || r.status === 'idle'));
      rueckfall = { status: lebt ? 'gestartet' : 'fehlgeschlagen', modell: altModell, runtime: altArgs.target_runtime ?? null, wrapper_pid: lebt ? pid : null };
      if (lebt) rueckLauf = { job_id: j.job_id ?? null, wrapper_pid: pid, lauf_hash: text(s.plattform_lauf_hash, 128) };
    }
    if (rueckLauf && altModell) rueckfall.modell_bindung = await bestaetigeWechselModell(await modellLaufBindungAktiv(z.project), z.identity_id, altModell, rueckLauf);
    else if (profilVorher && hindernis !== 'anderer_lauf_aktiv') profilZurueck = await stelleProfilStandHer(z.identity_id, profilVorher);
    console.debug('[modellwechsel-rezept] Rueckfall', { identity_id: z.identity_id, abbruch, rueckfall, profil_zurueckgesetzt: profilZurueck });
  }
  const ok = !abbruch;
  // Erst nach bestaetigtem Start: modell_bestaetigt (plattform_modell schreibt completeSpecialistJob an die Laufgeneration).
  // P22-T119 R1c: bei Schalter modell_lauf_bindung EIN nur lauf-gebunden (CAS), sonst Bestand.
  const modellBindung = ok ? await bestaetigeWechselModell(await modellLaufBindungAktiv(z.project), z.identity_id, modell, neuLauf) : null;
  let auditiert = false;
  try {
    await getPool().query('INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, neu, grund) VALUES ($1,$2,$3,$4::jsonb,$5)',
      [z.identity_id, wer, 'plattform_modellwechsel', JSON.stringify({ ...audit, ok, abbruch, neu_wrapper_pid: neuPid, ...(rezeptAn ? { rueckfall, profil_zurueckgesetzt: profilZurueck } : {}),
        schritte: schritte.map(s => ({ schritt: s.schritt, status: s.status ?? null, job_id: s.job_id ?? null, uebersprungen: s.uebersprungen ?? null })) }), grund.slice(0, 500)]);
    auditiert = true;
  } catch { auditiert = false; }
  return { success: ok, ...(abbruch ? { error: abbruch } : {}), identity_id: z.identity_id, agent: z.agent_id, project: z.project, modell, runtime, effort, kosten_art: kostenArt(runtime), schritte,
    ...(rueckfall ? { rueckfall } : {}),
    debug: { schalter: PLATTFORM_MODELLWECHSEL_FUNKTION, ...debugRezept, ort: z.ort, bisher: audit.von, wrapper_status: z.wrapper?.status ?? null, alt_wrapper_pid: altPid, neu_wrapper_pid: neuPid,
      modell_pruefung: w.pruefQuelle, grenzen_quelle: grenzen.quelle, auditiert, modell_bindung: modellBindung,
      ...(rezeptAn ? { abgeloest_extern: extern, rueckfall, profil_zurueckgesetzt: profilZurueck } : {}) } };
}
