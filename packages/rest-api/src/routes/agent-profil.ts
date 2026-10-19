/**
 * P22-T13 Paket D: REST-Vertrag der Profilverwaltung fuer die aktive Web-UI (nur API, kein UI-Bau).
 * Basis: /api/projects/:project/agent-profile
 *
 * AKTEUR: Web-UI-Sitzung des Users (AuthTokenRow kind=session, scope=null, wie project-restore/user-post) ->
 * User, und NUR dann wird mitUserHerkunft('web-ui-chat') gesetzt. Koordinatoren melden sich mit ihrem persoenlichen
 * Ausweis im Header x-synapse-agent-token (zusaetzlich zu einem gueltigen Bearer); sie sind NIE User. Access-/OAuth-
 * Tokens, Tray- und andere Sitzungen sind ohne Ausweis abgelehnt. Die User-Herkunft kommt nie aus Body/Query.
 * ALLE Routen rufen denselben Core-Dispatcher wie admin (fuehreW1bAdminAus): Rechte, Produkt-Schalter und Fehlercodes
 * sind identisch. Antworten sind Cache-Control: no-store (token-/web-ui-koordinator-token enthalten den echten Token).
 *
 *   GET  /schalter                          profil_schalter_status
 *   PUT  /schalter                          profil_schalter_setzen {profil_funktion, aktiv, grund, ebene?}
 *   GET  /uebersicht                        profil_uebersicht (tokenfrei)
 *   GET  /schattenprofile?zustand=          schattenprofil_liste
 *   POST /schattenprofile/:id/korrigieren   {erwartete_revision, korrektur, grund}
 *   POST /schattenprofile/:id/bestaetigen   {erwartete_revision, korrektur?, typ_id?, user_zustimmung?, grund}
 *   POST /schattenprofile/:id/ablehnen      {erwartete_revision, grund}
 *   GET  /typen | POST /typen {profil_scope?, typ_schluessel, typ_inhalt, grund}
 *   POST /typen/:typ_id/revisionen          {erwartete_revision, typ_inhalt, grund}
 *   GET  /typen/:typ_id/revisionen/:revision   (revision = Zahl oder 'aktuell')
 *   GET  /profile/:identity_id/historie
 *   POST /profile/:identity_id/aendern      {erwartete_revision, profil_patch, typ_id?, grund, user_auftrag?}
 *   POST /profile/:identity_id/rollback     {ziel_revision, erwartete_revision, grund}
 *   GET  /persona?ziel_identity_id=         persona_liste (+ aktuelle Zuweisung)
 *   POST /persona                           {profil_scope?, persona_name, persona_inhalt, user_auftrag?}
 *   GET  /persona/:vorlage_id/versionen
 *   POST /persona/:vorlage_id/versionen     {persona_inhalt, user_auftrag?}
 *   PUT  /profile/:identity_id/persona      {persona_vorlage_id, persona_version, user_auftrag?}
 *   POST /profile/:identity_id/persona/entfernen   {grund}
 *   POST /profile/:identity_id/token-abruf  {anlass}
 *   GET  /tasks/:task_id/bindung            task_bindung_lesen (offen|identitaet|team)
 *   PUT  /tasks/:task_id/bindung            {bindung_art: identitaet|team, bindung_identity_ids[], grund?}
 *   POST /tasks/:task_id/bindung/aendern    {bindung_art, bindung_identity_ids[], grund}
 *   POST /tasks/:task_id/bindung/entblocken {grund}
 *   GET  /web-ui-koordinator-token?identity_id=    nur User
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  agentPrincipalAusAnmeldung, fuehreW1bAdminAus, leseAgentBezugModus, mitUserHerkunft, pruefeAgentToken, w1bFehlerStatus, type W1bAkteur,
} from '@synapse/core';
import { validateToken } from '../services/auth.js';

export interface AgentProfilRoutesDeps { validateToken?: typeof validateToken }

class RouteFehler extends Error { constructor(public readonly code: string, public readonly status: number) { super(code); } }

type Quelle = (req: FastifyRequest) => Record<string, unknown>;
const params = (req: FastifyRequest): Record<string, string> => (req.params ?? {}) as Record<string, string>;
const query = (req: FastifyRequest): Record<string, unknown> => (req.query ?? {}) as Record<string, unknown>;
const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

interface RouteDef { methode: 'GET' | 'POST' | 'PUT'; pfad: string; action: string; quelle: Quelle }

const ROUTEN: RouteDef[] = [
  { methode: 'GET', pfad: '/schalter', action: 'profil_schalter_status', quelle: () => ({}) },
  { methode: 'PUT', pfad: '/schalter', action: 'profil_schalter_setzen', quelle: body },
  { methode: 'GET', pfad: '/uebersicht', action: 'profil_uebersicht', quelle: () => ({}) },
  { methode: 'GET', pfad: '/schattenprofile', action: 'schattenprofil_liste', quelle: req => ({ zustand: query(req).zustand }) },
  { methode: 'POST', pfad: '/schattenprofile/:id/korrigieren', action: 'schattenprofil_korrigieren', quelle: req => ({ ...body(req), schattenprofil_id: params(req).id }) },
  { methode: 'POST', pfad: '/schattenprofile/:id/bestaetigen', action: 'schattenprofil_bestaetigen', quelle: req => ({ ...body(req), schattenprofil_id: params(req).id }) },
  { methode: 'POST', pfad: '/schattenprofile/:id/ablehnen', action: 'schattenprofil_ablehnen', quelle: req => ({ ...body(req), schattenprofil_id: params(req).id }) },
  { methode: 'GET', pfad: '/typen', action: 'typ_liste', quelle: () => ({}) },
  { methode: 'POST', pfad: '/typen', action: 'typ_anlegen', quelle: body },
  { methode: 'POST', pfad: '/typen/:typ_id/revisionen', action: 'typ_aendern', quelle: req => ({ ...body(req), typ_id: params(req).typ_id }) },
  { methode: 'GET', pfad: '/typen/:typ_id/revisionen/:revision', action: 'typ_revision_lesen',
    quelle: req => ({ typ_id: params(req).typ_id, ...(/^\d+$/.test(params(req).revision ?? '') ? { typ_revision: Number(params(req).revision) } : {}) }) },
  { methode: 'GET', pfad: '/profile/:identity_id/historie', action: 'profil_historie', quelle: req => ({ ziel_identity_id: params(req).identity_id }) },
  { methode: 'POST', pfad: '/profile/:identity_id/aendern', action: 'profil_aendern', quelle: req => ({ ...body(req), ziel_identity_id: params(req).identity_id }) },
  { methode: 'POST', pfad: '/profile/:identity_id/rollback', action: 'profil_rollback', quelle: req => ({ ...body(req), ziel_identity_id: params(req).identity_id }) },
  { methode: 'GET', pfad: '/persona', action: 'persona_liste', quelle: req => ({ ziel_identity_id: query(req).ziel_identity_id }) },
  { methode: 'POST', pfad: '/persona', action: 'persona_anlegen', quelle: body },
  { methode: 'GET', pfad: '/persona/:vorlage_id/versionen', action: 'persona_versionen', quelle: req => ({ persona_vorlage_id: params(req).vorlage_id }) },
  { methode: 'POST', pfad: '/persona/:vorlage_id/versionen', action: 'persona_neue_version', quelle: req => ({ ...body(req), persona_vorlage_id: params(req).vorlage_id }) },
  { methode: 'PUT', pfad: '/profile/:identity_id/persona', action: 'persona_zuweisen', quelle: req => ({ ...body(req), ziel_identity_id: params(req).identity_id }) },
  { methode: 'POST', pfad: '/profile/:identity_id/persona/entfernen', action: 'persona_entfernen', quelle: req => ({ ...body(req), ziel_identity_id: params(req).identity_id }) },
  { methode: 'POST', pfad: '/profile/:identity_id/token-abruf', action: 'token_abrufen', quelle: req => ({ ...body(req), ziel_identity_id: params(req).identity_id }) },
  { methode: 'GET', pfad: '/tasks/:task_id/bindung', action: 'task_bindung_lesen', quelle: req => ({ bindung_task_id: params(req).task_id }) },
  { methode: 'PUT', pfad: '/tasks/:task_id/bindung', action: 'task_bindung_festlegen', quelle: req => ({ ...body(req), bindung_task_id: params(req).task_id }) },
  { methode: 'POST', pfad: '/tasks/:task_id/bindung/aendern', action: 'task_bindung_aendern', quelle: req => ({ ...body(req), bindung_task_id: params(req).task_id }) },
  { methode: 'POST', pfad: '/tasks/:task_id/bindung/entblocken', action: 'task_bindung_entblocken', quelle: req => ({ ...body(req), bindung_task_id: params(req).task_id }) },
  { methode: 'GET', pfad: '/web-ui-koordinator-token', action: 'web_ui_koordinator_token', quelle: req => ({ ziel_identity_id: query(req).identity_id }) },
];

export async function registerAgentProfilRoutes(f: FastifyInstance, o: AgentProfilRoutesDeps = {}): Promise<void> {
  const validate = o.validateToken ?? validateToken;

  async function akteur(req: FastifyRequest, project: string): Promise<{ akteur: W1bAkteur; user: boolean }> {
    const text = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const auth = text ? await validate(text) : null;
    if (!auth) throw new RouteFehler('unauthorized', 401);
    if (auth.kind === 'session' && auth.scope === null) return { akteur: { art: 'user' }, user: true };
    const ausweis = req.headers['x-synapse-agent-token'];
    if (typeof ausweis !== 'string' || !ausweis) throw new RouteFehler('nur_user_oder_koordinator', 403);
    try {
      const anm = await pruefeAgentToken(ausweis, project, await leseAgentBezugModus(), { ids: [] });
      return { akteur: { art: 'identitaet', principal: agentPrincipalAusAnmeldung(anm) }, user: false };
    } catch {
      throw new RouteFehler('ausweis_ungueltig', 401);
    }
  }

  async function bearbeite(req: FastifyRequest, reply: FastifyReply, def: RouteDef): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    try {
      const project = params(req).project;
      if (!project) throw new RouteFehler('project_fehlt', 400);
      const wer = await akteur(req, project);
      const args = { ...def.quelle(req), project };
      const lauf = () => fuehreW1bAdminAus(def.action, args, { akteur: wer.akteur });
      const antwort = wer.user ? await mitUserHerkunft('web-ui-chat', lauf) : await lauf();
      if (antwort.success === false) {
        const code = typeof antwort.error === 'string' ? antwort.error : 'w1b_admin_fehler';
        return reply.code(w1bFehlerStatus(code)).send({ ...antwort, error: { code, ...(antwort.details ? { details: antwort.details } : {}) }, success: false });
      }
      return antwort;
    } catch (e) {
      if (e instanceof RouteFehler) return reply.code(e.status).send({ success: false, error: { code: e.code } });
      throw e;
    }
  }

  for (const def of ROUTEN) {
    f.route({ method: def.methode, url: '/api/projects/:project/agent-profile' + def.pfad, handler: (req, reply) => bearbeite(req, reply, def) });
  }
}

export async function agentProfilRoutes(fastify: FastifyInstance): Promise<void> {
  await registerAgentProfilRoutes(fastify);
}
