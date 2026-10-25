/**
 * Synapse API - Daemon-Sync (P9-T27, letzter Schritt: Daemon ohne DATABASE_URL)
 *
 * ZWECK: Die letzten PG-Wege des lokalen FileWatcher-Daemons laufen ueber die API. Registriert aus
 *   daemonJobsRoutes (routes/daemon-jobs.ts) mit DERSELBEN Vorpruefung: nur Daemon-/Tray-Service-Token,
 *   Host AUS DEM TOKEN (nie vom Client), daemon_id = daemon-<host>-<pid>. Jedes Projekt muss eindeutig
 *   auf dem Token-Host liegen (projekteDesHosts, 10-s-Cache).
 *
 *   POST /api/daemon/sync            { host, daemon_id, aktion, project, ... }
 *        datei | dokument | entfernen                     Platte -> PG (indexiereDateiInhalt, indexiereExtrahiertesDokument, removeFile)
 *        code_zeile | geaenderte | geloeschte | hash_bekannt | inhalt | geloescht_abschliessen
 *                                                         PG -> Platte (pgWatcherDatenweg; Abschluss nur passende Zeile)
 *        ignore_regeln                                    project_ignore_rules (ladeIgnoreRegelZeilen)
 *        ereignisse_aufraeumen | ereignisse               watcher_events (TTL bzw. gebuendelter INSERT)
 *        datei_zeile | bekannte_version                   intern sync_datei (pgSyncDateiZugriff)
 *   POST /api/daemon/projekt-schalter { project, enabled }        -> setProjectEnabled
 *   POST /api/daemon/project-init     { aktion: claim|abschluss|expire|registrieren, ... }
 *   POST /api/daemon/tray             { aktion, project, ... }   lokale Tray-Endpunkte des Daemons (api.ts)
 *
 * ADDITIV: keine bestehende Route aendert sich; der PG-Weg des Daemons bleibt Rueckfall.
 * Datei-Inhalte kommen als JSON (bodyLimit der API, Standard 64 MB).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  pruefeAgentToken, importiereSitzungsEintraege, meldeModSitzung,
  projekteDesHosts,
  loeseAgentZiel, leseAgentBezugModus, mitAgentAufrufKontext, type AgentZiel,
  istSyncPfad,
  pgWatcherDatenweg,
  ladeIgnoreRegelZeilen,
  indexiereDateiInhalt,
  indexiereExtrahiertesDokument,
  removeFile,
  isProjectEnabled,
  setProjectEnabled,
  schliesseGeloeschteZeileFuerDaemon,
  protokolliereWatcherEreignisse,
  pgSyncDateiZugriff,
  claimPendingProjectInitJob,
  completeProjectInitJob,
  expirePendingProjectInitJobs,
  eigenerProjectInitJob,
  registriereInitProjektFuerDaemon,
  trayWatcherEreignisse,
  trayDateiVersionen,
  listWrapperStatus,
  getWrapperStatus,
  removeWrapperStatus,
  listChannels,
  getChannelMessages,
  postChannelMessage,
  listActiveAgents,
  resetProjectParse,
  reparseProject,
} from '@synapse/core';
import type { WatcherEreignisEintrag, ExtractedDocument } from '@synapse/core';

/** Gleiche Signatur wie der Pruefer in routes/daemon-jobs.ts. */
export type DaemonPruefer = (
  request: FastifyRequest,
  reply: FastifyReply,
  host: unknown,
  daemonId: unknown,
) => Promise<{ host: string; daemonId: string } | null>;

const HOST_CACHE_MS = 10_000;
const DOKUMENT_TYPEN = ['pdf', 'docx', 'doc', 'xlsx', 'xls'];
const INIT_STATUS = ['done', 'failed', 'rejected', 'timeout'];
const MAX_EREIGNISSE = 5000;

type Body = Record<string, unknown> & { host?: unknown; daemon_id?: unknown; aktion?: unknown; project?: unknown };

