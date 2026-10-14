/**
 * Synapse API - Daemon-Jobs (P9-T27, Welle 1, Schritte 1 und 2)
 *
 * ZWECK: Der lokale FileWatcher-Daemon holt Shell- und Spezialisten-Jobs ueber die API statt per
 *   eigener PostgreSQL-Verbindung (LISTEN/claim/complete). Zugang ist der, den der Daemon ohnehin
 *   hat: synapse_api_url + Token aus ~/.synapse/file-watcher/config.json (Tray). Muster wie die
 *   intern-Bruecke (routes/intern-daemon.ts): Long-Poll zum Abholen, eigene Route zum Melden.
 *
 *   GET  /api/daemon/shell/jobs?host=&daemon_id=&projekte=a,b&frei=<n>&warte=<s>
 *        -> { success, jobs:[ShellJobRow], abbrueche:[job_id] }  (Long-Poll bis warte, max 25 s)
 *   POST /api/daemon/shell/abschluss  { host, daemon_id, id, abschluss:ShellJobCompletion }
 *   POST /api/daemon/shell/wartung    { host, daemon_id, aktion:'reap'|'expire'|'eigene_laufende' }
 *
 *   GET  /api/daemon/specialist/jobs?host=&daemon_id=&projekte=a,b&warte=<s>
 *        -> { success, jobs:[SpecialistJobRow + lokaler_projektpfad] }
 *   POST /api/daemon/specialist/abschluss { host, daemon_id, id, abschluss:SpecialistJobCompletion }
 *   POST /api/daemon/specialist/wartung   { host, daemon_id, aktion:'expire'|'wrapper_kandidaten'|
 *                                           'wrapper_abgestuerzt', projekte?, alter_ms?, kandidat? }
 *
 * P9-T27 WELLE 2 (Daemon ohne DATABASE_URL, gleiche Auth):
 *   GET  /api/daemon/shell/kontext?host=&daemon_id=&id=   -> { success, kontext:ShellExecKontextDaten }
 *        (Projektpfad, Projekt-DB, passwortfreie System-DB-Grenze, DB-Freigabe, Katalog; nur eigener laufender Job)
 *   POST /api/daemon/shell/sicherung { host, daemon_id, id, speicher }  -> beginneShellSicherungsJob
 *   POST /api/daemon/specialist/daten { host, daemon_id, aktion, ... }   -> PG-Schritte der Spezialisten-Tools
 *   GET  /api/daemon/projekte?host=&daemon_id=             -> { success, projekte:[{name,path,enabled,setup_phase}] }
 *   POST /api/daemon/heartbeat { host, daemon_id, aktion:'melden'|'loeschen', projekte, pid? }
 *   Alles nur fuer Projekte, die auf dem Token-Host liegen (projekteDesHosts / lokalerProjektpfadFuerHost).
 *
 * AUTH: globaler Bearer-Hook (/api/*) UND hier: nur Daemon-/Tray-Service-Token (kind service, scope
 *   daemon | daemon:*). Der Host kommt aus der bestaetigten Hostbindung des Tokens
 *   (ProjectRestoreService.daemonHost(token_hash), Muster routes/project-restore.ts) — nie vom Client.
 *   Ein mitgeschicktes host muss dazu passen (sonst 403 host_verboten), daemon_id muss
 *   daemon-<eigener Host>-<pid> sein. Geclaimt/gemeldet/gereapt wird nur fuer Projekte dieses Hosts
 *   (projekteDesHosts im Core). Access-/OAuth-/Session-/GPU-Token -> 403 daemon_token_erforderlich.
 * ADDITIV: keine bestehende Route aendert sich; der PG-Weg des Daemons bleibt Vorgabe.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DAEMON_JOB_WARTE_MAX_S,
  EXPIRE_PENDING_AFTER_SEC,
  expirePendingShellJobs,
  expirePendingSpecialistJobs,
  holeShellJobsFuerDaemon,
  holeSpecialistJobsFuerDaemon,
  istGueltigeDaemonId,
  istGueltigerHost,
  leseProjektListe,
  listeEigeneLaufendeShellJobs,
  lokalerProjektpfadFuerHost,
  markiereWrapperAbgestuerzt,
  reapOrphanedRunningJobs,
  schliesseDaemonJobWecker,
  schliesseShellJobFuerDaemon,
  schliesseSpecialistJobFuerDaemon,
  wrapperReapKandidaten,
} from '@synapse/core';
import { ProjectRestoreService } from '@synapse/core';
import type { ShellJobCompletion, SpecialistJobCompletion } from '@synapse/core';
// P9-T27 Welle 2
import {
  getPool,
  projekteDesHosts,
  ladeShellExecKontextFuerDaemon,
  speichereShellSicherungFuerDaemon,
  listModels,
  ensureGeneralChannel,
  joinChannel,
  beginneSitzung,
  upsertWrapperStatus,
  setzeHeartbeatBeimSpawn,
  removeWrapperStatus,
  postToInbox,
  // P9-T27 Nachbesserung (291473c2 Nr. 1): nur Daten des geprueften Projekts
  entferneAgentAusProjektChannels,
  meldeAgentImProjektAb,
  sitzungsProjektDesAgenten,
  andereProjekteDesAgenten,
  entferneInboxImProjekt,
  upsertDaemonHeartbeat,
  clearDaemonHeartbeat,
  istVirtuellesProjekt,
  istVirtuellerRegistryPfad,
} from '@synapse/core';
import type { ShellSicherungEingabe } from '@synapse/core';
import { validateToken, type AuthTokenRow } from '../services/auth.js';
// P9-T27 letzter Schritt: Datei-Sync, Projekt-Schalter, project-init, Tray (gleiche Vorpruefung)
import { daemonSyncRoutes } from './daemon-sync.js';

const SHELL_STATUS = ['done', 'failed', 'rejected', 'timeout'] as const;

/** Abhaengigkeiten fuer Tests (Standard: echte Token-Pruefung und echte Hostbindung). */
export interface DaemonJobsRoutesOptionen {
  validateToken?: (token: string) => Promise<AuthTokenRow | null>;
  daemonHost?: (tokenHash: string) => Promise<string | null>;
}

