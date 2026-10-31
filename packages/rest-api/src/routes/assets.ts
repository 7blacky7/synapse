/** P13-T24/A6: additive Assetfamilie, gleicher API-Zugang, Binärstream statt JSON-ReadAll. */
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {AssetKonfliktKern,AssetUploadKern,AssetManifestKern,assetProjektNutztShare,setzeAssetInspektionsModus,normalisiereSpeicherPfad,assetArt,AssetUploadFehler,AssetSpeicherFehler,API_CONTRACT_HEADER,apiCapabilitiesForClient,isProjectEnabled,ladeAssetProjektoptionen,leseAssetTransferGenerisch,meldeAssetQuellenFehlen,getAssetKonfiguration,loeseAssetProjektoptionen,
  meldeAssetPcStand,assetPcZustellung,pcZustellungFuerAsset,leseAssetPcZustellungSchalter,pruefePublishSperre,leseAssetPublishRecoverySchalter,
  inventarProjektIntern,raeumeReverseAltbestandAuf,leseAssetInternAufraeumenSchalter} from '@synapse/core';
import type {AssetMutationEingang,AssetUploadSitzung,AssetUploadEingang,AssetUploadKontext,AssetDownloadRange} from '@synapse/core';
import {validateToken} from '../services/auth.js';
import type {AuthTokenRow} from '../services/auth.js';

export interface AssetRouteAbhaengigkeiten {
  upload?:AssetUploadKern;
  manifest?:AssetManifestKern;
  konflikte?:AssetKonfliktKern;
  validateToken?:typeof validateToken;
  projektErlaubt?:(projekt:string,principal:AuthTokenRow)=>Promise<boolean>;
  /** P22-T237: Kern fuer User-Uploads in den Share (quelle share); Standard new AssetUploadKern({quelle:'share'}). */
  shareUpload?:AssetUploadKern;
  /** P22-T237: Schalter asset_pc_zustellung und Zustellstand je Asset (Standard aus core; injizierbar fuer Tests). */
  pcZustellungSchalter?:(projekt:string)=>Promise<{aktiv:boolean}>;
  pcZustellung?:(projekt:string,asset_id:string)=>Promise<{status:string;hinweis:string}|null>;
  /** P22-T206: Pruefen/Loesen der Publikationssperre und deren Schalter (Standard aus core; injizierbar fuer Tests). */
  publishSperre?:typeof pruefePublishSperre;
  publishRecoverySchalter?:(projekt:string)=>Promise<{aktiv:boolean}>;
}
export function assetSitzungAntwort(s:AssetUploadSitzung){
  return {id:s.id,bereich:s.bereich,ziel_ref:s.ziel_ref,logischer_pfad:s.logischer_pfad,groesse:s.groesse,sha256:s.sha256,
    offset:s.offset,status:s.status,lease_bis:s.lease_bis,...(s.ergebnis?{asset_id:s.ergebnis.asset_id,revision:s.ergebnis.revision,
      ...(s.ergebnis.konflikt?{konflikt:s.ergebnis.konflikt}:{})}:{})};
}
export function assetRange(header:string|undefined):AssetDownloadRange|undefined {
  if(header===undefined)return undefined;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if(!match||!match[1]&&!match[2])throw new AssetUploadFehler('range_ungueltig',416,'Genau ein gültiger Bytebereich erforderlich.');
  return total=>{
    if(total===0)throw new AssetUploadFehler('range_ungueltig',416,'Leere Datei hat keinen Bytebereich.');
    const number=(s:string)=>{const n=Number(s);if(!Number.isSafeInteger(n)||n<0)throw new AssetUploadFehler('range_ungueltig',416,'Ungültige Bereichszahl.');return n;};
    const offset=match[1]?number(match[1]):Math.max(0,total-number(match[2]));
    const end=match[1]?(match[2]?Math.min(total-1,number(match[2])):total-1):total-1;
    if(offset>=total||end<offset||!match[1]&&number(match[2])===0)throw new AssetUploadFehler('range_ungueltig',416,'Range außerhalb Datei.');
    return {offset,groesse:end-offset+1};
  };
}
export async function assetRequestKontext(request:FastifyRequest,projekt:string,schreiben=true,o:AssetRouteAbhaengigkeiten={}):Promise<AssetUploadKontext>{
    const token=/^Bearer\s+(.+)$/i.exec(String(request.headers.authorization??''))?.[1]?.trim();
    if(!token)throw new AssetUploadFehler('unauthorized',401,'Bearer-Token fehlt.');
    const principal=await (o.validateToken??validateToken)(token);
    if(!principal)throw new AssetUploadFehler('unauthorized',401,'Token ungültig/abgelaufen.');
    const daemon=principal.kind==='service'&&(principal.scope==='daemon'||principal.scope?.startsWith('daemon:'));
    const user=principal.kind==='access'||principal.kind==='session';
    if(principal.scope?.startsWith('compute-node:')||(!daemon&&!user)||schreiben&&!daemon)
      throw new AssetUploadFehler('token_nicht_erlaubt',403,'Diese Operation braucht eine Daemon-Identität; Compute-Ausweise sind ausgeschlossen.');
    const capabilities=apiCapabilitiesForClient(request.headers[API_CONTRACT_HEADER]);
    if(!capabilities)throw new AssetUploadFehler('vertrag_erforderlich',426,'API-Vertrag Version1 erforderlich.');
    if(!capabilities.features.includes('asset_sync'))throw new AssetUploadFehler('asset_sync_deaktiviert',503,'Asset-Sync nicht aktiviert.');
    const allowed=await (o.projektErlaubt??(async p=>isProjectEnabled(p)))(projekt,principal);
    if(!allowed)throw new AssetUploadFehler('projekt_verboten',403,'Projekt fehlt oder ist nicht freigegeben.');
    const host_id=daemon?(principal.scope==='daemon'?'token:'+principal.token_hash:principal.scope!.slice(7)):'user:'+principal.token_hash;
    if(!host_id)throw new AssetUploadFehler('host_ungueltig',403,'Daemon-Hostbindung fehlt.');
    return {bereich:'projekt',ziel_ref:projekt,host_id};
  }

