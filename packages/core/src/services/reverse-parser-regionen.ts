/** P18-T95: bounded contiguous UTF-8 source regions, ORIGINAL byte offsets. */
export interface ReverseParserQuelle {size:number;readRange(offset:number,length:number):Promise<Buffer>}
export interface ReverseCodeRegion {start:number;ende:number;text:string;kodierung:'utf8'}
export interface ReverseRegionSchritt {offset:number;region?:ReverseCodeRegion;grund?:string}
export function codeVerdacht(text:string):boolean {
 const braces=text.includes('{')&&text.lastIndexOf('}')>text.indexOf('{');
 for(const line of text.split('\n')){
  const s=line.trim(),paren=s.indexOf('(');if(paren<1)continue;
  const prefix=s.slice(0,paren),tokens=prefix.split(/\s+/);
  if(prefix.startsWith('function ')&&braces||prefix.startsWith('def ')&&text.includes('\n '))return true;
  if(braces&&tokens.length>=2&&tokens.every(x=>/^[\w:*&<>]+$/.test(x))&&/^[\w:]+$/.test(tokens[tokens.length-1]))return true;
 }
 return false;
}
export async function* reverseCodeRegionen(q:ReverseParserQuelle,o:{direkt:boolean;ab:number;lesen:number;max:number;min:number;luecke:number}):AsyncGenerator<ReverseRegionSchritt>{
 if(o.luecke!==0)throw Error('reverse_parser_region_luecke_nicht_unterstuetzt');
 if(o.direkt){
  if(q.size>o.max){yield {offset:q.size,grund:'parser_einheit_zu_gross'};return;}
  if(o.ab>=q.size)return;
  const chunks:Buffer[]=[];
  for(let at=0;at<q.size;at+=o.lesen){const n=Math.min(o.lesen,q.size-at),b=await q.readRange(at,n);if(b.length!==n)throw Error('reverse_parser_quelle_kurz');chunks.push(b);}
  const b=Buffer.concat(chunks),text=b.toString('utf8');
  if(!Buffer.from(text).equals(b)||b.includes(0)){yield {offset:q.size,grund:'quelltext_kodierung_unbekannt'};return;}
  yield {offset:q.size,region:{start:0,ende:q.size,text,kodierung:'utf8'}};return;
 }
 // One bounded Buffer, never a JS number[] per byte. Never concatenate across binary bytes.
 const pending=Buffer.alloc(o.max);let size=0,start=o.ab,oversize=false;
 const take=(end:number):ReverseRegionSchritt|undefined=>{
  if(oversize)return {offset:end,grund:'parser_einheit_zu_gross'};
  const b=pending.subarray(0,size),text=b.toString('utf8');
  if(text.length>=o.min&&Buffer.from(text).equals(b)&&codeVerdacht(text))return {offset:end,region:{start,ende:end,text,kodierung:'utf8'}};
  return undefined;
 };
 for(let at=o.ab;at<q.size;){
  const n=Math.min(o.lesen,q.size-at),b=await q.readRange(at,n);if(b.length!==n)throw Error('reverse_parser_quelle_kurz');
  for(let i=0;i<b.length;i++){
   const pos=at+i,v=b[i],print=v===9||v===10||v===13||v>=32&&v!==127;
   if(print){if(!size&&!oversize)start=pos;if(!oversize){if(size===o.max){size=0;oversize=true;}else pending[size++]=v;}}
   else {const r=take(pos);if(r)yield r;size=0;oversize=false;start=pos+1;}
  }
  at+=b.length;yield {offset:size||oversize?start:at};
 }
 const r=take(q.size);if(r)yield r;
 yield {offset:q.size};
}
