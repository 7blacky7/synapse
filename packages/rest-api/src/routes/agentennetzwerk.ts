import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listeProjekte, pruefeAgentToken, ausweisProjekteStatus } from '@synapse/core';
import { validateToken } from '../services/auth.js';
import type { NetzwerkSicht } from '../services/agentennetzwerk.js';
import { ladeAgentennetzwerk, ladeNetzwerkDatengrundlage } from '../services/agentennetzwerk.js';
/** Bestehender Auth- und Ausweisweg; ohne belegten Akteur kein globaler Datenzugriff. */
export async function netzwerkSicht(req:FastifyRequest):Promise<NetzwerkSicht|null> {
 const token=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization??''))?.[1]?.trim();
 const auth=token ? await validateToken(token) : null;
 if(!auth || !['session','access','service'].includes(auth.kind)) return null;
 const ausweis=req.headers['x-synapse-agent-token'];
 const registry=(await listeProjekte()).map(p=>p.name);
 if(typeof ausweis==='string' && ausweis){
  try {
   const p=await pruefeAgentToken(ausweis), i=p.identitaet;
   if(auth.scope?.startsWith('agent:identitaet:') && auth.scope.slice('agent:identitaet:'.length)!==i.id) return null;
   if(auth.scope?.startsWith('hauptagent:identitaet:') && auth.scope.slice('hauptagent:identitaet:'.length)!==i.id) return null;
   if(i.rolle==='main')return {projekte:registry,projektlose:true,identity_id:i.id};
   const stand=await ausweisProjekteStatus(i.id,i.project);
   const mehr=stand.schalter as {aktiv?:boolean}|undefined;
   const projekte=mehr?.aktiv && Array.isArray(stand.projekte) ? (stand.projekte as Array<{project:string;zugang:string}>).filter(z=>z.zugang!=='abgelaufen').map(z=>z.project) : [];
   const erlaubt=new Set([i.project,...projekte]);
   return {projekte:registry.filter(p=>erlaubt.has(p)),projektlose:false,identity_id:i.id};
  } catch {return null;}
 }
 // Agenten- und Spezialservice-Scopes sind niemals ein User-Zugang.
 if((auth.kind==='session'||auth.kind==='access') && !auth.scope?.startsWith('agent:') && !auth.scope?.startsWith('hauptagent:'))
  return {projekte:registry,projektlose:true,identity_id:null};
 return null;
}
/** Initialsnapshot und Wiederabgleich nach SSE-Hinweis; begrenzt, metadaten-only. */
export async function agentennetzwerkRoutes(app: FastifyInstance): Promise<void> {
 app.get<{Params:{name:string}; Querystring:{nur?:string; umfang?:string}}>('/api/projects/:name/agentennetzwerk', async (request, reply) => {
  reply.header('Cache-Control','no-store');
  try {
   const nur = request.query.nur;
   const globalerAbruf = nur === 'projekt_aktivitaeten' || request.query.umfang === 'global';
   const sicht:NetzwerkSicht|null = globalerAbruf ? await netzwerkSicht(request) : {projekte:[request.params.name],projektlose:false,identity_id:null};
   if(!sicht) return reply.code(401).send({success:false,error:{message:'Akteur nicht authentifiziert'}});
   if(globalerAbruf && !sicht.projekte.includes(request.params.name)) return reply.code(403).send({success:false,error:{message:'Projekt nicht sichtbar'}});
   if (nur === 'aktuelle_tasks' || nur === 'projekt_aktivitaeten') return await ladeNetzwerkDatengrundlage(request.params.name, nur, sicht);
   if (nur !== undefined) return reply.code(400).send({success:false,error:{message:'Unbekannter Abruf'}});
   if (request.query.umfang !== undefined && request.query.umfang !== 'projekt' && request.query.umfang !== 'global') return reply.code(400).send({success:false,error:{message:'Unbekannter Umfang'}});
   return await ladeAgentennetzwerk(request.params.name, request.query.umfang === 'global' ? 'global' : 'projekt', sicht);
  }
  catch { return reply.code(503).send({ success:false,error:{message:'Agentennetzwerk derzeit nicht erreichbar'} }); }
 });
}
