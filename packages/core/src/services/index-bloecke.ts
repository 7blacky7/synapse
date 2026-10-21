/** Gemeinsame Indexmechanik (Projekt und Reverse): begrenzte Blöcke, ohne Tabellen-/Speicherwissen.
 * Projektwriter behält seine atomare Dateitransaktion; Reverse bestätigt jeden Block mit seinem Auftragscursor. */
export interface IndexBlockGrenzen {zeilen:number;bytes?:number}
function pruefe(g:IndexBlockGrenzen):void {
 if(!Number.isSafeInteger(g.zeilen)||g.zeilen<1||g.bytes!==undefined&&(!Number.isSafeInteger(g.bytes)||g.bytes<2))
  throw new Error('index_block_grenzen_ungueltig');
}
const laenge=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');
export function* indexBloecke<T>(quelle:Iterable<T>,g:IndexBlockGrenzen):Generator<T[]>{
 pruefe(g);let block:T[]=[],bytes=2;
 for(const v of quelle){
  const n=g.bytes===undefined?0:laenge(v);
  if(g.bytes!==undefined&&n+2>g.bytes)throw new Error('index_record_zu_gross');
  if(block.length&&(block.length>=g.zeilen||g.bytes!==undefined&&bytes+n+1>g.bytes)){yield block;block=[];bytes=2;}
  bytes+=n+(block.length?1:0);block.push(v);
 }
 if(block.length)yield block;
}
export async function* indexBloeckeAsync<T>(quelle:AsyncIterable<T>|Iterable<T>,g:IndexBlockGrenzen):AsyncGenerator<T[]>{
 pruefe(g);let block:T[]=[],bytes=2;
 for await(const v of quelle){
  const n=g.bytes===undefined?0:laenge(v);
  if(g.bytes!==undefined&&n+2>g.bytes)throw new Error('index_record_zu_gross');
  if(block.length&&(block.length>=g.zeilen||g.bytes!==undefined&&bytes+n+1>g.bytes)){yield block;block=[];bytes=2;}
  bytes+=n+(block.length?1:0);block.push(v);
 }
 if(block.length)yield block;
}
