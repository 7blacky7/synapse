/** P16-T15: begrenzter TS-Worker; Paketcache und virtuelle PG-Quellen, kein Emit. */
import { parentPort } from 'node:worker_threads';
import path from 'node:path';
import ts from 'typescript';
import { aenderungsBereiche } from './file-diff.js';
import type { PruefDatei } from './plan-befunde.js';
import type { TypAuftrag, TypPruefung, TypRohBefund } from './typen-pruefung.js';

interface PaketCache {
  basis?: ts.Program;
  schatten?: ts.Program;
  quellen: Map<string,{text:string;optionen:string;sf:ts.SourceFile}>;
}
const cache = new Map<string,PaketCache>();
const norm = (p:string) => path.resolve(p).replace(/\\/g,'/');
const leer = (status:TypPruefung['status'],hinweis?:string):TypPruefung =>
  ({status,dauer_ms:0,befunde:[],altlasten:0,dateien:[],vollstaendig:status==='fertig',fehlende_module:[],betroffene_aufrufer:[],...(hinweis?{hinweis}:{})});

/** Nur Abhängigkeiten und Compiler-Libs kommen von der Platte, nie Projekt-Quelltexte. */
function hostFuer(root:string,texte:Map<string,string>,paket:PaketCache,optionen:ts.CompilerOptions):ts.CompilerHost {
  const host=ts.createCompilerHost(optionen,true);
  const disk=ts.sys;
  const imRoot=(p:string)=>norm(p).startsWith(norm(root)+'/');
  const extern=(p:string)=>/\/node_modules\//.test(norm(p)) || imRoot(p) && /\.d\.[cm]?ts$/.test(p) && /\/dist\//.test(norm(p));
  const read=(p:string)=>texte.get(norm(p)) ?? (extern(p)?disk.readFile(p):undefined);
  const exists=(p:string)=>texte.has(norm(p)) || extern(p)&&disk.fileExists(p);
  const dirs=new Set<string>();
  for(const f of texte.keys()) for(let d=path.dirname(f); imRoot(d) || norm(d)===norm(root); d=path.dirname(d)) {
    dirs.add(norm(d)); if(norm(d)===norm(root)) break;
  }
  host.readFile=read;
  host.fileExists=exists;
  host.directoryExists=p=>dirs.has(norm(p)) || extern(path.join(p,'__probe__')) && (disk.directoryExists?.(p)??false);
  host.getDirectories=p=>[...new Set([
    ...[...dirs].filter(d=>norm(path.dirname(d))===norm(p)).map(d=>path.basename(d)),
    ...(extern(path.join(p,'__probe__')) ? disk.getDirectories(p):[]),
  ])];
  host.getCurrentDirectory=()=>root;
  host.realpath=p=>texte.has(norm(p))?norm(p):(disk.realpath?.(p)??p);
  host.getSourceFile=(f,lang)=>{
    const text=read(f);
    if(text===undefined) return undefined;
    const key=norm(f);
    const optionen=JSON.stringify(lang);
    const alt=paket.quellen.get(key);
    if(alt?.text===text && alt.optionen===optionen) return alt.sf;
    const sf=ts.createSourceFile(f,text,lang,true);
    paket.quellen.set(key,{text,optionen,sf});
    return sf;
  };
  host.writeFile=()=>{};
  return host;
}

