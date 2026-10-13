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
function nodeFreigabe(text:string,env:Record<string,string|undefined>,p:ShellDbFreigabe):ShellDbErgebnis{
  const f=ts.createSourceFile('db-ziel.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const betroffen=/\b(?:query|execute)\s*\(|\b(?:Client|Pool|getPool)\s*\(/.test(text);
  if(!betroffen)return {betroffen:false,erlaubt:false,ziele:[]};
  if((f as ts.SourceFile&{parseDiagnostics?:unknown[]}).parseDiagnostics?.length)return {betroffen:true,erlaubt:false,ziele:[]};
  const decl=new Map<string,ts.Expression>(),zuweisungen=new Map<string,ts.BinaryExpression[]>(),ziele:Array<ShellDbZiel|undefined>=[],sqlTexte:string[]=[],konstruktoren=new Set(['Client','Pool']);
  const raw=env.DATABASE_URL,defaultZiel=raw?dbZielAusUrl(raw):pgUmgebungsZiel(env);
  if(raw||Object.keys(env).some(k=>/^PG(?:HOST|PORT|DATABASE|USER)$/.test(k)&&!!env[k]))ziele.push(defaultZiel);
  let ok=true;
  function key(n:ts.Expression):string|undefined{
    if(ts.isIdentifier(n))return n.text;
    if(ts.isPropertyAccessExpression(n)){const b=key(n.expression);return b?b+'.'+n.name.text:undefined;}
    if(ts.isElementAccessExpression(n)&&n.argumentExpression&&ts.isStringLiteralLike(n.argumentExpression)){const b=key(n.expression);return b?b+'.'+n.argumentExpression.text:undefined;}
    return undefined;
  }
  function bind(n:ts.Node):void{
    if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)decl.set(n.name.text,n.initializer);
    if(ts.isImportSpecifier(n)&&['Client','Pool'].includes(n.propertyName?.text??n.name.text))konstruktoren.add(n.name.text);
    if(ts.isVariableDeclaration(n)&&ts.isObjectBindingPattern(n.name))for(const e of n.name.elements)if(ts.isIdentifier(e.name)&&['Client','Pool'].includes(e.propertyName?.getText(f)??e.name.text))konstruktoren.add(e.name.text);
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){
      const k=key(n.left);if(k)zuweisungen.set(k,[...zuweisungen.get(k)??[],n]);
    }
    ts.forEachChild(n,bind);
  }
  bind(f);
  function value(n:ts.Expression|undefined,depth=0):unknown{
    if(!n||depth>12)return undefined;
    if(ts.isStringLiteralLike(n))return n.text;
    if(ts.isNumericLiteral(n))return String(n.text);
    if(ts.isIdentifier(n)){
      const a=zuweisungen.get(n.text)?.at(-1);
      if(a?.operatorToken.kind===ts.SyntaxKind.EqualsToken)return value(a.right,depth+1);
      if(a?.operatorToken.kind===ts.SyntaxKind.PlusEqualsToken){const b=value(decl.get(n.text),depth+1),v=value(a.right,depth+1);return typeof b==='string'&&typeof v==='string'?b+v:undefined;}
      return a?undefined:value(decl.get(n.text),depth+1);
    }
    if(ts.isAwaitExpression(n)||ts.isParenthesizedExpression(n))return value(n.expression,depth+1);
    if(ts.isPropertyAccessExpression(n)&&n.expression.getText(f)==='process.env')return env[n.name.text];
    if(ts.isBinaryExpression(n)){
      const a=value(n.left,depth+1),b=value(n.right,depth+1);
      if(n.operatorToken.kind===ts.SyntaxKind.PlusToken)return typeof a==='string'&&typeof b==='string'?a+b:undefined;
      if(n.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken)return a===undefined||a===null?b:a;
      if(n.operatorToken.kind===ts.SyntaxKind.BarBarToken)return a||b;
    }
    if(ts.isTemplateExpression(n)){
      let s=n.head.text;for(const part of n.templateSpans){const v=value(part.expression,depth+1);if(typeof v!=='string')return undefined;s+=v+part.literal.text;}return s;
    }
    if(ts.isNewExpression(n)&&n.expression.getText(f)==='URL')return value(n.arguments?.[0],depth+1);
    if(ts.isPropertyAccessExpression(n)&&['href','pathname'].includes(n.name.text)){
      const raw=value(n.expression,depth+1);if(typeof raw==='string')try{return n.name.text==='href'?raw:new URL(raw).pathname;}catch{return undefined;}
    }
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='toString')return value(n.expression.expression,depth+1);
    if(ts.isPropertyAccessExpression(n)){const o=objekt(n.expression,depth+1);if(o)return value(eigenschaften(o).get(n.name.text),depth+1);}
    return undefined;
  }
  function objekt(n:ts.Expression|undefined,depth=0):ts.ObjectLiteralExpression|undefined{
    if(!n||depth>12)return undefined;
    if(ts.isObjectLiteralExpression(n))return n;
    if(ts.isIdentifier(n))return objekt(decl.get(n.text),depth+1);
    if(ts.isParenthesizedExpression(n)||ts.isAwaitExpression(n))return objekt(n.expression,depth+1);
    if(ts.isPropertyAccessExpression(n)){const o=objekt(n.expression,depth+1);return o?objekt(eigenschaften(o).get(n.name.text),depth+1):undefined;}
    if(ts.isElementAccessExpression(n)&&n.argumentExpression&&ts.isStringLiteralLike(n.argumentExpression)){const o=objekt(n.expression,depth+1);return o?objekt(eigenschaften(o).get(n.argumentExpression.text),depth+1):undefined;}
    return undefined;
  }
  function eigenschaften(o:ts.ObjectLiteralExpression):Map<string,ts.Expression>{
    const out=new Map<string,ts.Expression>();
    for(const p of o.properties){
      if(ts.isPropertyAssignment(p))out.set(p.name.getText(f).replace(/^['"]|['"]$/g,''),p.initializer);
      else if(ts.isShorthandPropertyAssignment(p))out.set(p.name.text,p.name);
    }
    return out;
  }
  function objektKeys(o:ts.ObjectLiteralExpression,n:ts.Expression):string[]{
    return [...new Set([key(n),...[...decl].filter(([,e])=>objekt(e)===o).map(([k])=>k)].filter((k):k is string=>!!k))];
  }
  /** Nur konkrete initiale/zugewiesene Werte; fremde Literale niemals durch den Default verdecken. */
  function bekannteWerte(n:ts.Expression|undefined,feldKey?:string,seen=new Set<string>()):unknown[]{
    const out:unknown[]=[];let current=value(n),k=feldKey??(n?key(n):undefined);
    if(current!==undefined)out.push(current);
    if(k&&!seen.has(k)){
      const next=new Set(seen);next.add(k);
      if(n&&ts.isIdentifier(n)&&decl.has(n.text)){
        const original=decl.get(n.text)!;
        if(ts.isIdentifier(original)||ts.isPropertyAccessExpression(original))out.push(...bekannteWerte(original,undefined,next).filter(v=>v!==undefined));
      }
      for(const a of zuweisungen.get(k)??[]){
        const rhs=value(a.right);
        current=a.operatorToken.kind===ts.SyntaxKind.EqualsToken?rhs:a.operatorToken.kind===ts.SyntaxKind.PlusEqualsToken&&typeof current==='string'&&typeof rhs==='string'?current+rhs:undefined;
        if(current!==undefined)out.push(current);
      }
    }
    if(current===undefined)out.push(undefined);
    return out;
  }
  function url(n:ts.Expression,feldKey?:string):void{
    for(const v of bekannteWerte(n,feldKey))ziele.push(typeof v==='string'?dbZielAusUrl(v):undefined);
  }
  function konfigurierteZiele(n:ts.Expression):void{
    const o=objekt(n);if(!o)return;
    const props=eigenschaften(o),basisKeys=objektKeys(o,n);
    const uri=props.get('connectionString');
    if(uri)for(const k of basisKeys.length?basisKeys:[undefined])url(uri,k?k+'.connectionString':undefined);
    const uriWerte=uri?(basisKeys.length?basisKeys:[undefined]).flatMap(k=>bekannteWerte(uri,k?k+'.connectionString':undefined)):[];
    const base=uriWerte.length?dbZielAusUrl(uriWerte.at(-1)):defaultZiel;
    const tuple:Record<string,unknown>={host:base?.host,port:base?.port,database:base?.datenbank,user:base?.user};
    let hatOverride=false;
    for(const k of ['host','port','database','user']){
      const fks=basisKeys.map(b=>b+'.'+k);
      if(!props.has(k)&&!fks.some(fk=>zuweisungen.has(fk)))continue;
      hatOverride=true;
      const values=(fks.length?fks:[undefined]).flatMap(fk=>bekannteWerte(props.get(k),fk));
      for(const v of values){
        if(typeof v!=='string'){ok=false;continue;}
        // Jedes sichtbare Zwischenziel muss ebenso im eigenen Kontext bleiben.
        const z={host:String(k==='host'?v:tuple.host??''),port:String(k==='port'?v:tuple.port??''),datenbank:String(k==='database'?v:tuple.database??''),user:String(k==='user'?v:tuple.user??'')};
        if(base&&!eigenesZiel(z,p))ok=false;
      }
      tuple[k]=values.at(-1);
    }
    if(hatOverride)ziele.push(Object.values(tuple).every(v=>typeof v==='string'&&!!v)?{host:String(tuple.host).toLowerCase(),port:String(tuple.port),datenbank:String(tuple.database),user:String(tuple.user)}:undefined);
  }
  function scan(n:ts.Node):void{
    if(ts.isPropertyAssignment(n)&&n.name.getText(f).replace(/^['"]|['"]$/g,'')==='connectionString')url(n.initializer);
    if(ts.isNewExpression(n)&&(ts.isIdentifier(n.expression)?konstruktoren.has(n.expression.text):ts.isPropertyAccessExpression(n.expression)&&['Client','Pool'].includes(n.expression.name.text))&&n.arguments?.[0]&&ts.isStringLiteralLike(n.arguments[0]))url(n.arguments[0]);
    if(ts.isNewExpression(n)&&n.arguments?.[0]&&(ts.isIdentifier(n.expression)?konstruktoren.has(n.expression.text):ts.isPropertyAccessExpression(n.expression)&&['Client','Pool'].includes(n.expression.name.text)))konfigurierteZiele(n.arguments[0]);
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&/^process\.env\.(?:DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER)$/.test(n.left.getText(f))){
      const v=value(n.right);if(n.left.getText(f)==='process.env.DATABASE_URL'&&typeof v==='string')ziele.push(dbZielAusUrl(v));
      else if(n.left.getText(f)==='process.env.DATABASE_URL'&&/^process\.env\./.test(n.right.getText(f)))ok=false;
      else if(typeof v==='string'&&n.left.getText(f)!=='process.env.DATABASE_URL'){
        const key=n.left.getText(f).slice(12),soll=defaultZiel&&({PGHOST:defaultZiel.host,PGPORT:defaultZiel.port,PGDATABASE:defaultZiel.datenbank,PGUSER:defaultZiel.user} as Record<string,string>)[key];
        if(v!==soll)ok=false;
      }
    }
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['query','execute'].includes(n.expression.name.text)&&n.arguments[0]){
      const a=n.arguments[0],o=objekt(a),e=o?eigenschaften(o).get('text'):a;
      const fks=o?objektKeys(o,a).map(k=>k+'.text'):[];
      for(const v of (fks.length?fks:[undefined]).flatMap(k=>bekannteWerte(e,k)))if(typeof v==='string')sqlTexte.push(v);
    }
    ts.forEachChild(n,scan);
  }
  scan(f);
  const erlaubt=ok&&ziele.length>0&&ziele.every(z=>eigenesZiel(z,p)&&dbUmgebungPasst(env,z)&&sqlTexte.every(s=>sqlBleibtInDb(s,z)));
  return {betroffen:true,erlaubt,ziele:erlaubt?ziele as ShellDbZiel[]:[]};
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