/** Daemon-/Tray-Zugang wie in routes/project-restore.ts: nur Service-Token mit Scope daemon[:*]. */
function istDaemonToken(row: AuthTokenRow): boolean {
  return row.kind === 'service' && (row.scope === 'daemon' || (typeof row.scope === 'string' && row.scope.startsWith('daemon:')));
}

type Pruefer = (request: FastifyRequest, reply: FastifyReply, host: unknown, daemonId: unknown) => Promise<{ host: string; daemonId: string } | null>;

/**
 * Gemeinsame Vorpruefung: Daemon-Token, Host AUS DEM TOKEN, daemon_id. Liefert null, wenn bereits
 * geantwortet wurde. Ein vom Client genanntes host ist nur noch eine Gegenprobe.
 */
function erstellePruefer(o: DaemonJobsRoutesOptionen): Pruefer {
  const validate = o.validateToken ?? validateToken;
  let service: ProjectRestoreService | null = null;
  const daemonHost = o.daemonHost ?? ((hash: string) => (service ??= new ProjectRestoreService()).daemonHost(hash));
  return async (request, reply, host, daemonId) => {
    const raw = request.headers.authorization;
    const token = typeof raw === 'string' ? /^Bearer\s+(.+)$/i.exec(raw.trim())?.[1]?.trim() : undefined;
    const row = token ? await validate(token).catch(() => null) : null;
    if (!row) {
      reply.code(401).send({ success: false, error: 'unauthorized' });
      return null;
    }
    if (!istDaemonToken(row)) {
      reply.code(403).send({ success: false, error: 'daemon_token_erforderlich', message: 'Nur der Daemon-/Tray-Zugang (Service-Token daemon) darf Daemon-Jobs holen und melden.' });
      return null;
    }
    if (host !== undefined && host !== '' && !istGueltigerHost(host)) {
      reply.code(400).send({ success: false, error: 'host_ungueltig' });
      return null;
    }
    const eigen = await daemonHost(row.token_hash);
    if (!eigen) {
      reply.code(403).send({ success: false, error: 'daemon_host_nicht_gebunden', message: 'Dieser Daemon-Zugang ist keinem PC zugeordnet (Tray: PC zuordnen).' });
      return null;
    }
    if (!istGueltigerHost(eigen)) {
      reply.code(403).send({ success: false, error: 'daemon_host_ungueltig' });
      return null;
    }
    if (host !== undefined && host !== '' && host !== eigen) {
      reply.code(403).send({ success: false, error: 'host_verboten', message: 'host passt nicht zur Hostbindung dieses Daemon-Zugangs.' });
      return null;
    }
    if (!istGueltigeDaemonId(daemonId, eigen)) {
      reply.code(400).send({ success: false, error: 'daemon_id_ungueltig', message: 'daemon_id muss daemon-<host>-<pid> sein.' });
      return null;
    }
    return { host: eigen, daemonId };
  };
}

