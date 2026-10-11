/**
 * MODUL: agent-meta-yaml.ts
 * ZWECK: meta.yaml eines Spezialisten (.synapse/agents/<name>/meta.yaml) korrekt
 *        schreiben und tolerant lesen (P15-T39).
 *
 * BEFUND (11.10.2026): Der alte Writer (agents/skills.ts writeMeta) schrieb
 * `expertise: ${wert}` ungequotet. Mit 'X: Y' im Wert ist das ungueltiges YAML
 * (BLOCK_AS_IMPLICIT_KEY), mit ' #' schneidet ein echter Parser den Rest als
 * Kommentar ab, mit Zeilenumbruch landet der Rest in einer eigenen Zeile.
 * Die Synapse-eigenen Leser lesen zeilenweise (erster Doppelpunkt trennt) und
 * verstehen den Bestand deshalb richtig — ein echter YAML-Parser nicht.
 *
 * SCHREIBEN: Ein Wert bleibt plain, wenn ein YAML-Parser exakt denselben String
 * zurueckliest; sonst wird er als JSON-String geschrieben (gueltiger YAML-
 * Double-Quoted-Scalar, immer einzeilig — \n, \", Umlaute bleiben erhalten).
 *
 * LESEN: Zuerst zeilenweise wie bisher (Bestand bleibt bit-gleich lesbar), dazu
 * werden "..."- und '...'-Werte entquotet. Nur wenn die Datei echte YAML-Struktur
 * traegt (Block-Scalar | / >, eingerueckte Folgezeilen), entscheidet der echte
 * Parser (yaml, eemeli). Scheitert der, bleibt das zeilenweise Ergebnis.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface AgentMetaFelder {
  name: string;
  model: string;
  expertise: string;
  created: string;
}

type YamlModul = {
  parseDocument(text: string, opt?: Record<string, unknown>): { errors: unknown[]; toJS(): unknown };
};
let yamlModul: YamlModul | null | undefined;

function ladeYaml(): YamlModul | null {
  if (yamlModul !== undefined) return yamlModul;
  try {
    yamlModul = require('yaml') as YamlModul;
  } catch {
    yamlModul = null;
  }
  return yamlModul;
}

/** Konservativer Rueckfall ohne Parser: nur Buchstaben, Ziffern und harmlose Zeichen bleiben plain. */
const SICHER_PLAIN = /^[\p{L}\p{N}][\p{L}\p{N} _.,/()+-]*$/u;
const NICHT_PLAIN = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

/** Ein Wert als YAML-Scalar: plain wenn eindeutig, sonst JSON-quotiert. */
export function yamlSkalar(wert: string): string {
  const v = String(wert);
  if (v.length === 0) return '""';
  if (/[\r\n\t]/.test(v) || v !== v.trim() || NICHT_PLAIN.test(v)) return JSON.stringify(v);
  const y = ladeYaml();
  if (y) {
    try {
      const doc = y.parseDocument(`k: ${v}\n`);
      const js = doc.errors.length === 0 ? (doc.toJS() as Record<string, unknown> | null) : null;
      if (js && typeof js === 'object' && Object.keys(js).length === 1 && js.k === v) return v;
    } catch {
      // faellt auf JSON-Quoting
    }
    return JSON.stringify(v);
  }
  return SICHER_PLAIN.test(v) && !/^[\d.+-]+$/.test(v) ? v : JSON.stringify(v);
}

const FELDER: Array<keyof AgentMetaFelder> = ['name', 'model', 'expertise', 'created'];

/** meta.yaml-Inhalt (gueltiges YAML, je Feld genau eine Zeile). */
export function serialisiereAgentMeta(meta: AgentMetaFelder): string {
  return FELDER.map((f) => `${f}: ${yamlSkalar(meta[f] ?? '')}`).join('\n') + '\n';
}

function entquote(wert: string): string {
  if (wert.length >= 2 && wert.startsWith('"') && wert.endsWith('"')) {
    try {
      const s: unknown = JSON.parse(wert);
      if (typeof s === 'string') return s;
    } catch {
      // kein JSON — als YAML-Double-Quoted zu exotisch: roh lassen
    }
    return wert;
  }
  if (wert.length >= 2 && wert.startsWith("'") && wert.endsWith("'")) {
    return wert.slice(1, -1).replace(/''/g, "'");
  }
  return wert;
}

/**
 * Liest meta.yaml tolerant. Liefert alle gefundenen Schluessel als String;
 * ob name/model/expertise/created vollstaendig sind, entscheidet der Aufrufer.
 */
export function leseAgentMetaYaml(roh: string): Record<string, string> {
  const zeilenweise: Record<string, string> = {};
  let strukturiert = false;
  for (const zeile of roh.split(/\r?\n/)) {
    if (zeile.trim() === '' || zeile.trimStart().startsWith('#')) continue;
    if (/^\s/.test(zeile)) {
      strukturiert = true; // eingerueckte Folgezeile: echtes YAML
      continue;
    }
    const idx = zeile.indexOf(':');
    if (idx === -1) continue;
    const schluessel = zeile.slice(0, idx).trim();
    const wert = zeile.slice(idx + 1).trim();
    if (/^[|>][+-]?\d*$/.test(wert)) strukturiert = true;
    if (!schluessel || !wert) continue;
    const entquotet = entquote(wert);
    // Leer (auch '""') gilt wie bisher als nicht vorhanden.
    if (entquotet.length > 0) zeilenweise[schluessel] = entquotet;
  }
  if (!strukturiert) return zeilenweise;

  const y = ladeYaml();
  if (!y) return zeilenweise;
  try {
    const doc = y.parseDocument(roh);
    if (doc.errors.length > 0) return zeilenweise;
    const js = doc.toJS();
    if (!js || typeof js !== 'object' || Array.isArray(js)) return zeilenweise;
    const ergebnis: Record<string, string> = { ...zeilenweise };
    for (const [k, v] of Object.entries(js as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        const s = String(v);
        if (s.length > 0) ergebnis[k] = s;
      }
    }
    return ergebnis;
  } catch {
    return zeilenweise;
  }
}
