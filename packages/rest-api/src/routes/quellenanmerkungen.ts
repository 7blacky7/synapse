/** P22-T195: User-Sammelkorb. Wird ausschliesslich hinter dem bestehenden interaktiven User-Guard registriert. */
import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {
 getPool,AnmerkungFehler,ladeAnmerkungQuelle,leseAnmerkungenStand,listeQuellenanmerkungen,holeQuellenanmerkung,
 speichereQuellenanmerkungen,sendeZitatAnEmpfaenger,pinneUserEntscheidung,textMitZitaten,pruefeChatZitateAnfrage,
 postToInbox,mitAgentAufrufKontext,leseAgentBezugModus,setzeProfilProduktSchalter,spiegeleThoughtInTopf,type AnmerkungEntwurf,
} from '@synapse/core';
type R=Record<string,unknown>;
export async function quellenanmerkungenRoutes(app:FastifyInstance){
 const basis='/api/agent-runtimes/anmerkungen';
 app.get<{Params:{project:string}}>(basis+'/:project/stand',async(req,reply)=>{
  try{return await leseAnmerkungenStand(req.params.project);}catch{return reply.code(500).send({success:false,error:{message:'Anmerkungen sind nicht lesbar.'}});}
 });
 app.put<{Params:{project:string};Body:{aktiv:boolean}}>(basis+'/:project/stand',async(req,reply)=>{
  try{
   if(typeof req.body?.aktiv!=='boolean')throw new AnmerkungFehler('aktiv_ungueltig','Ein/Aus angeben.');
   await setzeProfilProduktSchalter({ebene:'projekt',project:req.params.project,funktion:'zeilen_anmerkungen',aktiv:req.body.aktiv,grund:'Web-UI Zeilen-Anmerkungen'}, {system:'user'});
   return await leseAnmerkungenStand(req.params.project);
  }catch(e){return antwortFehler(reply,e);}
 });
 app.get<{Params:{project:string;art:string;id:string};Querystring:{offset?:string}}>(basis+'/:project/quelle/:art/:id',async(req,reply)=>{
  try{
   const q=await ladeAnmerkungQuelle(req.params.project,req.params.art,req.params.id,undefined,false,true);
   const a=await listeQuellenanmerkungen(q.project,{art:q.art,quelle_id:q.id,status:'alle',offset:req.query.offset},true);
   return {...a,quelle:{project:q.project,art:q.art,id:q.id,anzeige_id:q.anzeige_id,titel:q.titel,text:q.text,hash:q.hash}};
  }catch(e){return antwortFehler(reply,e);}
 });
 app.get<{Params:{project:string;id:string}}>(basis+'/:project/eintrag/:id',async(req,reply)=>{
  try{return await holeQuellenanmerkung(req.params.project,req.params.id,true);}catch(e){return antwortFehler(reply,e);}
 });
 app.post<{Body:{project:string;vorgang:string;eintraege:AnmerkungEntwurf[];empfaenger?:string[];pin?:{project:string;art:string;id:string}}}>(basis+'/sammelkorb',async(req,reply)=>{
  const b=req.body;if(!b||typeof b.project!=='string'||typeof b.vorgang!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.vorgang)||!Array.isArray(b.eintraege)||(!b.empfaenger?.length&&!b.pin))return reply.code(400).send({success:false,error:{message:'Korb und Ziel angeben.'}});
  const db=await getPool().connect(),nachCommit:Array<()=>void>=[];
  try{
   await db.query('BEGIN');
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[String(b.vorgang)]);
   const key='sammelkorb',hash=createHash('sha256').update(JSON.stringify(b)).digest('hex');
   const alt=(await db.query<{inhalt_hash:string;ergebnis:R}>('SELECT inhalt_hash,ergebnis FROM quellenanmerkung_sendungen WHERE vorgang=$1 AND ziel=$2',[b.vorgang,key])).rows[0];
   if(alt){if(alt.inhalt_hash!==hash)throw new AnmerkungFehler('vorgang_konflikt','Vorgang bereits mit anderem Inhalt gespeichert.',409);await db.query('COMMIT');return alt.ergebnis;}
   const anmerkungen=await speichereQuellenanmerkungen(db,b.vorgang,b.eintraege,'user');
   const zitate=await Promise.all(b.eintraege.map(async e=>{
    const q=await ladeAnmerkungQuelle(e.project,e.art,e.quelle_id,db,false,true);
    return {art:e.art,id:q.anzeige_id,projekt:e.project,titel:q.titel,ausschnitt:e.ausschnitt,anmerkung:e.anmerkung};
   }));
   const z=await pruefeChatZitateAnfrage(zitate,b.project);
   if(!z.ok)throw new AnmerkungFehler(z.code,z.message,z.status);
   let zustellung:unknown=null,pin:unknown=null;
   if(b.empfaenger?.length){
    const modus=await leseAgentBezugModus();
    const r=await sendeZitatAnEmpfaenger({project:b.project,empfaenger:b.empfaenger,zitate},async(ziel,text)=>
     mitAgentAufrufKontext({bezug:{...modus,modus:'beide'},principal:null},()=>postToInbox('user',ziel,text,ziel.project,{transaktion:db,nachCommit})));
    if(!r.ok)throw new AnmerkungFehler(r.code,r.message,r.status);
    if(r.empfaenger.some(e=>e.fehler))throw new AnmerkungFehler('zustellung_fehlgeschlagen','Die Nachricht wurde nicht zugestellt.',503);
    zustellung=r;
   }
   if(b.pin){
    const p=await pinneUserEntscheidung({...b.pin,text:textMitZitaten('',z.zitate)},undefined,async e=>{
     // Derselbe Pin-Vertrag; nur sein PG-Write wird in die Sammelkorb-Transaktion aufgenommen.
     await db.query(`INSERT INTO thoughts(id,project,source,content,tags,task_id,timestamp) VALUES($1,$2,'user',$3,$4,$5,NOW())`,
      [b.vorgang,e.project,e.content,e.tags,e.task_id]);
     nachCommit.push(()=>{void spiegeleThoughtInTopf(e.project,{id:b.vorgang,source:'user',content:e.content,tags:e.tags}).then(r=>{if(r.fehler)console.error('[quellenanmerkungen] Pin-Topf-Nachlauf fehlgeschlagen');}).catch(()=>console.error('[quellenanmerkungen] Pin-Topf-Nachlauf fehlgeschlagen'));});
     return {id:b.vorgang};
    });
    if(!p.ok)throw new AnmerkungFehler(p.code,p.message,p.status);pin=p;
   }
   const ergebnis={success:true,anmerkungen,zustellung,pin,debug:{vorgang:b.vorgang,anzahl:anmerkungen.length,speicher:'postgresql'}};
   await db.query('INSERT INTO quellenanmerkung_sendungen(vorgang,ziel,inhalt_hash,ergebnis) VALUES($1,$2,$3,$4::jsonb)',[b.vorgang,key,hash,JSON.stringify(ergebnis)]);
   await db.query('COMMIT');for(const f of nachCommit)f();
   console.debug('[quellenanmerkungen]',{vorgang:b.vorgang,anzahl:anmerkungen.length,versand:!!zustellung,pin:!!pin});
   return ergebnis;
  }catch(e){await db.query('ROLLBACK');return antwortFehler(reply,e);}finally{db.release();}
 });
}
function antwortFehler(reply:import('fastify').FastifyReply,e:unknown){
 if(e instanceof AnmerkungFehler)return reply.code(e.status).send({success:false,error:{code:e.code,message:e.message}});
 console.error('[quellenanmerkungen] Vorgang fehlgeschlagen',e instanceof Error?e.name:'unbekannt');
 return reply.code(500).send({success:false,error:{message:'Anmerkungen konnten nicht verarbeitet werden. Der Entwurf bleibt erhalten.'}});
}