export function createAssetsRoutes(o:AssetRouteAbhaengigkeiten={}):(f:FastifyInstance)=>Promise<void>{
  let upload=o.upload,manifestKern=o.manifest,konfliktKern=o.konflikte;
  const konflikte=()=>konfliktKern??=new AssetKonfliktKern();
  const manifest=()=>manifestKern??=new AssetManifestKern();
  const kern=()=>upload??=(new AssetUploadKern());
  const kontext=(request:FastifyRequest,projekt:string,schreiben=true)=>assetRequestKontext(request,projekt,schreiben,o);
  // P22-T237: Upload durch den User (Web-UI/Tool, host user:<hash>) direkt in den Projekt-Share, nur mit Schalter asset_pc_zustellung.
  // Quelle 'share' wie beim Share-Scanner (kein PC beteiligt); alle uebrigen Schreibwege bleiben Daemon-Pflicht. AUS = 403 wie bisher.
  let shareKern=o.shareUpload;
  const uploadKontext=async(request:FastifyRequest,projekt:string):Promise<AssetUploadKontext>=>{
    try{return await kontext(request,projekt);}
    catch(e){
      if(!(e instanceof AssetUploadFehler)||e.code!=='token_nicht_erlaubt')throw e;
      const c=await kontext(request,projekt,false);
      if(!c.host_id.startsWith('user:')||!(await (o.pcZustellungSchalter??leseAssetPcZustellungSchalter)(projekt)).aktiv)throw e;
      return c;
    }
  };
  const userUpload=(c:AssetUploadKontext)=>c.host_id.startsWith('user:');
  const uploadKern=(c:AssetUploadKontext)=>userUpload(c)?(shareKern??=new AssetUploadKern({quelle:'share'})):kern();
  async function run(reply:FastifyReply,fn:()=>Promise<unknown>){
    try{return await fn();}catch(e){
      if(e instanceof AssetUploadFehler)return reply.code(e.httpStatus).send({success:false,error:{code:e.code,message:e.message,...(e.details?{details:e.details}:{})}});
      if(e instanceof AssetSpeicherFehler)return reply.code(['konflikt','hash_falsch'].includes(e.code)?409:400).send({success:false,error:{code:e.code,message:e.message}});
      throw e;
    }
  }
  return async fastify=>{
    // Nur dieses gekapselte Plugin nimmt rohe Chunks; bestehende JSONparser bleiben erhalten.
    fastify.addContentTypeParser('application/octet-stream',(request,payload,done)=>done(null,payload));
    const base='/api/projects/:projekt/assets';
    fastify.get<{Params:{projekt:string};Querystring:{asset_id?:string;file_path?:string;limit?:string;offset?:string}}>(base+'/konflikte',async(req,reply)=>run(reply,async()=>{
      await kontext(req,req.params.projekt,false);
      return {success:true,...await konflikte().liste(req.params.projekt,{asset_id:req.query.asset_id,file_path:req.query.file_path,
        limit:req.query.limit===undefined?undefined:Number(req.query.limit),offset:req.query.offset===undefined?undefined:Number(req.query.offset)})};
    }));
    fastify.post<{Params:{projekt:string;asset_id:string};Body:{wahl?:unknown}}>(base+'/konflikte/:asset_id/loesen',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false),wahl=req.body?.wahl;
      if(wahl!=='pc'&&wahl!=='share')throw new AssetUploadFehler('eingang_ungueltig',400,'Wahl pc oder share erforderlich.');
      return {success:true,asset:await konflikte().loesen(c,req.params.asset_id,wahl,c.host_id)};
    }));
    // A8: only transfer budgets/direction, never server filesystem roots or storage keys.
    fastify.get<{Params:{projekt:string}}>(base+'/sync-optionen',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false),cfg=getAssetKonfiguration();
      const entry=await ladeAssetProjektoptionen(req.params.projekt),effective=entry?.wirksam??loeseAssetProjektoptionen(cfg,{});
      const generisch=await leseAssetTransferGenerisch(req.params.projekt);
      return {success:true,contractVersion:1,host:c.host_id,richtung:effective.richtung,policyRevision:entry?.policyRevision??0,
        chunkBytes:cfg.speicher.chunkBytes,parallelTransfers:cfg.speicher.parallelTransfers,timeoutMs:cfg.speicher.timeoutMs,retryMs:cfg.sync.retryIntervallMs,
        scanMs:cfg.sync.scanIntervallMs,maxDateiBytes:effective.maxDateiBytes,
        // P22-T238: ohne Einschraenkung KEINE Liste (Daemon nimmt dann jedes erkannte Format); generischeFormate = Schalter
        // asset_transfer_generisch (Formate ohne Inspector), generisch_debug zeigt Quelle/Ablauf/Lesefehler.
        ...(effective.alleTypen?{}:{erlaubteTypen:effective.erlaubteTypen}),alleTypen:effective.alleTypen,
        generischeFormate:generisch.aktiv,generisch_debug:{quelle:generisch.quelle,bis:generisch.bis,letzter_fehler:generisch.letzter_fehler}};
    }));
    // P22-T236: Daemon meldet lokal entfernte Assets ohne Share-Bytes (legacy_local), auch bei Asset-Sync AUS. Nur mit
    // Produkt-Schalter asset_index_wirklichkeit (sonst success:false funktion_aus); Share-Assets loescht der Transferweg.
    fastify.post<{Params:{projekt:string};Body:{pfade?:unknown}}>(base+'/quelle-fehlt',async(req,reply)=>run(reply,async()=>{
      await kontext(req,req.params.projekt);
      return meldeAssetQuellenFehlen(req.params.projekt,req.body?.pfade);
    }));
    // A8 setzt den Share-Writer vor dem ersten Upload, damit kein lokaler Inspector daneben schreibt.
    fastify.get<{Params:{projekt:string}}>(base+'/inspektionsmodus',async(req,reply)=>run(reply,async()=>{
      await kontext(req,req.params.projekt,false);
      return {success:true,modus:await assetProjektNutztShare(req.params.projekt)?'asset_sync':'legacy_local'};
    }));
    fastify.post<{Params:{projekt:string};Body:{modus?:unknown}}>(base+'/inspektionsmodus',async(req,reply)=>run(reply,async()=>{
      await kontext(req,req.params.projekt);
      const modus=req.body?.modus;
      if(modus!=='asset_sync'&&modus!=='legacy_local')throw new AssetUploadFehler('modus_ungueltig',400,'asset_sync oder legacy_local erforderlich.');
      try {await setzeAssetInspektionsModus(req.params.projekt,modus);}
      catch {throw new AssetUploadFehler('inspektionsmodus_konflikt',409,'Projektmodus nicht umschaltbar; Transportbindungen prüfen.');}
      return {success:true,modus};
    }));
    fastify.get<{Params:{projekt:string};Querystring:{cursor?:string;limit?:string}}>(base+'/manifest',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false);
      return {success:true,...await manifest().manifest(c,{cursor:req.query.cursor,limit:req.query.limit===undefined?undefined:Number(req.query.limit)})};
    }));
    fastify.get<{Params:{projekt:string};Querystring:{cursor?:string;limit?:string}}>(base+'/aenderungen',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false);
      return {success:true,...await manifest().aenderungen(c,{cursor:req.query.cursor,limit:req.query.limit===undefined?undefined:Number(req.query.limit)})};
    }));
    for(const art of ['verschieben','loeschen','wiederherstellen'] as const){
      fastify.post<{Params:{projekt:string};Body:AssetMutationEingang}>(base+'/'+art,async(req,reply)=>run(reply,async()=>{
        const c=await kontext(req,req.params.projekt);return {success:true,asset:await manifest().mutieren(c,art,req.body)};
      }));
    }

    // P22-T237: bestaetigter Share->PC-Stand nach jedem Daemon-Abgleich (nur Daemon; Schalter AUS = angenommen, nicht gespeichert).
    fastify.post<{Params:{projekt:string};Body:Record<string,unknown>}>(base+'/pc-stand',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt);
      const body=req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{};
      return {success:true,...await meldeAssetPcStand(c,body)};
    }));
    // P22-T237: Status-/Debug-Route der Zustellung Share -> Projektordner (Projekt, mit ?asset_id= je Asset).
    fastify.get<{Params:{projekt:string};Querystring:{asset_id?:string;limit?:string}}>(base+'/pc-zustellung',async(req,reply)=>run(reply,async()=>{
      await kontext(req,req.params.projekt,false);
      const z=await assetPcZustellung(req.params.projekt,{asset_id:req.query.asset_id,limit:req.query.limit===undefined?undefined:Number(req.query.limit)});
      // P22-T206: Zustand der Publikationssperre mit anzeigen (eine haengende Sperre blockiert jede Finalisierung).
      const sperre=z.aktiv?await (o.publishSperre??pruefePublishSperre)(req.params.projekt).catch(e=>({zustand:'unklar',grund:(e as Error).message})):undefined;
      return {success:true,...z,...(sperre?{publish_sperre:sperre}:{})};
    }));
    // P22-T206: Publikationssperre pruefen (GET, nur lesen) bzw. loesen (POST). Loesen nur mit User-Token, Schalter
    // asset_publish_recovery EIN, bestaetigt:true und grund (>= 10 Zeichen); eine Alt-Sperre ohne Besitzerangabe zusaetzlich nur
    // mit ohne_besitzer_nachweis:true (USER-FREIGABE). Die PG-Pruefung (keine aktive Finalisierung) gilt immer.
    // P22-T241: Inventar des Projekt-.intern (Ordner, Staging/Journal/Revisionen nach Herkunft, fremde Ordner). Nur lesen.
    fastify.get<{Params:{projekt:string};Querystring:{journal_limit?:string}}>(base+'/intern-inventar',async(req,reply)=>run(reply,async()=>{
      await kontext(req,req.params.projekt,false);
      const limit=req.query.journal_limit===undefined?undefined:Number(req.query.journal_limit);
      if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<0||limit>1_000_000))throw new AssetUploadFehler('limit_ungueltig',400,'journal_limit 0..1000000.');
      return {success:true,inventar:await inventarProjektIntern(req.params.projekt,{journalLimit:limit})};
    }));
    // P22-T241: Reverse-Altbestand im Projekt-.intern (nur Herkunft reverse_uebernehmen, abgeschlossene Sitzungen). Vorschau immer;
    // Ausfuehren nur User-Token + Schalter asset_intern_aufraeumen + bestaetigt:true + grund (USER-FREIGABE).
    fastify.post<{Params:{projekt:string};Body:{ausfuehren?:unknown;bestaetigt?:unknown;grund?:unknown}}>(base+'/reverse-altbestand',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false),b=req.body??{};
      if(!c.host_id.startsWith('user:'))throw new AssetUploadFehler('token_nicht_erlaubt',403,'Nur der User darf den Reverse-Altbestand bearbeiten.');
      const ausfuehren=b.ausfuehren===true;
      if(ausfuehren){
        if(b.bestaetigt!==true||typeof b.grund!=='string'||b.grund.trim().length<10)throw new AssetUploadFehler('bestaetigung_fehlt',400,'bestaetigt:true und grund (mind. 10 Zeichen) erforderlich.');
        if(!(await leseAssetInternAufraeumenSchalter(req.params.projekt)).aktiv)throw new AssetUploadFehler('schalter_aus',409,'Produkt-Schalter asset_intern_aufraeumen ist fuer dieses Projekt AUS.');
      }
      const bericht=await raeumeReverseAltbestandAuf(req.params.projekt,{ausfuehren,bestaetigt:b.bestaetigt===true});
      if(bericht.ausgefuehrt)console.warn('[asset-intern] '+req.params.projekt+': Reverse-Altbestand entfernt ('+bericht.staging.dateien+' Staging, '+bericht.journal.dateien+' Journal): '+String(b.grund).slice(0,200));
      return {success:true,bericht};
    }));
    fastify.get<{Params:{projekt:string}}>(base+'/publish-sperre',async(req,reply)=>run(reply,async()=>{
      await kontext(req,req.params.projekt,false);
      return {success:true,sperre:await (o.publishSperre??pruefePublishSperre)(req.params.projekt)};
    }));
    fastify.post<{Params:{projekt:string};Body:{bestaetigt?:unknown;grund?:unknown;ohne_besitzer_nachweis?:unknown}}>(base+'/publish-sperre',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false),b=req.body??{};
      if(!c.host_id.startsWith('user:'))throw new AssetUploadFehler('token_nicht_erlaubt',403,'Nur der User darf die Publikationssperre loesen.');
      if(b.bestaetigt!==true||typeof b.grund!=='string'||b.grund.trim().length<10)throw new AssetUploadFehler('bestaetigung_fehlt',400,'bestaetigt:true und grund (mind. 10 Zeichen) erforderlich.');
      if(!(await (o.publishRecoverySchalter??leseAssetPublishRecoverySchalter)(req.params.projekt)).aktiv)
        throw new AssetUploadFehler('schalter_aus',409,'Produkt-Schalter asset_publish_recovery ist fuer dieses Projekt AUS.');
      const sperre=await (o.publishSperre??pruefePublishSperre)(req.params.projekt,{ausfuehren:true,ohneBesitzerNachweis:b.ohne_besitzer_nachweis===true});
      console.warn('[asset-sperre] '+req.params.projekt+': manuelles Loesen ('+c.host_id.slice(0,12)+'...): '+sperre.zustand+' - '+String(b.grund).slice(0,200));
      return {success:true,sperre,grund:String(b.grund)};
    }));

    fastify.post<{Params:{projekt:string};Body:AssetUploadEingang}>(base+'/uploads',async(req,reply)=>run(reply,async()=>{
      const c=await uploadKontext(req,req.params.projekt);
      if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new AssetUploadFehler('eingang_ungueltig',400,'Uploadmetadaten fehlen.');
      return {success:true,upload:assetSitzungAntwort(await uploadKern(c).erstellen(c,req.body))};
    }));
    fastify.get<{Params:{projekt:string;id:string}}>(base+'/uploads/:id',async(req,reply)=>run(reply,async()=>{
      const c=await uploadKontext(req,req.params.projekt);return {success:true,upload:assetSitzungAntwort(await uploadKern(c).status(c,req.params.id))};
    }));
    fastify.put<{Params:{projekt:string;id:string};Querystring:{offset?:string}}>(base+'/uploads/:id/chunk',async(req,reply)=>run(reply,async()=>{
      const c=await uploadKontext(req,req.params.projekt),raw=req.headers['content-length'];
      if(req.headers['content-type']?.split(';')[0]!=='application/octet-stream'||typeof raw!=='string'||!/^\d+$/.test(raw))
        throw new AssetUploadFehler('stream_erforderlich',400,'Binärstream mit Content-Length erforderlich.');
      const offset=Number(req.query.offset??req.headers['x-synapse-upload-offset']),groesse=Number(raw);
      if(!Number.isSafeInteger(offset)||offset<0)throw new AssetUploadFehler('offset_konflikt',409,'Bestätigter Offset erforderlich.');
      const source=req.body as AsyncIterable<Uint8Array>;
      if(!source||typeof source[Symbol.asyncIterator]!=='function')throw new AssetUploadFehler('stream_erforderlich',400,'Binärstream fehlt.');
      return {success:true,upload:assetSitzungAntwort(await uploadKern(c).teil(c,req.params.id,offset,groesse,source))};
    }));
    fastify.post<{Params:{projekt:string;id:string}}>(base+'/uploads/:id/finalisieren',async(req,reply)=>run(reply,async()=>{
      const c=await uploadKontext(req,req.params.projekt),s=await uploadKern(c).finalisieren(c,req.params.id);
      // P22-T237: nur beim User-Upload den Zustellstand mitgeben (Daemon-Uploads kommen vom PC selbst).
      const pc=userUpload(c)&&s.ergebnis?.asset_id?await (o.pcZustellung??pcZustellungFuerAsset)(req.params.projekt,s.ergebnis.asset_id):null;
      return {success:true,upload:assetSitzungAntwort(s),...(pc?{pc_zustellung:pc}:{})};
    }));
    fastify.get<{Params:{projekt:string};Querystring:{asset_id?:string;pfad?:string;revision:string}}>(base+'/bytes',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false),result=await kern().bytes(c,req.query,assetRange(typeof req.headers.range==='string'?req.headers.range:undefined));
      reply.header('Content-Type','application/octet-stream').header('Content-Length',result.groesse).header('Accept-Ranges','bytes')
        .header('ETag','"'+result.sha256+'"').header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff')
        .header('Content-Disposition','attachment').header('x-synapse-asset-revision',result.revision);
      if(req.headers.range){reply.code(206);reply.header('Content-Range','bytes '+result.offset+'-'+(result.offset+result.groesse-1)+'/'+result.gesamt);}
      return reply.send(result.stream);
    }));
  };
}

