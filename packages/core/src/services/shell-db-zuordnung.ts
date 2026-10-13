/** P10-T65: reine Zuordnung ALLER SQL-Ziele, keine Ausführung und keine Zugangsdaten im Ergebnis. */
import ts from 'typescript';
import type {ShellTextKommando} from './shell-sicherung-parser.js';
export interface ShellDbZiel {host:string;port:string;datenbank:string;user:string;}
export interface ShellDbFreigabe {
  project:string;
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
function sqlBleibtInDb(sql:string,z:ShellDbZiel):boolean {
  // Wechsel/Serveradministration/externes SQL ist keine Freigabe der eigenen DB.
  if(/\\(?:connect|c|include|i|ir|!|gexec)\b|(?:\bdblink\b|\bpostgres_fdw\b|\bPROGRAM\b|\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|SERVER|SYSTEM|TABLESPACE)\b)/i.test(sql))return false;
  for(const m of sql.matchAll(/\b(?:CREATE|ALTER|DROP)\s+DATABASE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_]\w*))/gi))
    if((m[1]??m[2])!==z.datenbank)return false;
  return true;
}
function psqlZiel(k:ShellTextKommando,env:Record<string,string|undefined>):{ziel?:ShellDbZiel;sql:string[];ok:boolean} {
  const a=k.argv.slice(1);let raw=env.DATABASE_URL,sql:string[]=[],ok=true;
  let host:string|undefined,port:string|undefined,db:string|undefined,user:string|undefined;
  for(let i=0;i<a.length;i++){
    const w=a[i];if(w.dynamisch){ok=false;continue;}
    const t=w.text;
    if(t==='-c'||t==='--command'){if(a[i+1]&&!a[i+1].dynamisch)sql.push(a[++i].text);else ok=false;continue;}
    const cm=t.match(/^--command=(.*)$/s);if(cm){sql.push(cm[1]);continue;}
    if(['-f','--file','-l','--list'].includes(t)||t.startsWith('--file=')){ok=false;continue;}
    const flag=/^(?:-h|--host|-p|--port|-U|--username|-d|--dbname)$/.test(t)?t:undefined;
    if(flag){const value=a[++i];if(!value||value.dynamisch){ok=false;continue;}
      if(['-h','--host'].includes(flag))host=value.text;
      if(['-p','--port'].includes(flag))port=value.text;
      if(['-U','--username'].includes(flag))user=value.text;
      if(['-d','--dbname'].includes(flag)){if(/^postgres(?:ql)?:\/\//.test(value.text))raw=value.text;else db=value.text;}
      continue;
    }
    if(t.startsWith('-')){
      if(!['-X','--no-psqlrc','-q','--quiet','-t','--tuples-only','-A','--no-align','-w','--no-password','--'].includes(t))ok=false;
    }else if(/^postgres(?:ql)?:\/\//.test(t))raw=t;
    else if(!db)db=t;else ok=false;
  }
  const z=dbZielAusUrl(raw);
  if(host||port||db||user){
    if(!z)return {sql,ok:false};
    if(host)z.host=host.toLowerCase();if(port)z.port=port;if(db)z.datenbank=db;if(user)z.user=user;
  }
  return {ziel:z,sql,ok:ok&&sql.length>0&&!k.umleitungen.length};
}
function nodeZiele(text:string,env:Record<string,string|undefined>):{ziele:Array<ShellDbZiel|undefined>;sql:string[];ok:boolean} {
  const f=ts.createSourceFile('db-inline.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  if((f as ts.SourceFile&{parseDiagnostics?:unknown[]}).parseDiagnostics?.length)return {ziele:[undefined],sql:[],ok:false};
  const decl=new Map<string,ts.Expression>(),pg=new Set<string>(),poolFns=new Set<string>(),clients=new Map<string,ShellDbZiel|undefined>();
  const mutable=new Set<string>(),envAliases=new Set<string>();
  let ok=true,queries=0;const ziele:Array<ShellDbZiel|undefined>=[],sql:string[]=[];
  function value(n:ts.Expression|undefined,depth=0):unknown{
    if(!n||depth>12)return undefined;
    if(ts.isStringLiteralLike(n))return n.text;
    if(ts.isNumericLiteral(n))return Number(n.text);
    if(ts.isAwaitExpression(n)||ts.isParenthesizedExpression(n))return value(n.expression,depth+1);
    if(ts.isIdentifier(n))return mutable.has(n.text)?undefined:value(decl.get(n.text),depth+1);
    if(ts.isPropertyAccessExpression(n)&&n.expression.getText(f)==='process.env')return env[n.name.text];
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=value(n.left,depth+1),b=value(n.right,depth+1);return typeof a==='string'&&typeof b==='string'?a+b:undefined;}
    if(ts.isObjectLiteralExpression(n)){const o:Record<string,unknown>={};for(const p of n.properties){if(!ts.isPropertyAssignment(p)||ts.isComputedPropertyName(p.name))return undefined;o[p.name.getText(f).replace(/^['"]|['"]$/g,'')]=value(p.initializer,depth+1);}return o;}
    return undefined;
  }
  function bind(n:ts.Node):void{
    if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)){
      const m=n.moduleSpecifier.text,b=n.importClause?.namedBindings;
      if(m==='pg'){if(n.importClause?.name)pg.add(n.importClause.name.text);if(b){if(ts.isNamespaceImport(b))pg.add(b.name.text);else for(const x of b.elements)if(['Client','Pool'].includes(x.propertyName?.text??x.name.text))pg.add(x.name.text);}}
      if(m==='@synapse/core'||/(?:^|\/)core\/dist\/db\/client\.js$/.test(m)){
        if(b&&ts.isNamedImports(b))for(const x of b.elements)if((x.propertyName?.text??x.name.text)==='getPool')poolFns.add(x.name.text);
      }
    }
    if(ts.isVariableDeclaration(n)&&n.initializer){
      if(ts.isIdentifier(n.name)){
        decl.set(n.name.text,n.initializer);
        if(n.initializer.getText(f)==='process.env')envAliases.add(n.name.text);
        const e=ts.isAwaitExpression(n.initializer)?n.initializer.expression:n.initializer;
        if(ts.isCallExpression(e)&&ts.isIdentifier(e.expression)&&e.expression.text==='require'&&value(e.arguments[0])==='pg')pg.add(n.name.text);
      }else if(ts.isObjectBindingPattern(n.name)&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(f)==='require'&&value(n.initializer.arguments[0])==='pg'){
        for(const x of n.name.elements)if(ts.isIdentifier(x.name)&&['Client','Pool'].includes(x.propertyName?.getText(f)??x.name.text))pg.add(x.name.text);
      }
    }
    // Änderbare Einstellungen/Umgebung bleiben unklar; URLs niemals erraten.
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){
      let base:ts.Node=n.left;while(ts.isPropertyAccessExpression(base)||ts.isElementAccessExpression(base))base=base.expression;
      if(ts.isIdentifier(base))mutable.add(base.text);
      if(/^process(?:\.env|\[['"]env['"]\])/.test(n.left.getText(f))||ts.isIdentifier(base)&&envAliases.has(base.text)||n.left.getText(f)==='process')ok=false;
    }
    ts.forEachChild(n,bind);
  }
  bind(f);
  function target(n:ts.Expression):ShellDbZiel|undefined{
    const v=value(n);
    if(typeof v==='string')return dbZielAusUrl(v);
    if(v&&typeof v==='object'){
      const o=v as Record<string,unknown>;
      if(Object.keys(o).some(k=>!['connectionString','host','port','database','user','password','ssl','application_name','options'].includes(k)))return undefined;
      if(o.connectionString!==undefined)return Object.keys(o).some(k=>['host','port','database','user'].includes(k))?undefined:dbZielAusUrl(o.connectionString);
      if(['host','port','database','user'].every(k=>typeof o[k]==='string'||k==='port'&&typeof o[k]==='number'))return {host:String(o.host).toLowerCase(),port:String(o.port),datenbank:String(o.database),user:String(o.user)};
    }
    return undefined;
  }
  function scan(n:ts.Node):void{
    if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer){
      const e=ts.isAwaitExpression(n.initializer)?n.initializer.expression:n.initializer;
      if(ts.isNewExpression(e)&&((ts.isIdentifier(e.expression)&&pg.has(e.expression.text))||(ts.isPropertyAccessExpression(e.expression)&&pg.has(e.expression.expression.getText(f))&&['Client','Pool'].includes(e.expression.name.text)))){
        const z=e.arguments?.length===1&&!mutable.has(n.name.text)?target(e.arguments[0]):undefined;clients.set(n.name.text,z);ziele.push(z);
      }else if(ts.isCallExpression(e)&&ts.isIdentifier(e.expression)&&poolFns.has(e.expression.text)&&!e.arguments.length){
        const z=dbZielAusUrl(env.DATABASE_URL);clients.set(n.name.text,z);ziele.push(z);
      }else if(ts.isIdentifier(e)&&clients.has(e.text))clients.set(n.name.text,clients.get(e.text));
      else if(ts.isCallExpression(e)&&ts.isPropertyAccessExpression(e.expression)&&e.expression.name.text==='connect'&&clients.has(e.expression.expression.getText(f)))clients.set(n.name.text,clients.get(e.expression.expression.getText(f)));
    }
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['query','execute'].includes(n.expression.name.text)){
      queries++;if(!clients.has(n.expression.expression.getText(f)))ziele.push(undefined);
      const s=value(n.arguments[0]);if(typeof s==='string')sql.push(s);else ok=false;
    }
    // Stringausführung/auswertbare Codewege können weitere DB-Ziele verbergen.
    if(ts.isCallExpression(n)&&(/^(?:eval|Function|process\.loadEnvFile)$/.test(n.expression.getText(f))||n.expression.getText(f).includes('dotenv')||n.arguments.some(a=>a.getText(f)==='process.env'||ts.isIdentifier(a)&&envAliases.has(a.text))))ok=false;
    ts.forEachChild(n,scan);
  }
  scan(f);return {ziele,sql,ok:ok&&queries>0&&sql.length===queries};
}
export function pruefeDbKommando(k:ShellTextKommando,env:Record<string,string|undefined>,p:ShellDbFreigabe):ShellDbErgebnis {
  const cmd=k.argv[0]?.text.replace(/\\/g,'/').split('/').pop()?.toLowerCase();
  if(cmd==='psql'||cmd==='psql.exe'){
    const x=psqlZiel(k,env),allowed=x.ok&&eigenesZiel(x.ziel,p)&&x.sql.every(s=>sqlBleibtInDb(s,x.ziel!));
    return {betroffen:true,erlaubt:allowed,ziele:allowed?[x.ziel!]:[]};
  }
  if(k.inline_skript?.sprache==='node'){
    const x=nodeZiele(k.inline_skript.text,env);
    if(!x.ziele.length&&!x.sql.length)return {betroffen:false,erlaubt:false,ziele:[]};
    const allowed=x.ok&&x.ziele.length>0&&x.ziele.every(z=>eigenesZiel(z,p))&&x.sql.every(s=>x.ziele.every(z=>sqlBleibtInDb(s,z!)));
    return {betroffen:true,erlaubt:allowed,ziele:allowed?x.ziele as ShellDbZiel[]:[]};
  }
  // Nicht verstandene SQL-Interpreter werden nie von der neuen Ausnahme erfasst.
  return {betroffen:!!k.inline_skript&&/\b(?:query|execute)\s*\(/.test(k.inline_skript.text)||!!cmd&&/^(?:mysql|mariadb|sqlite3)$/.test(cmd),erlaubt:false,ziele:[]};
}
