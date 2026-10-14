/**
 * P9-T31: Routen fuer den rechnergebundenen Loesch-Code und das Loeschen von Projekten (Tray, Web-UI, Daemon).
 *
 * REGELN (User 14.10.2026 + thought a78f5248): Der Loesch-Code ist auf JEDEM Weg Pflicht — auch fuer den User im
 * Tray/Web-UI (Schutz vor einem Fehlklick). Gleiche Regeln wie beim Agentenweg: Vorschau mit Zaehlung zuerst,
 * Code rechnergebunden, ~3 Minuten, einmalig, auftragsgebunden.
 *
 * - Einrichten/Zuruecksetzen NUR mit Daemon-Zugang GENAU dieses Rechners (Tray) UND dem Login-TOTP des Users.
 *   Ein Agent auf dem PC, der den Tray-Token liest, kann deshalb kein eigenes Loesch-Geheimnis setzen.
 *   Die otpauth-URI/der QR-Code geht nur in diese Antwort an den Tray, nie in ein Agenten-Tool.
 * - Vorschau/Ausfuehren: Daemon-Zugang nur fuer den eigenen Rechner; Web-UI-Sitzung des Users (session ohne
 *   scope) mit frei gewaehltem Rechner. Access-/OAuth-Token und andere Sitzungen -> 403. Der Code wird immer
 *   gegen das Geheimnis des Rechners aus dem Auftrag geprueft.
 * - Daemon: holt Ordner-Loeschauftraege NUR fuer seinen eigenen, bestaetigten Rechner ab (kein PG vom PC).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  ProjectRestoreService,
  ProjectRestoreError,
  API_CONTRACT_HEADER,
  apiCapabilitiesForClient,
  LoeschTokenFehler,
  ProjektLoeschenFehler,
  loeschTokenStatus,
  loeschTokenEinrichten,
  loeschTokenBestaetigen,
  pruefeLoeschLoginMitSperre,
  projektLoeschenVorschau,
  projektLoeschenAusfuehren,
  loeschAuftragStatus,
  claimOrdnerLoeschungen,
  schliesseOrdnerLoeschung,
  ladeProjektDbKonfig,
  type PsqlAusfuehrer,
} from '@synapse/core';
import { validateToken, verifyTotp, generateQrDataUrl, type AuthTokenRow } from '../services/auth.js';
import { dockerPsqlAusfuehrer } from './projekt-db.js';

/** psql in den Projekt-DB-Container (nur wenn konfiguriert) — zum Entfernen einer von Synapse angelegten Projekt-DB. */
export function loeschPsql(): PsqlAusfuehrer | undefined {
  const konfig = ladeProjektDbKonfig();
  return konfig ? dockerPsqlAusfuehrer(konfig) : undefined;
}

export interface LoeschRoutesDeps {
  service?: ProjectRestoreService;
  validateToken?: typeof validateToken;
  verifyTotp?: typeof verifyTotp;
  psql?: () => PsqlAusfuehrer | undefined;
}

