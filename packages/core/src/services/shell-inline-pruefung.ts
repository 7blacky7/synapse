/** P10-T47: Sprachsyntax liefert Aufruffakten; Risiken/Stufen kommen aus dem Regelkatalog. */
import ts from'typescript';
import path from'node:path';
import{parseShellText,type ShellTextKommando}from'./shell-sicherung-parser.js';
export interface InlineKontext{cwd?:string;projekt_root?:string;project?:string;os?:string;scratchpad_roots?:string[];inline_pfade?:Record<string,boolean|undefined>;testprojekt?:boolean;}
export interface InlineOperation{ziel_im_projekt?:boolean;ziel?:string;testprojekt:boolean;statischer_befehl?:boolean;eingabe_ungeklaert?:boolean;befehl?:ShellTextKommando;name:string;}
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
 const U=Symbol('unbekannt'),H=Symbol('git-objekt-id');
 type Scope=Map<string,unknown>;
 type Fn=ts.ArrowFunction|ts.FunctionExpression|ts.FunctionDeclaration;
 const aliases=new Map<string,string>(),decl=new Map<string,ts.Expression>(),functions=new Map<string,Fn>(),mutable=new Set<string>(),out:ShellTextKommando[]=[];
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
  if(ts.isCallExpression(n))return moduleOf(n)??'<wert>';
  if(ts.isAwaitExpression(n)||ts.isParenthesizedExpression(n))return name(n.expression,depth+1);
  return dyn;
 }
 const apiName=(n:ts.Expression)=>name(n);
 function body(fn:Fn):ts.Expression|undefined{
  if(!fn.body)return undefined;if(!ts.isBlock(fn.body))return fn.body;
  return fn.body.statements.length===1&&ts.isReturnStatement(fn.body.statements[0])?fn.body.statements[0].expression:undefined;
 }
 function fnOf(n:ts.Expression,depth=0):Fn|undefined{
  if(depth>12)return undefined;
  if(ts.isParenthesizedExpression(n))return fnOf(n.expression,depth+1);
  if(ts.isIdentifier(n)&&!mutable.has(n.text))return functions.get(n.text)??(decl.get(n.text)?fnOf(decl.get(n.text)!,depth+1):undefined);
  return undefined;
 }
 function bindings(fn:Fn,args:readonly ts.Expression[],scope:Scope,depth:number):Scope{
  const local=new Map(scope);
  fn.parameters.forEach((p,i)=>{if(ts.isIdentifier(p.name))local.set(p.name.text,i<args.length?value(args[i],scope,depth+1):p.initializer?value(p.initializer,scope,depth+1):undefined);});
  return local;
 }
 const objectValue=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const hashText=(v:unknown):v is {art:symbol;text:string}=>objectValue(v)&&v.art===H;
 function plus(a:unknown,b:unknown):unknown{
  if(typeof a==='string'&&typeof b==='string')return a+b;
  if(typeof a==='number'&&typeof b==='number')return a+b;
  if((a===H||hashText(a))&&(typeof b==='string'||b===H||hashText(b))||typeof a==='string'&&(b===H||hashText(b)))
   return {art:H,text:(a===H?'<git-objekt-id>':hashText(a)?a.text:String(a))+(b===H?'<git-objekt-id>':hashText(b)?b.text:String(b))};
  return U;
 }
 function value(n:ts.Expression|undefined,scope:Scope,depth=0):unknown{
  if(!n)return undefined;if(depth>12)return U;
  if(ts.isStringLiteralLike(n))return n.text;
  if(ts.isNumericLiteral(n))return Number(n.text);
  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isPrefixUnaryExpression(n)&&ts.isNumericLiteral(n.operand))return (n.operator===ts.SyntaxKind.MinusToken?-1:1)*Number(n.operand.text);
  if(ts.isIdentifier(n)){
   if(mutable.has(n.text))return U;
   if(scope.has(n.text))return scope.get(n.text);
   if(n.text==='undefined')return undefined;
   return decl.has(n.text)?value(decl.get(n.text),scope,depth+1):U;
  }
  if(ts.isParenthesizedExpression(n)||ts.isAwaitExpression(n))return value(n.expression,scope,depth+1);
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken)return plus(value(n.left,scope,depth+1),value(n.right,scope,depth+1));
  if(ts.isArrayLiteralExpression(n)){const xs:unknown[]=[];for(const e of n.elements){const v=value(ts.isSpreadElement(e)?e.expression:e,scope,depth+1);if(ts.isSpreadElement(e)){if(!Array.isArray(v))return U;xs.push(...v);}else xs.push(v);}return xs;}
  if(ts.isObjectLiteralExpression(n)){
   const obj:Record<string,unknown>={};
   for(const p of n.properties){
    if(ts.isSpreadAssignment(p)){const v=value(p.expression,scope,depth+1);if(!objectValue(v)||hashText(v))return U;Object.assign(obj,v);}
    else if(ts.isShorthandPropertyAssignment(p))obj[p.name.text]=value(p.name,scope,depth+1);
    else if(ts.isPropertyAssignment(p)&&!ts.isComputedPropertyName(p.name))obj[p.name.getText(file).replace(/^['"]|['"]$/g,'')]=value(p.initializer,scope,depth+1);
    else return U;
   }
   return obj;
  }
  if(ts.isCallExpression(n)){
   const fn=fnOf(n.expression),expr=fn&&body(fn);if(fn&&expr)return value(expr,bindings(fn,n.arguments,scope,depth),depth+1);
   if(ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='trim')return value(n.expression.expression,scope,depth+1);
   const api=apiName(n.expression),args=n.arguments.map(x=>value(x,scope,depth+1)),p=o.os==='windows'?path.win32:path.posix;
   if(api==='process.cwd'&&!args.length)return o.cwd;
   if(/^(?:path\.)?(?:join|resolve)$/.test(api)&&args.every(x=>typeof x==='string'))return api.endsWith('join')?p.join(...args as string[]):p.resolve(o.cwd??'.',...args as string[]);
   if(api==='Object.entries'&&objectValue(args[0])&&!hashText(args[0]))return Object.entries(args[0]);
   if(api==='Object.keys'&&objectValue(args[0])&&!hashText(args[0]))return Object.keys(args[0]);
   if(api==='child_process.execFileSync'&&args[0]==='git'&&Array.isArray(args[1])&&args[1][0]==='hash-object'&&objectValue(args[2])&&typeof args[2].encoding==='string')return H;
  }
  return U;
 }
 function baseIdentifier(n:ts.Node):string|undefined{
  if(ts.isIdentifier(n))return n.text;
  if(ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n))return baseIdentifier(n.expression);
  return undefined;
 }
 function bind(n:ts.Node):void{
  if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)){
   const mod=moduleName(n.moduleSpecifier.text),cl=n.importClause;if(cl?.name)aliases.set(cl.name.text,mod);
   if(cl?.namedBindings){if(ts.isNamespaceImport(cl.namedBindings))aliases.set(cl.namedBindings.name.text,mod);else for(const b of cl.namedBindings.elements)aliases.set(b.name.text,mod+'.'+(b.propertyName?.text??b.name.text));}
  }
  if(ts.isVariableDeclaration(n)&&n.initializer){
   if(ts.isIdentifier(n.name)){decl.set(n.name.text,n.initializer);if((ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer))&&body(n.initializer))functions.set(n.name.text,n.initializer);}
   else if(ts.isObjectBindingPattern(n.name)){const mod=moduleOf(n.initializer);if(mod)for(const b of n.name.elements)if(ts.isIdentifier(b.name))aliases.set(b.name.text,mod+'.'+(b.propertyName?.getText(file)??b.name.text));}
  }
  if(ts.isFunctionDeclaration(n)&&n.name&&body(n))functions.set(n.name.text,n);
  if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){const key=baseIdentifier(n.left);if(key)mutable.add(key);}
  if((ts.isPrefixUnaryExpression(n)||ts.isPostfixUnaryExpression(n))&&(n.operator===ts.SyntaxKind.PlusPlusToken||n.operator===ts.SyntaxKind.MinusMinusToken)){const key=baseIdentifier(n.operand);if(key)mutable.add(key);}
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&/^(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/.test(n.expression.name.text)){const key=baseIdentifier(n.expression.expression);if(key)mutable.add(key);}
  ts.forEachChild(n,bind);
 }
 bind(file);
 if(mutable.has('process'))o={...o,testprojekt:false};
 const wrappers=new Set(functions.values());let budget=0,grenze=false;
 function visit(n:ts.Node,scope:Scope,depth=0):void{
  if(depth>12||++budget>2048){if(!grenze){out.push(fakt('inline.ungeklaert',[],'node',o));grenze=true;}return;}
  if((ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isFunctionDeclaration(n))&&wrappers.has(n))return;
  if(ts.isForOfStatement(n)&&ts.isVariableDeclarationList(n.initializer)&&n.initializer.declarations.length===1){
   const pattern=n.initializer.declarations[0].name,items=value(n.expression,scope);
   const apply=(item:unknown)=>{const local=new Map(scope);if(ts.isIdentifier(pattern))local.set(pattern.text,item);
    else if(ts.isArrayBindingPattern(pattern))pattern.elements.forEach((b,i)=>{if(ts.isBindingElement(b)&&ts.isIdentifier(b.name))local.set(b.name.text,Array.isArray(item)?item[i]:U);});
    visit(n.statement,local,depth+1);};
   if(Array.isArray(items)&&items.length<=64)for(const item of items)apply(item);else apply(U);
   return;
  }
  if(ts.isCallExpression(n)){
   const fn=fnOf(n.expression),expr=fn&&body(fn);
   if(fn&&expr){for(const arg of n.arguments)visit(arg,scope,depth+1);visit(expr,bindings(fn,n.arguments,scope,depth),depth+1);return;}
   const api=apiName(n.expression),args=n.arguments.map(x=>value(x,scope)),opts=args[2];
   let method:string|undefined;
   for(const v of args)if(objectValue(v)&&Object.hasOwn(v,'method'))method=typeof v.method==='string'?v.method:dyn;
   if(/^(?:fetch|(?:https?|axios|requests|httpx)\.request)$/.test(api)&&n.arguments[1]&&!objectValue(args[1]))method=method??dyn;
   let projected:ShellTextKommando[]=[],eingabe=false;
   const optionsOk=n.arguments.length<=2||n.arguments.length===3&&objectValue(opts)&&!hashText(opts)&&Object.keys(opts).every(k=>['encoding','stdio','input'].includes(k))&&
    (opts.encoding===undefined||opts.encoding===null||typeof opts.encoding==='string')&&
    (opts.stdio===undefined||typeof opts.stdio==='string'&&['pipe','inherit','ignore'].includes(opts.stdio));
   if(/^child_process\.(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)$/.test(api)&&typeof args[0]==='string'){
    if(/^child_process\.exec(?:Sync)?$/.test(api)){const tree=parseShellText(args[0]);if(n.arguments.length===1&&!tree.komplex&&!tree.ungeklart.length)projected=tree.kommandos;}
    else if(optionsOk&&Array.isArray(args[1])){
     const words=[args[0],...args[1]],argv=words.map((v,i)=>{
      const cache=i>=2&&words[0]==='git'&&words[1]==='update-index'&&words[i-1]==='--cacheinfo'&&hashText(v)&&/^[0-7]{6},<git-objekt-id>,/.test(v.text);
      return {text:typeof v==='string'?v:cache?v.text:dyn,dynamisch:typeof v!=='string'&&!cache};
     });
     projected=[{argv,umleitungen:[]}];eingabe=objectValue(opts)&&opts.input!==undefined&&typeof opts.input!=='string';
    }
   }
   if(api==='process.kill'&&typeof args[0]==='number')projected.push({argv:['kill',String(args[0])].map(text=>({text,dynamisch:false})),umleitungen:[]});
   const statisch=projected.length>0&&projected.every(k=>!k.argv.some(a=>a.dynamisch)&&(!/^(?:node|python[\d.]*)(?:\.exe)?$/.test(k.argv[0]?.text??'')||!!k.inline_skript));
   const carrier=fakt(api,args,'node',o,method,statisch);
   if(eingabe&&carrier.skript_operation){carrier.skript_operation.eingabe_ungeklaert=true;carrier.skript_operation.befehl=projected[0];}
   out.push(carrier,...projected.flatMap(k=>k.inline_skript?skriptFakten(k.inline_skript.text,k.inline_skript.sprache,o,tiefe+1):[k]));
   for(const arg of n.arguments){const escaped=fnOf(arg),e=escaped&&body(escaped);if(escaped&&e)visit(e,new Map(escaped.parameters.filter(p=>ts.isIdentifier(p.name)).map(p=>[(p.name as ts.Identifier).text,U])),depth+1);}
  }
  if(ts.isIdentifier(n)&&functions.has(n.text)){
   const parent=n.parent;
   const declaration=(ts.isVariableDeclaration(parent)||ts.isFunctionDeclaration(parent))&&parent.name===n;
   if(!declaration){const escaped=functions.get(n.text)!,e=body(escaped);if(e){
    const unknown=new Map(scope);for(const p of escaped.parameters)if(ts.isIdentifier(p.name))unknown.set(p.name.text,U);
    visit(e,unknown,depth+1);
   }}
  }
  ts.forEachChild(n,child=>visit(child,scope,depth));
 }
 visit(file,new Map());return out;
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
