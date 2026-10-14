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
export interface ShellDbErgebnis {betroffen:boolean;erlaubt:boolean;ziele:ShellDbZiel[];live?:boolean;}
/** User-Vorgabe 14.10.2026: nur veraenderndes SQL gegen die Produktions-DB ist gesperrt, Lesen nicht. */
export const LIVE_SCHREIBEND=/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|LOCK)\b/i;
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
/** P10-T71 Nachtrag (Befund e8459f6a): Prod-Ziel auch als Teil-Tupel ohne URL/User erkennen.
 * Massgeblich sind Port+DB der Live-DB (Host egal wie beim URL-Abgleich); fehlender Port = pg/libpq-Standard 5432. */
export function istLiveTeilZiel(port:string|undefined,datenbank:string|undefined,p:ShellDbFreigabe):boolean {
  return !!p.live&&!!datenbank&&(port===undefined||port===''?'5432':port)===p.live.port&&datenbank===p.live.datenbank;
}
/** Port/DB aus psql-Verbindungsargument (URL, Conninfo 'host=.. port=.. dbname=..' oder DB-Name) plus PG*-Umgebung.
 * P10-T71 Nachbesserung: ohne DB-Namen nimmt libpq den User-Namen (URL-User, user=, PGUSER) als DB. */
function teilZielAusVerbindung(raw:string|undefined,env:Record<string,string|undefined>):{port?:string;datenbank?:string} {
  if(raw&&/^postgres(?:ql)?:\/\//i.test(raw)){
    try{const u=new URL(raw.replace(/^postgres(?:ql)?:/i,'postgresql:'));const user=u.searchParams.get('user')??(decodeURIComponent(u.username)||env.PGUSER);
      return {port:u.searchParams.get('port')??(u.port||env.PGPORT),datenbank:u.searchParams.get('dbname')??(decodeURIComponent(u.pathname.slice(1))||env.PGDATABASE||user||undefined)};}
    catch{return {};}
  }
  if(raw&&raw.includes('=')){
    const kv:Record<string,string>={};
    for(const m of raw.matchAll(/(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S+))/g))kv[m[1].toLowerCase()]=m[2]??m[3];
    return {port:kv.port??env.PGPORT,datenbank:kv.dbname??env.PGDATABASE??kv.user??env.PGUSER};
  }
  return {port:env.PGPORT,datenbank:raw??env.PGDATABASE??env.PGUSER};
}
/** P10-T71 Nachbesserung: psql-Metabefehle, die Dateien/Fremdinhalt ausfuehren oder Daten schreiben. */
export const PSQL_META_SCHREIBEND=/\\(?:i|ir|include|include_relative|gexec|!|copy|lo_import|lo_unlink)(?![A-Za-z_])/;
/** Literale postgres-URL bzw. Conninfo im Skripttext, die auf Port+DB der Live-DB zeigt. */
function literalLive(s:string,env:Record<string,string|undefined>,p:ShellDbFreigabe):boolean {
  if(/^postgres(?:ql)?(?:\+\w+)?:\/\//i.test(s)){
    const t=teilZielAusVerbindung(s.replace(/^postgres(?:ql)?(?:\+\w+)?:/i,'postgresql:'),env);
    return istLiveTeilZiel(t.port,t.datenbank,p);
  }
  if(/\bdbname\s*=/.test(s)){const t=teilZielAusVerbindung(s,env);return istLiveTeilZiel(t.port,t.datenbank,p);}
  return false;
}
/** P10-T71 Nachtrag: pg-Config ohne URL (Objekt mit database/port, auch ueber Variable an Client/Pool) oder
 * PGPORT/PGDATABASE in der Umgebung zeigt auf die Prod-DB und das Skript enthaelt schreibendes SQL. */
