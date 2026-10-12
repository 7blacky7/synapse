/** t76-A: begrenzte Sprachfakten für Literal-Buildschleifen, kein Shell-Interpreter. */
import path from'node:path';import{createHash}from'node:crypto';
import{parseShellText}from'./shell-sicherung-parser.js';import type{ShellLageKontext}from'./shell-lage.js';import type{ShellProbeAnfrage,ShellProbeAntwort}from'./shell-lage-probe.js';
export async function gebundeneBuildLogFakten(command:string,ctx:ShellLageKontext,probe:(input:ShellProbeAnfrage)=>Promise<ShellProbeAntwort>):Promise<{text:string;belege:Array<{pfad:string;kanonisch:string;scope:string}>;hash:string}|undefined>{
 if(ctx.inspect===false||ctx.os!=='linux'||ctx.shell&&!['sh','bash'].includes(ctx.shell)||command.length>32768)return;
 const loop=command.match(/^\s*for\s+([A-Za-z_]\w*)\s+in\s+([^;]+);\s*do\s+([\s\S]*);\s*done\s*$/);
 if(!loop)return;const key=loop[1],items=loop[2].trim().split(/\s+/);
 if(!items.length||items.length>16||!items.every(x=>/^@[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(x)))return;
 const original=parseShellText(loop[3],ctx.shell??'sh');
 if(original.kommandos.some(k=>(k.umleitungs_woerter??[]).some(w=>/[\x27\\\\]/.test(w.raw??w.text))))return;
 const bodies:string[]=[],belege:Array<{pfad:string;kanonisch:string;scope:string}>=[];
 for(const item of items){
  const transformed=item.replaceAll('/','_'),base=item.split('/').at(-1)!;
  const variable='\\$\\{?'+key+'\\}?';
  const tr=new RegExp('\\$\\(\\s*echo\\s+"?'+variable+'"?\\s*\\|\\s*tr\\s+/\\s+_\\s*\\)','g');
  const basename=new RegExp('\\$\\(\\s*basename\\s+"?'+variable+'"?\\s*\\)','g');
  const body=loop[3].replace(tr,transformed).replace(basename,base).replace(new RegExp('\\$'+key+'(?![A-Za-z0-9_])|\\$\\{'+key+'\\}','g'),item);
  // Keine unbekannte Substitution im Schreibziel; sonst bleiben alte Fakten erhalten.
  const tree=parseShellText(body,ctx.shell??'sh');
  let builds=0;
  for(const k of tree.kommandos){
   const words=k.argv.map(x=>x.text);let cmd=words.shift()??'';
   if(cmd==='nice'){if(words[0]==='-n'&&/^-?\d+$/.test(words[1]??'')){words.splice(0,2);}else return;cmd=words.shift()??'';}
   if(cmd==='ionice'){if(words[0]==='-c3')words.shift();else if(words[0]==='-c'&&words[1]==='3')words.splice(0,2);else return;cmd=words.shift()??'';}
   if(!['pnpm','echo','grep','head'].includes(cmd))return;
   if(cmd!=='pnpm'){if(k.umleitungen.length)return;continue;}
   if(words.length!==3||words[0]!=='--filter'||words[1]!==item||words[2]!=='build'||k.umleitungen.length!==1)return;
   if(belege.length>=64)return;builds++;
   const target=k.umleitungen[0];
   if(!/\.log$/.test(target)||target.includes('$')||/[?*[\]\0\r\n]/.test(target))return;
   const pfad=path.posix.resolve(ctx.cwd,target),name=path.posix.basename(pfad);
   if(!name.includes(transformed)&&!name.includes(base))return;
   const roots=[ctx.project_root,...ctx.scratchpad_roots??[],...(ctx.env?.SYNAPSE_SCRATCHPAD_ROOT?[ctx.env.SYNAPSE_SCRATCHPAD_ROOT]:[])];
   const native=await probe({cwd:ctx.cwd,pfade:[pfad,...roots,'/tmp']});const file=native.pfade[0];
   if(!file?.kanonisch||file.fehler||file.existiert&&file.eigener_benutzer!==true)return;
   const canonical=file.kanonisch;
   let scope='';
   for(let i=0;i<roots.length;i++){
    const root=native.pfade[i+1]?.kanonisch??roots[i],rel=path.posix.relative(root,canonical);
    if(rel===''||rel!=='..'&&!rel.startsWith('../')&&!path.posix.isAbsolute(rel)){scope=i===0?'projekt':'scratchpad';break;}
   }
   // Nur unmittelbar unter /tmp, konkreter paketgebundener *.log-Name eines Builds.
   const tmp=native.pfade[roots.length+1]?.kanonisch;
   if(!scope&&tmp&&path.posix.dirname(canonical)===tmp&&path.posix.basename(canonical)===name)scope='temp-build-log';
   if(!scope)return;
   belege.push({pfad,kanonisch:canonical,scope});
  }
  if(!builds)return;bodies.push(body);
 }
 const text=bodies.join(';\n');if(text.length>262144)return;
 return {text,belege,hash:createHash('sha256').update(JSON.stringify([command,text,belege])).digest('hex')};
}
