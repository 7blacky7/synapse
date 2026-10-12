const PLATZHALTER = '[WERT]';
export const MCP_JSON_PFAD_REGEX_SQL = '(^|/)\\.mcp\\.json(\\.[^/]*)?$';
const SENSIBLER_SCHLUESSEL = /(?:token|key|secret|password|authorization)/i;
export const MCP_JSON_FELD_PREFIX=/(?<!\\)("(?:\\.|[^"\\])*")(\s*:\s*)/g;
export const MCP_JSON_FELD_WERT=/^("(?:\\.|[^"\\])*"|[^,}\]]+)/;
const SENSIBLE_BEREICHE = new Set(['env', 'headers']);
/** Shell-Muster und Literalquellen nutzen genau dieselbe Namensregel. */
export const SHELL_LITERAL_MIN_LAENGE=8;
export function istShellGeheimnisName(name:string):boolean{
  const norm=name.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
  // Synapse-Verfahrenskennungen sind keine Authentifizierungs-Tokens; UUID-Form allein genügt nicht.
  if(/^(?:wait_token|batch_token|stream_id)$/.test(norm))return false;
  // Zähler/Maße beschreiben Geheimnisse, tragen aber selbst keine Zugangsdaten.
  if(/(?:^|[_.-])(?:count|length|size|limit|ttl|timeout|duration|ms|rate|usage|used|path|file)$/.test(norm))return false;
  if(/^(?:input|output|total|cached|prompt|completion)_tokens(?:_|$)/.test(norm))return false;
  return /(?:^|[_.-])(?:keys?|tokens?|secrets?|password|pass|pwd|auth|authorization|credentials?)(?:$|[_.-])/.test(norm);
}
/** Ein generisches JSON-Feld key/keys benennt oft einen Datenbankschluessel.
 * Ohne Secret-Qualifier ist es kein Geheimnisindikator; bekannte Literale bleiben geschuetzt.
 * Env-Zuweisungen und die strengere MCP-Konfigmaske behalten ihre bisherige Regel.
 */
export function istShellJsonGeheimnisName(name:string):boolean {
  return !/^keys?$/i.test(name) && istShellGeheimnisName(name);
}
export const URL_ZUGANGSDATEN = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/@?#:\s]+:[^/@?#\s]*@/gi;

export function istMcpJsonDatei(pfad: string | null | undefined): boolean {
  if (typeof pfad !== 'string' || pfad === '') return false;
  const name = pfad.replace(/\\/g, '/').split('/').pop() ?? '';
  return name === '.mcp.json' || (name.startsWith('.mcp.json.') && name !== '.mcp.json.example');
}

export function maskiereUrl(wert: string): string {
  if(!wert.includes('://'))return wert;
  return wert.replace(URL_ZUGANGSDATEN, '$1[WERT]@');
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