/** A7 metadata events; old bodies never enter this dispatcher. No scan list implies deletion. */
export interface AssetFsEingang {
 projekt:string;typ:string;pfad?:string;event_id?:string;contractVersion?:number;host?:string;
 logischer_pfad?:string;alter_pfad?:string;sha256?:string;groesse?:number;erwartete_assetrevision?:string;
 upload_id?:string;asset_id?:string;asset?:boolean;restore_window_ms?:number;
}
let fsUpload:AssetUploadKern|undefined,fsManifest:AssetManifestKern|undefined;
export function istAssetFsEreignis(e:AssetFsEingang){
 return Boolean(e&&(e.asset===true||e.asset_id!==undefined||e.upload_id!==undefined||e.erwartete_assetrevision!==undefined
   ||typeof e.logischer_pfad==='string'&&assetArt(e.logischer_pfad)==='nur_asset'
   ||e.contractVersion!==undefined&&e.event_id!==undefined&&typeof e.pfad==='string'&&assetArt(e.pfad)==='nur_asset'));
}
export async function dispatchAssetFsEreignis(req:FastifyRequest,e:AssetFsEingang,o:AssetRouteAbhaengigkeiten={}){
 const c=await assetRequestKontext(req,e.projekt,true,o);
 if(e.contractVersion!==1||typeof e.event_id!=='string'||!e.event_id||e.event_id.length>200)
   throw new AssetUploadFehler('vertrag_erforderlich',400,'Assetereignis braucht Vertrag1 und Event-ID.');
 if(e.host!==undefined&&e.host!==c.host_id)throw new AssetUploadFehler('host_ungueltig',403,'Hostfeld weicht vom authentifizierten Daemon ab.');
 const logical=normalisiereSpeicherPfad(e.logischer_pfad??e.pfad??'');
 const mutation=o.manifest??(fsManifest??=new AssetManifestKern());
 if(['deleted','unlink','verschoben','moved','wiederhergestellt','restored'].includes(e.typ)){
   const art=['deleted','unlink'].includes(e.typ)?'loeschen':['verschoben','moved'].includes(e.typ)?'verschieben':'wiederherstellen';
   const id=e.asset_id??await mutation.assetNachPfad(c,art==='verschieben'?e.alter_pfad??'':logical,e.event_id);
   return {success:true,asset:await mutation.mutieren(c,art,{event_id:e.event_id,asset_id:id,basis_revision:e.erwartete_assetrevision!,
     ...(e.restore_window_ms!==undefined?{restore_window_ms:e.restore_window_ms}:{}),
     ...(art==='verschieben'?{alter_pfad:e.alter_pfad,pfad:logical}:{})})};
 }
 if(!['added','add','modified','change'].includes(e.typ))throw new AssetUploadFehler('eingang_ungueltig',400,'Unbekannter Assetereignistyp.');
 if(!e.upload_id)throw new AssetUploadFehler('upload_erforderlich',409,'Neue Bytes müssen über eine bestätigte Uploadsitzung übertragen werden.');
 const upload=o.upload??(fsUpload??=new AssetUploadKern()),s=await upload.status(c,e.upload_id);
 if(s.logischer_pfad!==logical||e.sha256!==s.sha256||e.groesse!==s.groesse||e.erwartete_assetrevision!==s.auftrag.basis_revision)
   throw new AssetUploadFehler('revision_konflikt',409,'Ereignis passt nicht zu bestätigtem Uploadauftrag.');
 return {success:true,upload:assetSitzungAntwort(await upload.finalisieren(c,e.upload_id))};
}

export const assetsRoutes=createAssetsRoutes();