function istText(v: unknown, max = 4096): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
}

function grenze(v: unknown, vorgabe: number, min: number, max: number): number {
  const n = Number(v ?? vorgabe);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : vorgabe;
}

function istIsoZeit(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));
}

export async function daemonSyncRoutes(fastify: FastifyInstance, pruefeDaemon: DaemonPruefer): Promise<void> {
  // Host-Pruefung je (Host, Projekt) mit kurzem Cache: der Watcher fragt im 2-s-Takt je Projekt.
  const cache = new Map<string, { ok: boolean; bis: number }>();
  async function liegtAufHost(project: string, host: string): Promise<boolean> {
    const key = `${host}\u0000${project}`;
    const jetzt = Date.now();
    const c = cache.get(key);
    if (c && c.bis > jetzt) return c.ok;
    const ok = (await projekteDesHosts([project], host)).length === 1;
    cache.set(key, { ok, bis: jetzt + HOST_CACHE_MS });
    if (cache.size > 2000) for (const [k, v] of cache) if (v.bis <= jetzt) cache.delete(k);
    return ok;
  }

  /** Vorpruefung + Projekt dieses Hosts. Liefert null, wenn bereits geantwortet wurde. */
  async function pruefeProjekt(request: FastifyRequest, reply: FastifyReply, body: Body): Promise<{ host: string; daemonId: string; project: string } | null> {
    const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
    if (!d) return null;
    if (!istText(body.project, 128)) {
      reply.code(400).send({ success: false, error: 'project_fehlt' });
      return null;
    }
    if (!(await liegtAufHost(body.project, d.host))) {
      reply.code(409).send({ success: false, error: 'projekt_nicht_auf_diesem_host' });
      return null;
    }
    return { ...d, project: body.project };
  }

  function pfadOder400(reply: FastifyReply, p: unknown): p is string {
    if (istSyncPfad(p)) return true;
    reply.code(400).send({ success: false, error: 'file_path_ungueltig' });
    return false;
  }

  // ── Datei-Sync ─────────────────────────────────────────────────────────────────────────────
  const SYNC_AKTIONEN = ['datei', 'dokument', 'entfernen', 'code_zeile', 'geaenderte', 'geloeschte', 'hash_bekannt', 'inhalt',
    'geloescht_abschliessen', 'ignore_regeln', 'ereignisse_aufraeumen', 'ereignisse', 'datei_zeile', 'bekannte_version'] as const;

  fastify.post<{ Body: Body }>('/api/daemon/sync', async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const aktion = body.aktion;
    if (typeof aktion !== 'string' || !(SYNC_AKTIONEN as readonly string[]).includes(aktion)) {
      const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
      if (!d) return reply;
      return reply.code(400).send({ success: false, error: 'aktion_unbekannt', erlaubt: SYNC_AKTIONEN });
    }

    // watcher_events gebuendelt: mehrere Projekte je Aufruf, jedes einzeln gegen den Host geprueft.
    if (aktion === 'ereignisse') {
      const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
      if (!d) return reply;
      const roh = Array.isArray(body.eintraege) ? body.eintraege.slice(0, MAX_EREIGNISSE) : null;
      if (!roh) return reply.code(400).send({ success: false, error: 'eintraege_fehlen' });
      const erlaubt: WatcherEreignisEintrag[] = [];
      let verworfen = 0;
      for (const e of roh as Array<Record<string, unknown>>) {
        if (!e || typeof e !== 'object' || !istText(e.project, 128) || !istText(e.kind, 64) || typeof e.file_path !== 'string'
          || e.file_path.length > 4096 || !(await liegtAufHost(e.project, d.host))) { verworfen++; continue; }
        erlaubt.push({ project: e.project, kind: e.kind, file_path: e.file_path, details: e.details });
      }
      const n = await protokolliereWatcherEreignisse(erlaubt);
      return { success: true, aktion, geschrieben: n, verworfen };
    }

    const p = await pruefeProjekt(request, reply, body);
    if (!p) return reply;
    const project = p.project;

    switch (aktion) {
      case 'datei': {
        if (!pfadOder400(reply, body.file_path)) return reply;
        if (typeof body.content !== 'string') return reply.code(400).send({ success: false, error: 'content_fehlt' });
        // Wie darfWatcherEventNachSlot im Daemon: add/change nur fuer eingeschaltete Projekte.
        if (!(await isProjectEnabled(project))) return { success: true, aktion, geaendert: 0, verworfen: 'projekt_deaktiviert' };
        const groesse = Number.isSafeInteger(body.datei_groesse) && Number(body.datei_groesse) >= 0 ? Number(body.datei_groesse) : undefined;
        const geaendert = await indexiereDateiInhalt(body.file_path, project, body.content, {
          dateiGroesse: groesse,
          scanAbgeschlossen: typeof body.scan_abgeschlossen === 'boolean' ? body.scan_abgeschlossen : undefined,
        });
        return { success: true, aktion, geaendert };
      }
      case 'dokument': {
        if (!pfadOder400(reply, body.file_path)) return reply;
        const doc = body.doc as Partial<ExtractedDocument> | null | undefined;
        if (doc !== null && (!doc || typeof doc !== 'object' || typeof doc.text !== 'string' || !DOKUMENT_TYPEN.includes(String(doc.type))
          || (doc.metadata !== undefined && (typeof doc.metadata !== 'object' || doc.metadata === null)))) {
          return reply.code(400).send({ success: false, error: 'doc_ungueltig' });
        }
        if (!(await isProjectEnabled(project))) return { success: true, aktion, verworfen: 'projekt_deaktiviert' };
        const d = doc ? { text: doc.text as string, type: doc.type as ExtractedDocument['type'], metadata: (doc.metadata ?? {}) as ExtractedDocument['metadata'] } : null;
        return { success: true, aktion, ergebnis: await indexiereExtrahiertesDokument(body.file_path, project, d) };
      }
      case 'entfernen':
        if (!pfadOder400(reply, body.file_path)) return reply;
        await removeFile(body.file_path, project);
        return { success: true, aktion };
      case 'code_zeile':
        if (!pfadOder400(reply, body.file_path)) return reply;
        return { success: true, aktion, vorhanden: await pgWatcherDatenweg.codeZeileVorhanden(project, body.file_path) };
      case 'geaenderte': {
        if (!istIsoZeit(body.untergrenze)) return reply.code(400).send({ success: false, error: 'untergrenze_ungueltig' });
        const vollNach = typeof body.voll_nach === 'string' ? body.voll_nach : null;
        const seiten = await pgWatcherDatenweg.geaenderte(project, { untergrenze: body.untergrenze, vollNach, limit: grenze(body.limit, 500, 1, 2000) });
        return { success: true, aktion, ...seiten };
      }
      case 'geloeschte': {
        if (!istIsoZeit(body.untergrenze)) return reply.code(400).send({ success: false, error: 'untergrenze_ungueltig' });
        const geloeschtNach = typeof body.geloescht_nach === 'string' ? body.geloescht_nach : null;
        const seiten = await pgWatcherDatenweg.geloeschte(project, { untergrenze: body.untergrenze, geloeschtNach, limit: grenze(body.limit, 500, 1, 2000) });
        return { success: true, aktion, ...seiten };
      }
      case 'hash_bekannt':
        if (!pfadOder400(reply, body.file_path)) return reply;
        if (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) return reply.code(400).send({ success: false, error: 'hash_ungueltig' });
        return { success: true, aktion, bekannt: await pgWatcherDatenweg.hashBekannt(project, body.file_path, body.hash) };
      case 'inhalt':
        if (!pfadOder400(reply, body.file_path)) return reply;
        return { success: true, aktion, content: (await pgWatcherDatenweg.inhalt(project, body.file_path)) ?? null };
      case 'geloescht_abschliessen': {
        if (!pfadOder400(reply, body.file_path)) return reply;
        if (!istText(body.id, 64)) return reply.code(400).send({ success: false, error: 'id_fehlt' });
        // Nur eine soft-geloeschte Zeile genau dieses Projekts und Pfads (nie blind per id).
        const ok = await schliesseGeloeschteZeileFuerDaemon(project, body.id, body.file_path);
        if (!ok) return reply.code(409).send({ success: false, error: 'zeile_passt_nicht' });
        return { success: true, aktion };
      }
      case 'ignore_regeln':
        return { success: true, aktion, regeln: await ladeIgnoreRegelZeilen(project) };
      case 'ereignisse_aufraeumen':
        await pgWatcherDatenweg.ereignisseAufraeumen(project);
        return { success: true, aktion };
      case 'datei_zeile':
        if (!pfadOder400(reply, body.file_path)) return reply;
        return { success: true, aktion, zeile: (await pgSyncDateiZugriff.zeile(project, body.file_path)) ?? null };
      case 'bekannte_version':
        if (!pfadOder400(reply, body.file_path)) return reply;
        if (typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) return reply.code(400).send({ success: false, error: 'hash_ungueltig' });
        return { success: true, aktion, version: (await pgSyncDateiZugriff.bekannteVersion(project, body.file_path, body.hash)) ?? null };
      default:
        return reply.code(400).send({ success: false, error: 'aktion_unbekannt' });
    }
  });

  // ── Projekt-Schalter (Tray enable/disable) ─────────────────────────────────────────────────
  fastify.post<{ Body: Body }>('/api/daemon/projekt-schalter', async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const p = await pruefeProjekt(request, reply, body);
    if (!p) return reply;
    if (typeof body.enabled !== 'boolean') return reply.code(400).send({ success: false, error: 'enabled_fehlt' });
    await setProjectEnabled(p.project, body.enabled);
    return { success: true, project: p.project, enabled: body.enabled };
  });

  // ── project-init (Web-KI Self-Service) ─────────────────────────────────────────────────────
  fastify.post<{ Body: Body }>('/api/daemon/project-init', async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
    if (!d) return reply;
    switch (body.aktion) {
      case 'claim':
        // Host aus dem Token: nur Jobs ohne Host-Vorgabe oder fuer genau diesen Host.
        return { success: true, aktion: 'claim', job: await claimPendingProjectInitJob(d.daemonId, d.host) };
      case 'expire': {
        const s = grenze(body.max_alter_s, 30, 30, 3600);
        return { success: true, aktion: 'expire', anzahl: await expirePendingProjectInitJobs(s, d.host) };
      }
      case 'abschluss': {
        if (!istText(body.id, 64)) return reply.code(400).send({ success: false, error: 'id_fehlt' });
        const a = body.abschluss as Record<string, unknown> | undefined;
        if (!a || typeof a !== 'object' || !INIT_STATUS.includes(String(a.status))) return reply.code(400).send({ success: false, error: 'abschluss_ungueltig' });
        if (!(await eigenerProjectInitJob(body.id, d.daemonId))) return reply.code(409).send({ success: false, error: 'nicht_eigener_job' });
        const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
        await completeProjectInitJob(body.id, {
          status: a.status as 'done' | 'failed' | 'rejected' | 'timeout',
          resolved_path: text(a.resolved_path, 4096),
          error: text(a.error, 200),
          message: text(a.message, 8000),
        });
        return { success: true, aktion: 'abschluss' };
      }
      case 'registrieren': {
        if (!istText(body.id, 64)) return reply.code(400).send({ success: false, error: 'id_fehlt' });
        const job = await eigenerProjectInitJob(body.id, d.daemonId);
        if (!job) return reply.code(409).send({ success: false, error: 'nicht_eigener_job' });
        const pfad = body.path;
        // Nur absolute Pfade, deren letzter Teil der Job-Name ist (wie initializeProject: WORKSPACE_ROOT/<name>).
        if (!istText(pfad) || !pfad.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(pfad)
          || pfad.split(/[\\/]/).includes('..') || pfad.split(/[\\/]/).filter(Boolean).pop() !== job.name) {
          return reply.code(400).send({ success: false, error: 'path_ungueltig' });
        }
        const r = await registriereInitProjektFuerDaemon(job, d.host, pfad, typeof body.lokale_phase === 'string' ? body.lokale_phase : null);
        return { success: true, aktion: 'registrieren', ...r };
      }
      default:
        return reply.code(400).send({ success: false, error: 'aktion_unbekannt', erlaubt: ['claim', 'abschluss', 'expire', 'registrieren'] });
    }
  });

  // ── P22-T133: lokale CLI-Sitzung -> Agenten-Verlauf ──
  // Body { host, daemon_id, ausweis, runtime?, eintraege[1..500] } (cli-verlauf.ts im Daemon). Die Identitaet kommt
  // aus dem Ausweis, nie aus dem Body; gespeichert wie der Wrapper-Spiegel (importiereSitzungsEintraege, ref einmalig).
  fastify.post<{ Body: Body }>('/api/daemon/cli-verlauf', async (request, reply) => {
    const body = (request.body ?? {}) as Body & { ausweis?: unknown; runtime?: unknown; eintraege?: unknown };
    const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
    if (!d) return reply;
    const eintraege = Array.isArray(body.eintraege) ? body.eintraege : null;
    if (!istText(body.ausweis, 200) || !eintraege || eintraege.length === 0 || eintraege.length > 500) {
      return reply.code(400).send({ success: false, error: 'cli_verlauf_ungueltig' });
    }
    let identityId: string;
    try { identityId = (await pruefeAgentToken(body.ausweis)).identitaet.id; }
    catch { return reply.code(403).send({ success: false, error: 'ausweis_ungueltig' }); }
    // P22-T135: herkunft cli -> Eingaben bekommen ihren Absender (User an der CLI bzw. Kopf der zugestellten Nachricht).
    const r = await importiereSitzungsEintraege(identityId, eintraege, { runtime: istText(body.runtime, 32) ? body.runtime : 'claude', herkunft: 'cli' });
    return { success: true, ...r };
  });

  // ── P22-T134: Mod-Inbox – Sitzungen mit wartender Claude-Code-Mod melden ──
  // Body { host, daemon_id, sitzungen[1..50]: { sitzung, ausweis } } (mod-inbox.ts im Daemon). Die Identitaet kommt aus dem
  // Ausweis, nie aus dem Body; die API merkt sich Identitaet -> Host fuer die Zustellung (core mod-inbox.ts, Schalter mod_inbox).
  fastify.post<{ Body: Body }>('/api/daemon/mod-inbox', async (request, reply) => {
    const body = (request.body ?? {}) as Body & { sitzungen?: unknown };
    const d = await pruefeDaemon(request, reply, body.host, body.daemon_id);
    if (!d) return reply;
    const liste = Array.isArray(body.sitzungen) ? body.sitzungen as Array<{ sitzung?: unknown; ausweis?: unknown } | null> : null;
    if (!liste || liste.length === 0 || liste.length > 50) {
      return reply.code(400).send({ success: false, error: 'mod_inbox_ungueltig' });
    }
    const sitzungen: Array<Record<string, unknown>> = [];
    for (const roh of liste) {
      const sitzung = roh?.sitzung;
      const ausweis = roh?.ausweis;
      if (!istText(sitzung, 64) || !istText(ausweis, 200)) continue;
      let identityId: string;
      try { identityId = (await pruefeAgentToken(ausweis)).identitaet.id; }
      catch { sitzungen.push({ sitzung, aktiv: false, identity_id: null, grund: 'ausweis_ungueltig' }); continue; }
      sitzungen.push({ sitzung, ...(await meldeModSitzung({ host: d.host, sitzung, identity_id: identityId })) });
    }
    return { success: true, sitzungen };
  });

  // ── Tray (lokale Daemon-API, api.ts) ───────────────────────────────────────────────────────
  const TRAY_AKTIONEN = ['history', 'file_versions', 'specialists', 'specialist', 'specialist_entfernen', 'channels', 'feed', 'post',
    'agents', 'reindex', 'reparse'] as const;
  fastify.post<{ Body: Body }>('/api/daemon/tray', async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const p = await pruefeProjekt(request, reply, body);
    if (!p) return reply;
    const project = p.project;
    return mitAgentAufrufKontext({principal:null,bezug:await leseAgentBezugModus()},async()=>{
    switch (body.aktion) {
      case 'history':
        return { success: true, events: await trayWatcherEreignisse(project, grenze(body.limit, 50, 1, 500)) };
      case 'file_versions':
        return { success: true, versions: await trayDateiVersionen(project, grenze(body.limit, 100, 1, 1000)) };
      case 'specialists':
        return { success: true, zeilen: await listWrapperStatus(project) };
      case 'specialist':
      case 'specialist_entfernen': {
        let ziel: string | AgentZiel;
        if (body.identity_id !== undefined) {
          if (!istText(body.identity_id,128) || (await leseAgentBezugModus()).modus==='alt') return reply.code(409).send({success:false,error:'identity_ziel_nicht_verfuegbar'});
          try { ziel=await loeseAgentZiel(project,{identity_id:body.identity_id}); }
          catch { return reply.code(404).send({success:false,error:'identity_ziel_unbekannt'}); }
        } else {
          if (!istText(body.agent,128)) return reply.code(400).send({success:false,error:'agent_fehlt'});
          ziel=body.agent;
        }
        if(body.aktion==='specialist') return {success:true,zeile:(await getWrapperStatus(ziel,project))??null};
        await removeWrapperStatus(ziel,project);
        return {success:true};
      }
      case 'channels':
        return { success: true, channels: await listChannels(project, { mitArchiv: body.mit_archiv === true }) };
      case 'feed':
        if (!istText(body.channel, 256)) return reply.code(400).send({ success: false, error: 'channel_fehlt' });
        return {
          success: true,
          messages: await getChannelMessages(project, body.channel, { limit: grenze(body.limit, 50, 1, 1000), mitArchiv: body.mit_archiv === true }),
        };
      case 'post': {
        if (!istText(body.channel, 256) || !istText(body.sender, 128) || !istText(body.content, 100_000)) {
          return reply.code(400).send({ success: false, error: 'nachricht_ungueltig' });
        }
        const r = await postChannelMessage(project, body.channel, body.sender, body.content);
        return { success: true, nachricht: r ? { id: r.id, createdAt: r.createdAt } : null };
      }
      case 'agents':
        return { success: true, agents: await listActiveAgents(project) };
      case 'reindex':
        return { success: true, ergebnis: await resetProjectParse(project) };
      case 'reparse': {
        const extensions = Array.isArray(body.extensions) ? body.extensions.filter((e): e is string => istText(e, 32)).slice(0, 100) : undefined;
        // Bewusst nicht abgewartet (wie bisher im Daemon): Fortschritt im API-Log.
        void reparseProject(project, { extensions, nurVeraltete: body.nur_veraltete === true }).catch((err) => {
          console.error(`[daemon-sync] Reparse "${project}" abgebrochen:`, err);
        });
        return { success: true, gestartet: true };
      }
      default:
        return reply.code(400).send({ success: false, error: 'aktion_unbekannt', erlaubt: TRAY_AKTIONEN });
    }
    });
  });
}
