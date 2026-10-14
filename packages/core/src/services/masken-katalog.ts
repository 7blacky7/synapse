/**
 * P18-T11/RV1: zentrale Quelle für Geheimnis-Maskierung.
 *
 * Profile behalten ihre Altsemantik: Erklärungen [GEHEIM], Shell/MCP [WERT].
 * Struktur-/Namensregeln brauchen ihren Parserkontext und dürfen nicht als
 * unbedingte Textersetzungen ausgeführt werden. Die alten Module exportieren
 * dieselben Funktionen weiter. Keine DB, Dateizugriffe oder Logs in diesem Modul.
 */
export type MaskenBereich = 'erklaerung' | 'shell' | 'reverse';
export type MaskenErsetzer = (treffer: string, ...gruppen: string[]) => string;
export interface MaskenEintrag {
  readonly kennung: string;
  readonly muster: RegExp;
  readonly ersatz: MaskenErsetzer;
  readonly anwendungsbereich: readonly (MaskenBereich | 'mcp-json')[];
  readonly art: 'text' | 'name' | 'struktur';
}
const GEHEIM = '[GEHEIM]';
const ENV_PLATZHALTER = '[WERT]';
const SHELL_NAME_AUSNAHME = /^(?:wait_token|batch_token|stream_id)$/;
const SHELL_NAME_MASS = /(?:^|[_.-])(?:count|length|size|limit|ttl|timeout|duration|ms|rate|usage|used|path|file)$/;
const SHELL_NAME_TOKENS = /^(?:input|output|total|cached|prompt|completion)_tokens(?:_|$)/;
// P10-T72: deutsche Schreibweisen (passwort/kennwort) und passwd sind ebenfalls Geheimnisnamen.
const SHELL_NAME_GEHEIM = /(?:^|[_.-])(?:keys?|tokens?|secrets?|password|passwort|kennwort|passwd|pass|pwd|auth|authorization|credentials?)(?:$|[_.-])|^pgpass(?:word)?$/;
/** P10-T72: Platzhalter-Woerter aus Vorlagen (z. B. postgresql://user:passwort@... in .env.example) sind
 * keine bekannten Geheimwerte; als Literal ersetzt wuerden sie den SCHLUESSEL "passwort" maskieren und den
 * echten Wert daneben stehen lassen. */
const SHELL_LITERAL_PLATZHALTER = /^(?:passwor[dt]|kennwort|changeme|platzhalter|placeholder|beispiel|example)$/i;
const SHELL_JSON_KEY = /^keys?$/i;
export const SHELL_BEARER_WERT = /^Bearer\s+(.+)$/i;

// ─── MCP-JSON, Namen und URLs (bestehender Vertrag) ────────────────────────────
const PLATZHALTER = '[WERT]';
export const MCP_JSON_PFAD_REGEX_SQL = '(^|/)\\.mcp\\.json(\\.[^/]*)?$';
const SENSIBLER_SCHLUESSEL = /(?:token|key|secret|password|passwort|passwd|kennwort|authorization)/i;
export const MCP_JSON_FELD_PREFIX=/(?<!\\)("(?:\\.|[^"\\])*")(\s*:\s*)/g;
export const MCP_JSON_FELD_WERT=/^("(?:\\.|[^"\\])*"|[^,}\]]+)/;
const SENSIBLE_BEREICHE = new Set(['env', 'headers']);
/** Shell-Muster und Literalquellen nutzen genau dieselbe Namensregel. */
export const SHELL_LITERAL_MIN_LAENGE=8;
export function istShellGeheimnisName(name:string):boolean{
  const norm=name.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
  // Synapse-Verfahrenskennungen sind keine Authentifizierungs-Tokens; UUID-Form allein genügt nicht.
  if(SHELL_NAME_AUSNAHME.test(norm))return false;
  // Zähler/Maße beschreiben Geheimnisse, tragen aber selbst keine Zugangsdaten.
  if(SHELL_NAME_MASS.test(norm))return false;
  if(SHELL_NAME_TOKENS.test(norm))return false;
  return SHELL_NAME_GEHEIM.test(norm);
}
/** Ein generisches JSON-Feld key/keys benennt oft einen Datenbankschluessel.
 * Ohne Secret-Qualifier ist es kein Geheimnisindikator; bekannte Literale bleiben geschuetzt.
 * Env-Zuweisungen und die strengere MCP-Konfigmaske behalten ihre bisherige Regel.
 */
export function istShellJsonGeheimnisName(name:string):boolean {
  return !SHELL_JSON_KEY.test(name) && istShellGeheimnisName(name);
}
/** User-Vorgabe 14.10.2026: der Name allein (key=, token=, pass=) macht keinen Wert geheim.
 * Geschwaerzt wird per Namensregel nur ein Wert, der nach Zugangsdaten aussieht; bekannte Geheimniswerte
 * aus den Secret-Quellen maskiert die werteweise Maske unabhaengig davon. */