function warteMsAus(roh: unknown): number {
  const n = Number(roh ?? DAEMON_JOB_WARTE_MAX_S);
  return Math.min(Math.max(Number.isFinite(n) ? n : DAEMON_JOB_WARTE_MAX_S, 0), DAEMON_JOB_WARTE_MAX_S) * 1000;
}

/** P9-T27 Welle 2: Agentenname wie in Spezialisten-Tools (kein Pfad, begrenzt). */
function istAgentName(n: unknown): n is string {
  return typeof n === 'string' && n.length > 0 && n.length <= 128 && !n.includes('..') && !/[\\/\u0000-\u001f]/.test(n);
}

/** Fehlercode -> HTTP-Status fuer den Shell-Kontext. */
function kontextStatus(error: string): number {
  return error === 'job_unbekannt' ? 404 : 409;
}

function istShellAbschluss(a: unknown): a is ShellJobCompletion {
  return !!a && typeof a === 'object' && (SHELL_STATUS as readonly string[]).includes(String((a as { status?: unknown }).status));
}

export async function daemonJobsRoutes(fastify: FastifyInstance, optionen: DaemonJobsRoutesOptionen = {}): Promise<void> {
  fastify.addHook('onClose', async () => { await schliesseDaemonJobWecker(); });
  const pruefeDaemon = erstellePruefer(optionen ?? {});

  // ── Shell ────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { host?: string; daemon_id?: string; projekte?: string; frei?: string; warte?: string } }>(
    '/api/daemon/shell/jobs',
    async (request, reply) => {
      const d = await pruefeDaemon(request, reply, request.query.host, request.query.daemon_id);
      if (!d) return reply;
      const frei = Number(request.query.frei ?? 1);
      let geschlossen = false;
      request.raw.on('close', () => { geschlossen = true; });
      const abruf = await holeShellJobsFuerDaemon({
        daemonId: d.daemonId,
        host: d.host,
        projekte: leseProjektListe(request.query.projekte),
        frei: Number.isFinite(frei) ? frei : 1,
        warteMs: warteMsAus(request.query.warte),
        istGeschlossen: () => geschlossen || reply.raw.destroyed,
      });
      if (geschlossen || reply.raw.destroyed) return reply;
      return { success: true, ...abruf, server_zeit: new Date().toISOString() };
    },
  );

  fastify.post<{ Body: { host?: string; daemon_id?: string; id?: string; abschluss?: unknown } }>(
    '/api/daemon/shell/abschluss',
    async (request, reply) => {
      const body = request.body ?? {};
      const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
      if (!d) return reply;
      if (typeof body.id !== 'string' || !body.id) return reply.code(400).send({ success: false, error: 'id_fehlt' });
      if (!istShellAbschluss(body.abschluss)) return reply.code(400).send({ success: false, error: 'abschluss_ungueltig' });
      const r = await schliesseShellJobFuerDaemon(body.id, d.daemonId, body.abschluss);
      if (!r.ok) return reply.code(r.error === 'job_unbekannt' ? 404 : 409).send({ success: false, ...r });
      return { success: true, ...r };
    },
  );

  fastify.post<{ Body: { host?: string; daemon_id?: string; aktion?: string } }>(
    '/api/daemon/shell/wartung',
    async (request, reply) => {
      const body = request.body ?? {};
      const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
      if (!d) return reply;
      switch (body.aktion) {
        case 'reap':
          // d.host stammt aus dem Token: ein Daemon reapt nur Claims seines eigenen Hosts.
          return { success: true, aktion: 'reap', anzahl: await reapOrphanedRunningJobs(d.host) };
        case 'expire':
          return { success: true, aktion: 'expire', anzahl: await expirePendingShellJobs(EXPIRE_PENDING_AFTER_SEC) };
        case 'eigene_laufende':
          return { success: true, aktion: 'eigene_laufende', jobs: await listeEigeneLaufendeShellJobs(d.daemonId) };
        default:
          return reply.code(400).send({ success: false, error: 'aktion_unbekannt', erlaubt: ['reap', 'expire', 'eigene_laufende'] });
      }
    },
  );

  // ── Spezialisten ─────────────────────────────────────────────────────────
  // P9-T27 Welle 2: Kontext fuer execShellInProject (Daemon ohne eigene PG-Lesewege)
  fastify.get<{ Querystring: { host?: string; daemon_id?: string; id?: string } }>(
    '/api/daemon/shell/kontext',
    async (request, reply) => {
      const d = await pruefeDaemon(request, reply, request.query.host, request.query.daemon_id);
      if (!d) return reply;
      const id = request.query.id;
      if (typeof id !== 'string' || !id) return reply.code(400).send({ success: false, error: 'id_fehlt' });
      const r = await ladeShellExecKontextFuerDaemon(id, d.daemonId, d.host);
      if (!r.ok) return reply.code(kontextStatus(r.error)).send({ success: false, error: r.error });
      return { success: true, kontext: r.kontext };
    },
  );

  // P9-T27 Welle 2: Sicherungs-Audit eines eigenen laufenden Jobs (beginneShellSicherungsJob serverseitig)
  fastify.post<{ Body: { host?: string; daemon_id?: string; id?: string; speicher?: unknown } }>(
    '/api/daemon/shell/sicherung',
    async (request, reply) => {
      const body = request.body ?? {};
      const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
      if (!d) return reply;
      if (typeof body.id !== 'string' || !body.id) return reply.code(400).send({ success: false, error: 'id_fehlt' });
      const s = body.speicher as Partial<ShellSicherungEingabe> | undefined;
      if (!s || typeof s !== 'object' || !s.entscheidung || typeof s.entscheidung !== 'object' || !s.lage || typeof s.lage !== 'object') {
        return reply.code(400).send({ success: false, error: 'speicher_ungueltig' });
      }
      const r = await speichereShellSicherungFuerDaemon(body.id, d.daemonId, s as ShellSicherungEingabe);
      if (!r.ok) return reply.code(kontextStatus(r.error)).send({ success: false, error: r.error });
      return { success: true, id: r.id ?? null };
    },
  );

  // P9-T27 Welle 2: Projekt-Snapshot dieses Hosts fuer enabled-sync (gleiche Abfrage wie bisher im Daemon)
  fastify.get<{ Querystring: { host?: string; daemon_id?: string } }>(
    '/api/daemon/projekte',
    async (request, reply) => {
      const d = await pruefeDaemon(request, reply, request.query.host, request.query.daemon_id);
      if (!d) return reply;
      const res = await getPool().query<{ name: string; path: string; enabled: boolean; setup_phase: string | null }>(
        `SELECT p.name, p.path, p.enabled, s.setup_phase
           FROM projects p
           LEFT JOIN project_setup_status s ON s.project = p.name
          WHERE p.hostname = $1`,
        [d.host],
      );
      const projekte = res.rows.filter((r) => !istVirtuellesProjekt(r.name) && !istVirtuellerRegistryPfad(r.path));
      return { success: true, host: d.host, projekte };
    },
  );

  // P9-T27 Welle 2: Daemon-Heartbeat (daemon_heartbeats) fuer die Projekte dieses Hosts
  fastify.post<{ Body: { host?: string; daemon_id?: string; aktion?: string; projekte?: string[] | string; pid?: number } }>(
    '/api/daemon/heartbeat',
    async (request, reply) => {
      const body = request.body ?? {};
      const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
      if (!d) return reply;
      const projekte = await projekteDesHosts(leseProjektListe(body.projekte), d.host);
      if (body.aktion === 'melden') {
        const pid = Number.isSafeInteger(body.pid) ? Number(body.pid) : Number(d.daemonId.slice(`daemon-${d.host}-`.length));
        const fehler: string[] = [];
        for (const p of projekte) {
          try { await upsertDaemonHeartbeat(p, d.host, pid); } catch (err) { fehler.push(`${p}: ${(err as Error).message}`); }
        }
        return { success: fehler.length === 0, aktion: 'melden', projekte, ...(fehler.length ? { fehler } : {}) };
      }
      if (body.aktion === 'loeschen') {
        for (const p of projekte) { try { await clearDaemonHeartbeat(p); } catch { /* wie im Daemon: ignorieren */ } }
        return { success: true, aktion: 'loeschen', projekte };
      }
      return reply.code(400).send({ success: false, error: 'aktion_unbekannt', erlaubt: ['melden', 'loeschen'] });
    },
  );

  fastify.get<{ Querystring: { host?: string; daemon_id?: string; projekte?: string; warte?: string } }>(
    '/api/daemon/specialist/jobs',
    async (request, reply) => {
      const d = await pruefeDaemon(request, reply, request.query.host, request.query.daemon_id);
      if (!d) return reply;
      let geschlossen = false;
      request.raw.on('close', () => { geschlossen = true; });
      const jobs = await holeSpecialistJobsFuerDaemon({
        daemonId: d.daemonId,
        host: d.host,
        projekte: leseProjektListe(request.query.projekte),
        warteMs: warteMsAus(request.query.warte),
        istGeschlossen: () => geschlossen || reply.raw.destroyed,
      });
      if (geschlossen || reply.raw.destroyed) return reply;
      return { success: true, jobs, server_zeit: new Date().toISOString() };
    },
  );

  fastify.post<{ Body: { host?: string; daemon_id?: string; id?: string; abschluss?: SpecialistJobCompletion } }>(
    '/api/daemon/specialist/abschluss',
    async (request, reply) => {
      const body = request.body ?? {};
      const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
      if (!d) return reply;
      if (typeof body.id !== 'string' || !body.id) return reply.code(400).send({ success: false, error: 'id_fehlt' });
      const a = body.abschluss;
      if (!a || typeof a !== 'object' || !(SHELL_STATUS as readonly string[]).includes(String(a.status))) {
        return reply.code(400).send({ success: false, error: 'abschluss_ungueltig' });
      }
      const r = await schliesseSpecialistJobFuerDaemon(body.id, d.daemonId, a);
      if (!r.ok) return reply.code(r.error === 'job_unbekannt' ? 404 : 409).send({ success: false, ...r });
      return { success: true, ...r };
    },
  );

  fastify.post<{
    Body: {
      host?: string;
      daemon_id?: string;
      aktion?: string;
      projekte?: string[] | string;
      alter_ms?: number;
      max_alter_s?: number;
      kandidat?: { project?: string; agent_name?: string; wrapper_pid?: number; last_activity?: string };
    };
  }>('/api/daemon/specialist/wartung', async (request, reply) => {
    const body = request.body ?? {};
    const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
    if (!d) return reply;
    switch (body.aktion) {
      case 'expire': {
        // P10-T78 (Abnahme 61ca8b09): expire wirkt hostuebergreifend auf alle pending Spezialisten-Jobs. Untergrenze
        // 30 s (wie der Daemon selbst), damit ein Client mit kleinem max_alter_s keine frischen Jobs anderer Hosts verwirft.
        const minS = 30, s = Number(body.max_alter_s ?? minS);
        const maxAlterS = Number.isFinite(s) ? Math.max(minS, Math.floor(s)) : minS;
        return { success: true, aktion: 'expire', max_alter_s: maxAlterS, anzahl: await expirePendingSpecialistJobs(maxAlterS) };
      }
      case 'wrapper_kandidaten': {
        const alter = Number(body.alter_ms ?? 300_000);
        return {
          success: true,
          aktion: 'wrapper_kandidaten',
          kandidaten: await wrapperReapKandidaten(leseProjektListe(body.projekte), d.host, Number.isFinite(alter) && alter > 0 ? alter : 300_000),
        };
      }
      case 'wrapper_abgestuerzt': {
        const k = body.kandidat;
        if (!k || typeof k.project !== 'string' || typeof k.agent_name !== 'string' || !Number.isSafeInteger(k.wrapper_pid) || typeof k.last_activity !== 'string') {
          return reply.code(400).send({ success: false, error: 'kandidat_ungueltig' });
        }
        // Nur Wrapper von Projekten, die eindeutig auf DIESEM Host liegen (wie reapLokaleWrapper).
        if (!(await lokalerProjektpfadFuerHost(k.project, d.host))) {
          return reply.code(409).send({ success: false, error: 'projekt_nicht_auf_diesem_host' });
        }
        return {
          success: true,
          aktion: 'wrapper_abgestuerzt',
          anzahl: await markiereWrapperAbgestuerzt({ project: k.project, agent_name: k.agent_name, wrapper_pid: Number(k.wrapper_pid), last_activity: k.last_activity }),
        };
      }
      default:
        return reply.code(400).send({ success: false, error: 'aktion_unbekannt', erlaubt: ['expire', 'wrapper_kandidaten', 'wrapper_abgestuerzt'] });
    }
  });

  // P9-T27 Welle 2: PG-Schritte der Spezialisten-Tools (spawn/stop/purge/wake), ausgefuehrt im Daemon.
  // Jede Aktion ausser 'modelle' verlangt ein Projekt, das eindeutig auf dem Token-Host liegt.
  const SPEZIALISTEN_DATEN = ['modelle', 'projektpfad', 'general_channel', 'channel_beitreten', 'sitzung_neu', 'wrapper_status',
    'heartbeat_beim_spawn', 'wrapper_pid', 'wrapper_gestoppt', 'aus_channels', 'chat_abmelden', 'wrapper_status_entfernen',
    'inbox_entfernen', 'inbox_post'] as const;
  fastify.post<{
    Body: {
      host?: string; daemon_id?: string; aktion?: string; project?: string; agent?: string; channel?: string;
      created_by?: string; pid?: number; zeile?: Record<string, unknown>; from?: string; to?: string; content?: string;
    };
  }>('/api/daemon/specialist/daten', async (request, reply) => {
    const body = request.body ?? {};
    const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
    if (!d) return reply;
    const aktion = body.aktion;
    if (!aktion || !(SPEZIALISTEN_DATEN as readonly string[]).includes(aktion)) {
      return reply.code(400).send({ success: false, error: 'aktion_unbekannt', erlaubt: SPEZIALISTEN_DATEN });
    }
    if (aktion === 'modelle') return { success: true, aktion, modelle: await listModels() };
    const project = aktion === 'wrapper_status' ? body.zeile?.project : body.project;
    if (typeof project !== 'string' || leseProjektListe(project).length !== 1) {
      return reply.code(400).send({ success: false, error: 'project_fehlt' });
    }
    if (aktion === 'projektpfad') return { success: true, aktion, pfad: await lokalerProjektpfadFuerHost(project, d.host) };
    if ((await projekteDesHosts([project], d.host)).length !== 1) {
      return reply.code(409).send({ success: false, error: 'projekt_nicht_auf_diesem_host' });
    }
    const agent = aktion === 'wrapper_status' ? body.zeile?.agentName : aktion === 'inbox_post' ? body.to : body.agent;
    if (!istAgentName(agent)) return reply.code(400).send({ success: false, error: 'agent_ungueltig' });
    switch (aktion) {
      case 'general_channel':
        await ensureGeneralChannel(project, istAgentName(body.created_by) ? body.created_by : agent, agent);
        return { success: true, aktion };
      case 'channel_beitreten':
        if (typeof body.channel !== 'string' || !body.channel) return reply.code(400).send({ success: false, error: 'channel_fehlt' });
        return { success: true, aktion, beigetreten: await joinChannel(project, body.channel, agent) };
      case 'sitzung_neu': {
        // agent_sessions.id ist global: gehoert die Sitzung einem anderen Projekt, bleibt sie unberuehrt.
        const sitzungsProjekt = await sitzungsProjektDesAgenten(agent);
        if (sitzungsProjekt !== null && sitzungsProjekt !== project) {
          return reply.code(409).send({ success: false, error: 'agent_in_anderem_projekt', andere_projekte: [sitzungsProjekt] });
        }
        await beginneSitzung(agent, project, 'neu');
        return { success: true, aktion };
      }
      case 'wrapper_status':
        await upsertWrapperStatus(body.zeile as unknown as Parameters<typeof upsertWrapperStatus>[0]);
        return { success: true, aktion };
      case 'heartbeat_beim_spawn':
        await setzeHeartbeatBeimSpawn(project, agent);
        return { success: true, aktion };
      case 'wrapper_pid': {
        const { rows } = await getPool().query<{ wrapper_pid: number | null }>(
          'SELECT wrapper_pid FROM wrapper_status WHERE agent_name=$1 AND project=$2', [agent, project]);
        return { success: true, aktion, pid: rows.length === 1 && rows[0].wrapper_pid ? Number(rows[0].wrapper_pid) : null };
      }
      case 'wrapper_gestoppt': {
        if (!Number.isSafeInteger(body.pid) || Number(body.pid) <= 1) return reply.code(400).send({ success: false, error: 'pid_ungueltig' });
        // PID-CAS wie stoppeLokalenWrapper: ein zwischenzeitlich neu gestarteter Wrapper bleibt unangetastet.
        const r = await getPool().query(
          "UPDATE wrapper_status SET status='stopped',busy=false,current_task=NULL,connected_mcp=false WHERE agent_name=$1 AND project=$2 AND wrapper_pid=$3",
          [agent, project, Number(body.pid)]);
        return { success: true, aktion, anzahl: r.rowCount ?? 0 };
      }
      // P9-T27 Nachbesserung (291473c2 Nr. 1): wirkt nur im geprueften Projekt, nie projektuebergreifend.
      case 'aus_channels':
        return { success: true, aktion, anzahl: await entferneAgentAusProjektChannels(agent, project) };
      case 'chat_abmelden':
        return { success: true, aktion, anzahl: await meldeAgentImProjektAb(agent, project) };
      case 'wrapper_status_entfernen':
        await removeWrapperStatus(agent, project);
        return { success: true, aktion };
      case 'inbox_entfernen': {
        // specialist_inbox hat keine project-Spalte: nur loeschen, wenn der Name allein diesem Projekt gehoert.
        const r = await entferneInboxImProjekt(agent, project);
        if (r.andereProjekte.length > 0) {
          return reply.code(409).send({ success: false, error: 'agent_in_anderem_projekt', andere_projekte: r.andereProjekte });
        }
        return { success: true, aktion, anzahl: r.anzahl };
      }
      case 'inbox_post': {
        if (!istAgentName(body.from) || typeof body.content !== 'string') return reply.code(400).send({ success: false, error: 'nachricht_ungueltig' });
        const r = await postToInbox(body.from, agent, body.content, project);
        return { success: true, aktion, id: r.id };
      }
      default:
        return reply.code(400).send({ success: false, error: 'aktion_unbekannt' });
    }
  });

  // P9-T27 letzter Schritt: /api/daemon/sync, /projekt-schalter, /project-init, /tray (routes/daemon-sync.ts)
  await daemonSyncRoutes(fastify, pruefeDaemon);
}