function configFuer(file:string,texte:Map<string,string>,root:string):string|null {
  for(let dir=path.dirname(file); ;dir=path.dirname(dir)) {
    const config=norm(path.join(dir,'tsconfig.json'));
    if(texte.has(config)) return config;
    if(norm(dir)===norm(root) || !norm(dir).startsWith(norm(root)+'/')) return null;
  }
}
function konfig(config:string,texte:Map<string,string>,host:ts.CompilerHost):ts.ParsedCommandLine {
  const gelesen=ts.readConfigFile(config,host.readFile);
  if(gelesen.error) throw new Error(ts.flattenDiagnosticMessageText(gelesen.error.messageText,' '));
  const parseHost:ts.ParseConfigHost={
    useCaseSensitiveFileNames:true,readFile:host.readFile,fileExists:host.fileExists,
    readDirectory:(dir,ext,exclude,include,depth)=> {
      // TypeScripts eigener Match-Algorithmus erhält include/exclude/globs wie ein echter Paket-Build.
      const api=ts as typeof ts & {matchFiles:(p:string,e:readonly string[]|undefined,x:readonly string[]|undefined,i:readonly string[]|undefined,c:boolean,cwd:string,d:number|undefined,
        entries:(p:string)=>{files:string[];directories:string[]},real:(p:string)=>string)=>string[]};
      return api.matchFiles(dir,ext,exclude,include,true,host.getCurrentDirectory(),depth,p=>{
        const prefix=norm(p)+'/';
        const files:string[]=[],directories=new Set<string>();
        for(const f of texte.keys()) if(f.startsWith(prefix)) {
          const suffix=f.slice(prefix.length),slash=suffix.indexOf('/');
          if(slash<0) files.push(suffix); else directories.add(suffix.slice(0,slash));
        }
        return {files,directories:[...directories]};
      },p=>p);
    },
  };
  return ts.parseJsonConfigFileContent(gelesen.config,parseHost,path.dirname(config),{noEmit:true},config);
}
interface Diagnose {d:ts.DiagnosticWithLocation;file:string;zeile:number;spalte:number;key:string}
function diagnosen(prog:ts.Program,ziele:Set<string>):Diagnose[] {
  const out:Diagnose[]=[];
  for(const p of ziele) {
    const sf=prog.getSourceFile(p); if(!sf || /\.(?:js|mjs|cjs)$/.test(p) && !prog.getCompilerOptions().checkJs) continue;
    for(const d of prog.getSemanticDiagnostics(sf)) {
      if(!d.file || d.start===undefined || d.category!==ts.DiagnosticCategory.Error) continue;
      const pos=d.file.getLineAndCharacterOfPosition(d.start);
      const meldung=ts.flattenDiagnosticMessageText(d.messageText,' ');
      // Zeilenverschiebungen werden nicht zu neuen Altlasten; Multiset erhält Mehrfachdiagnosen.
      const ausschnitt=d.file.text.slice(d.start,d.start+(d.length??0));
      out.push({d:d as ts.DiagnosticWithLocation,file:norm(d.file.fileName),zeile:pos.line+1,spalte:pos.character+1,
        key:JSON.stringify([norm(d.file.fileName),d.code,meldung,ausschnitt])});
    }
  }
  return out;
}
function neuGegen(neu:Diagnose[],alt:Diagnose[]):Diagnose[] {
  const zaehler=new Map<string,number>();
  for(const d of alt) zaehler.set(d.key,(zaehler.get(d.key)??0)+1);
  return neu.filter(d=>{const n=zaehler.get(d.key)??0;if(n){zaehler.set(d.key,n-1);return false;}return true;});
}

/** Wie P16-T8: Diff-Bereiche stufenweise in Op-Reihenfolge zuschalten, paketweit. */
function stufen(dateien:PruefDatei[],root:string) {
  return dateien.map(d=>{
    const alt=d.basis.split('\n'),neu=d.ergebnis.split('\n');
    const ops=d.ops;
    // Benachbarte Ersetzungen gleicher Länge bleiben an Op-Grenzen getrennt.
    // Sonst würde ein gemeinsamer Diff-Hunk erst mit der letzten Op zugeschaltet.
    const bereiche=aenderungsBereiche(alt,neu).flatMap(b=>{
      if(b.a1-b.a0!==b.b1-b.b0) return [b];
      const grenzen=[...new Set([b.b0,b.b1,...ops.flatMap(o=>o.spannen.flatMap(s=>s)).filter(n=>n>b.b0&&n<b.b1)])].sort((x,y)=>x-y);
      return grenzen.slice(0,-1).map((s,i)=>({a0:b.a0+s-b.b0,a1:b.a0+grenzen[i+1]-b.b0,b0:s,b1:grenzen[i+1]}));
    });
    const rang=bereiche.map(b=>{
      const beruehrt=ops.filter(o=>o.spannen.some(([s,e])=>s<e&&b.b0<b.b1?s<b.b1&&e>b.b0:s<=b.b1&&e>=b.b0));
      return Math.max(...(beruehrt.length?beruehrt:ops).map(o=>o.op_index));
    });
    return {d,file:norm(path.join(root,d.file_path)),rang,text:(st:number)=>{
      if(d.geloescht && ops.some(o=>o.op_index<=st)) return undefined;
      const out:string[]=[];let pa=0;
      bereiche.forEach((b,i)=>{out.push(...alt.slice(pa,b.a0),...(rang[i]<=st?neu.slice(b.b0,b.b1):alt.slice(b.a0,b.a1)));pa=b.a1;});
      out.push(...alt.slice(pa));return out.join('\n');
    }};
  });
}

