/**
 * P10-T35: lexikalische Shell-Struktur, KEINE Expansion/Evaluation/Ausführung.
 * Absichtlich begrenzte Grammatik: unauflösbare Konstrukte werden ausgewiesen.
 */
export type SicherungsShell = 'bash' | 'sh' | 'pwsh' | 'cmd';
export interface ShellWort { text: string; dynamisch: boolean; raw?: string; }
export interface ShellInlineSkript { workspace_testdatei?:boolean; testprojekt?:boolean;sprache:'node'|'python';text:string;expansion:boolean;argv_index?:number;cwd?:string; }
export interface ShellTextKommando { /** P10-T73: Zielargumente kommen aus stdin (xargs), statisch unbekannt. */ argumente_aus_stdin?: boolean; umgebungsquelle?:{pfad:string;sha256:string;testprojekt:boolean;port:string;datenbank:string};inline_skript?:ShellInlineSkript; skript_operation?:import('./shell-inline-pruefung.js').InlineOperation; argv: ShellWort[]; umleitungen: string[]; umleitungs_woerter?: ShellWort[]; zuweisungen?: ShellWort[]; shell?: SicherungsShell; nach?: string; }
export interface ShellTextBaum { kommandos: ShellTextKommando[]; ungeklart: string[]; komplex: boolean; }
type Token = ShellWort & { operator?: boolean; quoted?: boolean; };
const TRENNER = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', '{', '}']);
const SCRIPT = /^(?:ba|da|z|k)?sh$|^pwsh(?:\.exe)?$|^powershell(?:\.exe)?$|^cmd(?:\.exe)?$/i;
const basis = (s: string) => s.replace(/\\/g, '/').split('/').pop() ?? s;

