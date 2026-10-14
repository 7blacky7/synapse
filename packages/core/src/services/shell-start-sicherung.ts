/**
 * P10-T37: feste Startentscheidung und gemeinsame bestehende Rollenprüfung.
 * Reine Funktion; führt weder Originalbefehl noch Vorschau aus.
 */
import {createHash}from'node:crypto';
import path from'node:path';
import{skriptFakten}from'./shell-inline-pruefung.js';
import {pruefeShellText,normalisiereShellKommando,strengereShellStufe,SHELL_SICHERE_GERAETE,type ShellSicherungsKatalog,type ShellAntwortEintrag,type ShellStufe,type ShellTrefferGefahr}from'./shell-sicherung.js';
import os from'node:os';
import{stelleShellRueckfrage,loeseShellRueckfrageEin,type ShellBestaetigungEingabe,type ShellDemaskierung}from'./shell-rueckfrage.js';
import {parseShellText,type SicherungsShell}from'./shell-sicherung-parser.js';
import type{ShellLage,ShellLageZiel}from'./shell-lage.js';
import{darfKoordinatorOderUser}from'./rollen-pruefung.js';
import{LIVE_SCHREIBEND}from'./shell-db-zuordnung.js';
export interface ShellBestaetigung {
  grund:string; befehl_hash:string; lage_hash:string; regelversion:string;
}
export interface ShellStartEingabe {
  /** Privater Workspace-Ausführungsweg; nie aus Clientdaten übernehmen. */
  workspace_testdateien?:boolean;
  project:string; command:string; lage:ShellLage; agent_id?:string|null;
  rechner?:string; bestaetigt?:ShellBestaetigung|null;
  /** P10-T73: Bestaetigung einer Rueckfrage durch den aufrufenden Agenten selbst. */
  bestaetigung?:ShellBestaetigungEingabe|null;
  geschuetzte_pids?:number[]; geschuetzte_namen?:string[];
}
export interface ShellSicherungsAntwort {
  ausgefuehrt:boolean; stufe:'hinweis'|'anleitung'|'rueckfrage'|'sperre'; error?:string;
  risiko:string; lage:ShellLage; sicher:string; danach:string; trotzdem:string;
  bestaetigungsdaten:Omit<ShellBestaetigung,'grund'>;
  /** P10-T73: nur bei stufe rueckfrage ohne gueltige Bestaetigung. */
  bestaetigung_id?:string; gueltig_bis?:string;
}
export interface ShellStartEntscheidung {
  darf_starten:boolean; antwort?:ShellSicherungsAntwort;
  /** Laeuft trotzdem; nur Warnhinweis (User-Vorgabe 14.10.2026). */
  hinweis?:{stufe:'hinweis';risiko:string;danach:string;sicher:string};
  audit:{agent_id:string|null;grund:string|null;befehl_hash:string;lage_hash:string;
    regelversion:string;stufe:string;entscheidung:'erlaubt'|'bestaetigt'|'abgewiesen';zeit:string;
    bestaetigung_id?:string;demaskierung?:Omit<ShellDemaskierung,'grund'>&{grund:string}};
}
/** P10-T73: true, wenn das Ziel an einem sicheren Ort liegt (Testordner/Scratchpad, Projekt bzw. Build-/Testsegment). */
function zielSicher(pfad:string|undefined,lage:ShellLage,g:ShellTrefferGefahr,z?:ShellLageZiel):boolean{
  const win=lage.os==='windows',p=win?path.win32:path.posix;
  if(pfad&&SHELL_SICHERE_GERAETE.test(pfad))return true;
  if(!pfad||z&&(z.ungeklaert.length||z.leere_variablen.length))return false;
  const rel=(root:string):string|undefined=>{
    const r=p.relative(win?root.toLowerCase():root,win?pfad.toLowerCase():pfad);
    return r!=='..'&&!r.startsWith('..'+p.sep)&&!p.isAbsolute(r)?r:undefined;
  };
  // Testordner = Temp-Verzeichnis des pruefenden Rechners (Windows-Temp nur, wenn auch hier Windows laeuft).
  const temp=[...(win?(process.platform==='win32'?[os.tmpdir()]:[]):[os.tmpdir(),'/tmp']),...(lage.scratchpad_roots??[])];
  if(temp.some(t=>{const r=rel(t);return r!==undefined&&r!=='';}))return true;
  const imProjekt=rel(lage.project_root);
  if(imProjekt===undefined)return false;
  if(g.ziel==='ausserhalb_projekt')return true;
  return imProjekt!==''&&imProjekt.split(p.sep).some(t=>(g.sichere_segmente??[]).some(s=>{try{return new RegExp(s,'i').test(t);}catch{return false;}}));
}
/** P10-T73: Ortsbedingung eines gefaehrlichen Treffers gegen die Lage; ohne Ortsbedingung immer gefaehrlich. */
function gefahrGilt(g:ShellTrefferGefahr,lage:ShellLage):boolean{
  if(!g.ziel)return true;
  const kandidaten=new Set(g.kandidaten.flatMap(x=>[x,x.replace(/^(?:of|if)=/,'')]));
  const zugeordnet=new Set<string>();
  for(const z of lage.ziele){
    if(!kandidaten.has(z.ausdruck)&&!(z.expandiert!==undefined&&kandidaten.has(z.expandiert)))continue;
    zugeordnet.add(z.ausdruck);if(z.expandiert!==undefined)zugeordnet.add(z.expandiert);
    if(z.rolle!=='ziel')continue;
    if(!zielSicher(z.kanonisch??z.pfad,lage,g,z))return true;
  }
  const p=lage.os==='windows'?path.win32:path.posix;
  // H1 (fail-closed): Kandidaten ohne Lage-Ziel (getrennte Flags, Starterprogramme, Aliase ...) selbst einordnen.
  // Was sich nicht sicher aufloesen laesst (Variable, Verzeichniswechsel), gilt als gefaehrlich.
  const cdImBefehl=(lage.kommandos??[]).some(k=>/^(?:cd|pushd|popd|chdir|set-location|sl)$/i.test(basename(k.argv[0]?.text??'')));
  for(const roh of g.kandidaten){
    if(roh.startsWith('-')||roh.startsWith('/')&&lage.os==='windows'&&/^\/[a-z?]+$/i.test(roh)||zugeordnet.has(roh)||/^if=/.test(roh))continue;
    const k=roh.replace(/^of=/,'');
    if(zugeordnet.has(k)||SHELL_SICHERE_GERAETE.test(k))continue;
    if(!k||cdImBefehl||/[$`%]/.test(k)||/^~/.test(k))return true;
    if(lage.os!=='windows'&&/^(?:[A-Za-z]:[\\/]|\\\\)/.test(k))return true;
    if(!zielSicher(p.resolve(lage.cwd,k),lage,g))return true;
  }
  for(const s of g.skript_ziele??[])if(!zielSicher(p.resolve(lage.cwd,s),lage,{...g,ziel:'ausserhalb_projekt'}))return true;
  return false;
}
export function regelVersion(k:ShellSicherungsKatalog):string{
  const stable={regeln:k.regeln.slice().sort((a,b)=>a.id.localeCompare(b.id)),
    antworten:k.antworten.slice().sort((a,b)=>a.id.localeCompare(b.id)),
    risiko_verben:k.risiko_verben.slice().sort((a,b)=>a.id.localeCompare(b.id))};
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
const basename=(s:string)=>s.replace(/\\/g,'/').split('/').pop()?.toLowerCase()??s.toLowerCase();
function lageKommandos(o:ShellStartEingabe){
  return o.lage.quell_hash===createHash('sha256').update(o.command).digest('hex')?o.lage.kommandos:undefined;
}
function selbstschaden(o:ShellStartEingabe):string|undefined {
  const pids=new Set(o.geschuetzte_pids??[]),names=new Set((o.geschuetzte_namen??[]).map(x=>x.toLowerCase()));
  for(const k of (lageKommandos(o)??parseShellText(o.command,o.lage.shell).kommandos).flatMap(k=>k.inline_skript?skriptFakten(k.inline_skript.text,k.inline_skript.sprache,{project:o.project,cwd:o.lage.cwd,testprojekt:k.inline_skript.testprojekt??o.lage.testprojekt,inline_pfade:o.lage.inline_pfade,scratchpad_roots:o.lage.scratchpad_roots,projekt_root:o.lage.project_root,os:o.lage.os}):[k]).map(normalisiereShellKommando)){
    const words=k.argv.map(w=>w.text);let name=basename(words.shift()??'');
    while(/^(?:sudo|env|command|exec|nohup)$/.test(name)){
      while(words.length&&(words[0].startsWith('-')||/^[A-Za-z_]\w*=/.test(words[0])))words.shift();
      name=basename(words.shift()??'');
    }
    const script=/^(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?)$/.test(name)
      ? words.find(w=>!w.startsWith('-')):name;
    if(/^(?:context-handoff\.sh|cc-handoff)$/.test(basename(script??'')))
      return 'Context-Handoff über die Synapse-Shell würde ihre Prozesskette beenden. Den Handoff im eigenen Agenten-Harness ausführen.';
    let targets:string[]=[];
    if(name==='kill'){
      let options=true;
      for(let i=0;i<words.length;i++){
        const w=words[i];if(options&&w==='--'){options=false;continue;}
        if(options&&/^(?:-s|--signal|-n)$/.test(w)){i++;continue;}
        if(options&&/^-[0-9]+$/.test(w)&&(w==='-1'||pids.has(Math.abs(Number(w)))))targets.push(w);
        if(options&&w.startsWith('-'))continue;targets.push(w);
      }
    }else if(/^(?:taskkill(?:\.exe)?|stop-process)$/.test(name)){
      words.forEach((w,i)=>{if(/^(?:\/pid|-id)$/i.test(w)&&words[i+1])targets.push(...words[i+1].split(','));});
    }
    if(targets.some(t=>t==='-1'||/^-?\d+$/.test(t)&&pids.has(Math.abs(Number(t)))))
      return 'Der Signalbefehl trifft den Daemon oder seine Elternkette. Den vorgesehenen Neustart beim Koordinator anfordern.';
    if(/^(?:pkill|killall|taskkill(?:\.exe)?|stop-process)$/.test(name)&&
      words.some(w=>names.has(w.toLowerCase())))
      return 'Der Prozessname umfasst den Daemon oder seine Elternkette. Den vorgesehenen Neustart beim Koordinator anfordern.';
  }
  return undefined;
}
function pfadQuote(s:string,shell:SicherungsShell):string|undefined{
  if(/[\u0000-\u001f\u007f]/.test(s))return undefined;
  if(shell==='pwsh')return "'"+s.replace(/'/g,"''")+"'";
  if(shell==='cmd')return /[%!"^&|<>]/.test(s)?undefined:'"'+s+'"';
  return "'"+s.replace(/'/g,"'\\''")+"'";
}
function vorschau(a:ShellAntwortEintrag|undefined,o:ShellStartEingabe,k:ShellSicherungsKatalog):string{
  const shell=o.lage.shell;const fallback=shell==='cmd'?'cd':shell==='pwsh'?'Get-Location':'pwd';
  const template=a?.sicher[shell];if(!template)return fallback;
  let bad=false;
  const text=template.replace(/\{\{([A-Za-z_]\w*)\}\}/g,(_all,name:string)=>{
    if(name!=='ziel'||a?.platzhalter[name]!=='pfad'){bad=true;return '';}
    const candidates=o.lage.ziele.filter(x=>x.rolle==='ziel');
    if(candidates.length!==1||candidates[0].ungeklaert.length||candidates[0].glob){bad=true;return '';}
    const value=candidates[0].kanonisch??candidates[0].pfad;
    if(!value||!(o.lage.os==='windows'?path.win32:path.posix).isAbsolute(value)){bad=true;return '';}
    const q=pfadQuote(value,shell);if(!q){bad=true;return '';}return q;
  });
  if(bad||/\{\{|\}\}/.test(text))return fallback;
  const check=pruefeShellText(text,{shell,project:o.project,os:o.lage.os,rechner:o.rechner,katalog:k});
  return check.stufe==='laeuft'&&!check.risiko_verb&&!check.ungeklaert.length?text:fallback;
}
export function pruefeShellStart(o:ShellStartEingabe,k:ShellSicherungsKatalog):ShellStartEntscheidung{
  const eigeneDb=!!lageKommandos(o)&&o.lage.datenbank_zuordnung?.project===o.project&&o.lage.sicher_aufloesbar;
  const text=pruefeShellText(o.command,{workspace_testdateien:o.workspace_testdateien,projekt_eigene_db:eigeneDb,projekt_db_geprueft:o.lage.datenbank_pruefung,shell:o.lage.shell,project:o.project,os:o.lage.os,rechner:o.rechner,katalog:k,kommandos:lageKommandos(o),cwd:o.lage.cwd,testprojekt:o.lage.testprojekt,inline_pfade:o.lage.inline_pfade,scratchpad_roots:o.lage.scratchpad_roots,projekt_root:o.lage.project_root});
  const hard=selbstschaden(o)??(o.lage.datenbank_live?'Der Befehl veraendert direkt die Synapse-Produktionsdatenbank. Schreibender Shell-Zugriff darauf ist gesperrt (Lesen ist frei); Daten nur ueber die Synapse-Tools aendern.':undefined);
  // P10-T73: Ortsbedingungen gefaehrlicher Treffer gegen die Lage pruefen; ohne Gefahr gilt die Regelstufe.
  const treffer=text.treffer.flatMap(t=>!t.gefahr||gefahrGilt(t.gefahr,o.lage)?[t]:
    t.basis_stufe&&t.basis_stufe!=='rueckfrage'?[{regel_id:t.regel_id,antwort_id:t.antwort_id,stufe:t.basis_stufe}]:[]);
  const textStufe=treffer.reduce<ShellStufe>((s,t)=>strengereShellStufe(s,t.stufe),'laeuft');
  let stufe:ShellStufe=textStufe;
  if(text.ungeklaert.includes('parser_grenze')&&/^\s*(?:node|python[\d.]*)(?:\.exe)?\b/.test(o.command))stufe=strengereShellStufe(stufe,'anleitung');
  if(o.lage.datenbank_abgewiesen)stufe=strengereShellStufe(stufe,'anleitung');
  if(hard)stufe='sperre';
  else if(text.risiko_verb&&!o.lage.sicher_aufloesbar&&stufe==='laeuft')stufe='anleitung';
  // User-Vorgabe 14.10.2026: ausser Sperren nur Warnhinweise, nichts wartet auf Bestaetigung.
  if(stufe==='anleitung')stufe='hinweis';
  const befehl_hash=createHash('sha256').update(JSON.stringify([o.project,o.command])).digest('hex');
  const bindings={befehl_hash,lage_hash:o.lage.hash,regelversion:regelVersion(k)};
  let allow=stufe==='laeuft'||stufe==='hinweis',confirmed=false,error:string|undefined;
  if(o.bestaetigt&&stufe!=='laeuft'&&stufe!=='hinweis'){
    if(!darfKoordinatorOderUser(o.agent_id)){allow=false;error='nur_koordinator';}
    else if(typeof o.bestaetigt.grund!=='string'||o.bestaetigt.grund.trim().length<10){allow=false;error='grund_fehlt';}
    else if(Object.entries(bindings).some(([key,value])=>o.bestaetigt?.[key as keyof ShellBestaetigung]!==value)){
      allow=false;error='bestaetigung_veraltet';
    }else if(stufe!=='sperre'){allow=true;confirmed=true;}
  }
  // P10-T73: Rueckfrage. Der AUFRUFENDE Agent bestaetigt selbst mit ID + Grund; sonst neue fluechtige ID.
  let bestaetigungId:string|undefined,rueckfrage:{bestaetigung_id:string;gueltig_bis:string}|undefined;
  if(stufe==='rueckfrage'&&!confirmed){
    const bindung={art:'befehl' as const,agent_id:o.agent_id??null,project:o.project,...bindings};
    if(o.bestaetigung){
      const r=loeseShellRueckfrageEin(o.bestaetigung.id,o.bestaetigung.grund,bindung);
      if(r.ok){allow=true;confirmed=true;bestaetigungId=o.bestaetigung.id;error=undefined;}
      else error=r.error;
    }
    if(!confirmed){allow=false;rueckfrage=stelleShellRueckfrage(bindung);}
  }
  if(stufe==='sperre'){allow=false;error='shell_sperre';}
  const audit={agent_id:o.agent_id??null,grund:confirmed?(bestaetigungId?o.bestaetigung!.grund.trim():o.bestaetigt!.grund.trim()):eigeneDb&&allow?'projekt_eigene_db':null,...bindings,
    stufe,entscheidung:allow?(confirmed?'bestaetigt' as const:'erlaubt' as const):'abgewiesen' as const,zeit:new Date().toISOString(),
    ...(bestaetigungId?{bestaetigung_id:bestaetigungId}:{})};
  if(stufe==='laeuft'&&allow)return {darf_starten:true,audit};
  const strongest=treffer.filter(t=>t.stufe===textStufe).sort((a,b)=>a.regel_id.localeCompare(b.regel_id))[0];
  const answer=k.antworten.find(a=>a.id===strongest?.antwort_id&&a.status==='aktiv');
  const risiko=hard??answer?.risiko??'Die Wirkung ist ohne sicher aufgelöste Lage nicht verlässlich bestimmbar.';
  // User-Vorgabe 14.10.2026: Aenderungen an Projekt-/Test-DBs gehoeren in den Code, nicht direkt per Shell.
  const adhocSql=!!o.lage.datenbank_pruefung&&LIVE_SCHREIBEND.test(o.command);
  if(stufe==='hinweis'&&allow)return {darf_starten:true,audit,
    hinweis:adhocSql
      ?{stufe:'hinweis',risiko:'Veraendernder SQL direkt auf einer Datenbank per Shell.',
        danach:'Laeuft. Zum Ausprobieren in Ordnung; soll die Aenderung bleiben, gehoert sie in den Code (Migration oder Testcode im Projekt).',sicher:vorschau(answer,o,k)}
      :{stufe:'hinweis',risiko,danach:answer?.danach??'Ziel und Wirkung pruefen.',sicher:vorschau(answer,o,k)}};
  const fehler=error??(rueckfrage?'shell_rueckfrage':undefined);
  const antwort:ShellSicherungsAntwort={ausgefuehrt:allow,stufe:stufe==='laeuft'?'anleitung':stufe,...(fehler?{error:fehler}:{}),
    risiko,lage:o.lage,sicher:vorschau(answer,o,k),
    danach:hard??answer?.danach??'Ziel und Wirkung mit einer harmlosen Vorschau klären.',
    trotzdem:stufe==='sperre'?'Nicht übergehbar, auch nicht durch Koordinator oder User.':
      rueckfrage?'Nicht ausgeführt. Bestätigen kann nur der aufrufende Agent selbst: denselben Befehl mit bestaetigung:{id:<bestaetigung_id>,'+
        'grund:"<mind. 10 Zeichen>"} bis gueltig_bis erneut senden'+(o.agent_id?'':' (agent_id erforderlich)')+
        '. Ohne Bestätigung verfällt die Rückfrage ohne Spur. Bei Drift (Befehl, Lage, Regeln) neue Rückfrage.':
      'Koordinator oder User kann denselben Befehl und dieselbe Lage mit bestaetigt:{grund,...bestaetigungsdaten} bestätigen. Bei Drift erneut prüfen.',
    bestaetigungsdaten:bindings,...(rueckfrage??{})};
  return {darf_starten:allow,antwort,audit};
}
