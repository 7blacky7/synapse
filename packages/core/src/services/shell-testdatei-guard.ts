/** P10-T65: enger Aufrufnachweis, keine statische Berechnung von JS-Datenbankzielen. */
import ts from 'typescript';
import path from 'node:path';
export function testDateiPfad(root:string,datei:string):boolean{
  const rel=path.relative(root,datei).replace(/\\/g,'/');
  return /^(?:packages\/[^/]+\/tests\/.+|scripts\/test-[^/]+)\.(?:mjs|cjs|js)$/.test(rel);
}
export function testDateiNutztGuard(text:string,datei:string,root:string):boolean{
  const f=ts.createSourceFile('testdatei.mjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  if((f as ts.SourceFile&{parseDiagnostics?:unknown[]}).parseDiagnostics?.length)return false;
  const imports=new Set<string>(),clients=new Map<string,number>();let ok=true,queries=0;
  for(const s of f.statements){
    if(ts.isImportDeclaration(s)&&ts.isStringLiteral(s.moduleSpecifier)){
      const m=s.moduleSpecifier.text;
      const resolved=path.resolve(path.dirname(datei),m);
      const known=['packages/core/dist/services/test-db-laufzeit-schutz.js','scripts/lib/test-db-schutz.mjs'].some(v=>resolved===path.resolve(root,v));
      const b=s.importClause?.namedBindings;
      if(known&&b&&ts.isNamedImports(b))for(const x of b.elements)
        if((x.propertyName?.text??x.name.text)==='oeffneGeschuetzteShellTestDb')imports.add(x.name.text);
    }
    if(ts.isVariableStatement(s))for(const d of s.declarationList.declarations){
      const e=d.initializer;
      if(ts.isIdentifier(d.name)&&e&&ts.isAwaitExpression(e)&&ts.isCallExpression(e.expression)&&
        ts.isIdentifier(e.expression.expression)&&imports.has(e.expression.expression.text)&&e.expression.arguments.length<=1)
        clients.set(d.name.text,d.end);
    }
  }
  function scan(n:ts.Node):void{
    if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['query','execute'].includes(n.expression.name.text)){
      queries++;const receiver=n.expression.expression;
      if(!ts.isIdentifier(receiver)||!clients.has(receiver.text)||n.pos<clients.get(receiver.text)!)ok=false;
    }
    ts.forEachChild(n,scan);
  }
  scan(f);
  return ok&&imports.size>0&&clients.size>0&&queries>0;
}
