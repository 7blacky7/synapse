/**
 * Synapse API - Intern-Daemon-Bruecke (P15-T12, Etappe 2, 11.10.2026)
 *
 * ZWECK: Lokale FileWatcher-Daemons holen hier Steuerbefehle des Tools 'intern' ab (worker_status,
 *   worker_pausieren, worker_fortsetzen, worker_durchlauf) und melden die Ergebnisse zurueck.
 *   Die Bruecke ist der API-Zugang, den der Daemon ohnehin hat (synapse_api_url + Service-Token aus
 *   ~/.synapse/file-watcher/config.json) — keine PG-Tabelle, kein NOTIFY.
 *
 *   GET  /api/intern/daemon/befehle?host=<hostname>&warte=<s>
 *        SYNAPSE_INTERN_TOOL aus -> { success, debug:false } sofort (Daemon hat dann keine Steuerung).
 *        an -> Long-Poll bis warte (max 25 s): { success, debug:true, befehle:[{id, befehl, args}] }.
 *   POST /api/intern/daemon/antwort { host, id?, ergebnis?, anmeldung?, worker_status? }
 *
 * AUTH: globaler Bearer-Hook (/api/*). Zusaetzlich abgelehnt: Tokens von GPU-Knoten
 *   (scope compute-node:*) — die sollen keine Daemon-Befehle abholen koennen.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  alleSchalter,
  leseTokenIdentitaetSchalter,
  holeDaemonBefehle,
  internToolAktiv,
  istGueltigerHost,
  meldeDaemonAntwort,
  meldeDaemonStatus,
  stelleDaemonBefehleZurueck,
  vergissDaemons,
} from '@synapse/core';
import { validateToken } from '../services/auth.js';

const MAX_WARTE_S = 25;

async function istGpuKnotenToken(request: FastifyRequest): Promise<boolean> {
  const raw = request.headers.authorization;
  const token = typeof raw === 'string' ? /^Bearer\s+(.+)$/i.exec(raw.trim())?.[1]?.trim() : undefined;
  if (!token) return false;
  const row = await validateToken(token).catch(() => null);
  return typeof row?.scope === 'string' && row.scope.startsWith('compute-node:');
}

export async function internDaemonRoutes(fastify: FastifyInstance): Promise<void> {
  // Beim Schliessen (Deploy) wartende Long-Polls sofort beenden, statt bis zu 25 s zu halten.
  fastify.addHook('onClose', async () => { vergissDaemons(); });
  fastify.get<{ Querystring: { host?: string; warte?: string } }>(
    '/api/intern/daemon/befehle',
    async (request, reply) => {
      if (await istGpuKnotenToken(request)) return reply.code(403).send({ success: false, error: 'token_nicht_erlaubt' });
      if (!internToolAktiv()) return {
        success: true, debug: false, server_zeit: new Date().toISOString(),
        token_identitaet: await leseTokenIdentitaetSchalter(),
      };
      const host = request.query.host;
      if (!istGueltigerHost(host)) return reply.code(400).send({ success: false, error: 'host_ungueltig' });
      const warteRoh = Number(request.query.warte ?? MAX_WARTE_S);
      const warteMs = Math.min(Math.max(Number.isFinite(warteRoh) ? warteRoh : MAX_WARTE_S, 0), MAX_WARTE_S) * 1000;
      let geschlossen = false;
      request.raw.on('close', () => { geschlossen = true; });
      const befehle = await holeDaemonBefehle(host, warteMs);
      if (geschlossen || reply.raw.destroyed) {
        // Verbindung weg (Daemon-Neustart, Netz): Befehle nicht verlieren, der naechste Poll holt sie.
        stelleDaemonBefehleZurueck(host, befehle);
        return reply;
      }
      // Frisch lesen, kein gecachter letzter EIN-Stand bei PG-Ausfall. Unbekannt/Fehler = AUS.
      let tray_token_weiterleitung: unknown = null;
      try { tray_token_weiterleitung = (await alleSchalter()).find((s) => s.name === 'tray_token_weiterleitung') ?? null; } catch { /* AUS */ }
      return { success: true, debug: true, befehle, server_zeit: new Date().toISOString(), tray_token_weiterleitung,
        token_identitaet: await leseTokenIdentitaetSchalter() };
    },
  );

  fastify.post<{ Body: { host?: string; id?: string; ergebnis?: Record<string, unknown>; anmeldung?: boolean; worker_status?: unknown } }>(
    '/api/intern/daemon/antwort',
    async (request, reply) => {
      if (!internToolAktiv()) return { success: true, debug: false };
      if (await istGpuKnotenToken(request)) return reply.code(403).send({ success: false, error: 'token_nicht_erlaubt' });
      const body = request.body ?? {};
      if (!istGueltigerHost(body.host)) return reply.code(400).send({ success: false, error: 'host_ungueltig' });
      if (body.worker_status !== undefined) meldeDaemonStatus(body.host, body.worker_status);
      let zugestellt: boolean | undefined;
      if (typeof body.id === 'string') {
        const ergebnis = body.ergebnis && typeof body.ergebnis === 'object' ? body.ergebnis : { success: false, error: 'ohne_ergebnis' };
        zugestellt = meldeDaemonAntwort(body.host, body.id, ergebnis);
      }
      return { success: true, debug: true, ...(zugestellt !== undefined ? { zugestellt } : {}) };
    },
  );
}