export function parseShellText(text: string, shell: SicherungsShell = 'bash', tiefe = 0): ShellTextBaum {
  const out: ShellTextBaum = { kommandos: [], ungeklart: [], komplex: false };
  if (tiefe > 8 || text.length > 262144) { out.ungeklart.push('parser_grenze'); return out; }
  let tokens: Token[] = [], word = '', dynamisch = false, begonnen = false;
  let quote = '', i = 0, quoted = false, wordStart = 0;
  const nested = (s: string, art: SicherungsShell = shell) => {
    const r = parseShellText(s, art, tiefe + 1);
    out.kommandos.push(...r.kommandos); out.ungeklart.push(...r.ungeklart); out.komplex = true;
  };
  const emitWord = () => {
    if (begonnen) tokens.push({ text: word, dynamisch, quoted, raw: text.slice(wordStart, i) });
    word = ''; dynamisch = false; begonnen = false; quoted = false;
  };
  const flush = () => {
    if (!tokens.length) return;
    let argv: ShellWort[] = [], umleitungen: string[] = [], umleitungs_woerter: ShellWort[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.operator) {
        if (/^(?:>&|<&)$/.test(t.text)) { k++; }
        else if (/^[0-9]*(?:>|>>|>|&>|&>>)$/.test(t.text)) {
          umleitungen.push(tokens[k + 1]?.text ?? '');
          if(tokens[k+1])umleitungs_woerter.push(tokens[k+1]);
          if (tokens[k + 1]?.dynamisch) out.ungeklart.push('ziel_dynamisch');
          k++;
        } else if (/^(?:[0-9]*<|<<-?|<<<)$/.test(t.text)) k++;
        continue;
      }
      argv.push({ text: t.text, dynamisch: t.dynamisch, raw: t.raw });
    }
    // Shell-Zuweisungen stehen vor dem ausführbaren Wort, nicht als Kommando.
    const zuweisungen: ShellWort[]=[];
    while (argv.length && /^[A-Za-z_][\w]*=/.test(argv[0].text)) zuweisungen.push(argv.shift()!);
    // Kontrollwörter sind keine ausführbaren Programme.
    while (argv.length && /^(?:then|do|else|if|while|until|!|&)$/.test(argv[0].text)) {
      out.ungeklart.push('kontrollfluss_nicht_statisch');argv.shift();
    }
    const interpreter=/^(?:node|python[\d.]*)(?:\.exe)?$/i.test(basis(argv[0]?.text??''));
    const option=argv.findIndex((a,i)=>i>0&&/^(?:-c|-e|--eval)$/.test(a.text));
    const inline=interpreter&&option>=0&&argv[option+1]?{sprache:(/^node/i.test(basis(argv[0].text))?'node':'python') as 'node'|'python',text:argv[option+1].text,expansion:false,argv_index:option+1}:undefined;
    if (argv.length || umleitungen.length || zuweisungen.length) out.kommandos.push({ argv, umleitungen, umleitungs_woerter, zuweisungen, shell,...(inline?{inline_skript:inline}:{}) });
    if (argv.length) {
      const b = basis(argv[0].text);
      if (argv[0].dynamisch || /^(?:eval|source|\.)$/i.test(b)) out.ungeklart.push('dynamisches_programm');
      if (SCRIPT.test(b)) {
        const option = argv.findIndex((a, k) => k > 0 && /^(?:-[A-Za-z]*c|--command|-command|\/c)$/i.test(a.text));
        if (option >= 0 && argv[option + 1]) {
          const art = /pwsh|powershell/i.test(b) ? 'pwsh' : /^cmd/i.test(b) ? 'cmd' : 'bash';
          nested(argv[option + 1].text, art);
        } else if (argv.length > 1) out.ungeklart.push('script_datei');
      }
      if (/^(?:node|python[\d.]*)(?:\.exe)?$/i.test(b) && !inline && !(tokens.some(t=>t.operator&&/^<<-?$/.test(t.text))&&argv.slice(1).every(a=>a.text==='-'||a.text.startsWith('-')))) out.ungeklart.push('interpreter_datei');
      const exec = argv.findIndex(a => /^-exec(?:dir)?$/.test(a.text));
      if (b === 'find' && exec >= 0) {
        const end = argv.findIndex((a, k) => k > exec && (a.text === '+' || a.text === ';'));
        out.kommandos.push({ argv: argv.slice(exec + 1, end < 0 ? undefined : end), umleitungen: [] });
      }
    }
    tokens = [];
  };
  // Findet schließendes ) unter Beachtung von Quotes und verschachtelten Klammern.
  const substitution = (start: number, input = text): { body: string; end: number } => {
    let depth = 1, q = '';
    for (let j = start; j < input.length; j++) {
      const c = input[j];
      if (c === '\\' && shell !== 'pwsh') { j++; continue; }
      if (q) { if (c === q) q = ''; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return { body: input.slice(start, j), end: j }; }
    }
    out.ungeklart.push('offene_substitution'); return { body: input.slice(start), end: input.length };
  };
  while (i < text.length) {
    const c = text[i];
    if (!begonnen && !/\s/.test(c) && !/[;&|<>(){}]/.test(c)) wordStart=i;
    const esc = shell === 'pwsh' ? String.fromCharCode(96) : shell === 'cmd' ? '^' : '\\';
    if (quote !== "'" && c === esc) {
      if (i + 1 >= text.length) out.ungeklart.push('offenes_escape');
      else if (text[i + 1] !== '\n') { word += text[i + 1]; begonnen = true; }
      i += 2; continue;
    }
    if (quote === "'") {
      if (c === "'" && shell === 'pwsh' && text[i + 1] === "'") { word += "'"; i += 2; continue; }
      if (c === "'") quote = ''; else word += c;
      i++; continue;
    }
    if (c === '$' && text[i + 1] === '(' && shell !== 'cmd') {
      const sub = substitution(i + 2); nested(sub.body);
      word += text.slice(i, sub.end + 1); begonnen = true; dynamisch = true; i = sub.end + 1; continue;
    }
    if (c.charCodeAt(0) === 96 && shell !== 'pwsh' && shell !== 'cmd') {
      let j = i + 1;
      while (j < text.length && text[j].charCodeAt(0) !== 96) { if (text[j] === '\\') j++; j++; }
      if (j >= text.length) out.ungeklart.push('offene_backticks');
      nested(text.slice(i + 1, j)); word += text.slice(i, j + 1); begonnen = true; dynamisch = true; i = j + 1; continue;
    }
    if (quote === '"') {
      if (c === '"') quote = ''; else { word += c; if (c === '$' || (shell === 'cmd' && /[%!]/.test(c))) dynamisch = true; }
      i++; continue;
    }
    if (c === "'" && shell !== 'cmd' || c === '"') { quote = c; quoted = true; begonnen = true; i++; continue; }
    if (c === '#' && !begonnen && shell !== 'cmd') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '$' || (shell === 'cmd' && /[%!]/.test(c))) dynamisch = true;
    if (c === '\n') {
      emitWord();
      const here = tokens.findIndex(t => t.operator && /^<<-?$/.test(t.text));
      const delimiter = here >= 0 ? tokens[here + 1]?.text : undefined;
      const expandHere = here >= 0 && !tokens[here + 1]?.quoted;
      if (tokens.filter(t => t.operator && /^<<-?$/.test(t.text)).length > 1) out.ungeklart.push('mehrfach_heredoc');
      const owner = tokens.find(t => !t.operator && !/^[A-Za-z_]\w*=/.test(t.text))?.text ?? '';
      flush(); out.komplex = true; i++;
      if (delimiter) {
        const start = i;
        let end = i;
        while (end < text.length) {
          const eol = text.indexOf('\n', end);
          const lineEnd = eol < 0 ? text.length : eol;
          if (text.slice(end, lineEnd).replace(/^\t+/, '') === delimiter) {
            const body = text.slice(start, end);
            if (SCRIPT.test(basis(owner))) nested(body, /pwsh|powershell/i.test(owner) ? 'pwsh' : 'bash');
            else if (/^(?:node|python[\d.]*)(?:\.exe)?$/i.test(basis(owner))&&out.kommandos.at(-1)?.argv.slice(1).every(a=>a.text==='-'||a.text.startsWith('-'))) {
              const command=out.kommandos.at(-1)!;
              command.inline_skript={sprache:/^node/i.test(basis(owner))?'node':'python',text:body,expansion:expandHere};
            }
            if (expandHere && !SCRIPT.test(basis(owner))) {
              // Here-Doc-Daten sind keine Befehle; nur echte Substitutionen laufen.
              for (let h = 0; h < body.length; h++) {
                if (body[h] === '\\') { h++; continue; }
                if (body[h] === '$' && body[h+1] === '(') { const sub = substitution(h+2, body); nested(sub.body); h = sub.end; }
                else if (body.charCodeAt(h) === 96) {
                  const stop = body.indexOf(String.fromCharCode(96),h+1);
                  if (stop < 0) { out.ungeklart.push('offene_backticks'); break; }
                  nested(body.slice(h+1,stop)); h=stop;
                }
              }
            }
            i = eol < 0 ? text.length : eol + 1; break;
          }
          if (eol < 0) { out.ungeklart.push('offenes_heredoc'); i = text.length; break; }
          end = eol + 1;
        }
      }
      continue;
    }
    if (/\s/.test(c)) { emitWord(); i++; continue; }
    if (/[;&|<>(){}]/.test(c)) {
      // Leere {} in find -exec sind ein normales Argument, kein Block.
      if (c === '{' && text[i + 1] === '}') { word += '{}'; begonnen = true; i += 2; continue; }
      emitWord();
      const op = ['&&', '||', '<<<', '<<-', '<<', '>>', '&>>', '&>', '>&', '<&', '|&'].find(x => text.startsWith(x, i)) ?? c;
      out.komplex = true;
      if (TRENNER.has(op) || op === '|&') { flush(); if(out.kommandos.length)out.kommandos[out.kommandos.length-1].nach=op; }
      else {
        // 2> ist stderr-Umleitung, nicht das zusätzliche Argument "2".
        if (op.includes('>') && tokens.at(-1)?.text.match(/^\d+$/)) tokens.pop();
        tokens.push({ text: op, dynamisch: false, operator: true });
      }
      i += op.length; continue;
    }
    word += c; begonnen = true; i++;
  }
  if (quote) out.ungeklart.push('offenes_quote');
  emitWord(); flush();
  out.ungeklart = [...new Set(out.ungeklart)];
  return out;
}