export function pruefeTypAuftrag(a:TypAuftrag):TypPruefung {
  const start=Date.now(),frist=start+a.budget_ms;
  const basis=new Map(a.quellen.map(r=>[norm(path.join(a.root,r.file_path)),r.content]));
  for(const d of a.dateien) {
    const f=norm(path.join(a.root,d.file_path));
    // Neue Dateien gehören nicht zur Basis (leerer Inhalt wäre ein anderer Modulzustand).
    if(d.basis==='' && !a.quellen.some(r=>r.file_path===d.file_path)) basis.delete(f);else basis.set(f,d.basis);
  }
  const schatten=new Map(basis);
  for(const d of a.dateien) {
    const f=norm(path.join(a.root,d.file_path));
    if(d.geloescht) schatten.delete(f);else schatten.set(f,d.ergebnis);
  }
  const ziele=new Set(a.ziele.map(p=>norm(path.join(a.root,p))));
  const configs=new Set([...ziele].map(f=>configFuer(f,schatten,a.root)??configFuer(f,basis,a.root)).filter((p):p is string=>p!==null));
  const out:TypPruefung={...leer('fertig'),dateien:a.ziele};
  if(!configs.size) return {...leer('nicht_verfuegbar','Kein Paket-tsconfig im Code-Index.'),dateien:a.ziele};
  const schritte=stufen(a.dateien,a.root);
  for(const config of configs) {
    const key=a.project+'|'+a.root+'|'+config;
    const paket:PaketCache=cache.get(key)??{quellen:new Map()};
    cache.delete(key);cache.set(key,paket);
    while(cache.size>4) cache.delete(cache.keys().next().value!);
    const bauen=(texte:Map<string,string>,old?:ts.Program)=>{
      const h=hostFuer(a.root,texte,paket,{});
      const k=konfig(config,texte,h);
      if(k.errors.some(d=>d.code!==18003)) throw new Error(k.errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '));
      const host=hostFuer(a.root,texte,paket,k.options);
      return ts.createProgram({rootNames:k.fileNames,options:k.options,host,oldProgram:old,projectReferences:k.projectReferences});
    };
    const alt=bauen(basis,paket.basis);paket.basis=alt;
    const neu=bauen(schatten,paket.schatten);paket.schatten=neu;
    const inPaket=new Set([...ziele].filter(f=>configFuer(f,schatten,a.root)===config || configFuer(f,basis,a.root)===config));
    const vorher=diagnosen(alt,inPaket),nachher=diagnosen(neu,inPaket);
    const neue=a.basisvergleich ? neuGegen(nachher,vorher) : nachher;
    out.altlasten+=a.basisvergleich ? nachher.length-neue.length : 0;
    // Ohne installierte Standardtypen/Abhängigkeiten sind Typvergleiche nicht belastbar.
    const externFehler=(x:Diagnose)=>{
      if(x.d.code===2688)return true;
      if(![2307,7016].includes(x.d.code))return false;
      const modul=/'([^']+)'/.exec(ts.flattenDiagnosticMessageText(x.d.messageText,' '))?.[1];
      return !!modul && !modul.startsWith('.') && !path.isAbsolute(modul);
    };
    const umgebung=[...vorher,...nachher].filter(externFehler);
    const optionen=[...alt.getOptionsDiagnostics(),...neu.getOptionsDiagnostics()];
    if(umgebung.length || optionen.some(d=>d.code===2688) || alt.getGlobalDiagnostics().some(d=>d.code===2318)) {
      out.vollstaendig=false;
      out.fehlende_module.push(...umgebung.map(x=>{
        const text=ts.flattenDiagnosticMessageText(x.d.messageText,' ');
        return /'([^']+)'/.exec(text)?.[1] ?? text;
      }),...optionen.filter(d=>d.code===2688).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')));
      if(alt.getGlobalDiagnostics().some(d=>d.code===2318)) out.fehlende_module.push('TypeScript-Standardtypen');
      out.hinweis='Externe Typen fehlen; auf unaufgelösten Externa beruhende Diagnosen sperren nicht.';
    }
    // Unaufgelöste Externa sind eine Abdeckungslücke, kein Planfehler.
    const relevant=neue.filter(x=>!externFehler(x));
    const stufenIndizes=[...new Set(a.dateien.flatMap(d=>d.ops.map(o=>o.op_index)))].sort((x,y)=>x-y);
    const ursachen=new Map<string,number>();
    if(a.basisvergleich && relevant.length && stufenIndizes.length===1) for(const d of relevant) ursachen.set(d.key,stufenIndizes[0]);
    else if(a.basisvergleich && relevant.length) {
      let old=alt;
      for(const st of stufenIndizes) {
        if(Date.now()>=frist) return {...leer('zeitlimit'),dateien:a.ziele};
        const text=new Map(basis);
        for(const s of schritte) {
          const inhalt=s.text(st);
          if(inhalt===undefined) text.delete(s.file);else text.set(s.file,inhalt);
        }
        old=bauen(text,old);
        for(const d of neuGegen(diagnosen(old,inPaket),vorher)) if(!ursachen.has(d.key)) ursachen.set(d.key,st);
        if(relevant.every(d=>ursachen.has(d.key))) break;
      }
    }
    for(const d of relevant) {
      const opIndex=ursachen.get(d.key);
      const quelle=a.dateien.find(f=>f.ops.some(o=>o.op_index===opIndex));
      const op=quelle?.ops.find(o=>o.op_index===opIndex);
      // Keine erfundene Verursacherzuordnung bei nicht rekonstruierbaren Kombinationsfehlern.
      if(a.basisvergleich && (!quelle || !op)) {out.status='nicht_verfuegbar';out.vollstaendig=false;out.hinweis='Typursache nicht eindeutig rekonstruierbar.';continue;}
      const rel=path.relative(a.root,d.file).replace(/\\/g,'/');
      const zeilen:[number,number]=[Math.max(1,(op?.spannen[0]?.[0]??0)+1),Math.max(1,op?.spannen[0]?.[1]??1)];
      const befund:TypRohBefund={
        quelle:'typen',pruefer:'typen:typescript@'+ts.version,severity:'error',datei:rel,
        zeilen:[d.zeile,d.zeile],spalte:d.spalte,code:'TS'+d.d.code,
        was:ts.flattenDiagnosticMessageText(d.d.messageText,' '),
        warum:a.basisvergleich ? 'Diese Typdiagnose ist im Paket-Basisstand nicht vorhanden und entsteht erst durch den Plan.' : 'TypeScript meldet diesen Typfehler im aktuellen PG-Stand der Datei.',
        wie:'Typ beziehungsweise Signatur an der verursachenden Op und die betroffenen Aufrufer zusammen korrigieren.',
        wo:[],op_index:op?.op_index ?? null,agent_id:op?.agent_id ?? null,
        ...(op ? {entstanden_bei:{op_index:op.op_index,zeilen}} : {}),bemerkt_bei:{zeile:d.zeile,spalte:d.spalte},
      };
      out.befunde.push(befund);
      if(quelle && rel!==quelle.file_path) out.befunde.push({...befund,severity:'warning',
        code:'FOLGEFEHLER_TS'+d.d.code,was:'Folgefehler in anderer Datei: '+befund.was});
    }
    if(Date.now()>=frist) return {...leer('zeitlimit'),dateien:a.ziele};
    // Nicht mehr existierende Quellen aus dem begrenzten AST-Cache entfernen.
    for(const f of paket.quellen.keys()) if(!basis.has(f)&&!schatten.has(f)&&!f.includes('/node_modules/')) paket.quellen.delete(f);
  }
  out.fehlende_module=[...new Set(out.fehlende_module)];
  out.dauer_ms=Date.now()-start;
  return out;
}

parentPort?.on('message',(msg:{id:number;auftrag:TypAuftrag})=>{
  let ergebnis:TypPruefung;
  try {ergebnis=pruefeTypAuftrag(msg.auftrag);}
  catch(err){ergebnis=leer('nicht_verfuegbar',(err as Error).message);}
  parentPort!.postMessage({id:msg.id,ergebnis});
});