export async function registerLoeschRoutes(f: FastifyInstance, o: LoeschRoutesDeps = {}): Promise<void> {
  const service = o.service ?? new ProjectRestoreService();
  const validate = o.validateToken ?? validateToken;
  const loginTotp = o.verifyTotp ?? verifyTotp;
  const psql = o.psql ?? loeschPsql;

  async function identity(req: FastifyRequest): Promise<AuthTokenRow> {
    const text = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const auth = text ? await validate(text) : null;
    if (!auth) throw new ProjectRestoreError('unauthorized', 401);
    if (!apiCapabilitiesForClient(req.headers[API_CONTRACT_HEADER])?.features.includes('asset_sync')) {
      throw new ProjectRestoreError('vertrag_erforderlich', 426);
    }
    return auth;
  }
  const daemon = (a: AuthTokenRow): boolean => a.kind === 'service' && (a.scope === 'daemon' || (a.scope?.startsWith('daemon:') ?? false));
  const webUiUser = (a: AuthTokenRow): boolean => a.kind === 'session' && a.scope === null;
  async function eigenerHost(auth: AuthTokenRow): Promise<string> {
    if (!daemon(auth)) throw new ProjectRestoreError('daemon_host_erforderlich', 403);
    const h = await service.daemonHost(auth.token_hash);
    if (!h) throw new ProjectRestoreError('daemon_host_nicht_gebunden', 403);
    return h;
  }
  /** Daemon: nur der eigene Rechner. Web-UI-User: frei gewaehlter Rechner. Sonst 403. */
  async function host(auth: AuthTokenRow, gewuenscht?: unknown): Promise<string> {
    if (daemon(auth)) {
      const eigen = await eigenerHost(auth);
      if (gewuenscht !== undefined && gewuenscht !== eigen) throw new ProjectRestoreError('host_verboten', 403);
      return eigen;
    }
    if (webUiUser(auth) && typeof gewuenscht === 'string' && gewuenscht) return gewuenscht;
    throw new ProjectRestoreError('nur_tray_oder_user', 403);
  }
  async function run(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProjectRestoreError || e instanceof LoeschTokenFehler || e instanceof ProjektLoeschenFehler) {
        return reply.code(e.httpStatus).send({ success: false, error: { code: e.code, message: e.message } });
      }
      throw e;
    }
  }

  // ── Loesch-Code dieses Rechners ──
  f.get<{ Querystring: { hostname?: string } }>('/api/loesch-token/status', (req, reply) => run(reply, async () => {
    const auth = await identity(req);
    const h = await host(auth, daemon(auth) ? undefined : req.query?.hostname);
    return { success: true, ...(await loeschTokenStatus(h)) };
  }));
  f.post<{ Body: { login_code?: unknown } }>('/api/loesch-token/einrichten', (req, reply) => run(reply, async () => {
    const auth = await identity(req);
    const h = await eigenerHost(auth);
    const login = typeof req.body?.login_code === 'string' ? req.body.login_code.replace(/\s+/g, '') : '';
    // B3: Versuchsbegrenzung je Rechner (verifyTotp selbst begrenzt nicht). Gesperrt -> 429, ohne Pruefung.
    const loginOk = await pruefeLoeschLoginMitSperre(h, async () => /^\d{6}$/.test(login) && (await loginTotp(login)));
    if (!loginOk) {
      throw new LoeschTokenFehler('login_code_ungueltig', 'Login-Code (Synapse-Anmeldung) falsch — Einrichtung abgelehnt.', 403);
    }
    const e = await loeschTokenEinrichten(h, { von: 'tray:' + h });
    return {
      success: true,
      hostname: h,
      otpauth_uri: e.otpauth_uri,
      qr: await generateQrDataUrl(e.otpauth_uri),
      ersetzt_bestehendes: e.ersetzt_bestehendes,
      hinweis: 'QR-Code mit der Authenticator-App scannen und den ersten Code zur Bestaetigung eingeben. Ein bisheriger Loesch-Code gilt bis dahin weiter.',
    };
  }));
  f.post<{ Body: { code?: unknown } }>('/api/loesch-token/bestaetigen', (req, reply) => run(reply, async () => {
    const h = await eigenerHost(await identity(req));
    return { success: true, ...(await loeschTokenBestaetigen(h, req.body?.code)) };
  }));

  // ── Projekt loeschen (Tray "Projekt loeschen …", Web-UI) ──
  f.post<{ Params: { project: string }; Body: { hostname?: unknown; umfang?: unknown } }>('/api/projects/:project/loeschen/vorschau', (req, reply) => run(reply, async () => {
    const auth = await identity(req);
    const h = await host(auth, req.body?.hostname);
    return projektLoeschenVorschau({ project: req.params.project, hostname: h, umfang: req.body?.umfang, agent: (daemon(auth) ? 'tray:' : 'web-ui:') + h });
  }));
  f.post<{ Params: { id: string }; Body: { loesch_code?: unknown } }>('/api/loesch-auftraege/:id/ausfuehren', (req, reply) => run(reply, async () => {
    const auth = await identity(req);
    let nurHost: string | undefined;
    if (daemon(auth)) nurHost = await eigenerHost(auth);
    else if (!webUiUser(auth)) throw new ProjectRestoreError('nur_tray_oder_user', 403);
    return projektLoeschenAusfuehren({
      loesch_auftrag_id: req.params.id,
      loesch_code: req.body?.loesch_code,
      agent: nurHost ? 'tray:' + nurHost : 'web-ui',
      nurHost,
      psql: psql(),
    });
  }));
  f.get<{ Params: { id: string } }>('/api/loesch-auftraege/:id', (req, reply) => run(reply, async () => {
    const auth = await identity(req);
    if (!daemon(auth) && !webUiUser(auth)) throw new ProjectRestoreError('nur_tray_oder_user', 403);
    // B2: Daemon-Zugang sieht nur Auftraege seines eigenen Rechners (fremde -> 404 ohne Details).
    return loeschAuftragStatus(req.params.id, undefined, { nurHost: daemon(auth) ? await eigenerHost(auth) : undefined });
  }));

  // ── Daemon: Ordner-Loeschungen des eigenen Rechners ──
  f.post('/api/project-init/projekt-loeschen/claim', (req, reply) => run(reply, async () => {
    return { success: true, jobs: await claimOrdnerLoeschungen(await eigenerHost(await identity(req))) };
  }));
  f.post<{ Params: { id: string }; Body: { status?: unknown; message?: unknown } }>('/api/project-init/projekt-loeschen/:id/complete', (req, reply) => run(reply, async () => {
    await schliesseOrdnerLoeschung(req.params.id, await eigenerHost(await identity(req)), req.body ?? {});
    return { success: true };
  }));
}
