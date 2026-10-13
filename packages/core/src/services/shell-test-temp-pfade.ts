/** t84: begrenzte Test-Pfadprovenanz; weder Testcode noch Helfer werden ausgeführt. */
import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {InlineKontext} from './shell-inline-pruefung.js';
const TEMP=Symbol('selbst-mkdtemp');
interface Temp {art:typeof TEMP;id:number;rel:string;}
const sichererPrefix=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}-$/.test(s);
export class ShellTestTempPfade {
 readonly erlaubt:boolean;
 readonly testdatei:boolean;
 readonly testHelferImport:boolean;
 private readonly links:boolean;
 private readonly cwdGeaendert:boolean;
 private readonly p:typeof path.posix;
 constructor(private readonly o:InlineKontext,private readonly file:ts.SourceFile,private readonly unbekannt:symbol){
  this.p=o.os==='windows'?path.win32:path.posix;
  const rel=o.testdatei_pfad&&o.projekt_root?this.p.relative(o.projekt_root,o.testdatei_pfad).replace(/\\/g,'/'):'';
  let tempEnvGeaendert=false,links=false,cwdGeaendert=false,letztesSchreiben=-1,lastFs:ts.Node|undefined;
  const fsAliase=new Set<string>(),tempAliase=new Set<string>(),erzeugungen:ts.CallExpression[]=[];
  for(const n of file.statements)if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)&&/^(?:node:)?fs(?:\/promises)?$/.test(n.moduleSpecifier.text)&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings))for(const b of n.importClause.namedBindings.elements)if(/^(?:rm|unlink|writeFile|appendFile|rename|copyFile|cp|mkdir|rmdir|truncate)(?:Sync)?$/.test(b.propertyName?.text??b.name.text))fsAliase.add(b.name.text);
  for(const n of file.statements)if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)&&/^(?:node:)?fs(?:\/promises)?$/.test(n.moduleSpecifier.text)&&n.importClause?.namedBindings&&ts.isNamedImports(n.importClause.namedBindings))for(const b of n.importClause.namedBindings.elements)if(/^mkdtemp(?:Sync)?$/.test(b.propertyName?.text??b.name.text))tempAliase.add(b.name.text);
  const tempScan=(n:ts.Node):void=>{if(ts.isCallExpression(n)&&(/\.(?:mkdtemp)(?:Sync)?$/.test(n.expression.getText(file))||ts.isIdentifier(n.expression)&&tempAliase.has(n.expression.text)))erzeugungen.push(n);ts.forEachChild(n,tempScan);};tempScan(file);
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
  const nachGebundenerWurzel=(n:ts.Node):boolean=>{
   // Eine terminale Umgebungswiederherstellung kann einen zuvor gebundenen
   // mkdtemp-String nicht ändern. Keine zweite Erzeugung und kein anderer Scope.
   const creation=erzeugungen.length===1?erzeugungen[0]:undefined;
   if(!creation||funktionVon(n)!==funktionVon(creation))return false;
   const initializer=ts.isAwaitExpression(creation.parent)?creation.parent:creation;
   const declaration=initializer.parent;
   if(!ts.isVariableDeclaration(declaration)||declaration.initializer!==initializer||!ts.isVariableDeclarationList(declaration.parent)||(declaration.parent.flags&ts.NodeFlags.Const)===0)return false;
   const statement=declaration.parent.parent,container=statement.parent;
   if(!ts.isVariableStatement(statement)||!(ts.isSourceFile(container)||ts.isBlock(container)&&container.parent===funktionVon(creation)))return false;
   for(let block:ts.Node|undefined=n.parent;block;block=block.parent)
    if(ts.isBlock(block)&&ts.isTryStatement(block.parent)&&block.parent.finallyBlock===block&&creation.end<block.parent.pos)return true;
   return false;
  };
  const nachWurzel=(n:ts.Node)=>nachCleanup(n)||nachGebundenerWurzel(n);
  const envZiel=(n:ts.Node)=>/^(?:process\.env$|process\.env\.(?:TMPDIR|TMP|TEMP)\b|process\.env\[)/i.test(n.getText(file));
  const envScan=(n:ts.Node):void=>{
   if(ts.isCallExpression(n)&&n.expression.getText(file)==='process.chdir'||ts.isBinaryExpression(n)&&/^process\.(?:cwd|chdir)$/.test(n.left.getText(file)))cwdGeaendert=true;
   if(ts.isCallExpression(n)&&(/(?:^|\.)(?:symlink|link)(?:Sync)?$/.test(n.expression.getText(file))||ts.isIdentifier(n.expression)&&linkAliase.has(n.expression.text)))links=true;
   if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&!nachWurzel(n)&&envZiel(n.left))tempEnvGeaendert=true;
   if(ts.isDeleteExpression(n)&&!nachWurzel(n)&&envZiel(n.expression))tempEnvGeaendert=true;
   if(ts.isCallExpression(n)&&!nachWurzel(n)&&/^Object\.(?:assign|defineProperty|defineProperties)$/.test(n.expression.getText(file))&&n.arguments[0]?.getText(file)==='process.env')
    for(const a of n.arguments.slice(1)){
     if(/(?:TMPDIR|TMP|TEMP)/i.test(a.getText(file)))tempEnvGeaendert=true;
     if(n.expression.getText(file)==='Object.assign'&&(!ts.isObjectLiteralExpression(a)||a.properties.some(p=>ts.isSpreadAssignment(p))))tempEnvGeaendert=true;
    }
   ts.forEachChild(n,envScan);
  };envScan(file);
  this.testdatei=!!rel&&!rel.startsWith('../')&&!this.p.isAbsolute(rel)&&/^(?:packages\/[^/]+\/tests\/|scripts\/test-[^/]+(?:$|\/))/.test(rel);
  this.links=links;this.cwdGeaendert=cwdGeaendert;
  // Lokale Test-Helfer erhalten keine Ausnahme, unabhängig von Importbindung
  // oder vorhandenen Snapshots. Unaufgelöste dynamische Imports bleiben unklar.
  const testHelfer=(s:string):boolean=>{
   if(/^file:/i.test(s))try{s=fileURLToPath(s);}catch{return true;}
   if(!this.o.projekt_root||!this.o.testdatei_pfad||!s.startsWith('.')&&!this.p.isAbsolute(s))return false;
   const target=this.p.resolve(this.p.dirname(this.o.testdatei_pfad),s);
   const r=this.p.relative(this.o.projekt_root,target).replace(/\\/g,'/');
   const infrastruktur=new Set(['scripts/lib/test-db-schutz.mjs','packages/core/dist/services/test-db-laufzeit-schutz.js']);
   if(infrastruktur.has(r)||/^packages\/[^/]+\/dist(?:\/|$)/.test(r))return false;
   if(/^(?:node_modules\/|packages\/[^/]+\/node_modules\/)/.test(r))
    return /(?:^|\/)node_modules\/(?:fs-extra|rimraf|del|trash|shelljs)(?:\/|$)/.test(r);
   // Andere lokale Module aus Testpfaden bzw. unklare lokale Quellen gewähren
   // keine Ausnahme. Insbesondere keine Freigabe anhand eines Dateinamens.
   return true;
  };
  const decl=new Map<string,ts.Expression>(),aliases=new Map<string,string>();
  const binds=(n:ts.Node):void=>{
   if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)decl.set(n.name.text,n.initializer);
   if(ts.isImportDeclaration(n)&&ts.isStringLiteralLike(n.moduleSpecifier)&&n.importClause?.namedBindings){
    const mod=n.moduleSpecifier.text.replace(/^node:/,'');
    if(ts.isNamedImports(n.importClause.namedBindings))for(const b of n.importClause.namedBindings.elements)aliases.set(b.name.text,mod+'.'+(b.propertyName?.text??b.name.text));
    else if(ts.isNamespaceImport(n.importClause.namedBindings))aliases.set(n.importClause.namedBindings.name.text,mod);
   }
   ts.forEachChild(n,binds);
  };binds(file);
  const api=(e:ts.Expression):string=>ts.isIdentifier(e)?aliases.get(e.text)??e.text:ts.isPropertyAccessExpression(e)?api(e.expression)+'.'+e.name.text:'?';
  const produkt=(s:string):boolean=>{
   if(/^file:/i.test(s))try{s=fileURLToPath(s);}catch{return false;}
   const target=this.p.isAbsolute(s)?this.p.normalize(s):this.p.resolve(this.p.dirname(this.o.testdatei_pfad??''),s);
   const rel=this.o.projekt_root?this.p.relative(this.o.projekt_root,target).replace(/\\/g,'/'):'';
   return /^packages\/[^/]+\/dist(?:\/|$)/.test(rel);
  };
  const basisPfad=(e:ts.Expression|undefined,depth=0):string|undefined=>{
   if(!e||depth>8)return undefined;
   if(ts.isStringLiteralLike(e))return this.p.resolve(this.p.dirname(this.o.testdatei_pfad??''),e.text);
   if(ts.isIdentifier(e))return basisPfad(decl.get(e.text),depth+1);
   // Betreiber-Override des Produkt-dist; der vorhandene Produkt-Fallback bleibt
   // neutral nach26486. Explizite Testpfade in einem Zweig bleiben ausgeschlossen.
   if(ts.isConditionalExpression(e)){
    const a=basisPfad(e.whenTrue,depth+1),b=basisPfad(e.whenFalse,depth+1);
    return a&&produkt(a)?a:b&&produkt(b)&&(!a||produkt(a))?b:undefined;
   }
   if(ts.isNewExpression(e)&&api(e.expression)==='URL'&&e.arguments?.length===2&&e.arguments[1].getText(file)==='import.meta.url')return basisPfad(e.arguments[0],depth+1);
   return undefined;
  };
  const produktImport=(e:ts.Expression|undefined,depth=0):boolean=>{
   if(!e||depth>8)return false;
   if(ts.isStringLiteralLike(e))return produkt(e.text);
   if(ts.isIdentifier(e))return produktImport(decl.get(e.text),depth+1);
   if(ts.isCallExpression(e)&&api(e.expression)==='url.pathToFileURL')return e.arguments.length===1&&produktImport(e.arguments[0],depth+1);
   if(ts.isCallExpression(e)&&/^path\.(?:resolve|join)$/.test(api(e.expression))){
    const rest=e.arguments.slice(1);
    if(!rest.length||!rest.every(ts.isStringLiteralLike))return false;
    const relative=this.p.normalize(this.p.join(...rest.map(x=>(x as ts.StringLiteralLike).text))).replace(/\\/g,'/');
    return /^packages\/[^/]+\/dist(?:\/|$)/.test(relative);
   }
   if(ts.isNewExpression(e)&&api(e.expression)==='URL'&&e.arguments?.length===2){
    if(e.arguments[1].getText(file)==='import.meta.url'&&ts.isStringLiteralLike(e.arguments[0]))return !testHelfer(e.arguments[0].text);
    const base=basisPfad(e.arguments[1]);
    if(!base||!produkt(base))return false;
    const rel=e.arguments[0];
    if(ts.isStringLiteralLike(rel))return produkt(this.p.resolve(base,rel.text));
    if(!ts.isIdentifier(rel))return false;
    let fn:ts.Node|undefined=e.parent;while(fn&&!ts.isFunctionLike(fn))fn=fn.parent;
    if(!fn||!ts.isArrowFunction(fn)||fn.parameters.length!==1||!ts.isIdentifier(fn.parameters[0].name)||fn.parameters[0].name.text!==rel.text||!ts.isVariableDeclaration(fn.parent)||!ts.isIdentifier(fn.parent.name))return false;
    const wrapper=fn.parent.name.text;let count=0,ok=true;
    const calls=(n:ts.Node):void=>{if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text===wrapper){count++;const a=n.arguments[0];if(n.arguments.length!==1||!a||!ts.isStringLiteralLike(a)||!produkt(this.p.resolve(base,a.text)))ok=false;}ts.forEachChild(n,calls);};calls(file);
    return count>0&&ok;
   }
   return false;
  };
  let helfer=false;
  const imports=(n:ts.Node):void=>{
   if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteralLike(n.moduleSpecifier)&&(testHelfer(n.moduleSpecifier.text)||/^(?:fs-extra|rimraf|del|trash|shelljs)(?:\/|$)/.test(n.moduleSpecifier.text)))helfer=true;
   if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(n.expression)&&n.expression.text==='require')){
    const arg=n.arguments[0];
    if(!produktImport(arg)&&(!arg||!ts.isStringLiteralLike(arg)||testHelfer(arg.text)||/^(?:fs-extra|rimraf|del|trash|shelljs)(?:\/|$)/.test(arg.text)))helfer=true;
   }
   ts.forEachChild(n,imports);
  };imports(file);
  this.testHelferImport=this.testdatei&&helfer;
  this.erlaubt=this.testdatei&&!this.testHelferImport&&!tempEnvGeaendert&&!links&&!cwdGeaendert;
 }
 ist(v:unknown):v is Temp {return !!v&&typeof v==='object'&&(v as Temp).art===TEMP;}
 dateiUrl():unknown {return this.erlaubt?pathToFileURL(this.o.testdatei_pfad!).href:this.unbekannt;}
 private prefix(p:unknown):boolean {
  if(!this.erlaubt||typeof p!=='string'||!sichererPrefix(this.p.basename(p)))return false;
  const dir=this.p.dirname(p);
  if(!this.erlaubterBasisPfad(dir))return false;
  // Der erste Durchgang erhebt nur Probeziele. Freigabe braucht anschließend
  // positive native Nachweise für den konkreten Prefix UND dessen Elternpfad.
  this.o.test_probe_pfade?.push(p,dir);
  return this.o.inline_pfade?this.o.inline_pfade[p]===true&&this.o.inline_pfade[dir]===true:!!this.o.test_probe_pfade;
 }
 private erlaubterBasisPfad(dir:string):boolean {
  if(this.o.test_tmpdir&&dir===this.o.test_tmpdir)return true;
  const rel=this.o.projekt_root?this.p.relative(this.o.projekt_root,dir).replace(/\\/g,'/'):'';
  return /^(?:packages\/[^/]+\/tests\/fixtures)(?:\/|$)/.test(rel);
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
 call(api:string,args:unknown[],n:ts.CallExpression):unknown|undefined {
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
  return undefined;
 }
 /** Nur tatsächlich schreibende Datei-APIs; Rename/Copy brauchen auch ein begrenztes Ziel. */
 dateiOperation(api:string,args:unknown[]):boolean|undefined {
  if(this.testdatei&&/^fs(?:\.promises)?\.mkdtemp(?:Sync)?$/.test(api))return this.prefix(args[0]);
  if(!this.testdatei||!/^fs(?:\.promises)?\.(?:rm|unlink|writeFile|appendFile|rename|copyFile|cp|mkdir|rmdir|truncate)(?:Sync)?$/.test(api))return undefined;
  if(this.links||this.cwdGeaendert)return false;
  const safe=(v:unknown)=>this.ist(v);
  return safe(args[0])&&(!/\.(?:rename|copyFile|cp)(?:Sync)?$/.test(api)||safe(args[1]));
 }
}
