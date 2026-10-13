/** P10-T65: reine Zuordnung ALLER SQL-Ziele, keine Ausführung und keine Zugangsdaten im Ergebnis. */
import ts from 'typescript';
import type {ShellTextKommando} from './shell-sicherung-parser.js';
export interface ShellDbZiel {host:string;port:string;datenbank:string;user:string;}
export interface ShellDbFreigabe {
  project:string;
  /** Trusted Server-Konfiguration; nie aus der Prüfverbindung lernen. */
  test_system_id?:string;
  ziele:Array<ShellDbZiel&{art:'projekt'|'test'}>;
  live?:ShellDbZiel;
}
export interface ShellDbErgebnis {betroffen:boolean;erlaubt:boolean;ziele:ShellDbZiel[];}
export function dbZielAusUrl(raw:unknown):ShellDbZiel|undefined {
  if(typeof raw!=='string')return undefined;
  try {
    const u=new URL(raw);
    if(!/^postgres(?:ql)?:$/.test(u.protocol)||!u.hostname||!u.port||!u.username||u.hash)return undefined;
    // libpq kann host/port/user/dbname durch URI-Optionen überschreiben.
    if([...u.searchParams.keys()].some(k=>!['sslmode','application_name','connect_timeout','options'].includes(k)))return undefined;
    const datenbank=decodeURIComponent(u.pathname.slice(1)),user=decodeURIComponent(u.username);
    if(!datenbank||datenbank.includes('/')||!user)return undefined;
    return {host:u.hostname.toLowerCase(),port:u.port,datenbank,user};
  }catch{return undefined;}
}
export function gleichesDbZiel(a:ShellDbZiel,b:ShellDbZiel):boolean {
  return a.host.toLowerCase()===b.host.toLowerCase()&&a.port===b.port&&a.datenbank===b.datenbank&&a.user===b.user;
}
function eigenesZiel(z:ShellDbZiel|undefined,p:ShellDbFreigabe):z is ShellDbZiel {
  return !!z&&!!p.live&&z.port!==p.live.port&&z.datenbank!==p.live.datenbank&&
    p.ziele.some(x=>gleichesDbZiel(x,z));
}
export function sqlBleibtInDb(sql:string,z:ShellDbZiel):boolean {
  // Wechsel/Serveradministration/externes SQL ist keine Freigabe der eigenen DB.
  if(/\\(?:connect|c|include|i|ir|!|gexec)\b|(?:\bdblink\b|\bpostgres_fdw\b|\bPROGRAM\b|\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|SERVER|SYSTEM|TABLESPACE)\b)/i.test(sql))return false;
  for(const m of sql.matchAll(/\b(?:CREATE|ALTER|DROP)\s+DATABASE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))/gi))
    if((m[1]??m[2])!==z.datenbank)return false;
  return true;
}
export function dbUmgebungPasst(env:Record<string,string|undefined>,z:ShellDbZiel):boolean {
  const erwartung:Record<string,string>={PGHOST:z.host,PGPORT:z.port,PGDATABASE:z.datenbank,PGUSER:z.user};
  for(const [key,v]of Object.entries(env)){
    const upper=key.toUpperCase();if(!upper.startsWith('PG')||v===undefined||v==='')continue;
    if(upper==='PGPASSWORD')continue;
    const soll=erwartung[upper];
    if(soll===undefined||(upper==='PGHOST'?v.toLowerCase():v)!==soll)return false;
  }
  return true;
}
function psqlZiel(k:ShellTextKommando,env:Record<string,string|undefined>):{ziel?:ShellDbZiel;sql:string[];ok:boolean} {
  const a=k.argv.slice(1);let raw:string|undefined,dbName:string|undefined,sql:string[]=[],ok=true;
  const overrides:Record<string,string>={};
  const conn=(v:string)=>{if(/^postgres(?:ql)?:\/\//.test(v)){if(raw!==undefined)ok=false;raw=v;}else {if(dbName!==undefined)ok=false;dbName=v;}};
  for(let i=0;i<a.length;i++){
    const w=a[i];if(w.dynamisch){ok=false;continue;}const t=w.text;
    if(['-c','--command'].includes(t)){const v=a[++i];if(v&&!v.dynamisch)sql.push(v.text);else ok=false;continue;}
    if(t.startsWith('--command=')){sql.push(t.slice(10));continue;}
    if(['-d','--dbname'].includes(t)){const v=a[++i];if(v&&!v.dynamisch)conn(v.text);else ok=false;continue;}
    if(t.startsWith('--dbname=')){conn(t.slice(9));continue;}
    const keys:Record<string,string>={'-h':'PGHOST','--host':'PGHOST','-p':'PGPORT','--port':'PGPORT','-U':'PGUSER','--username':'PGUSER'};
    if(keys[t]){const v=a[++i];if(v&&!v.dynamisch)overrides[keys[t]]=v.text;else ok=false;continue;}
    const eq=t.match(/^--(host|port|username)=(.*)$/);if(eq){overrides[{'host':'PGHOST','port':'PGPORT','username':'PGUSER'}[eq[1]]!]=eq[2];continue;}
    if(['-f','--file','-o','--output','-F','--format','-n','--schema','-t','--table'].includes(t)){if(!a[++i]||a[i].dynamisch)ok=false;continue;}
    if(t.startsWith('-')){if(!/^(?:-X|--no-psqlrc|-q|--quiet|-A|--no-align|-w|--no-password|-s|-a|-Fp|--(?:schema-only|data-only|clean|if-exists|no-owner|no-privileges|no-acl|tuples-only|format=\w+))$/.test(t))ok=false;continue;}
    conn(t);
  }
  const effective={...env,...overrides,...(dbName?{PGDATABASE:dbName}:{})};
  const z=raw?dbZielAusUrl(raw):pgUmgebungsZiel(effective);
  if(z&&!dbUmgebungPasst(effective,z))ok=false;
  return {ziel:z,sql,ok:ok&&!!z};
}
/** User-Richtungswechsel2: Umgebung ist Zielkontext; erkennbare Overrides gewinnen als Ablehnungsfakten. */
function pgUmgebungsZiel(env:Record<string,string|undefined>):ShellDbZiel|undefined{
  if(!['PGHOST','PGPORT','PGDATABASE','PGUSER'].every(k=>!!env[k]))return undefined;
  return {host:env.PGHOST!.toLowerCase(),port:env.PGPORT!,datenbank:env.PGDATABASE!,user:env.PGUSER!};
}
/** Richtungswechsel3: direkte unveränderte Env-Ziele; keinerlei Datenflussbeweis. */
function nodeFreigabe(text:string,env:Record<string,string|undefined>,p:ShellDbFreigabe):ShellDbErgebnis {
  const betroffen=/\b(?:query|execute)\s*\(|\b(?:Client|Pool|getPool)\s*\(/.test(text);
  if(!betroffen)return {betroffen:false,erlaubt:false,ziele:[]};
  const f=ts.createSourceFile('db-ziel.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const ziel=env.DATABASE_URL?dbZielAusUrl(env.DATABASE_URL):pgUmgebungsZiel(env);
  if(!eigenesZiel(ziel,p)||!dbUmgebungPasst(env,ziel)||(f as ts.SourceFile&{parseDiagnostics?:unknown[]}).parseDiagnostics?.length)
    return {betroffen:true,erlaubt:false,ziele:[]};
  let ok=true;
  const konstruktoren=new Set(['Client','Pool']);
  const direkteEnv=(n:ts.Expression):boolean=>ts.isPropertyAccessExpression(n)&&n.expression.getText(f)==='process.env'&&n.name.text==='DATABASE_URL';
  const name=(n:ts.PropertyName):string=>n.getText(f).replace(/^['"]|['"]$/g,'');
  function scan(n:ts.Node):void {
    if(ts.isImportSpecifier(n)&&['Client','Pool'].includes(n.propertyName?.text??n.name.text))konstruktoren.add(n.name.text);
    if(ts.isVariableDeclaration(n)&&ts.isObjectBindingPattern(n.name))for(const e of n.name.elements)
      if(ts.isIdentifier(e.name)&&['Client','Pool'].includes(e.propertyName?.getText(f)??e.name.text))konstruktoren.add(e.name.text);
    if(ts.isStringLiteralLike(n)&&(/postgres(?:ql)?:\/\//i.test(n.text)||!sqlBleibtInDb(n.text,ziel!)||/\bUSE\s+\w+/i.test(n.text)))ok=false;
    if(ts.isNewExpression(n)&&n.expression.getText(f)==='URL')ok=false;
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment) {
      // Auch Alias-/Objektmutation wird nicht durch einen früheren Env-Wert gerechtfertigt.
      if(/process\.env|\.(?:connectionString|host|hostname|port|database|user|pathname|href|text)\b/.test(n.left.getText(f)))ok=false;
    }
    if(ts.isPropertyAssignment(n)&&['host','hostname','port','database','user'].includes(name(n.name)))ok=false;
    if(ts.isPropertyAssignment(n)&&name(n.name)==='connectionString'&&!direkteEnv(n.initializer))ok=false;
    if(ts.isNewExpression(n)&&(ts.isIdentifier(n.expression)?konstruktoren.has(n.expression.text):ts.isPropertyAccessExpression(n.expression)&&['Client','Pool'].includes(n.expression.name.text))) {
      const args=n.arguments??[];
      if(args.length>1)ok=false;
      if(args.length===1) {
        const a=args[0];
        const envObj=ts.isObjectLiteralExpression(a)&&a.properties.length===1&&ts.isPropertyAssignment(a.properties[0])&&name(a.properties[0].name)==='connectionString'&&direkteEnv(a.properties[0].initializer);
        if(!direkteEnv(a)&&!envObj)ok=false;
      }
    }
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['query','execute'].includes(n.expression.name.text)) {
      // Variablen, QueryConfig, Templates und unbekannte SQL-Texte gehen zur Anleitung.
      if(!n.arguments[0]||!ts.isStringLiteralLike(n.arguments[0]))ok=false;
    }
    ts.forEachChild(n,scan);
  }
  scan(f);
  return {betroffen:true,erlaubt:ok,ziele:ok?[ziel!]:[]};
}

export function pruefeDbKommando(k:ShellTextKommando,env:Record<string,string|undefined>,p:ShellDbFreigabe):ShellDbErgebnis {
  const cmd=k.argv[0]?.text.replace(/\\/g,'/').split('/').pop()?.toLowerCase();
  if(cmd==='psql'||cmd==='psql.exe'||cmd==='pg_dump'||cmd==='pg_dump.exe'){
    const x=psqlZiel(k,env),allowed=x.ok&&eigenesZiel(x.ziel,p)&&x.sql.every(s=>sqlBleibtInDb(s,x.ziel!));
    return {betroffen:true,erlaubt:allowed,ziele:allowed?[x.ziel!]:[]};
  }
  if(k.inline_skript?.sprache==='node'){
    return nodeFreigabe(k.inline_skript.text,env,p);
  }
  // Nicht verstandene SQL-Interpreter werden nie von der neuen Ausnahme erfasst.
  return {betroffen:!!k.inline_skript&&/\b(?:query|execute)\s*\(/.test(k.inline_skript.text)||!!cmd&&/^(?:mysql|mariadb|sqlite3)$/.test(cmd),erlaubt:false,ziele:[]};
}
