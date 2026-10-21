/** P18-T84: Web-Zugang zum bestehenden Reverse-Vertrag, keine zweite Fachlogik. */
import type {FastifyInstance} from 'fastify';
import {fuehreReverseAus,REVERSE_DEFINITION,mitUserHerkunft,mitAgentToolAufruf} from '@synapse/core';
import {validateToken} from '../services/auth.js';
import {HAUPTAGENT_IDENTITAET_SCOPE} from '../services/agent-runtime/main-tool-profile.js';
const aktionen=new Set(['bindungen','eintrag','erkenntnis_liste','erkenntnis_get','erkenntnis_speichern','format_anhaengen']);
export async function reverseErkenntnisseRoutes(f:FastifyInstance,o:{validateToken?:typeof validateToken}={}):Promise<void>{
 const validate=o.validateToken??validateToken;
 f.post<{Params:{project:string};Body:Record<string,unknown>}>('/api/projects/:project/reverse-erkenntnisse',async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  const bearer=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization??''))?.[1];
  const auth=bearer?await validate(bearer):null;
  if(!auth)return reply.code(401).send({success:false,error:'unauthorized'});
  const raw=req.body;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!aktionen.has(String(raw.action)))return reply.code(400).send({success:false,error:'aktion_ungueltig'});
  // Authentifizierung niemals aus dem Body. Das URL-Projekt ist das Zugriffsziel.
  if(['token','agent_id','project','role'].some(k=>Object.hasOwn(raw,k)))return reply.code(400).send({success:false,error:'identitaet_nicht_im_body'});
  const args={...raw,project:req.params.project};
  if(auth.kind==='session'&&auth.scope===null)return mitUserHerkunft('web-ui-chat',()=>fuehreReverseAus({...args,agent_id:'user'}));
  const token=req.headers['x-synapse-agent-token'];
  if(typeof token!=='string'||!token)return reply.code(401).send({success:false,error:'ausweis_fehlt'});
  if(auth.scope!==null&&auth.scope!=='mcp:tools'&&!auth.scope.startsWith(HAUPTAGENT_IDENTITAET_SCOPE))return reply.code(403).send({success:false,error:'zugang_scope_ungeeignet'});
  // Derselbe Wrapper wie REST/stdio: Profil, Visum, Projektzugang und bezeugter Principal.
  return mitAgentToolAufruf('reverse',args,'reverse-erkenntnisse-web',async k=>{
   if(k.antwort?.success===false)return k.antwort;
   if(!k.principal)return {success:false,error:'ausweis_ungueltig'};
   if(auth.scope?.startsWith(HAUPTAGENT_IDENTITAET_SCOPE)&&auth.scope.slice(HAUPTAGENT_IDENTITAET_SCOPE.length)!==k.principal.identitaet.id)return {success:false,error:'ausweis_passt_nicht_zum_zugang'};
   return fuehreReverseAus(k.args);
  },token,new Set(Object.keys(REVERSE_DEFINITION.inputSchema.properties)));
 });
}
