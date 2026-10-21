/** P18-T77: byte-bounded physical pieces, exact concatenation and one logical file. */
export const REVERSE_TEXTSTUECK_BYTES=262144;
export interface ReverseTextStueck {inhalt:string;haupt:number;teil:number;zeilenOffset:number}
export function teileReverseText(text:string,maxBytes=REVERSE_TEXTSTUECK_BYTES):string[]{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<4)throw Error('stueck_budget_ungueltig');
 const bytes=Buffer.from(text),out:string[]=[];let von=0;
 while(von<bytes.length){
  let bis=Math.min(bytes.length,von+maxBytes);
  if(bis<bytes.length){
   const nl=bytes.lastIndexOf(10,bis-1);
   if(nl>=von)bis=nl+1;
   else{
    // Prefer a word boundary on giant lines. Never add a newline or split a UTF-8 code point.
    let ws=bis-1;while(ws>von&&bytes[ws]!==32&&bytes[ws]!==9)ws--;
    if(ws>von)bis=ws+1;
    else while(bis>von&&(bytes[bis]&0xc0)===0x80)bis--;
   }
  }
  out.push(bytes.subarray(von,bis).toString('utf8'));von=bis;
 }
 return out.length?out:[''];
}
export function reverseTextSammler(){
 const fertig:ReverseTextStueck[]=[];let akt='',zeilen=0,aktBytes=0;
 const flush=()=>{if(!akt)return;fertig.push({inhalt:akt,haupt:fertig.length,teil:0,zeilenOffset:0});akt='';zeilen=0;aktBytes=0;};
 return {
  add(text:string):{stueck:number;zeile:number}{
   const bytes=Buffer.byteLength(text);
   if(bytes>REVERSE_TEXTSTUECK_BYTES){
    flush();const haupt=fertig.length;let offset=0;
    for(const [teil,inhalt]of teileReverseText(text).entries()){
     fertig.push({inhalt,haupt,teil,zeilenOffset:offset});offset+=inhalt.split('\n').length-1;
    }
    return {stueck:haupt,zeile:1};
   }
   if(akt&&aktBytes+bytes>REVERSE_TEXTSTUECK_BYTES)flush();
   const pos={stueck:fertig.length,zeile:zeilen+1};akt+=text;aktBytes+=bytes;zeilen+=text.split('\n').length-1;return pos;
  },
  ende():ReverseTextStueck[]{flush();return fertig;},
 };
}
/** Logical views retain the shared CodeIntel reader; storage and FTS vectors stay byte-bounded. */
export function reverseLogischeDateien(ready:string,mitInhalt=true):string{
 const gruppe="p.eintrag_id=d.eintrag_id AND COALESCE(p.logischer_pfad,p.file_path)=COALESCE(d.logischer_pfad,d.file_path) AND p.schicht=d.schicht AND p.fingerabdruck=d.fingerabdruck";
 const inhalt=mitInhalt?"(SELECT string_agg(p.content,'' ORDER BY p.teil_nr) FROM reverse_code_dateien p WHERE "+gruppe+")":"d.content";
 return "(SELECT d.id,d.eintrag_id,d.file_path,d.file_name,d.file_type,"+
  "(SELECT sum(p.file_size)::int FROM reverse_code_dateien p WHERE "+gruppe+") AS file_size,"+
  inhalt+" AS content,d.content_hash,d.indexed_at,d.updated_at,d.deleted_at,d.ignored,d.parsed_at,d.parser_version,"+
  "d.tsv,d.tsv_zerlegt,d.datei_id,d.schicht,d.fingerabdruck,d.adresse,d.groesse_bytes,d.logischer_pfad,d.teil_nr,d.zeilen_offset,d.chunk_count "+
  "FROM reverse_code_dateien d WHERE d.teil_nr=0 AND "+ready+")";
}

/** AND lexemes may be in different physical pieces; never concatenate tsvectors past PG's size limit. */
export function reverseStueckSuchPraedikat(spalte:'tsv'|'tsv_zerlegt',query:string):string{
 const gruppe="p.eintrag_id=rvf.eintrag_id AND COALESCE(p.logischer_pfad,p.file_path)=rvf.file_path AND p.schicht=rvf.schicht AND p.fingerabdruck=rvf.fingerabdruck";
 return "(("+query+")::text<>'' AND NOT EXISTS(SELECT 1 FROM unnest(string_to_array(("+query+")::text,' & ')) AS lex(term) "+
  "WHERE NOT EXISTS(SELECT 1 FROM reverse_code_dateien p WHERE "+gruppe+" AND p."+spalte+" @@ lex.term::tsquery)))";
}
