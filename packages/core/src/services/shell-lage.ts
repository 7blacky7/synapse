/**
 * P10-T36: Variable/Pfad/Lage ohne Ausführen des Befehls.
 * Native Dateisystemprobe ist austauschbar (Daemon/Container derselbe Helfer).
 */
import path from 'node:path';
import {pruefeDbKommando,gleichesDbZiel,type ShellDbFreigabe,type ShellDbErgebnis} from './shell-db-zuordnung.js';
import{gebundeneBuildLogFakten}from'./shell-build-log-fakten.js';
import{skriptFakten}from'./shell-inline-pruefung.js';
import {createHash}from'node:crypto';
import {parseShellText,type SicherungsShell,type ShellWort,type ShellTextKommando}from'./shell-sicherung-parser.js';
import {probeShellLage,type ShellProbeAnfrage,type ShellProbeAntwort}from'./shell-lage-probe.js';

export interface ShellLageKontext {
  /** Nur Workspace-Orchestrator, kein Shell-Requestparameter. */
  workspace_testdateien?:boolean;
  /** Nur vom bestehenden API/Job-Vertrag, niemals von Nutzerparametern. */
  datenbank_freigabe?:ShellDbFreigabe;
  shell?: SicherungsShell; os?: 'linux'|'windows'|'macos'|'wsl';
  cwd: string; project_root: string; env?: Record<string,string|undefined>;
  variablen?: Record<string,string|undefined>;
  env_vollstaendig?: boolean; drive_cwds?: Record<string,string>; scratchpad_roots?:string[];
  inspect?: boolean; probe?: (input:ShellProbeAnfrage)=>Promise<ShellProbeAntwort>;
}
export interface ShellLageZiel {
  ausdruck: string; rolle: 'ziel'|'quelle'; expandiert?: string; pfad?: string;
  kanonisch?: string; existiert?: boolean; naechster_elternpfad?: string;
  links: Array<{pfad:string;ziel:string}>; mount?: string;
  wurzel?: boolean; im_projekt?: boolean; unc: boolean; geraet: boolean;
  glob: boolean; leere_variablen: string[]; ungeklaert: string[];
}
export interface ShellLage {
  /** Private target evidence only; never grants execution without accepted confirmation. */
  datenbank_testzuordnung?:{project:string;ziele:ShellDbFreigabe['ziele']};
  datenbank_pruefung?:boolean;
  datenbank_abgewiesen?:boolean;
  datenbank_zuordnung?:{project:string;ziele:ShellDbFreigabe['ziele'];grund:'projekt_eigene_db'};
  shell: SicherungsShell; os: ShellLageKontext['os']; cwd:string; project_root:string;
  variablen: Array<{name:string;wert?:string;gesetzt:boolean}>;
  kommandos?:ShellTextKommando[]; quell_hash?:string; inline_pfade?:Record<string,boolean|undefined>;scratchpad_roots?:string[];testprojekt?:boolean;
  build_log?:{belege:Array<{pfad:string;kanonisch:string;scope:string}>;hash:string};ziele:ShellLageZiel[]; ungeklaert:string[]; sicher_aufloesbar:boolean; hinweis?:string; hash:string;
}
interface Wert {wert?:string;leer:string[];probleme:string[];glob:boolean;}
const basis=(s:string)=>s.replace(/\\/g,'/').split('/').pop()??s;
const winOs=(o:ShellLageKontext)=>o.os==='windows';
const pArt=(o:ShellLageKontext)=>winOs(o)?path.win32:path.posix;

