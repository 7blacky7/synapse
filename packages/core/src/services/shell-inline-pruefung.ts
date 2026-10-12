/** P10-T47: Sprachsyntax liefert Aufruffakten; Risiken/Stufen kommen aus dem Regelkatalog. */
import ts from'typescript';
import path from'node:path';
import{parseShellText,type ShellTextKommando}from'./shell-sicherung-parser.js';
export interface InlineKontext{cwd?:string;projekt_root?:string;project?:string;os?:string;scratchpad_roots?:string[];inline_pfade?:Record<string,boolean|undefined>;testprojekt?:boolean;}
export interface InlineOperation{ziel_im_projekt?:boolean;ziel?:string;testprojekt:boolean;statischer_befehl?:boolean;name:string;}
const dyn='<dynamisch>';
function innerhalb(value:unknown,o:InlineKontext):boolean|undefined{
 if(typeof value!=='string'||!o.projekt_root)return undefined;
 const p=o.os==='windows'?path.win32:path.posix,target=p.resolve(o.cwd??o.projekt_root,value);
 if(o.inline_pfade)return o.inline_pfade[target];
 return [o.projekt_root,...o.scratchpad_roots??[]].some(root=>{
  const rel=p.relative(root,target);return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);
 });
}
function fakt(name:string,args:unknown[],sprache:'node'|'python',o:InlineKontext,method?:string,statisch=false):ShellTextKommando{
 const sql=/(?:^|\.)(?:query|execute)$/.test(name)?
  (typeof args[0]==='string'?pythonTokens(args[0]).filter(t=>t.name).map(t=>'<SQL:'+t.text.toUpperCase()+'>'):['<SQL:DYNAMISCH>']):[];
 return {argv:[sprache,sprache==='node'?'-e':'-c',name+'()',...(method?['<'+method.toUpperCase()+'>']:[]),...sql].map(text=>({text,dynamisch:false})),umleitungen:[],
  skript_operation:{name,...(typeof args[0]==='string'?{ziel:args[0]}:{}),ziel_im_projekt:innerhalb(args[0],o),testprojekt:o.testprojekt===true,statischer_befehl:statisch}};
}
function nodeFakten(text:string,o:InlineKontext,tiefe:number):ShellTextKommando[]{
 const file=ts.createSourceFile('inline.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 if((file as ts.SourceFile&{parseDiagnostics?:unknown[]}).parseDiagnostics?.length)return [fakt('inline.ungeklaert',[],'node',o)];
 const aliases=new Map<string,string>(),decl=new Map<string,ts.Expression>(),out:ShellTextKommando[]=[];
 const moduleName=(v:string)=>v.replace(/^node:/,'').replace(/\//g,'.');
 function moduleOf(n:ts.Expression):string|undefined{
  if(ts.isAwaitExpression(n))return moduleOf(n.expression);
  if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(n.expression)&&n.expression.text==='require')&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0]))return moduleName(n.arguments[0].text);
  return undefined;
 }
 function name(n:ts.Expression,depth=0):string{
  if(depth>12)return dyn;
  if(ts.isIdentifier(n)){const v=aliases.get(n.text);if(v)return v;const d=decl.get(n.text);return d?moduleOf(d)??name(d,depth+1):n.text;}
  if(ts.isPropertyAccessExpression(n))return name(n.expression,depth+1)+'.'+n.name.text;
  if(ts.isElementAccessExpression(n)&&n.argumentExpression&&ts.isStringLiteralLike(n.argumentExpression))return name(n.expression,depth+1)+'.'+n.argumentExpression.text;
  if(ts.isCallExpression(n))return moduleOf(n)??name(n.expression,depth+1)+'()';
  if(ts.isAwaitExpression(n)||ts.isParenthesizedExpression(n))return name(n.expression,depth+1);
  return dyn;
 }
 function value(n:ts.Expression|undefined,depth=0):unknown{
  if(!n||depth>12)return undefined;
  if(ts.isStringLiteralLike(n))return n.text;
  if(ts.isNumericLiteral(n))return Number(n.text);
  if(ts.isPrefixUnaryExpression(n)&&ts.isNumericLiteral(n.operand))return (n.operator===ts.SyntaxKind.MinusToken?-1:1)*Number(n.operand.text);
  if(ts.isIdentifier(n))return value(decl.get(n.text),depth+1);
  if(ts.isParenthesizedExpression(n))return value(n.expression,depth+1);
  if(ts.isArrayLiteralExpression(n)){const a=n.elements.map(x=>ts.isSpreadElement(x)?undefined:value(x,depth+1));return a.some(x=>x===undefined)?undefined:a;}
  if(ts.isCallExpression(n)){
   const api=name(n.expression),a=n.arguments.map(x=>value(x,depth+1)),p=o.os==='windows'?path.win32:path.posix;
   if(api==='process.cwd'&&!a.length)return o.cwd;
   if(/^(?:path\.)?(?:join|resolve)$/.test(api)&&a.every(x=>typeof x==='string'))
    return api.endsWith('join')?p.join(...a as string[]):p.resolve(o.cwd??'.',...a as string[]);
  }
  return undefined;
 }
 function bind(n:ts.Node):void{
  if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)){
   const mod=moduleName(n.moduleSpecifier.text),cl=n.importClause;
   if(cl?.name)aliases.set(cl.name.text,mod);
   if(cl?.namedBindings){if(ts.isNamespaceImport(cl.namedBindings))aliases.set(cl.namedBindings.name.text,mod);
    else for(const b of cl.namedBindings.elements)aliases.set(b.name.text,mod+'.'+(b.propertyName?.text??b.name.text));}
  }
  if(ts.isVariableDeclaration(n)&&n.initializer){
   if(ts.isIdentifier(n.name))decl.set(n.name.text,n.initializer);
   else if(ts.isObjectBindingPattern(n.name)){const mod=moduleOf(n.initializer);if(mod)for(const b of n.name.elements)
    if(ts.isIdentifier(b.name))aliases.set(b.name.text,mod+'.'+(b.propertyName?.getText(file)??b.name.text));}
  }
  ts.forEachChild(n,bind);
 }
 bind(file);
 function visit(n:ts.Node):void{
  if(ts.isCallExpression(n)){
   const api=name(n.expression),args=n.arguments.map(x=>value(x));
   let method:string|undefined;
   const object=(arg:ts.Expression,depth=0):ts.Expression=>depth<12&&ts.isIdentifier(arg)&&decl.has(arg.text)?object(decl.get(arg.text)!,depth+1):arg;
   for(const argument of n.arguments){const arg=object(argument);if(ts.isObjectLiteralExpression(arg))for(const property of arg.properties)
    if(ts.isPropertyAssignment(property)&&property.name.getText(file).replace(/^['"]|['"]$/g,'')==='method'){
     const v=value(property.initializer);method=typeof v==='string'?v:dyn;
    }
   }
   if(/^(?:fetch|(?:https?|axios|requests|httpx)\.request)$/.test(api)&&n.arguments[1]&&!ts.isObjectLiteralExpression(object(n.arguments[1])))method=method??dyn;
   let projected:ShellTextKommando[]=[];
   if(/^child_process\.(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)$/.test(api)&&typeof args[0]==='string'){
    if(/^child_process\.exec(?:Sync)?$/.test(api)){const tree=parseShellText(args[0]);if(n.arguments.length===1&&!tree.komplex&&!tree.ungeklart.length)projected=tree.kommandos;}
    else if(n.arguments.length===2&&!n.arguments.some(arg=>ts.isObjectLiteralExpression(arg)&&arg.properties.some(p=>ts.isPropertyAssignment(p)&&p.name.getText(file)==='shell'&&p.initializer.kind!==ts.SyntaxKind.FalseKeyword))&&Array.isArray(args[1])&&args[1].every(x=>typeof x==='string'))projected=[{argv:[args[0],...args[1]].map(text=>({text,dynamisch:false})),umleitungen:[]}];
   }
   if(api==='process.kill'&&typeof args[0]==='number')projected.push({argv:['kill',String(args[0])].map(text=>({text,dynamisch:false})),umleitungen:[]});
   const statisch=projected.length>0&&projected.every(k=>!k.argv.some(a=>a.dynamisch)&&(!/^(?:node|python[\d.]*)(?:\.exe)?$/.test(k.argv[0]?.text??'')||!!k.inline_skript));
   out.push(fakt(api,args,'node',o,method,statisch),...projected.flatMap(k=>k.inline_skript?skriptFakten(k.inline_skript.text,k.inline_skript.sprache,o,tiefe+1):[k]));
  }
  ts.forEachChild(n,visit);
 }
 visit(file);return out;
}
interface PyToken{text:string;literal?:string;nummer?:number;name?:boolean;}
/** Python-Lexeme: Kommentare/Strings sind Daten, keine geratenen Shell-Wörter. */
function pythonTokens(text:string):PyToken[]{
 const out:PyToken[]=[];let i=0;
 while(i<text.length){
  if(/\s/.test(text[i])){i++;continue;}
  if(text[i]==='#'){while(i<text.length&&text[i]!=='\n')i++;continue;}
  const s=text.slice(i).match(/^(?:[rubf]{0,2})?(['"])/i);
  if(s){const quote=s[1],prefix=s[0].slice(0,-1),at=i+s[0].length-1,triple=text.slice(at,at+3)===quote.repeat(3),endQuote=triple?quote.repeat(3):quote;
   let j=at+endQuote.length,result='';
   while(j<text.length&&!text.startsWith(endQuote,j)){
    if(text[j]==='\\'&&j+1<text.length){const c=text[++j];result+=/r/i.test(prefix)?'\\'+c:({n:'\n',r:'\r',t:'\t'} as Record<string,string>)[c]??c;j++;}
    else result+=text[j++];
   }
   out.push({text:'<string>',...(!/f/i.test(prefix)?{literal:result}:{})});
   if(/f/i.test(prefix))for(const expr of result.matchAll(/\{([^{}]+)\}/g))out.push(...pythonTokens(expr[1]));
   i=Math.min(text.length,j+endQuote.length);continue;
  }
  const number=text.slice(i).match(/^\d+/);if(number){out.push({text:number[0],nummer:Number(number[0])});i+=number[0].length;continue;}
  const id=text.slice(i).match(/^[A-Za-z_]\w*/);
  if(id){out.push({text:id[0],name:true});i+=id[0].length;continue;}
  out.push({text:text[i++]});
 }
 return out;
}
function pythonFakten(text:string,o:InlineKontext):ShellTextKommando[]{
 const t=pythonTokens(text),aliases=new Map<string,string>(),values=new Map<string,string>(),out:ShellTextKommando[]=[];
 for(let i=0;i<t.length;i++){
  if(t[i].text==='import'&&t[i+1]?.name){let mod=t[i+1].text,j=i+2;while(t[j]?.text==='.'&&t[j+1]?.name){mod+='.'+t[j+1].text;j+=2;}
   const from=i>=2&&t[i-2].text==='from'?t[i-1].text:undefined;
   const canonical=from?from+'.'+mod:mod;aliases.set(t[j]?.text==='as'&&t[j+1]?.name?t[j+1].text:mod,canonical);
  }
  if(t[i].name&&t[i+1]?.text==='='&&t[i+2]?.literal!==undefined)values.set(t[i].text,t[i+2].literal!);
 }
 for(let i=0;i<t.length;i++){
  if(!t[i].name||t[i-1]?.text==='.'&&t[i-2]?.text!==')'||['def','class'].includes(t[i-1]?.text??''))continue;
  let api=aliases.get(t[i].text)??t[i].text,j=i+1;
  while(t[j]?.text==='.'&&t[j+1]?.name){api+='.'+t[j+1].text;j+=2;}
  if(t[j]?.text!=='(')continue;
  let arg=t[j+1];if(arg?.name&&t[j+2]?.text==='=')arg=t[j+3];
  const val=arg?.literal??arg?.nummer??(arg?.text==='-'?-(t[j+2]?.nummer??NaN):arg?.name?values.get(arg.text):undefined);
  const method=/^(?:requests|httpx)\.request$/.test(api)?typeof val==='string'?val:dyn:undefined;
  out.push(fakt(api,[val],'python',o,method));
  if(/^os\.kill(?:pg)?$/.test(api)&&typeof val==='number'&&Number.isFinite(val))out.push({argv:['kill',String(api==='os.killpg'?-Math.abs(val):val)].map(text=>({text,dynamisch:false})),umleitungen:[]});
 }
 return out;
}
export function skriptFakten(text:string,sprache:'node'|'python',o:InlineKontext={},tiefe=0):ShellTextKommando[]{
 if(tiefe>8||text.length>262144)return [fakt('inline.ungeklaert',[],sprache,o)];
 return sprache==='node'?nodeFakten(text,o,tiefe):pythonFakten(text,o);
}
