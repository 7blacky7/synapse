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
import { validateToken, type AuthTokenRow } from '../services/auth.js';

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
        const s = Number(body.max_alter_s ?? 30);
        return { success: true, aktion: 'expire', anzahl: await expirePendingSpecialistJobs(Number.isFinite(s) && s > 0 ? Math.floor(s) : 30) };
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
}
