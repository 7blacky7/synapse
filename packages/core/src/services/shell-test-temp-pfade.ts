/** t84: begrenzte Test-Pfadprovenanz; weder Testcode noch Helfer werden ausgeführt. */
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {InlineKontext} from './shell-inline-pruefung.js';
const TEMP=Symbol('selbst-mkdtemp'),FACTORY=Symbol('test-mkdtemp-factory');
interface Temp {art:typeof TEMP;id:number;rel:string;}
interface Factory {art:typeof FACTORY;base:string;methoden:Set<string>;}
const moduleName=(s:string)=>s.replace(/^node:/,'').replace(/\//g,'.');
const sichererPrefix=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}-$/.test(s);
export class ShellTestTempPfade {
 readonly erlaubt:boolean;
 readonly testdatei:boolean;
 private readonly links:boolean;
 private readonly cwdGeaendert:boolean;
 private readonly p:typeof path.posix;
 private readonly factory=new Map<string,Factory>();
 constructor(private readonly o:InlineKontext,private readonly file:ts.SourceFile,private readonly unbekannt:symbol){
  this.p=o.os==='windows'?path.win32:path.posix;
  const rel=o.testdatei_pfad&&o.projekt_root?this.p.relative(o.projekt_root,o.testdatei_pfad).replace(/\\/g,'/'):'';
  let tempEnvGeaendert=false,links=false,cwdGeaendert=false,letztesSchreiben=-1,lastFs:ts.Node|undefined;
  const fsAliase=new Set<string>();
  for(const n of file.statements)if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)&&/^(?:node:)?fs(?:\/promises)?$/.test(n.moduleSpecifier.text)&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings))for(const b of n.importClause.namedBindings.elements)if(/^(?:rm|unlink|writeFile|appendFile|rename|copyFile|cp|mkdir|rmdir|truncate)(?:Sync)?$/.test(b.propertyName?.text??b.name.text))fsAliase.add(b.name.text);
  const fsScan=(n:ts.Node):void=>{if(ts.isCallExpression(n)&&(/\.(?:rm|unlink|writeFile|appendFile|rename|copyFile|cp|mkdir|rmdir|truncate)(?:Sync)?$/.test(n.expression.getText(file))||ts.isIdentifier(n.expression)&&fsAliase.has(n.expression.text))){if(n.end>letztesSchreiben){letztesSchreiben=n.end;lastFs=n;}}ts.forEachChild(n,fsScan);};fsScan(file);
  const linkAliase=new Set<string>();
  for(const n of file.statements)if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)&&/^(?:node:)?fs(?:\/promises)?$/.test(n.moduleSpecifier.text)&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings))for(const b of n.importClause.namedBindings.elements)if(/^(?:symlink|link)(?:Sync)?$/.test(b.propertyName?.text??b.name.text))linkAliase.add(b.name.text);
  const funktionVon=(n:ts.Node|undefined):ts.Node|undefined=>{while(n&&!ts.isFunctionLike(n))n=n.parent;return n;};
  const nachCleanup=(n:ts.Node):boolean=>{
   if(!lastFs||n.pos<letztesSchreiben||funktionVon(n)!==funktionVon(lastFs))return false;
   for(let a:ts.Node|undefined=n.parent;a;a=a.parent)
    if(ts.isBlock(a)&&ts.isTryStatement(a.parent)&&a.parent.finallyBlock===a&&lastFs.pos>a.pos&&lastFs.end<=a.end)return true;
   return false;
  };
  const envZiel=(n:ts.Node)=>/^(?:process\.env$|process\.env\.(?:TMPDIR|TMP|TEMP)\b|process\.env\[)/i.test(n.getText(file));
  const envScan=(n:ts.Node):void=>{
   if(ts.isCallExpression(n)&&n.expression.getText(file)==='process.chdir'||ts.isBinaryExpression(n)&&/^process\.(?:cwd|chdir)$/.test(n.left.getText(file)))cwdGeaendert=true;
   if(ts.isCallExpression(n)&&(/(?:^|\.)(?:symlink|link)(?:Sync)?$/.test(n.expression.getText(file))||ts.isIdentifier(n.expression)&&linkAliase.has(n.expression.text)))links=true;
   if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&!nachCleanup(n)&&envZiel(n.left))tempEnvGeaendert=true;
   if(ts.isDeleteExpression(n)&&!nachCleanup(n)&&envZiel(n.expression))tempEnvGeaendert=true;
   if(ts.isCallExpression(n)&&!nachCleanup(n)&&/^Object\.(?:assign|defineProperty|defineProperties)$/.test(n.expression.getText(file))&&n.arguments[0]?.getText(file)==='process.env')
    for(const a of n.arguments.slice(1)){
     if(/(?:TMPDIR|TMP|TEMP)/i.test(a.getText(file)))tempEnvGeaendert=true;
     if(n.expression.getText(file)==='Object.assign'&&(!ts.isObjectLiteralExpression(a)||a.properties.some(p=>ts.isSpreadAssignment(p))))tempEnvGeaendert=true;
    }
   ts.forEachChild(n,envScan);
  };envScan(file);
  this.testdatei=!!rel&&!rel.startsWith('../')&&!this.p.isAbsolute(rel)&&/^(?:packages\/[^/]+\/tests\/|scripts\/test-[^/]+(?:$|\/))/.test(rel);
  this.links=links;this.cwdGeaendert=cwdGeaendert;
  this.erlaubt=this.testdatei&&!tempEnvGeaendert&&!links&&!cwdGeaendert;
  if(this.erlaubt)for(const statement of file.statements){
   if(!ts.isImportDeclaration(statement)||!ts.isStringLiteralLike(statement.moduleSpecifier)||!statement.moduleSpecifier.text.startsWith('.'))continue;
   const specifier=statement.moduleSpecifier.text;
   const source=o.testhelfer?.find(h=>h.pfad===this.p.resolve(this.p.dirname(o.testdatei_pfad!),specifier));
   if(!source)continue;
   const hrel=this.p.relative(o.projekt_root!,source.pfad).replace(/\\/g,'/');
   if(!/^(?:packages\/[^/]+\/tests\/|scripts\/test-[^/]+(?:$|\/))/.test(hrel)||!/^[a-f0-9]{64}$/.test(source.sha256))continue;
   const bindings=statement.importClause?.namedBindings;
   if(!bindings||!ts.isNamedImports(bindings))continue;
   for(const b of bindings.elements){
    const summary=this.helfer(source.text,b.propertyName?.text??b.name.text);
    if(summary)this.factory.set(moduleName(statement.moduleSpecifier.text)+'.'+(b.propertyName?.text??b.name.text),summary);
   }
  }
 }
 ist(v:unknown):v is Temp {return !!v&&typeof v==='object'&&(v as Temp).art===TEMP;}
 private istFactory(v:unknown):v is Factory {return !!v&&typeof v==='object'&&(v as Factory).art===FACTORY;}
 dateiUrl():unknown {return this.erlaubt?pathToFileURL(this.o.testdatei_pfad!).href:this.unbekannt;}
 private innen(base:string,target:string):boolean{
  const r=this.p.relative(base,target);return r!==''&&r!=='..'&&!r.startsWith('..'+this.p.sep)&&!this.p.isAbsolute(r);
 }
 private coedit():string|undefined{
  if(!this.o.projekt_root)return undefined;
  const root=this.p.join(this.o.projekt_root,'coedit-test');
  return !this.o.inline_pfade||this.o.inline_pfade[root]===true?root:undefined;
 }
 private prefix(p:unknown):boolean {
  if(!this.erlaubt||typeof p!=='string'||!sichererPrefix(this.p.basename(p)))return false;
  const dir=this.p.dirname(p),coedit=this.coedit();
  if(coedit&&(dir===coedit||this.innen(coedit,dir)))return true;
  if(this.o.test_tmpdir&&dir===this.o.test_tmpdir)return true;
  const rel=this.o.projekt_root?this.p.relative(this.o.projekt_root,dir).replace(/\\/g,'/'):'';
  return /^(?:packages\/[^/]+\/tests\/fixtures)(?:\/|$)/.test(rel)&&
   (!this.o.inline_pfade||this.o.inline_pfade[p]===true);
 }
 private tempPath(v:Temp,rel:string):unknown {
  // Ein symbolischer Root ist kein beliebiger String: ../ und ein Sibling-Suffix dürfen ihn nicht verlassen.
  if(rel!==''&&!rel.startsWith(this.p.sep))return this.unbekannt;
  const root=this.p.resolve(this.p.parse(this.o.projekt_root??'/').root,'__synapse_test_root__');
  const target=this.p.normalize(root+rel),r=this.p.relative(root,target);
  if(r==='..'||r.startsWith('..'+this.p.sep)||this.p.isAbsolute(r))return this.unbekannt;
  return {art:TEMP,id:v.id,rel:r?this.p.sep+r:''} satisfies Temp;
 }
 plus(a:unknown,b:unknown):unknown|undefined{
  return this.ist(a)?typeof b==='string'?this.tempPath(a,a.rel+b):this.unbekannt:undefined;
 }
 call(api:string,args:unknown[],receiver:unknown,n:ts.CallExpression):unknown|undefined {
  if(!this.erlaubt)return undefined;
  if(api==='os.tmpdir'&&!args.length)return this.o.test_tmpdir??this.unbekannt;
  if(api==='url.fileURLToPath'&&typeof args[0]==='string')try{return fileURLToPath(args[0]);}catch{return this.unbekannt;}
  if(api==='path.dirname'&&typeof args[0]==='string')return this.p.dirname(args[0]);
  if(api==='path.dirname'&&this.ist(args[0]))return args[0].rel?this.tempPath(args[0],this.p.dirname(args[0].rel)):this.unbekannt;
  if(/^(?:path\.)?(?:join|resolve)$/.test(api)&&this.ist(args[0])){
   if(!args.slice(1).every(a=>typeof a==='string'&&!this.p.isAbsolute(a)))return this.unbekannt;
   const anchor=this.p.resolve(this.p.parse(this.o.projekt_root??'/').root,'__synapse_test_root__');
   const target=api.endsWith('resolve')?this.p.resolve(anchor+args[0].rel,...args.slice(1) as string[]):this.p.join(anchor+args[0].rel,...args.slice(1) as string[]);
   const rel=this.p.relative(anchor,target);
   if(rel==='..'||rel.startsWith('..'+this.p.sep)||this.p.isAbsolute(rel))return this.unbekannt;
   return {art:TEMP,id:args[0].id,rel:rel?this.p.sep+rel:''} satisfies Temp;
  }
  if(/^fs(?:\.promises)?\.mkdtemp(?:Sync)?$/.test(api))
   return this.prefix(args[0])?{art:TEMP,id:n.pos,rel:''} satisfies Temp:this.unbekannt;
  const summary=this.factory.get(api);
  if(summary)return args.length===0?summary:this.unbekannt;
  if(this.istFactory(receiver)&&ts.isPropertyAccessExpression(n.expression)&&receiver.methoden.has(n.expression.name.text)){
   const prefix=sichererPrefix(args[0])?this.p.join(receiver.base,args[0]):undefined;
   return args.length===1&&this.prefix(prefix)?{art:TEMP,id:n.pos,rel:''} satisfies Temp:this.unbekannt;
  }
  return undefined;
 }
 /** Nur tatsächlich schreibende Datei-APIs; Rename/Copy brauchen auch ein begrenztes Ziel. */
 dateiOperation(api:string,args:unknown[]):boolean|undefined {
  if(!this.testdatei||!/^fs(?:\.promises)?\.(?:rm|unlink|writeFile|appendFile|rename|copyFile|cp|mkdir|rmdir|truncate)(?:Sync)?$/.test(api))return undefined;
  if(this.links||this.cwdGeaendert)return false;
  const safe=(v:unknown)=>this.ist(v)||typeof v==='string'&&!!this.coedit()&&this.innen(this.coedit()!,this.p.resolve(this.o.cwd??this.o.projekt_root!,v))&&
   (!this.o.inline_pfade||this.o.inline_pfade[this.p.resolve(this.o.cwd??this.o.projekt_root!,v)]===true);
  return safe(args[0])&&(!/\.(?:rename|copyFile|cp)(?:Sync)?$/.test(api)||safe(args[1]));
 }
 /** Schmale Helferform: Factory ohne Override, zurückgegebene Methode erzeugt mkdtemp
  * und gibt dessen Root direkt oder über einen reinen Pfadnormalisierer zurück. */
 private helfer(text:string,exportName:string):Factory|undefined {
  if(text.length>65536)return undefined;
  const f=ts.createSourceFile('test-helfer.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  if((f as ts.SourceFile&{parseDiagnostics?:unknown[]}).parseDiagnostics?.length)return undefined;
  const aliases=new Map<string,string>(),decl=new Map<string,ts.Expression>(),mutable=new Set<string>();
  const name=(e:ts.Expression):string=>ts.isIdentifier(e)?aliases.has(e.text)&&mutable.has(e.text)?'?':aliases.get(e.text)??e.text:ts.isPropertyAccessExpression(e)?name(e.expression)+'.'+e.name.text:'?';
  const scan=(n:ts.Node):void=>{
   if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings))
    for(const b of n.importClause.namedBindings.elements)aliases.set(b.name.text,moduleName(n.moduleSpecifier.text)+'.'+(b.propertyName?.text??b.name.text));
   if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer){if(decl.has(n.name.text))mutable.add(n.name.text);decl.set(n.name.text,n.initializer);}
   if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){let left:ts.Expression=n.left;while(ts.isPropertyAccessExpression(left)||ts.isElementAccessExpression(left))left=left.expression;if(ts.isIdentifier(left))mutable.add(left.text);}
   ts.forEachChild(n,scan);
  };scan(f);
  const factory=f.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===exportName&&!!n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
  if(!factory?.body)return undefined;
  for(const param of factory.parameters)if(ts.isObjectBindingPattern(param.name))
   for(const b of param.name.elements)if(ts.isIdentifier(b.name)&&b.initializer)decl.set(b.name.text,b.initializer);
  const evalPath=(e:ts.Expression|undefined,scope=new Map<string,string>(),depth=0):string|undefined=>{
   if(!e||depth>12)return undefined;if(ts.isAwaitExpression(e)||ts.isParenthesizedExpression(e))return evalPath(e.expression,scope,depth+1);
   if(ts.isStringLiteralLike(e))return e.text;
   if(ts.isIdentifier(e))return mutable.has(e.text)?undefined:scope.get(e.text)??evalPath(decl.get(e.text),scope,depth+1);
   if(ts.isCallExpression(e)){
    const api=name(e.expression),args=e.arguments.map(a=>evalPath(a,scope,depth+1));
    if(api==='process.cwd'&&!args.length)return this.o.cwd;
    if(/^(?:path\.)?(?:join|resolve)$/.test(api)&&args.every(a=>typeof a==='string'))return api.endsWith('join')?this.p.join(...args as string[]):this.p.resolve(this.o.cwd??'.',...args as string[]);
   }return undefined;
  };
  const returned=factory.body.statements.filter((s):s is ts.ReturnStatement=>ts.isReturnStatement(s)).at(-1);
  if(!returned?.expression||!ts.isObjectLiteralExpression(returned.expression))return undefined;
  const extraReturns=(body:ts.Node,last:ts.Node):boolean=>{let extra=false;const scan=(n:ts.Node)=>{if(n!==body&&ts.isFunctionLike(n))return;if(ts.isReturnStatement(n)&&n!==last)extra=true;ts.forEachChild(n,scan);};scan(body);return extra;};
  if(extraReturns(factory.body,returned))return undefined;
  const methoden=new Set<string>();let base:string|undefined;
  for(const prop of returned.expression.properties){
   if(!prop.name)continue;
   const local=ts.isShorthandPropertyAssignment(prop)?prop.name.text:ts.isPropertyAssignment(prop)&&ts.isIdentifier(prop.initializer)?prop.initializer.text:undefined;
   const fn=local?decl.get(local):undefined;
   if(!fn||!ts.isArrowFunction(fn)||!ts.isBlock(fn.body)||fn.parameters.length!==1||!ts.isIdentifier(fn.parameters[0].name))continue;
   const prefixParam=fn.parameters[0].name.text,scope=new Map([[prefixParam,'synapse-provenance-']]);
   const made=fn.body.statements.flatMap(s=>ts.isVariableStatement(s)?s.declarationList.declarations:[])
    .find(d=>d.initializer&&ts.isAwaitExpression(d.initializer)&&ts.isCallExpression(d.initializer.expression)&&/^fs(?:\.promises)?\.mkdtemp$/.test(name(d.initializer.expression.expression)));
   if(!made?.initializer||!ts.isIdentifier(made.name))continue;
   const call=(made.initializer as ts.AwaitExpression).expression as ts.CallExpression;
   const p=evalPath(call.arguments[0],scope);
   if(!p||!this.prefix(p))continue;
   const ret=fn.body.statements.at(-1);
   if(!ret||!ts.isReturnStatement(ret)||!ret.expression)continue;
   let r=ret.expression;
   if(ts.isCallExpression(r)&&ts.isIdentifier(r.expression)&&r.arguments.length===1&&ts.isIdentifier(r.arguments[0])&&r.arguments[0].text===made.name.text){
    const wrapper=decl.get(r.expression.text);
    if(!wrapper||!ts.isArrowFunction(wrapper)||!ts.isBlock(wrapper.body)||wrapper.parameters.length!==1||!ts.isIdentifier(wrapper.parameters[0].name))continue;
    const last=wrapper.body.statements.at(-1);
    if(!last||!ts.isReturnStatement(last)||!last.expression||!ts.isIdentifier(last.expression)||extraReturns(wrapper.body,last))continue;
    const initializer=decl.get(last.expression.text);
    if(!initializer||!ts.isCallExpression(initializer)||name(initializer.expression)!=='path.resolve'||initializer.arguments.length!==1||initializer.arguments[0].getText(f)!==wrapper.parameters[0].name.text)continue;
    r=r.arguments[0];
   }
   if(!ts.isIdentifier(r)||r.text!==made.name.text)continue;
   // Andere Rückgabepfade bzw. Neuzuweisung des Roots sind keine Provenanz.
   let unsicher=false;
   const returns=(n:ts.Node)=>{if(n!==fn.body&&(ts.isFunctionLike(n)))return;if(ts.isReturnStatement(n)&&n!==ret)unsicher=true;ts.forEachChild(n,returns);};returns(fn.body);
   if(unsicher||mutable.has(made.name.text))continue;
   const dir=this.p.dirname(p);if(base&&base!==dir)continue;base=dir;methoden.add(prop.name.getText(f).replace(/^['"]|['"]$/g,''));
  }
  return base&&methoden.size?{art:FACTORY,base,methoden}:undefined;
 }
}