export function shellWertWirktGeheim(roh:string):boolean{
  const w=roh.trim().replace(/^(["'])([\s\S]*)\1$/,'$2');
  if(w.length<SHELL_LITERAL_MIN_LAENGE||/\s/.test(w))return false;
  // Code-Ausdruecke (Diffs, Quelltext) sind keine Zugangsdaten: key=bereich+':'+root, token=getToken(x).
  if(/[(){}\[\]<>;,`$]|['"]/.test(w))return false;
  return (/\d/.test(w)&&/[A-Za-z]/.test(w))||(w.length>=20&&/[a-z]/.test(w)&&/[A-Z]/.test(w))||(w.length>=16&&/[^A-Za-z0-9_.\-\/]/.test(w));
}
export const URL_ZUGANGSDATEN = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/@?#:\s]+:[^/@?#\s]*@/gi;

export function istMcpJsonDatei(pfad: string | null | undefined): boolean {
  if (typeof pfad !== 'string' || pfad === '') return false;
  const name = pfad.replace(/\\/g, '/').split('/').pop() ?? '';
  return name === '.mcp.json' || (name.startsWith('.mcp.json.') && name !== '.mcp.json.example');
}

export function maskiereUrl(wert: string): string {
  if(!wert.includes('://'))return wert;
  return ersetzeKatalogRegel(wert, 'shell.url');
}

/** Passwoerter aus URL-Userinfo, mit derselben URL-Regel wie die Ausgabe-Maske. */
export function shellUrlPasswoerter(text:string):string[] {
  const aus=new Set<string>();
  for(const m of text.matchAll(URL_ZUGANGSDATEN)){
    const userinfo=m[0].slice(m[1].length,-1),pass=userinfo.slice(userinfo.indexOf(':')+1);
    if(pass.length>=SHELL_LITERAL_MIN_LAENGE)aus.add(pass);
    try{const decoded=decodeURIComponent(pass);if(decoded.length>=SHELL_LITERAL_MIN_LAENGE)aus.add(decoded);}catch{/* nicht kodiert */}
  }
  return [...aus];
}
function wiederherstelleUrl(neu: string, alt: string): string {
  const altMatch = alt.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/@?#]+:[^/@?#]*@)([^/?#]+)/i);
  const neuMatch = neu.match(/^([a-z][a-z0-9+.-]*:\/\/)\[WERT\]@([^/?#]+)/i);
  if (!altMatch || !neuMatch || altMatch[1].toLowerCase() !== neuMatch[1].toLowerCase() || altMatch[3].toLowerCase() !== neuMatch[2].toLowerCase()) return neu;
  const maskierterPrefix = neuMatch[1] + '[WERT]@' + neuMatch[2];
  return neu.startsWith(maskierterPrefix) ? altMatch[0] + neu.slice(maskierterPrefix.length) : neu;
}

function maskiereWert(wert: unknown, sensibel = false, schluessel = '', shell = false): unknown {
  const hierSensibel = sensibel || (!shell && SENSIBLE_BEREICHE.has(schluessel.toLowerCase())) || (shell ? istShellJsonGeheimnisName(schluessel) : SENSIBLER_SCHLUESSEL.test(schluessel));
  if (Array.isArray(wert)) return wert.map((eintrag) => maskiereWert(eintrag, hierSensibel, '', shell));
  if (wert !== null && typeof wert === 'object') {
    return Object.fromEntries(Object.entries(wert as Record<string, unknown>).map(([k, v]) => [k, maskiereWert(v, hierSensibel, k, shell)]));
  }
  if (hierSensibel) {
    if(shell && typeof wert==='string' && /^[A-Za-z_][A-Za-z0-9_.-]*=/.test(wert))return wert.slice(0,wert.indexOf('=')+1)+PLATZHALTER;
    return PLATZHALTER;
  }
  return typeof wert === 'string' ? maskiereUrl(wert) : wert;
}

function parse(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function einrueckung(text: string): number | string {
  if (!text.includes('\n')) return '';
  const match = text.match(/\n([ \t]+)["']/);
  return match?.[1] ?? '  ';
}

function serialisiere(wert: unknown, referenz: string): string {
  const text = JSON.stringify(wert, null, einrueckung(referenz));
  return text + (referenz.endsWith('\n') ? '\n' : '');
}

export function maskiereMcpJson(text: string, shell = false): string {
  if (typeof text !== 'string' || text === '') return text;
  try {
    const original = parse(text);
    const maskiert = maskiereWert(original, false, '', shell);
    if (JSON.stringify(maskiert) === JSON.stringify(original)) return text;
    return serialisiere(maskiert, text);
  } catch {
    // Ungueltiges JSON bleibt nicht als moeglicher Geheimnis-Traeger sichtbar.
    return JSON.stringify(PLATZHALTER) + (text.endsWith('\n') ? '\n' : '');
  }
}

export function mcpJsonSicht(pfad: string | null | undefined, text: string): string {
  return istMcpJsonDatei(pfad) ? maskiereMcpJson(text) : text;
}

function maskierbarerSchluessel(sensibel: boolean, schluessel: string): boolean {
  return sensibel || SENSIBLE_BEREICHE.has(schluessel.toLowerCase()) || SENSIBLER_SCHLUESSEL.test(schluessel);
}

function wiederherstellen(neu: unknown, alt: unknown, sensibel: boolean, schluessel: string, pfad: string, hinweise: Set<string>): unknown {
  const hierSensibel = maskierbarerSchluessel(sensibel, schluessel);
  if (neu === PLATZHALTER && hierSensibel) {
    if (alt !== undefined) return alt;
    hinweise.add((schluessel || pfad || 'Wert') + ': Platzhalter ' + PLATZHALTER + ' ohne bekannten Wert, als Text geschrieben');
    return neu;
  }
  if (typeof neu === 'string' && typeof alt === 'string') {
    const altMaskiert = maskiereUrl(alt);
    if (neu === altMaskiert && neu !== alt) return alt;
    return wiederherstelleUrl(neu, alt);
  }
  if (Array.isArray(neu)) {
    return neu.map((v, i) => wiederherstellen(v, Array.isArray(alt) ? alt[i] : undefined, hierSensibel, '', pfad + '[' + i + ']', hinweise));
  }
  if (neu !== null && typeof neu === 'object') {
    const old = alt !== null && typeof alt === 'object' && !Array.isArray(alt) ? alt as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(neu as Record<string, unknown>).map(([k, v]) => [
      k,
      wiederherstellen(v, old[k], hierSensibel, k, pfad ? pfad + '.' + k : k, hinweise),
    ]));
  }
  return neu;
}

export function entmaskiereMcpJson(neu: string, alt: string): { inhalt: string; hinweise: string[] } {
  if (typeof neu !== 'string') return { inhalt: neu, hinweise: [] };
  if (neu === maskiereMcpJson(alt ?? '')) return { inhalt: alt, hinweise: [] };
  try {
    const neuObj = parse(neu);
    const altObj = alt ? parse(alt) : undefined;
    const hinweise = new Set<string>();
    const inhalt = wiederherstellen(neuObj, altObj, false, '', '', hinweise);
    return { inhalt: serialisiere(inhalt, neu), hinweise: [...hinweise] };
  } catch {
    return { inhalt: neu, hinweise: [] };
  }
}

type GeheimeFelder = Map<string, { name: string; wert: string }>;

function geheimeFelder(text: string, shell = false): GeheimeFelder {
  const aus: GeheimeFelder = new Map();
  const geheRekursiv = (wert: unknown, sensibel: boolean, schluessel: string, pfad: string): void => {
    const hierSensibel = shell ? sensibel || istShellJsonGeheimnisName(schluessel) : maskierbarerSchluessel(sensibel, schluessel);
    if (Array.isArray(wert)) {
      wert.forEach((v, i) => geheRekursiv(v, hierSensibel, '', pfad + '[' + i + ']'));
      return;
    }
    if (wert !== null && typeof wert === 'object') {
      for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
        geheRekursiv(v, hierSensibel, k, pfad ? pfad + '.' + k : k);
      }
      return;
    }
    const value = typeof wert === 'string' ? wert : JSON.stringify(wert);
    if (hierSensibel || (!shell && typeof wert === 'string' && maskiereUrl(wert) !== wert)) {
      aus.set(pfad, { name: schluessel || pfad || 'Wert', wert: value ?? '' });
    } else if(shell && typeof wert==='string'){
      shellUrlPasswoerter(wert).forEach((pass,i)=>aus.set(pfad+'#url-pass-'+i,{name:schluessel,wert:pass}));
    }
  };
  try { geheRekursiv(parse(text), false, '', ''); } catch { /* malformed config has no parsed values */ }
  return aus;
}

export function mcpJsonWerte(text: string, minLaenge = 6, shell = false): string[] {
  return [...geheimeFelder(text,shell).values()].map((feld) => feld.wert).filter((wert) => wert.length >= minLaenge);
}

export function mcpJsonHinweise(alt: string, neu: string, art: 'schreiben' | 'restore'): string[] {
  if ((alt ?? '') === (neu ?? '')) return [];
  const vorher = geheimeFelder(alt ?? '');
  const nachher = geheimeFelder(neu ?? '');
  const aus: string[] = [];
  for (const [pfad, feld] of vorher) {
    if (JSON.stringify(nachher.get(pfad)?.wert) === JSON.stringify(feld.wert)) continue;
    const status = art === 'restore' ? 'zurückgesetzt' : nachher.has(pfad) ? 'überschrieben' : 'entfernt';
    aus.push(feld.name + ': Wert ' + status + ', per files(restore) wiederherstellbar');
  }
  return [...new Set(aus)];
}

/** Maskiert JSON-Diffzeilen unter env/headers und an sensiblen Schluesseln, Schluessel bleiben sichtbar. */
export function maskiereMcpJsonDiffText(text: string, shell = false): string {
  if (typeof text !== 'string' || text === '') return text;
  const bloecke: Array<{ indent: number }> = [];
  return text.split('\n').map((zeile) => {
    if (zeile.startsWith('@@')) { bloecke.length = 0; return zeile; }
    const hatMarker = /^[ +\-]/.test(zeile);
    const marker = hatMarker ? zeile[0] : '';
    const body = hatMarker ? zeile.slice(1) : zeile;
    const kompakt = body.trim();
    if (kompakt.startsWith('{') || kompakt.startsWith('[')) {
      try {
        const wert = JSON.parse(kompakt) as unknown;
        if (wert !== null && typeof wert === 'object') {
          const fuehrend = body.slice(0, body.indexOf(kompakt));
          return marker + fuehrend + maskiereMcpJson(kompakt,shell);
        }
      } catch { /* einzelne Diff-Zeile statt kompletter JSON-Wert */ }
    }
    const indent = body.match(/^\s*/)?.[0].length ?? 0;
    if (/^\s*[}\]]/.test(body)) while (bloecke.length && indent <= bloecke[bloecke.length - 1].indent) bloecke.pop();
    const m = body.match(/^(\s*)("(?:\\.|[^"\\])*")(\s*:\s*)(.*?)(,?\s*)$/);
    if (!m) return zeile;
    let key = '';
    try { key = JSON.parse(m[2]) as string; } catch { return zeile; }
    const value = m[4];
    const sensibel = bloecke.length > 0 || (shell ? istShellJsonGeheimnisName(key) : maskierbarerSchluessel(false, key));
    const container = shell ? istShellJsonGeheimnisName(key) : SENSIBLE_BEREICHE.has(key.toLowerCase()) || SENSIBLER_SCHLUESSEL.test(key);
    let safe = value;
    if (sensibel && value !== '{' && value !== '[' && !value.startsWith('{') && !value.startsWith('[')) {
      safe = JSON.stringify(PLATZHALTER);
    } else if (!sensibel && value.startsWith('"')) {
      try { const v = JSON.parse(value) as unknown; if (typeof v === 'string') { const masked = maskiereUrl(v); if (masked !== v) safe = JSON.stringify(masked); } } catch { /* partial line */ }
    }
    if (container && (value.trim() === '{' || value.trim() === '[')) bloecke.push({ indent: m[1].length });
    return marker + m[1] + m[2] + m[3] + safe + m[5];
  }).join('\n');
}

export function maskiereMcpJsonFragment(text: string, shell = false): string {
  if (typeof text !== 'string' || text === '') return text;
  const lines = text.split('\n').map((line) => {
    const edits:Array<{von:number;bis:number;text:string}>=[];
    // Nur echte Feld-Praefixe scannen; kein KEY-Suchvorlauf durch lange zitierte Werte.
    for(const m of line.matchAll(MCP_JSON_FELD_PREFIX)) {
      let key='';try{key=JSON.parse(m[1]);}catch{/* unvollstaendiger Feldname */}
      if(!(shell ? istShellJsonGeheimnisName(key) : SENSIBLER_SCHLUESSEL.test(key)))continue;
      const von=m.index!+m[0].length, value=MCP_JSON_FELD_WERT.exec(line.slice(von));
      if(value)edits.push({von,bis:von+value[0].length,text:JSON.stringify(PLATZHALTER)});
    }
    const disjunkt=edits.filter((e,i)=>!edits.slice(0,i).some(v=>e.von<v.bis));
    let safe=line;for(const e of disjunkt.reverse())safe=safe.slice(0,e.von)+e.text+safe.slice(e.bis);
    return safe;
  });
  return maskiereMcpJsonDiffText(lines.join('\n'),shell);
}

// ─── Shell-Regeln und Provenienz (bestehender Vertrag) ──────────────────────
export const SHELL_KV_ZEILE=/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;
export const SHELL_BEARER=/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi;
/** Live-Regel: Passwort hinter sshpass -p (auch -p'x', -p"x", -px). Gruppe 1 Praefix, Gruppe 2 Wert. */
export const SHELL_SSHPASS=/((?:^|\s)sshpass\s+-p\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+)/g;
export const SHELL_JSON_FREI=/(^|[\s,{])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
export const SHELL_KV_FREI=/(^|[\s,{"'])([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;\\]+)/g;
export type ShellMaskenRegel='env_literal'|'url_passwort'|'bearer'|'kv_geheimname'|'json_geheimname'|'mcp_json_feld'|'sshpass_passwort';
export interface ShellMaskenTreffer {regel:ShellMaskenRegel;name?:string;start:number;ende:number;konfiguration:boolean;literal_normales_wort:boolean;}
export function shellIstLeerWert(wert:string):boolean{
 const w=wert.trim();return w===''||w.startsWith('#')||/^(""|''|\x60\x60)\s*(#.*)?$/.test(w);
}
const matcherCache=new WeakMap<readonly string[],RegExp|readonly string[]|null>();
export function holeShellLiteralMatcher(bekannteWerte:readonly string[]){
 let matcher=matcherCache.get(bekannteWerte);
 if(matcher===undefined){
  const werte=[...new Set(bekannteWerte)].filter(w=>w.length>=SHELL_LITERAL_MIN_LAENGE&&w!=='[WERT]'&&!SHELL_LITERAL_PLATZHALTER.test(w)).sort((a,b)=>b.length-a.length);
  matcher=werte.reduce((n,w)=>n+w.length,0)>32768?werte:werte.length?new RegExp('\\[WERT\\]|'+werte.map(w=>w.replace(/[.*+?^\x24{}()|[\]\\]/g,'\\$&')).join('|'),'g'):null;
  matcherCache.set(bekannteWerte,matcher);
 }
 return matcher;
}
const kopie=(r:RegExp)=>new RegExp(r.source,r.flags.includes('g')?r.flags:r.flags+'g');
const prioritaet:Record<ShellMaskenRegel,number>={env_literal:1,mcp_json_feld:2,json_geheimname:3,kv_geheimname:4,bearer:5,url_passwort:6,sshpass_passwort:7};
/** Kategorien beziehen sich ausschließlich auf tatsächliche gemeinsame Maskenregeln. */
export function sammleShellMaskenTreffer(text:string,werte:readonly string[],opt:{name?:string;strukturiert?:boolean}={}):ShellMaskenTreffer[]{
 const original=text,treffer:ShellMaskenTreffer[]=[];
 const addRaw=(regel:ShellMaskenRegel,start:number,ende:number,name?:string,konfiguration=false)=>{
  if(ende<=start)return;const raw=original.slice(start,ende),word=raw.replace(/^["'\x60]|["'\x60]$/g,'');
  if(raw==='[WERT]'||word==='[WERT]')return;
  treffer.push({regel,start,ende,name,konfiguration,literal_normales_wort:/^\p{L}{8,}$/u.test(word)});
 };
 const literals:Array<{start:number;ende:number}>=[];
 const matcher=holeShellLiteralMatcher(werte);
 if(matcher instanceof RegExp){for(const m of original.matchAll(kopie(matcher)))if(m[0]!=='[WERT]')literals.push({start:m.index!,ende:m.index!+m[0].length});}
 else if(matcher){
  let base=0;for(const part of original.split('[WERT]')){
   for(const value of matcher){let at=0;while((at=part.indexOf(value,at))>=0){const start=base+at,end=start+value.length;if(!literals.some(t=>t.start<end&&t.ende>start))literals.push({start,ende:end});at+=value.length;}}
   base+=part.length+6;
  }
 }
 literals.sort((a,b)=>a.start-b.start);
 const teile:Array<{start:number;ende:number;rohStart:number;rohEnde:number;maske:boolean}>=[];
 let cursor=0,neu='';
 for(const l of literals){
  if(l.start>cursor){teile.push({start:neu.length,ende:neu.length+l.start-cursor,rohStart:cursor,rohEnde:l.start,maske:false});neu+=original.slice(cursor,l.start);}
  teile.push({start:neu.length,ende:neu.length+6,rohStart:l.start,rohEnde:l.ende,maske:true});neu+='[WERT]';cursor=l.ende;
  addRaw('env_literal',l.start,l.ende,opt.name);
 }
 if(cursor<original.length){teile.push({start:neu.length,ende:neu.length+original.length-cursor,rohStart:cursor,rohEnde:original.length,maske:false});neu+=original.slice(cursor);}
 text=neu;
 const teilAn=(at:number)=>{
  let lo=0,hi=teile.length;
  while(lo<hi){const m=(lo+hi)>>1;if(teile[m].ende<=at)lo=m+1;else hi=m;}
  return teile[lo];
 };
 const startAn=(at:number)=>{const p=teilAn(at);return p?(p.maske?p.rohStart:p.rohStart+at-p.start):original.length;};
 const endeAn=(at:number)=>{const p=teilAn(Math.max(0,at-1));return p?(p.maske?p.rohEnde:p.rohStart+at-p.start):original.length;};
 const add=(regel:ShellMaskenRegel,start:number,end:number,name?:string,config=false)=>{
  const v=text.slice(start,end).replace(/^["'\x60]|["'\x60]$/g,'');if(v==='[WERT]'||!v)return;
  addRaw(regel,startAn(start),endeAn(end),name,config);
 };
 const namen:Array<{start:number;ende:number;name:string}>=[];
 let offset=0;
 for(const line of text.split('\n')){
  const body=line.endsWith('\r')?line.slice(0,-1):line,kv=SHELL_KV_ZEILE.exec(body);
  if(kv){
   const start=offset+kv[1].length+kv[2].length+kv[3].length;namen.push({start,ende:offset+body.length,name:kv[2]});
   if(istShellGeheimnisName(kv[2])&&!shellIstLeerWert(kv[4]))add('kv_geheimname',start,offset+body.length,kv[2],true);
  }
  for(const m of body.matchAll(kopie(MCP_JSON_FELD_PREFIX))){
   let name='';try{name=JSON.parse(m[1]);}catch{/* Unvollständige Logfragmente sind kein verifizierter Feldname. */}
   const start=offset+m.index!+m[0].length,value=MCP_JSON_FELD_WERT.exec(body.slice(m.index!+m[0].length));
   if(value){namen.push({start,ende:start+value[0].length,name});if(istShellJsonGeheimnisName(name)&&!value[0].trim().startsWith('{')&&!value[0].trim().startsWith('['))add('json_geheimname',start,start+value[0].length,name);}
  }
  offset+=line.length+1;
 }
 for(const m of text.matchAll(kopie(SHELL_KV_FREI))){
  const start=m.index!+m[1].length+m[2].length+m[3].length,end=m.index!+m[0].length;namen.push({start,ende:end,name:m[2]});
  if(istShellGeheimnisName(m[2]))add('kv_geheimname',start,end,m[2]);
 }
 for(const m of text.matchAll(kopie(SHELL_JSON_FREI)))if(istShellJsonGeheimnisName(m[3])){const start=m.index!+m[0].length-m[5].length;add('json_geheimname',start,start+m[5].length,m[3]);}
 const nameAn=(start:number,end:number)=>namen.filter(n=>n.start<=start&&n.ende>=end).sort((a,b)=>(a.ende-a.start)-(b.ende-b.start))[0]?.name??opt.name;
 // Schon ersetzte Literale behalten den tatsächlichen Feldnamen, auch bei öffentlichen Flags.
 const rohNamen=namen.map(n=>({...n,start:startAn(n.start),ende:endeAn(n.ende)}));
 for(const t of treffer)if(t.regel==='env_literal'){
  const n=rohNamen.filter(n=>n.start<=t.start&&n.ende>=t.ende).sort((a,b)=>(a.ende-a.start)-(b.ende-b.start))[0];
  if(n)t.name=n.name;
 }
 for(const m of text.matchAll(kopie(URL_ZUGANGSDATEN))){const start=m.index!+m[1].length,end=m.index!+m[0].length-1;add('url_passwort',start,end,nameAn(start,end));}
 for(const m of text.matchAll(kopie(SHELL_BEARER))){const start=m.index!+m[1].length,end=m.index!+m[0].length;add('bearer',start,end,nameAn(start,end)??'Authorization');}
 // Kategorien vorhandener Literal-Ersetzungen: Grenzen NICHT erweitern, keine neuen Ersetzungen erfinden.
 const annotiere=(regel:ShellMaskenRegel,start:number,end:number,name?:string,config=false)=>{
  for(const t of treffer)if(t.start<end&&t.ende>start){t.konfiguration ||=config;if(prioritaet[regel]>prioritaet[t.regel]){t.regel=regel;t.name=name??t.name;}}
 };
 for(const m of original.matchAll(kopie(URL_ZUGANGSDATEN)))annotiere('url_passwort',m.index!+m[1].length,m.index!+m[0].length-1,opt.name);
 for(const m of original.matchAll(kopie(SHELL_BEARER)))annotiere('bearer',m.index!+m[1].length,m.index!+m[0].length,opt.name??'Authorization');
 offset=0;
 for(const line of original.split('\n')){
  const kv=SHELL_KV_ZEILE.exec(line);
  if(kv&&istShellGeheimnisName(kv[2]))annotiere('kv_geheimname',offset+kv[1].length+kv[2].length+kv[3].length,offset+line.length,kv[2],true);
  offset+=line.length+1;
 }
 for(const m of original.matchAll(kopie(SHELL_KV_FREI)))if(istShellGeheimnisName(m[2]))annotiere('kv_geheimname',m.index!+m[1].length+m[2].length+m[3].length,m.index!+m[0].length,m[2]);
 for(const m of original.matchAll(/(?:^|\s)sshpass\s+-p\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/g)){
  const q=/^["']/.test(m[1]),start=m.index!+m[0].length-m[1].length+(q?1:0),end=m.index!+m[0].length-(q?1:0);
  annotiere('sshpass_passwort',start,end,'sshpass -p');
 }
 if(opt.strukturiert&&opt.name&&istShellJsonGeheimnisName(opt.name)){
  const start=/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(original)?original.indexOf('=')+1:0;addRaw('json_geheimname',start,original.length,opt.name);
 }
 treffer.sort((a,b)=>a.start-b.start||b.ende-a.ende);
 const aus:ShellMaskenTreffer[]=[];
 for(const t of treffer){const last=aus[aus.length-1];if(last&&t.start<last.ende){
  last.ende=Math.max(last.ende,t.ende);last.konfiguration ||=t.konfiguration;
  if(prioritaet[t.regel]>prioritaet[last.regel]){last.regel=t.regel;last.name=t.name??last.name;}else last.name ??=t.name;
  last.literal_normales_wort=last.literal_normales_wort&&t.literal_normales_wort;
 }else aus.push({...t});}
 return aus;
}

// ─── Shell-Textpipeline (bestehender Vertrag) ─────────────────────────────
export function maskiereShellText(text: string, bekannteWerte: readonly string[] = []): {text: string; maskiert: number} {
  let maskiert=0, aus=text;
  const matcher=holeShellLiteralMatcher(bekannteWerte);
  if(matcher instanceof RegExp)aus=aus.replace(matcher,(wert)=>{if(wert===ENV_PLATZHALTER)return wert;maskiert++;return ENV_PLATZHALTER;});
  else if(matcher)for(const wert of matcher){
    aus=aus.split(ENV_PLATZHALTER).map(teil=>teil.replaceAll(wert,()=>{maskiert++;return ENV_PLATZHALTER;})).join(ENV_PLATZHALTER);
  }
  const vorher=(aus.match(/\[WERT\]/g)??[]).length;
  if(/^\s*[\[{]/.test(aus))try {
    const original=JSON.parse(aus),strukturiert=maskiereMcpJson(aus,true);
    maskiert+=Math.max(0,(strukturiert.match(/\[WERT\]/g)??[]).length-vorher);
    const walk=(v:unknown):unknown=>{
      if(typeof v==='string'){const r=maskiereShellText(v,bekannteWerte);maskiert+=r.maskiert;return r.text;}
      if(Array.isArray(v))return v.map(walk);
      if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,w])=>[k,walk(w)]));
      return v;
    };
    const safe=walk(JSON.parse(strukturiert));
    return {text:maskiert?JSON.stringify(safe,null,aus.includes('\n')?2:undefined)+(aus.endsWith('\n')?'\n':''):aus,maskiert};
  }catch { /* freie Logzeile statt vollstaendigem JSON */ }
  aus=maskiereMcpJsonFragment(aus,true);
  aus=maskiereUrl(aus);
  aus=ersetzeKatalogRegel(aus,'shell.bearer');
  // P10-T42: sshpass -p <passwort> (Fund aus dem Altbestand-Test). Schon maskierte Werte bleiben, Quotes bleiben.
  aus=ersetzeKatalogRegel(aus,'shell.sshpass');
  aus=aus.split('\n').map(zeile=>{
    const kv=SHELL_KV_ZEILE.exec(zeile.endsWith('\r')?zeile.slice(0,-1):zeile);
    if(kv && istShellGeheimnisName(kv[2]) && shellWertWirktGeheim(kv[4])) return shellIstLeerWert(kv[4]) ? zeile : kv[1]+kv[2]+kv[3]+ENV_PLATZHALTER+(zeile.endsWith('\r')?'\r':'');
    return ersetzeKatalogRegel(zeile,'shell.json_frei');
  }).join('\n');
  aus=ersetzeKatalogRegel(aus,'shell.kv_frei');
  maskiert+=Math.max(0,(aus.match(/\[WERT\]/g)??[]).length-vorher);
  return {text:aus,maskiert};
}


/**
 * Geordneter Katalog. Namens-/Strukturmuster sind bewusst separat markiert:
 * ihre Anwendung und Ersetzung erfolgt im vorhandenen JSON-/Shell-Kontext.
 * Dynamische bekannte Literale stammen weiterhin ausschließlich vom Aufrufer.
 */
export const MASKEN_KATALOG: readonly MaskenEintrag[] = [
  {kennung: 'erklaerung.pem', muster: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.openai', muster: /\bsk-[A-Za-z0-9_-]{16,}/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.github', muster: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.github_pat', muster: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.aws', muster: /\bAKIA[0-9A-Z]{16}\b/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.slack', muster: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.google', muster: /\bAIza[0-9A-Za-z_-]{30,}/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.jwt', muster: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, ersatz: () => GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.bearer_lang', muster: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, ersatz: (_t, vor) => vor + GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.url_passwort', muster: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, ersatz: (_t, vor) => vor + GEHEIM + '@', anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung: 'erklaerung.zuweisung', muster: /\b((?:api[_-]?key|secret|token|passwor[dt]|passwd|pwd|access[_-]?key)["']?\s*[:=]\s*["'])[^"'\s]{8,}/gi, ersatz: (_t, vor) => vor + GEHEIM, anwendungsbereich: ['erklaerung', 'reverse'], art: 'text'},
  {kennung:'shell.url',muster:URL_ZUGANGSDATEN,ersatz:(_t,vor)=>vor+ENV_PLATZHALTER+'@',anwendungsbereich:['shell','mcp-json','reverse'],art:'text'},
  {kennung:'shell.bearer',muster:SHELL_BEARER,ersatz:(_t,vor)=>vor+ENV_PLATZHALTER,anwendungsbereich:['shell','reverse'],art:'text'},
  {kennung:'shell.sshpass',muster:SHELL_SSHPASS,ersatz:(t,vor,wert)=>{
    const q=wert[0]==='"'||wert[0]==="'"?wert[0]:'';
    return (q?wert.slice(1,-1):wert)===ENV_PLATZHALTER?t:vor+q+ENV_PLATZHALTER+q;
  },anwendungsbereich:['shell','reverse'],art:'text'},
  {kennung:'shell.kv_zeile',muster:SHELL_KV_ZEILE,ersatz:(t,vor,name,trenner,wert)=>istShellGeheimnisName(name)&&!shellIstLeerWert(wert)&&shellWertWirktGeheim(wert)?vor+name+trenner+ENV_PLATZHALTER:t,anwendungsbereich:['shell','reverse'],art:'struktur'},
  {kennung:'shell.kv_frei',muster:SHELL_KV_FREI,ersatz:(t,vor,name,trenner)=>istShellGeheimnisName(name)&&shellWertWirktGeheim(t.slice(vor.length+name.length+trenner.length))?vor+name+trenner+ENV_PLATZHALTER:t,anwendungsbereich:['shell','reverse'],art:'struktur'},
  {kennung:'shell.json_frei',muster:SHELL_JSON_FREI,ersatz:(t,vor,q,name,trenner,wert)=>istShellJsonGeheimnisName(name)&&shellWertWirktGeheim(wert)?vor+q+name+q+trenner+wert[0]+ENV_PLATZHALTER+wert[0]:t,anwendungsbereich:['shell','reverse'],art:'struktur'},
  {kennung:'shell.geheimname',muster:SHELL_NAME_GEHEIM,ersatz:()=>ENV_PLATZHALTER,anwendungsbereich:['shell','reverse'],art:'name'},
  {kennung:'shell.verfahrensname',muster:SHELL_NAME_AUSNAHME,ersatz:t=>t,anwendungsbereich:['shell','reverse'],art:'name'},
  {kennung:'shell.massname',muster:SHELL_NAME_MASS,ersatz:t=>t,anwendungsbereich:['shell','reverse'],art:'name'},
  {kennung:'shell.tokenzaehler',muster:SHELL_NAME_TOKENS,ersatz:t=>t,anwendungsbereich:['shell','reverse'],art:'name'},
  {kennung:'shell.json_key',muster:SHELL_JSON_KEY,ersatz:t=>t,anwendungsbereich:['shell','reverse'],art:'name'},
  {kennung:'mcp.geheimname',muster:SENSIBLER_SCHLUESSEL,ersatz:()=>PLATZHALTER,anwendungsbereich:['mcp-json'],art:'name'},
  {kennung:'mcp.feld_prefix',muster:MCP_JSON_FELD_PREFIX,ersatz:t=>t,anwendungsbereich:['shell','mcp-json','reverse'],art:'struktur'},
  {kennung:'mcp.feld_wert',muster:MCP_JSON_FELD_WERT,ersatz:()=>JSON.stringify(PLATZHALTER),anwendungsbereich:['shell','mcp-json','reverse'],art:'struktur'},
];

/** Bytegleiche Alt-Erklärungsmaske; Reihenfolge und Ersetzungszähler bleiben erhalten. */
export function schwaerzeGeheimnisse(text: string): {text: string; treffer: number} {
  return maskiereTextregeln(text, 'erklaerung');
}

const katalogNachKennung = new Map(MASKEN_KATALOG.map(e => [e.kennung, e]));
function ersetzeKatalogRegel(text: string, kennung: string): string {
  const e = katalogNachKennung.get(kennung)!;
  return text.replace(new RegExp(e.muster.source, e.muster.flags), (t: string, ...rest: unknown[]) =>
    e.ersatz(t, ...rest.filter((x): x is string => typeof x === 'string')));
}

function maskiereTextregeln(text: string, bereich: 'erklaerung' | 'reverse'): {text: string; treffer: number} {
  if (typeof text !== 'string' || text === '') return {text, treffer: 0};
  let treffer = 0;
  let aus = text;
  for (const eintrag of MASKEN_KATALOG) {
    if (eintrag.art !== 'text' || !eintrag.anwendungsbereich.includes(bereich)
      || eintrag.anwendungsbereich.includes('shell') || eintrag.anwendungsbereich.includes('mcp-json')) continue;
    aus = aus.replace(new RegExp(eintrag.muster.source,eintrag.muster.flags), (t: string, ...rest: unknown[]) => {
      treffer++;
      return eintrag.ersatz(t, ...rest.filter((x): x is string => typeof x === 'string'));
    });
  }
  return {text: aus, treffer};
}

/**
 * Neue gemeinsame Schnittstelle. Reverse kombiniert Shell-Kontextmaskierung und
 * formatierte Geheimnisse. treffer zählt tatsächliche Ersetzungen der Profile,
 * keine unterschiedlichen Geheimniswerte. Rohwerte werden weder geloggt noch
 * als Trefferliste zurückgegeben.
 */
export function maskiereMitKatalog(text: string, bereich: MaskenBereich, bekannteWerte: readonly string[] = []): {text: string; treffer: number} {
  if (bereich === 'erklaerung') return schwaerzeGeheimnisse(text);
  if (bereich !== 'shell' && bereich !== 'reverse') throw new RangeError('Unbekannter Maskenbereich');
  const shell = maskiereShellText(text,bekannteWerte);
  if (bereich === 'shell') return {text:shell.text,treffer:shell.maskiert};
  const erklaerung = maskiereTextregeln(shell.text,'reverse');
  return {text:erklaerung.text,treffer:shell.maskiert+erklaerung.treffer};
}

/** Liefert ausschließlich die Anzahl, niemals Text, Werte, Fundstellen oder Auszüge. */
export function zaehleMaskenTreffer(text: string, bereich: MaskenBereich, bekannteWerte: readonly string[] = []): number {
  return maskiereMitKatalog(text,bereich,bekannteWerte).treffer;
}