function expandiere(
  w:ShellWort, shell:SicherungsShell, env:Record<string,string|undefined>,
  ctx:ShellLageKontext, vars:Map<string,{name:string;wert?:string;gesetzt:boolean}>,
):Wert {
  const raw=w.raw??w.text;
  let result='',quote='',glob=false;const leer:string[]=[],probleme:string[]=[];
  const value=(name:string,environment=false)=>{
    const source=shell==='pwsh'&&environment?(ctx.env??{}):env;
    const key=shell==='pwsh'||shell==='cmd'?Object.keys(source).find(k=>k.toLowerCase()===name.toLowerCase()):name;
    const v=key===undefined?undefined:source[key];
    vars.set(name,{name,wert:v,gesetzt:v!==undefined});
    if(v===undefined) {
      if(!ctx.env_vollstaendig){probleme.push('variable_unbekannt:'+name);return '';}
      leer.push(name);return '';
    }
    if(v==='')leer.push(name);
    return v;
  };
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    const esc=shell==='pwsh'?String.fromCharCode(96):shell==='cmd'?'^':'\\';
    if(quote!=="'" && c===esc) {
      if(i+1>=raw.length){probleme.push('escape_unvollstaendig');break;}
      // In Bash-Doublequotes sind nur diese Backslash-Escapes aktiv.
      if(shell!=='pwsh'&&shell!=='cmd'&&quote==='"'&&!/[$"\\\n]/.test(raw[i+1])&&raw.charCodeAt(i+1)!==96){result+=c;continue;}
      result+=raw[++i];continue;
    }
    if(quote==="'"){
      if(c==="'"&&shell==='pwsh'&&raw[i+1]==="'"){result+="'";i++;continue;}
      if(c==="'")quote='';else result+=c;continue;
    }
    if(c==="'"&&shell!=='cmd'&&quote===''){quote="'";continue;}
    if(c==='"'){quote=quote==='"'?'':'"';continue;}
    if(c==='$'&&shell!=='cmd'){
      if(raw[i+1]==='('){probleme.push('substitution_nicht_ausgefuehrt');break;}
      const m=raw.slice(i).match(/^\$\{([A-Za-z_]\w*)(?:(:-|-)([^}]*))?\}|^\$(?:env:)?([A-Za-z_]\w*)/i);
      if(!m){probleme.push('variable_syntax_unbekannt');break;}
      const name=m[1]??m[4];const v=value(name,/^\$env:/i.test(m[0]));
      if(!quote && shell!=='pwsh' && /\s/.test(v))probleme.push('word_split_nicht_statisch');
      if(!quote && /[*?[]/.test(v))glob=true;
      if(m[2] && (m[2]===':-'&&v===''||m[2]==='-'&&vars.get(name)?.gesetzt===false)) {
        if(/[\\$()]/.test(m[3]??''))probleme.push('default_nicht_statisch');
        result+=m[3]??'';
      } else result+=v;
      i+=m[0].length-1;continue;
    }
    if(shell==='cmd'&&c==='%'){
      const m=raw.slice(i).match(/^%([A-Za-z_]\w*)%/);
      if(!m){probleme.push('cmd_expansion_unbekannt');break;}
      result+=value(m[1]);i+=m[0].length-1;continue;
    }
    if(shell==='cmd'&&c==='!'){probleme.push('cmd_delayed_expansion_unbekannt');break;}
    if(c.charCodeAt(0)===96&&shell!=='pwsh'&&shell!=='cmd'){probleme.push('substitution_nicht_ausgefuehrt');break;}
    if(c==='~'&&i===0&&!quote){
      if(raw.length>1 && raw[1]!=='/'){probleme.push('tilde_benutzer_nicht_statisch');break;}
      result+=value('HOME');continue;
    }
    if(!quote && /[*?[]/.test(c))glob=true;
    result+=c;
  }
  if(quote)probleme.push('quote_unvollstaendig');
  return {wert:probleme.length?undefined:result,leer:[...new Set(leer)],probleme,glob};
}
function absolut(value:string,cwd:string,ctx:ShellLageKontext,problems:string[]):string|undefined{
  const p=pArt(ctx);
  if(winOs(ctx)&&/^[A-Za-z_][\w-]+:/.test(value)){problems.push('provider_nicht_dateisystem');return undefined;}
  if(winOs(ctx)){
    const drive=value.match(/^([A-Za-z]):(?![\\/])/);
    if(drive) {
      const letter=drive[1].toUpperCase();
      const base=ctx.drive_cwds?.[letter]??(cwd.slice(0,2).toUpperCase()===letter+':'?cwd:undefined);
      if(!base){problems.push('laufwerks_cwd_unbekannt');return undefined;}
      return p.resolve(base,value.slice(2));
    }
    if(/^[\\/](?![\\/])/.test(value))return p.normalize(p.parse(cwd).root+value.replace(/^[\\/]+/,''));
  }
  return p.resolve(cwd,value);
}
function innerhalb(root:string,target:string,p:typeof path.posix,windows:boolean):boolean{
  const rel=p.relative(windows?root.toLowerCase():root,windows?target.toLowerCase():target);
  return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);
}
function targets(k:ShellTextKommando):Array<{word:ShellWort;rolle:'ziel'|'quelle';literal?:boolean}>{
  let a=k.argv.slice();
  while(/^(?:env|sudo|command|exec|nohup)$/.test(basis(a[0]?.text??''))){
    const wrapper=basis(a.shift()!.text);
    while(a.length&&(a[0].text.startsWith('-')||wrapper==='env'&&/^[A-Za-z_]\w*=/.test(a[0].text))){
      const opt=a.shift()!.text;if(opt==='--')break;
      if(/^(?:-u|-g|-C|--user|--group|--unset|--chdir)$/.test(opt))a.shift();
    }
  }
  const b=basis(a.shift()?.text??'').toLowerCase();
  const found:Array<{word:ShellWort;rolle:'ziel'|'quelle';literal?:boolean}>=[];
  if(b==='dd')for(const w of a)if(w.text.startsWith('of='))found.push({word:{...w,text:w.text.slice(3),raw:w.raw?.slice(3)},rolle:'ziel'});
  if(/^(?:rm|rmdir|del|erase|rd|remove-item|ri|mv|cp|chmod|chown|find|rsync|rclone|robocopy)(?:\.exe)?$/.test(b)){
    let literal=false,stop=false;const positional:ShellWort[]=[];
    for(let i=0;i<a.length;i++){
      const w=a[i],t=w.text;
      if(!stop&&t==='--'){stop=true;continue;}
      if(!stop&&/^-literalpath$/i.test(t)){literal=true;if(a[i+1])positional.push(a[++i]);continue;}
      if(!stop&&/^-path$/i.test(t)){if(a[i+1])positional.push(a[++i]);continue;}
      if(!stop&&(t.startsWith('-')||/^(?:robocopy|del|rmdir|rd)(?:\.exe)?$/.test(b)&&t.startsWith('/'))){
        if(b==='find')break;
        if(/^(?:--exclude|--include|--filter|-e|-f|-o|--chmod|--chown)$/.test(t))i++;
        continue;
      }
      positional.push(w);
    }
    if(/^(?:chmod|chown)$/.test(b))positional.shift();
    if(b==='rclone'&&/^(?:sync|copy|move)$/.test(positional[0]?.text??''))positional.shift();
    positional.forEach((word,i)=>found.push({word,rolle:/^(?:rsync|rclone|robocopy|cp|mv)$/.test(b)&&i===0?'quelle':'ziel',literal}));
  }
  for(const word of k.umleitungs_woerter??k.umleitungen.map(text=>({text,dynamisch:/[$%]/.test(text)})))
    found.push({word,rolle:'ziel',literal:false});
  return found;
}
export async function ermittleShellLage(command:string,ctx:ShellLageKontext):Promise<ShellLage>{
  const shell=ctx.shell??(winOs(ctx)?'cmd':'sh'),p=pArt(ctx);
  const buildLog=await gebundeneBuildLogFakten(command,{...ctx,shell},ctx.probe??probeShellLage);
  const tree=parseShellText(buildLog?.text??command,shell);
  const vars=new Map<string,{name:string;wert?:string;gesetzt:boolean}>();
  const actualEnv={...(ctx.env??{})};
  ctx={...ctx,env:actualEnv};
  const env:Record<string,string|undefined>=shell==='pwsh'?{...(ctx.variablen??{}),PWD:ctx.cwd,HOME:actualEnv.USERPROFILE??actualEnv.HOME}:{...actualEnv,PWD:ctx.cwd};
  if(env.CD===undefined)env.CD=ctx.cwd;
  let cwd=ctx.cwd;
  const ziele:ShellLageZiel[]=[];
  const inline_pfade:Record<string,boolean|undefined>={};
  let testprojekt=false;try{const db=new URL(ctx.env?.DATABASE_URL??'');testprojekt=db.port==='5433'&&!['/synapse','/postgres','/'].includes(db.pathname);}catch{/* keine verifizierte Spielwiese */}
  const scratchpad_roots=ctx.scratchpad_roots??(ctx.env?.SYNAPSE_SCRATCHPAD_ROOT?[ctx.env.SYNAPSE_SCRATCHPAD_ROOT]:[]);
  const kommandos:ShellTextKommando[]=[];
  const dbErgebnisse:ShellDbErgebnis[]=[];
  let dbKontextVerifiziert=true;
  let verifizierteTestdateien=0;
  const mitQuelle=tree.kommandos.some(k=>/^(?:source|\.)$/.test(k.argv[0]?.text??''));let autoExport=false;
  const unresolved=tree.ungeklart.filter(x=>!['ziel_dynamisch','dynamisches_programm'].includes(x));
  const probe=ctx.probe??probeShellLage;
  const expand=(w:ShellWort,art:SicherungsShell,local=env)=>expandiere(w,art,local,ctx,vars);
  const assignment=(name:string,words:ShellWort[],art:SicherungsShell)=>{
    let val:Wert;
    if(words[0]?.text.toLowerCase()==='join-path'){
      const args=words.slice(1).filter(w=>!/^-(?:path|childpath)$/i.test(w.text));
      const parts=args.map(w=>expand(w,art));
      const problems=parts.flatMap(w=>w.probleme);
      if(parts.length!==2)problems.push('join_path_argumente');
      if(parts.some(w=>w.wert===''))problems.push('join_path_leeres_segment');
      if(parts[1]?.wert && (p.isAbsolute(parts[1].wert)||/^[A-Za-z]:/.test(parts[1].wert)))problems.push('join_path_absolute_komponente');
      val={wert:problems.length?undefined:p.join(...parts.map(x=>x.wert??'')),leer:parts.flatMap(w=>w.leer),probleme:problems,glob:false};
    }else if(words.length===1 && (art!=='pwsh'||/^["'$]|^[-+]?\d/.test(words[0].raw??words[0].text)))val=expand(words[0],art);
    else val={probleme:['zuweisung_nicht_statisch'],leer:[],glob:false};
    env[name]=val.wert;if(val.probleme.length)unresolved.push(...val.probleme);
  };
  for(const k of tree.kommandos){
    const art=k.shell??shell;
    if(['&&','||','|','|&','&','(',')','{','}'].includes(k.nach??''))unresolved.push('scope_nicht_verifiziert');
    const local={...env};
    for(const w of k.zuweisungen??[]){
      const m=(w.raw??w.text).match(/^([A-Za-z_]\w*)=([\s\S]*)$/);
      if(m){if(mitQuelle&&m[1]==='DATABASE_URL')testprojekt=false;const v=expand({text:m[2],raw:m[2],dynamisch:true},art,local);local[m[1]]=v.wert;if(!k.argv.length&&!['|','|&','&'].includes(k.nach??''))env[m[1]]=v.wert;unresolved.push(...v.probleme);}
    }
    const psAssignment=art==='pwsh'?k.argv.map(w=>w.raw??w.text).join(' ').match(/^\$(env:)?([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/i):null;
    if(psAssignment){
      const rhs=parseShellText('value '+psAssignment[3],'pwsh');
      const words=rhs.kommandos.length===1?rhs.kommandos[0].argv.slice(1):[];
      assignment(psAssignment[2],words,art);
      if(psAssignment[1]){actualEnv[psAssignment[2]]=env[psAssignment[2]];delete env[psAssignment[2]];}
      continue;
    }
    if(art==='cmd'&&k.argv[0]?.text.toLowerCase()==='set'){
      const raw=k.argv.slice(1).map(w=>w.text).join(' ');
      const m=raw.match(/^([A-Za-z_]\w*)=([\s\S]*)$/);
      if(m)assignment(m[1],[{text:m[2],raw:m[2],dynamisch:/[%!]/.test(m[2])}],art);
      else unresolved.push('cmd_set_unbekannt');
      continue;
    }
    // Strukturiert weitergeben: keine erneute Shell-Auswertung expandierter Werte.
    const aufgeloest=(w:ShellWort):ShellWort=>{
      const v=expand(w,art,local);
      unresolved.push(...v.probleme);
      return {...w,text:v.wert??w.text,dynamisch:v.wert===undefined};
    };
    const projected:ShellTextKommando={
      argv:k.argv.map(aufgeloest),
      umleitungen:(k.umleitungs_woerter??k.umleitungen.map(text=>({text,dynamisch:false}))).map(w=>{const a=aufgeloest(w);return a.text===''&&w.dynamisch?{...a,text:w.text,dynamisch:true}:a;}).map(w=>w.text),
      shell:art,nach:k.nach,
      ...(k.inline_skript?{inline_skript:{...k.inline_skript,
        text:k.inline_skript.argv_index!==undefined?aufgeloest(k.argv[k.inline_skript.argv_index]).text:
          k.inline_skript.expansion?expand({text:k.inline_skript.text,
            raw:String.fromCharCode(34)+k.inline_skript.text.replaceAll(String.fromCharCode(34),String.fromCharCode(92,34))+String.fromCharCode(34),
            dynamisch:true},art,local).wert??k.inline_skript.text:k.inline_skript.text}}:{}),
    };
    let verifizierteDatei=false;
    const programm=basis(projected.argv[0]?.text??'').toLowerCase();
    if(/^(?:node)(?:\.exe)?$/.test(programm)&&!projected.inline_skript&&projected.argv[1]&&!projected.argv[1].text.startsWith('-')&&!projected.argv.some(w=>w.dynamisch)&&ctx.inspect!==false){
      const datei=p.resolve(cwd,projected.argv[1].text);
      const q=(await probe({cwd,testdatei:datei,projekt_root:ctx.project_root})).testdatei;
      if(q&&q.pfad===datei&&/^[a-f0-9]{64}$/.test(q.sha256)){
        verifizierteDatei=true;
        const rel=ctx.workspace_testdateien===true&&typeof q.kanonisch==='string'?p.relative(ctx.project_root,q.kanonisch).replace(/\\/g,'/'):undefined;
        const workspaceTest=rel!==undefined&&!p.isAbsolute(rel)&&!rel.startsWith('../')&&
          /^(?:packages\/[^/]+\/tests\/|scripts\/test-[^/]+(?:$|\/))/.test(rel);
        projected.inline_skript={sprache:'node',text:q.text,expansion:false,testprojekt:false,...(workspaceTest?{workspace_testdatei:true}:{})};
      }
    }
    if(verifizierteDatei)verifizierteTestdateien++;
    if(projected.inline_skript){
      projected.inline_skript.cwd=cwd;
      if(mitQuelle)projected.inline_skript.testprojekt=testprojekt;
      if(ctx.inspect!==false){
        const paths=[...new Set(skriptFakten(projected.inline_skript.text,projected.inline_skript.sprache,{cwd,projekt_root:ctx.project_root,os:ctx.os})
          .map(k=>k.skript_operation?.ziel).filter((x):x is string=>typeof x==='string').map(x=>p.resolve(cwd,x)))].slice(0,64);
        if(paths.length){
          const roots=[ctx.project_root,...scratchpad_roots];
          const native=await probe({cwd,pfade:[...paths,...roots]});
          for(let i=0;i<paths.length;i++){
            const n=native.pfade[i];
            inline_pfade[paths[i]]=n?.kanonisch&&!n.fehler?roots.some((root,j)=>innerhalb(native.pfade[paths.length+j]?.kanonisch??root,n.kanonisch!,p,winOs(ctx))):undefined;
          }
        }
      }
    }
    if(ctx.datenbank_freigabe)dbErgebnisse.push(pruefeDbKommando(projected,local,ctx.datenbank_freigabe));
    if(projected.argv.length||projected.umleitungen.length)kommandos.push(projected);
    const cmd=expand(k.argv[0]??{text:'',dynamisch:false},art,local);
    if(cmd.probleme.length)unresolved.push(...cmd.probleme);
    if(/^(?:export|unset)$/.test(cmd.wert??'')&&projected.argv.slice(1).some(w=>/^(?:DATABASE_URL|PG\w*)(?:=|$)/i.test(w.text)))dbKontextVerifiziert=false;
    if(mitQuelle&&/^(?:export|unset)$/.test(cmd.wert??'')&&projected.argv.slice(1).some(w=>/^(?:DATABASE_URL)(?:=|$)/.test(w.text)))testprojekt=false;
    if(art==='sh'||art==='bash'){
      if(cmd.wert==='set'&&projected.argv.length===2){if(projected.argv[1].text==='-a')autoExport=true;if(projected.argv[1].text==='+a')autoExport=false;}
      if(/^(?:source|\.)$/.test(cmd.wert??'')){
        const file=projected.argv[1],pfad=file&&!file.dynamisch?p.resolve(cwd,file.text):undefined;
        let verified=false,dbVerified=false;
        if(pfad&&projected.argv.length===2&&!(k.zuweisungen?.length)&&!k.umleitungen.length&&!['&&','||','|','|&','&'].includes(k.nach??'')&&ctx.inspect!==false){
          const q=(await probe({cwd,umgebungsdatei:pfad})).umgebungsdatei;
          // Zusatznachweis nur gegen vertrauenswürdige Registry/Test-Konfiguration.
          if(q&&q.pfad===pfad&&/^[a-f0-9]{64}$/.test(q.sha256)&&(autoExport||q.exportiert)&&q.datenbank_ziel&&ctx.datenbank_freigabe?.ziele.some(z=>gleichesDbZiel(z,q.datenbank_ziel!))){
            const z=q.datenbank_ziel;
            env.DATABASE_URL='postgresql://'+encodeURIComponent(z.user)+'@'+z.host+':'+z.port+'/'+encodeURIComponent(z.datenbank);
            actualEnv.DATABASE_URL=env.DATABASE_URL;
            verified=true;dbVerified=true;
          }
          if(q&&q.pfad===pfad&&/^[a-f0-9]{64}$/.test(q.sha256)&&q.testprojekt&&q.port==='5433'&&q.datenbank==='synapse_test'&&(autoExport||q.exportiert)){
            projected.umgebungsquelle={pfad,sha256:q.sha256,testprojekt:true,port:q.port,datenbank:q.datenbank};testprojekt=true;verified=true;
          }
        }
        if(!dbVerified)dbKontextVerifiziert=false;
        if(!verified){testprojekt=false;unresolved.push('lage_nicht_sicher_aufloesbar');}
      }
    }
    if(cmd.wert==='eval'||art!=='sh'&&art!=='bash'&&/^(?:source|\.)$/.test(cmd.wert??''))unresolved.push('lage_nicht_sicher_aufloesbar');
    if(/^(?:node|python[\d.]*)(?:\.exe)?$/.test(cmd.wert??'')&&!projected.inline_skript)unresolved.push('inline_oder_script_lage_unbekannt');
    if(art!==shell)unresolved.push('interpreter_scope_nicht_verifiziert');
    if(/^(?:cd|set-location)$/i.test(cmd.wert??'')){
      const val=expand(k.argv[1]??{text:'$HOME',raw:'$HOME',dynamisch:true},art,local);
      const errors=val.probleme.slice(),next=val.wert===undefined?undefined:absolut(val.wert,cwd,ctx,errors);
      let ok=false;
      if(next&&ctx.inspect!==false){
        const info=(await probe({cwd,pfade:[next]})).pfade[0];
        if(info?.existiert&&info.verzeichnis&&!info.fehler){cwd=info.kanonisch??next;ok=true;}
      }
      if(!ok)unresolved.push('cd_nicht_verifiziert',...errors);
      continue;
    }
    for(const t of targets({...k,argv:k.argv.map((w,i)=>i===0&&cmd.wert!==undefined?{...w,text:cmd.wert}:w)})){
      const val=expand(t.word,art,local);
      const errors=val.probleme.slice();
      let resolved=val.wert===undefined?undefined:absolut(val.wert,cwd,ctx,errors);
      if(val.wert===''){errors.push('ziel_leer');resolved=undefined;}
      const glob=!t.literal&&(val.glob||art==='pwsh'||art==='cmd' ? /[*?[]/.test(val.wert??''):false);
      const unc=winOs(ctx)&&/^\\\\[^?.\\]/.test(resolved??'');
      const device=winOs(ctx)?/^\\\\[?.]\\/.test(resolved??''):/^\/dev(?:\/|$)/.test(resolved??'');
      const r:ShellLageZiel={ausdruck:t.word.raw??t.word.text,rolle:t.rolle,expandiert:val.wert,pfad:resolved,
        links:[],unc,geraet:device,glob,leere_variablen:val.leer,ungeklaert:errors};
      if(resolved){
        const first=glob?resolved.search(/[*?[]/):-1;
        const inspectPath=first>=0?(resolved.slice(0,first).endsWith(p.sep)?resolved.slice(0,first):p.dirname(resolved.slice(0,first))):resolved;
        const base=p.normalize(inspectPath||p.parse(resolved).root);
        r.wurzel=base===p.parse(base).root;
        r.im_projekt=innerhalb(ctx.project_root,base,p,winOs(ctx));
        if(unc||device)errors.push('namespace_nicht_geprueft');
        else if(ctx.inspect!==false){
          const native=await probe({cwd,pfade:[base,ctx.project_root]});
          const n=native.pfade[0],root=native.pfade[1]?.kanonisch??ctx.project_root;
          if(n?.fehler)errors.push('dateisystem:'+n.fehler);
          if(n){r.kanonisch=n.kanonisch;r.existiert=glob?undefined:n.existiert;r.naechster_elternpfad=n.naechster_elternpfad;r.links=n.links;r.mount=n.mount;
            if(n.kanonisch)r.im_projekt=innerhalb(root,n.kanonisch,p,winOs(ctx));}
        }
      }
      ziele.push(r);unresolved.push(...errors);
    }
  }
  const interpreterDateien=tree.kommandos.filter(k=>/^(?:node|python[\d.]*)(?:\.exe)?$/i.test(basis(k.argv[0]?.text??''))&&!k.inline_skript).length;
  const ungeklaert=[...new Set(unresolved.filter(x=>x!=='interpreter_datei'||!interpreterDateien||interpreterDateien!==verifizierteTestdateien))];
  const sql=dbErgebnisse.filter(x=>x.betroffen);
  const dbEigene=ctx.datenbank_freigabe&&sql.length>0&&sql.every(x=>x.erlaubt)&&ungeklaert.length===0;
  const dbTestZiele=ctx.datenbank_freigabe&&!dbEigene&&dbKontextVerifiziert&&sql.length>0&&
    !ungeklaert.some(x=>/interpreter|script_datei|inline_oder_script|kontrollfluss|parser_grenze|lage_nicht_sicher_aufloesbar/.test(x))&&
    sql.every(x=>x.erlaubt&&x.ziele.length>0&&x.ziele.every(z=>z.datenbank==='synapse_test'&&z.port!=='5432'&&
      ctx.datenbank_freigabe!.live&&z.port!==ctx.datenbank_freigabe!.live!.port&&
      z.datenbank!==ctx.datenbank_freigabe!.live!.datenbank&&
      ctx.datenbank_freigabe!.ziele.some(t=>t.art==='test'&&gleichesDbZiel(t,z))))
    ?sql.flatMap(x=>x.ziele.map(z=>({...z,art:'test' as const}))):undefined;
  const base={shell,os:ctx.os,cwd:ctx.cwd,project_root:ctx.project_root,
    ...(dbTestZiele?{datenbank_testzuordnung:{project:ctx.datenbank_freigabe!.project,ziele:dbTestZiele}}:{}),
    ...(ctx.datenbank_freigabe&&sql.length?{datenbank_pruefung:true,...(!dbEigene?{datenbank_abgewiesen:true}:{})}:{}),
    ...(dbEigene?{datenbank_zuordnung:{project:ctx.datenbank_freigabe!.project,ziele:ctx.datenbank_freigabe!.ziele,grund:'projekt_eigene_db' as const}}:{}),
    ...(buildLog?{build_log:{belege:buildLog.belege,hash:buildLog.hash}}:{}),
    quell_hash:createHash('sha256').update(command).digest('hex'),
    sicher_aufloesbar:ungeklaert.length===0,...(ungeklaert.length?{hinweis:'Lage nicht sicher auflösbar'}:{}),
    ...(kommandos.some(k=>k.inline_skript)?{scratchpad_roots,testprojekt,...(ctx.inspect!==false?{inline_pfade}:{})}:{}),
    variablen:[...vars.values()].sort((a,b)=>a.name.localeCompare(b.name)),kommandos,ziele,ungeklaert};
  return {...base,hash:createHash('sha256').update(JSON.stringify(base)).digest('hex')};
}