function nodeLiveTeil(f:ts.SourceFile,text:string,env:Record<string,string|undefined>,p:ShellDbFreigabe):boolean {
  if(!p.live||!LIVE_SCHREIBEND.test(text))return false;
  if(env.PGDATABASE&&istLiveTeilZiel(env.PGPORT,env.PGDATABASE,p))return true;
  let treffer=false;
  const literal=(e:ts.Expression):string|undefined=>ts.isStringLiteralLike(e)||ts.isNumericLiteral(e)?e.text:undefined;
  function such(n:ts.Node):void {
    if(treffer)return;
    // P10-T71 Nachbesserung: connectionString/URL als Literal (auch ohne Port oder DB-Namen).
    if(ts.isStringLiteralLike(n)&&literalLive(n.text,env,p)){treffer=true;return;}
    if(ts.isObjectLiteralExpression(n)){
      let datenbank:string|undefined,port:string|undefined,portUnklar=false;
      for(const pr of n.properties){
        if(!ts.isPropertyAssignment(pr))continue;
        const k=pr.name.getText(f).replace(/^['"]|['"]$/g,'');
        if(k==='database')datenbank=literal(pr.initializer);
        if(k==='port'){port=literal(pr.initializer);if(port===undefined)portUnklar=true;}
      }
      if(datenbank!==undefined&&!portUnklar&&istLiveTeilZiel(port??env.PGPORT,datenbank,p))treffer=true;
    }
    ts.forEachChild(n,such);
  }
  such(f);
  return treffer;
}
/** P10-T71 Nachbesserung: Python-Client (psycopg2/psycopg/asyncpg/pg8000/SQLAlchemy) mit Prod-Ziel und
 * schreibendem SQL – gleiche Massstaebe wie nodeLiveTeil (Literal-URL/Conninfo, connect(dbname=.., port=..),
 * Dict-Config, PGPORT/PGDATABASE der Umgebung). Nicht-literaler Port = unklar, kein Treffer. */
export const PY_DB_CLIENT=/\b(?:psycopg2?|psycopg|asyncpg|pg8000|aiopg|sqlalchemy|create_engine)\b/;
function pythonLiveTeil(text:string,env:Record<string,string|undefined>,p:ShellDbFreigabe):boolean {
  if(!p.live||!LIVE_SCHREIBEND.test(text)||!PY_DB_CLIENT.test(text))return false;
  if(env.PGDATABASE&&istLiveTeilZiel(env.PGPORT,env.PGDATABASE,p))return true;
  for(const m of text.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g))if(literalLive(m[2],env,p))return true;
  const kwLive=(s:string):boolean=>{
    const db=s.match(/(?:\b|['"])(?:dbname|database)['"]?\s*[=:]\s*(['"])([^'"]+)\1/)?.[2]??
      (env.PGDATABASE?undefined:s.match(/(?:\b|['"])user['"]?\s*[=:]\s*(['"])([^'"]+)\1/)?.[2]);
    if(db===undefined)return false;
    const pm=s.match(/(?:\b|['"])port['"]?\s*[=:]\s*(?:(['"])(\d+)\1|(\d+)(?![\w.])|([^,\s)}]+))/);
    if(pm&&pm[4]!==undefined)return false;
    return istLiveTeilZiel(pm?(pm[2]??pm[3]):env.PGPORT,db,p);
  };
  for(const c of text.matchAll(/\b(?:connect|create_pool|Connection)\s*\(([^()]*)\)/g))if(kwLive(c[1]))return true;
  for(const d of text.matchAll(/\{([^{}]*)\}/g))if(/['"](?:dbname|database)['"]\s*:/.test(d[1])&&kwLive(d[1]))return true;
  return false;
}
/** P10-T71 Nachbesserung: dropdb/createdb/pg_restore schreiben in die DB, die sie benennen (pg_restore nur mit -d). */
const PG_WERKZEUG_WERTE:Record<string,Set<string>>={
  dropdb:new Set(['-h','--host','-p','--port','-U','--username','--maintenance-db']),
  createdb:new Set(['-h','--host','-p','--port','-U','--username','--maintenance-db','-D','--tablespace','-E','--encoding','-l','--locale','-O','--owner','-T','--template','-S','--strategy','--lc-collate','--lc-ctype','--icu-locale','--icu-rules','--locale-provider','--builtin-locale']),
  pg_restore:new Set(['-d','--dbname','-f','--file','-F','--format','-h','--host','-p','--port','-U','--username','-j','--jobs','-L','--use-list','-n','--schema','-N','--exclude-schema','-t','--table','-T','--trigger','-I','--index','-P','--function','-S','--superuser','--role','--section','--filter']),
};
function pgWerkzeugLive(cmd:string,k:ShellTextKommando,env:Record<string,string|undefined>,p:ShellDbFreigabe):boolean {
  const werte=PG_WERKZEUG_WERTE[cmd],opt:Record<string,string>={},pos:string[]=[],a=k.argv.slice(1);
  for(let i=0;i<a.length;i++){
    const w=a[i];if(w.dynamisch)continue;const t=w.text;
    if(t==='--'){pos.push(...a.slice(i+1).filter(x=>!x.dynamisch).map(x=>x.text));break;}
    const eq=t.match(/^(--[\w-]+)=([\s\S]*)$/);if(eq){opt[eq[1]]=eq[2];continue;}
    if(werte.has(t)){const v=a[++i];if(v&&!v.dynamisch)opt[t]=v.text;continue;}
    const kurz=t.match(/^(-[A-Za-z])(.+)$/);if(kurz&&werte.has(kurz[1])){opt[kurz[1]]=kurz[2];continue;}
    if(t.startsWith('-'))continue;
    pos.push(t);
  }
  const g=(...n:string[])=>n.map(x=>opt[x]).find(x=>x!==undefined);
  const port=g('-p','--port'),user=g('-U','--username');
  const umgebung={...env,...(port!==undefined?{PGPORT:port}:{}),...(user!==undefined?{PGUSER:user}:{})};
  const ziele:Array<string|undefined>=[];
  if(cmd==='pg_restore'){const d=g('-d','--dbname');if(d===undefined)return false;ziele.push(d);}
  else {
    if(pos[0]!==undefined||cmd==='createdb')ziele.push(pos[0]);
    const m=g('--maintenance-db');if(m!==undefined)ziele.push(m);
  }
  return ziele.some(z=>{const t=teilZielAusVerbindung(z,umgebung);return istLiveTeilZiel(t.port,t.datenbank,p);});
}
/** P10-T71 Nachbesserung: env/sudo/exec/nohup/time/timeout/nice/stdbuf vor dem eigentlichen Programm abwickeln
 * (env VAR=wert gilt als Umgebung), damit 'env PGPORT=5432 PGDATABASE=synapse psql …' erkannt wird. */
function entpackeWrapper(k:ShellTextKommando,env:Record<string,string|undefined>):{k:ShellTextKommando;env:Record<string,string|undefined>} {
  let argv=k.argv,e=env;
  for(let runde=0;runde<8;runde++){
    const name=argv[0]&&!argv[0].dynamisch?argv[0].text.replace(/\\/g,'/').split('/').pop()!.toLowerCase():'';
    if(!/^(?:env|sudo|doas|exec|nohup|time|command|nice|timeout|stdbuf)$/.test(name))break;
    let i=1;
    const zuweisungen=()=>{for(;i<argv.length;i++){const m=argv[i].dynamisch?null:argv[i].text.match(/^([A-Za-z_]\w*)=([\s\S]*)$/);if(!m)break;e={...e,[m[1]]:m[2]};}};
    if(name==='env'){
      for(;i<argv.length;i++){
        const t=argv[i].text;
        if(t==='-i'||t==='--ignore-environment'||t==='-'){e={};continue;}
        if(t==='-u'||t==='--unset'){const v=argv[++i]?.text;if(v){e={...e};delete e[v];}continue;}
        if(t==='-C'||t==='--chdir'||t==='-S'||t==='--split-string'){i++;continue;}
        if(t.startsWith('-'))continue;
        const m=argv[i].dynamisch?null:t.match(/^([A-Za-z_]\w*)=([\s\S]*)$/);if(m){e={...e,[m[1]]:m[2]};continue;}
        break;
      }
    }else if(name==='sudo'||name==='doas'){
      for(;i<argv.length&&argv[i].text.startsWith('-');i++)if(/^-[ugCDhprtUc]$/.test(argv[i].text))i++;
      zuweisungen();
    }else if(name==='timeout'){
      for(;i<argv.length&&argv[i].text.startsWith('-');i++)if(/^(?:-[sk]|--signal|--kill-after)$/.test(argv[i].text))i++;
      i++;
    }else{
      for(;i<argv.length&&argv[i].text.startsWith('-');i++)if(name==='nice'&&/^(?:-n|--adjustment)$/.test(argv[i].text)||name==='stdbuf'&&/^-[ioe]$/.test(argv[i].text))i++;
    }
    argv=argv.slice(i);
  }
  return argv===k.argv?{k,env}:{k:{...k,argv},env:e};
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
function psqlZiel(k:ShellTextKommando,env:Record<string,string|undefined>):{ziel?:ShellDbZiel;sql:string[];ok:boolean;teil:{port?:string;datenbank?:string};datei:boolean} {
  const a=k.argv.slice(1);let raw:string|undefined,dbName:string|undefined,sql:string[]=[],ok=true,datei=false;
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
    if(t==='-f'||t==='--file'||t.startsWith('--file='))datei=true;
    if(['-f','--file','-o','--output','-F','--format','-n','--schema','-t','--table'].includes(t)){if(!a[++i]||a[i].dynamisch)ok=false;continue;}
    if(t.startsWith('-')){if(!/^(?:-X|--no-psqlrc|-q|--quiet|-A|--no-align|-w|--no-password|-s|-a|-Fp|--(?:schema-only|data-only|clean|if-exists|no-owner|no-privileges|no-acl|tuples-only|format=\w+))$/.test(t))ok=false;continue;}
    conn(t);
  }
  const effective={...env,...overrides,...(dbName?{PGDATABASE:dbName}:{})};
  const z=raw?dbZielAusUrl(raw):pgUmgebungsZiel(effective);
  if(z&&!dbUmgebungPasst(effective,z))ok=false;
  return {ziel:z,sql,ok:ok&&!!z,teil:teilZielAusVerbindung(raw??dbName,{...env,...overrides}),datei};
}
/** User-Richtungswechsel2: Umgebung ist Zielkontext; erkennbare Overrides gewinnen als Ablehnungsfakten. */
function pgUmgebungsZiel(env:Record<string,string|undefined>):ShellDbZiel|undefined{
  if(!['PGHOST','PGPORT','PGDATABASE','PGUSER'].every(k=>!!env[k]))return undefined;
  return {host:env.PGHOST!.toLowerCase(),port:env.PGPORT!,datenbank:env.PGDATABASE!,user:env.PGUSER!};
}
/** t82: Env bestimmt das Ziel; SQL-Inhalt ist frei, erkennbare Verbindungswechsel nicht. */
function nodeFreigabe(text:string,env:Record<string,string|undefined>,p:ShellDbFreigabe):ShellDbErgebnis {
  const f=ts.createSourceFile('db-ziel.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const konstruktoren=new Set(['Client','Pool']),mcpKlassen=new Set<string>(),mcpModule=new Set<string>();
  const mcpQuelle=(s:string)=>/(?:^|\/)@modelcontextprotocol\/sdk\/(?:dist\/(?:esm|cjs)\/)?client(?:\/|$)/.test(s);
  function bind(n:ts.Node):void {
    if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)) {
      const mcp=mcpQuelle(n.moduleSpecifier.text),cl=n.importClause;
      if(mcp&&cl?.name)mcpModule.add(cl.name.text);
      if(cl?.namedBindings&&ts.isNamespaceImport(cl.namedBindings)&&mcp)mcpModule.add(cl.namedBindings.name.text);
      if(cl?.namedBindings&&ts.isNamedImports(cl.namedBindings))for(const b of cl.namedBindings.elements)
        if(['Client','Pool'].includes(b.propertyName?.text??b.name.text)){
          if(mcp)mcpKlassen.add(b.name.text);else konstruktoren.add(b.name.text);
        }
    }
    if(ts.isVariableDeclaration(n)&&ts.isObjectBindingPattern(n.name))for(const b of n.name.elements)
      if(ts.isIdentifier(b.name)&&['Client','Pool'].includes(b.propertyName?.getText(f)??b.name.text))konstruktoren.add(b.name.text);
    ts.forEachChild(n,bind);
  }
  bind(f);
  const dbKonstruktor=(e:ts.Expression)=>ts.isIdentifier(e)?konstruktoren.has(e.text)&&!mcpKlassen.has(e.text):
    ts.isPropertyAccessExpression(e)&&['Client','Pool'].includes(e.name.text)&&!mcpModule.has(e.expression.getText(f));
  let betroffen=false;
  function nutzung(n:ts.Node):void {
    if(ts.isNewExpression(n)&&dbKonstruktor(n.expression))betroffen=true;
    if(ts.isCallExpression(n)&&(dbKonstruktor(n.expression)||
      ts.isIdentifier(n.expression)&&['query','execute','getPool'].includes(n.expression.text)||
      ts.isPropertyAccessExpression(n.expression)&&['query','execute','getPool'].includes(n.expression.name.text)))betroffen=true;
    ts.forEachChild(n,nutzung);
  }
  nutzung(f);
  if(!betroffen)return {betroffen:false,erlaubt:false,ziele:[]};
  const lv=nodeLiveTeil(f,text,env,p)?{live:true}:{};
  const ziel=env.DATABASE_URL?dbZielAusUrl(env.DATABASE_URL):pgUmgebungsZiel(env);
  if(!eigenesZiel(ziel,p)||!dbUmgebungPasst(env,ziel)||(f as ts.SourceFile&{parseDiagnostics?:unknown[]}).parseDiagnostics?.length)
    return {betroffen:true,erlaubt:false,ziele:[],...lv};
  let ok=true;
  const direkteEnv=(n:ts.Expression):boolean=>ts.isPropertyAccessExpression(n)&&n.expression.getText(f)==='process.env'&&n.name.text==='DATABASE_URL';
  const name=(n:ts.PropertyName):string=>n.getText(f).replace(/^['"]|['"]$/g,'');
  function scan(n:ts.Node):void {
    if(ts.isStringLiteralLike(n)||ts.isTemplateHead(n)||ts.isTemplateMiddle(n)||ts.isTemplateTail(n)) {
      // Auch geteilte/templatisierte DB-Wechsel bleiben sichtbar. Schema-/Tabellen-SQL
      // darf dagegen aus Variablen, QueryConfig oder Laufzeitwerten entstehen.
      if(/postgres(?:ql)?:\/\//i.test(n.text)||!sqlBleibtInDb(n.text,ziel!)||
        /\bUSE\s+\w+|\b(?:CREATE|ALTER|DROP)\s+DATABASE\s*(?:IF\s+EXISTS\s*)?$/i.test(n.text))ok=false;
    }
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment) {
      // Auch Alias-/Objektmutation wird nicht durch einen früheren Env-Wert gerechtfertigt.
      const left=n.left.getText(f);
      if(/^process\.env$/.test(left)||/process\.env(?:\.(?:(?:SYNAPSE_)?DATABASE_URL|PG\w*)\b|\[['"](?:(?:SYNAPSE_)?DATABASE_URL|PG\w*)['"]\])/i.test(left)||
        /\.(?:connectionString|host|hostname|port|database|user|pathname|href)\b/.test(left))ok=false;
    }
    if(ts.isPropertyAssignment(n)&&name(n.name)==='connectionString'&&!direkteEnv(n.initializer))ok=false;
    if(ts.isNewExpression(n)&&dbKonstruktor(n.expression)) {
      const args=n.arguments??[];
      if(args.length>1)ok=false;
      if(args.length===1) {
        const a=args[0];
        const envObj=ts.isObjectLiteralExpression(a)&&a.properties.length===1&&ts.isPropertyAssignment(a.properties[0])&&name(a.properties[0].name)==='connectionString'&&direkteEnv(a.properties[0].initializer);
        if(!direkteEnv(a)&&!envObj)ok=false;
      }
    }
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&
      ['set','append','delete','sort'].includes(n.expression.name.text)&&
      ts.isPropertyAccessExpression(n.expression.expression)&&n.expression.expression.name.text==='searchParams')ok=false;
    ts.forEachChild(n,scan);
  }
  scan(f);
  return {betroffen:true,erlaubt:ok,ziele:ok?[ziel!]:[],...lv};
}

export function pruefeDbKommando(k:ShellTextKommando,env:Record<string,string|undefined>,p:ShellDbFreigabe):ShellDbErgebnis {
  const r=pruefeDbKommandoDirekt(k,env,p);
  // P10-T71 Nachbesserung: Wrapper (env/sudo/timeout …) aendern das Ergebnis fuer Nicht-Prod nicht, nur die Prod-Erkennung.
  if(r.live||!p.live)return r;
  const w=entpackeWrapper(k,env);
  return w.k!==k&&pruefeDbKommandoDirekt(w.k,w.env,p).live?{...r,betroffen:true,live:true}:r;
}
function pruefeDbKommandoDirekt(k:ShellTextKommando,env:Record<string,string|undefined>,p:ShellDbFreigabe):ShellDbErgebnis {
  const cmd=k.argv[0]?.text.replace(/\\/g,'/').split('/').pop()?.toLowerCase();
  if(cmd==='psql'||cmd==='psql.exe'||cmd==='pg_dump'||cmd==='pg_dump.exe'){
    const x=psqlZiel(k,env),allowed=x.ok&&eigenesZiel(x.ziel,p)&&x.sql.every(s=>sqlBleibtInDb(s,x.ziel!));
    // User-Vorgabe 14.10.2026: einzige harte DB-Grenze ist die Synapse-Produktions-DB.
    const istPsql=cmd==='psql'||cmd==='psql.exe';
    const schreibend=x.sql.length===0||x.sql.some(s=>LIVE_SCHREIBEND.test(s)||istPsql&&PSQL_META_SCHREIBEND.test(s))||istPsql&&x.datei;
    const live=!!x.ziel&&!!p.live&&x.ziel.port===p.live.port&&x.ziel.datenbank===p.live.datenbank&&schreibend||
      // P10-T71 Nachtrag: Prod-Tupel ohne URL/User (psql -h/-p/-d, Conninfo, PGPORT/PGDATABASE); pg_dump liest nur.
      (cmd==='psql'||cmd==='psql.exe')&&istLiveTeilZiel(x.teil.port,x.teil.datenbank,p)&&schreibend;
    return {betroffen:true,erlaubt:allowed,ziele:allowed?[x.ziel!]:[],...(live?{live:true}:{})};
  }
  // P10-T71 Nachbesserung: dropdb/createdb/pg_restore gegen die Prod-DB sind schreibend (pg_dump/pg_dumpall lesen nur).
  const werkzeug=cmd?.replace(/\.exe$/,'');
  if(werkzeug&&PG_WERKZEUG_WERTE[werkzeug]){
    const live=pgWerkzeugLive(werkzeug,k,env,p);
    return {betroffen:live,erlaubt:false,ziele:[],...(live?{live:true}:{})};
  }
  if(k.inline_skript?.sprache==='node'){
    return nodeFreigabe(k.inline_skript.text,env,p);
  }
  // P10-T71 Nachbesserung: Python-Client mit Prod-Ziel schreibend wird wie Node gesperrt.
  const pyLive=k.inline_skript?.sprache==='python'&&pythonLiveTeil(k.inline_skript.text,env,p);
  // Nicht verstandene SQL-Interpreter werden nie von der neuen Ausnahme erfasst.
  return {betroffen:pyLive||!!k.inline_skript&&/\b(?:query|execute)\s*\(/.test(k.inline_skript.text)||!!cmd&&/^(?:mysql|mariadb|sqlite3)$/.test(cmd),erlaubt:false,ziele:[],...(pyLive?{live:true}:{})};
}
