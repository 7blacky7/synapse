/**
 * P23-T5 (User-Grundsatz thought 6d99d9e6; Nachtrag Channel p23-skills 28020): FALL-SKILLS.
 *
 * 1. HINWEIS BEI FEHLBEDIENUNG: Eine feste Tabelle Fehlercode -> Fall-Skill (keine semantische Suche). Die Fehlerantwort
 *    bekommt beim ERSTEN Auftreten je Sitzung und Skill das Feld fall_skill {name, abruf, ausloeser}. Danach nicht mehr
 *    (Entprellung je Prozess, Schluessel = Sitzung des Aufrufers + Skill).
 * 2. JE WEG (User 19.10.2026): Synapse kennt Ausweis-Agenten (token, Principal vorhanden) und Legacy-Agenten
 *    (agent_id/project/role). Wo der Inhalt je Weg verschieden ist, gibt es getrennte Fall-Skills; die Tabelle waehlt
 *    automatisch nach dem Principal. Nie beide Varianten zugleich.
 * 3. KURZE TOOL-BESCHREIBUNGEN (tool-beschreibungen-kurz.ts) in tools/list.
 * 4. P23-T7 TOOL-FAELLE (Schalter 'fall_skill_faelle'): reicht ein Hinweis nicht (derselbe Fehlercode im selben Lauf erneut
 *    NACH dem Hinweis) oder gibt es fuer einen strukturierten Fehlercode keinen Fall-Skill, entsteht ein offener Fall im
 *    Erklaerungs-Topf (Familie tool:<tool>:<code>, erklaerungen.ts) - einmal je Lauf, Tool und Code, asynchron. Der Koordinator
 *    beantwortet ihn (code_check erklaerung_ablegen); die Antwort waehlt Jev kuenftig und sie ergaenzt den Fall-Skill.
 *
 * SCHALTER (memory regel-neue-funktionen-mit-schalter-und-debug), je Funktion getrennt, Standard AUS bis User-Freigabe:
 *   (I) Produkt-Schalter agent_profil_schalter funktion 'fall_skill_hinweis' bzw. 'tool_beschreibungen_kurz'
 *       (projekt > global; 'alle' schliesst sie bewusst NICHT ein), verwaltet ueber admin(profil_schalter_setzen,
 *       profil_funktion) / REST PUT .../agent-profile/schalter / Web-UI Panel Fall-Skills.
 *   (II) intern-Override gleichen Namens (nur SYNAPSE_INTERN_TOOL=1, modus freigegeben, befristet) hat Vorrang.
 *   Lesefehler -> AUS mit letzter_fehler. Gepuffert je Prozess (kernTtlMs), Schreiben eines Produkt-Schalters leert den Puffer.
 * DEBUG: leseFallSkillSchalter liefert {aktiv, quelle standard|produkt-schalter|intern, bis, letzter_fehler};
 *   fallSkillDiagnose() liefert Zaehler (geprueft, getroffen, ausgeliefert, entprellt) und die Tabelle.
 */
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import { leseProfilProduktSchalter, kernTtlMs, registriereSchalterGeschrieben } from './agent-profil-schalter.js';
import { kuerzeToolDefinition } from './tool-beschreibungen-kurz.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';
import { meldeFehlerfall, toolFamilie, type ToolFallKontext } from './erklaerungen.js';

// P23-T3: 'schlank' = schlanke Tool-Antworten (tool-antworten-schlank.ts), gleiche Lesestelle und Schalterart.
// P23-T7: 'faelle' = ungenuegende Fall-Skill-Hinweise als offene Tool-Faelle im Erklaerungs-Topf.
export const FALL_SKILL_FUNKTIONEN = { kurz: 'tool_beschreibungen_kurz', hinweis: 'fall_skill_hinweis', schlank: 'tool_antworten_schlank', faelle: 'fall_skill_faelle',
  // P23-T3 Punkt 6: fremde Shell-Ergebnisse anbieten (shell-hints.ts), gleiche Lesestelle und Schalterart.
  fremd: 'shell_fremde_ergebnisse' } as const;
export type FallSkillSchalterArt = keyof typeof FALL_SKILL_FUNKTIONEN;
export type FallSkillWeg = 'ausweis' | 'legacy';

export interface FallSkillSchalterStand {
  funktion: string;
  project: string | null;
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}

const PUFFER = new Map<string, { bis: number; stand: FallSkillSchalterStand }>();
/** Puffer verwerfen (Tests; automatisch nach jedem Schreiben eines Produkt-Schalters im eigenen Prozess). */
export function leereFallSkillSchalterPuffer(): void { PUFFER.clear(); }
registriereSchalterGeschrieben(leereFallSkillSchalterPuffer);

/** EINE Lesestelle je Funktion. */
export async function leseFallSkillSchalter(art: FallSkillSchalterArt, project?: string | null): Promise<FallSkillSchalterStand> {
  const funktion = FALL_SKILL_FUNKTIONEN[art];
  const p = typeof project === 'string' && project.trim() ? project.trim() : null;
  const schluessel = funktion + '\u0000' + (p ?? '');
  const ttl = kernTtlMs();
  const jetzt = Date.now();
  const c = ttl > 0 ? PUFFER.get(schluessel) : undefined;
  if (c && c.bis > jetzt) return c.stand;
  let stand: FallSkillSchalterStand = { funktion, project: p, aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null };
  let intern = false;
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [funktion],
        query_timeout: 2000,
      } as import('pg').QueryConfig & { query_timeout: number });
      if (r.rows[0]) {
        stand = { ...stand, aktiv: r.rows[0].aktiv, quelle: 'intern', bis: r.rows[0].bis?.toISOString() ?? null };
        intern = true;
      }
    } catch { stand = { ...stand, letzter_fehler: 'intern_schalter_nicht_lesbar' }; }
  }
  if (!intern) {
    const prod = await leseProfilProduktSchalter(funktion, p);
    stand = { ...stand, aktiv: prod.aktiv && !prod.letzter_fehler, quelle: prod.quelle === 'produkt-schalter' ? 'produkt-schalter' : 'standard',
      letzter_fehler: prod.letzter_fehler ?? stand.letzter_fehler };
  }
  if (ttl > 0 && !stand.letzter_fehler) PUFFER.set(schluessel, { bis: jetzt + ttl, stand });
  return stand;
}

// ---------------------------------------------------------------------------------------------
// Tabelle Fehlercode -> Fall-Skill. Reihenfolge = Vorrang (spezifisch vor allgemein).
// skill: gilt fuer beide Wege; ausweis/legacy: getrennte Varianten (Auswahl nach Principal).
// tools: nur fuer diese Tools (leer = alle).
// ---------------------------------------------------------------------------------------------
export interface FallSkillEintrag {
  codes: string[];
  tools?: string[];
  skill?: string;
  ausweis?: string;
  legacy?: string;
}

const FILES = ['files', 'files_batch'];
export const FALL_SKILL_TABELLE: readonly FallSkillEintrag[] = [
  // Identitaet / Weg
  { codes: ['agent_token_fehlt', 'identitaet_konflikt', 'token_ungueltig', 'token_abgelaufen'], skill: 'fall-querschnitt-ausweis-token' },
  { codes: ['shell_rueckfrage'], tools: ['shell'], ausweis: 'fall-shell-rueckfrage-ausweis', legacy: 'fall-shell-rueckfrage-legacy' },
  { codes: ['agent_fehlt', 'agent_id_fehlt'], ausweis: 'fall-querschnitt-ausweis-token', legacy: 'fall-querschnitt-agent-id-legacy' },
  { codes: ['grund_noetig'], legacy: 'fall-plan-grund-legacy' },
  // Parameter
  { codes: ['unbekannter_parameter', 'unbekannte_parameter'], skill: 'fall-querschnitt-unbekannter-parameter' },
  { codes: ['mehrdeutig'], skill: 'fall-querschnitt-id-praefix' },
  { codes: ['recht_fehlt', 'funktion_aus', 'keine_berechtigung'], skill: 'fall-querschnitt-recht-fehlt' },
  // files
  { codes: ['anchor_mismatch'], tools: FILES, skill: 'fall-files-anker' },
  { codes: ['pfad_gesperrt', 'pfad_ungueltig'], skill: 'fall-files-pfad' },
  { codes: ['pruef_befunde', 'syntax_befund', 'syntaxfehler'], tools: FILES, skill: 'fall-files-syntaxbefund' },
  { codes: ['suchtext_treffer'], tools: FILES, skill: 'fall-files-suchtext' },
  { codes: ['datei_existiert'], tools: FILES, skill: 'fall-files-create-existiert' },
  { codes: ['contribution_failed', 'coedit_conflict', 'waiting_for_contributors', 'coedit_wait'], tools: FILES, skill: 'fall-files-coedit' },
  { codes: ['late_line_ops_unmappable', 'stale', 'hash_konflikt', 'conflict'], tools: FILES, skill: 'fall-files-spaet' },
  { codes: ['plan_failed', 'plan_update_failed'], tools: FILES, skill: 'fall-files-plan-gescheitert' },
  { codes: ['expired', 'plan_abgelaufen'], tools: FILES, skill: 'fall-files-plan-ablauf' },
  { codes: ['history_leer_mit_agent_id'], tools: FILES, legacy: 'fall-files-history-filter-legacy' },
  // shell
  { codes: ['unterbrochen_durch', 'job_laeuft'], tools: ['shell'], skill: 'fall-shell-langer-job' },
  { codes: ['shell_gesperrt', 'befehl_gesperrt'], tools: ['shell'], skill: 'fall-shell-projektdateien' },
  // code_intel
  { codes: ['ausgabe_gekappt'], tools: ['code_intel'], skill: 'fall-ci-ausgabe-gross' },
  // jev / code_check / specialist / project
  { codes: ['kategorie_verboten', 'optionen_ungueltig', 'erste_id_fehlt', 'runde_ungueltig'], tools: ['jev'], skill: 'fall-jev-entscheiden' },
  { codes: ['selbsttest_fehlgeschlagen', 'dublette', 'erkennung_ungueltig'], tools: ['code_check'], skill: 'fall-cc-muster-anlegen' },
  { codes: ['effort_ungueltig', 'modell_unbekannt', 'unbekanntes_modell'], tools: ['specialist'], skill: 'fall-spez-spawn' },
  { codes: ['projekt_unbekannt', 'pfad_mehrdeutig', 'projekt_mehrdeutig'], tools: ['project'], skill: 'fall-projekt-pfad-aufloesen' },
];

const CODE_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;

/** Strukturierte Fehlercodes einer Antwort (error/fehler/code/status-Felder, Codes im Fehlertext) plus abgeleitete Faelle. */
export function sammleFehlercodes(tool: string, antwort: Record<string, unknown>, args: Record<string, unknown> = {}): string[] {
  const codes = new Set<string>();
  const nimm = (v: unknown) => {
    if (typeof v !== 'string' || !v) return;
    const t = v.trim();
    if (/^[a-z][a-z0-9_]*$/.test(t)) codes.add(t);
    else for (const m of t.slice(0, 2000).match(CODE_RE) ?? []) codes.add(m);
  };
  for (const k of ['error', 'error_code', 'fehler', 'code', 'fehlercode']) {
    const v = antwort[k];
    if (typeof v === 'string') nimm(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) { nimm((v as Record<string, unknown>).code); nimm((v as Record<string, unknown>).message); }
  }
  if (typeof antwort.status === 'string' && antwort.success === false) nimm(antwort.status);
  if (antwort.stufe === 'rueckfrage') codes.add('shell_rueckfrage');
  if (antwort.unterbrochen_durch !== undefined) codes.add('unterbrochen_durch');
  if (FILES.includes(tool)) {
    if (antwort.success === false && typeof antwort.count === 'number' && Array.isArray(antwort.lines)) codes.add('suchtext_treffer');
    if (antwort.applied === false && typeof antwort.message === 'string' && antwort.message.includes('existiert bereits')) codes.add('datei_existiert');
    const eintraege = Array.isArray(antwort.entries) ? antwort.entries : Array.isArray(antwort.history) ? antwort.history : null;
    if (args.action === 'history' && typeof args.agent_id === 'string' && args.agent_id && eintraege && eintraege.length === 0) codes.add('history_leer_mit_agent_id');
  }
  return [...codes];
}

export interface FallSkillTreffer { name: string; ausloeser: string; weg: FallSkillWeg | 'beide' }

/** Reine Tabellenabfrage (ohne Schalter/Entprellung). null = kein passender Fall-Skill fuer diesen Weg. */
export function ermittleFallSkill(tool: string, antwort: unknown, weg: FallSkillWeg, args: Record<string, unknown> = {}): FallSkillTreffer | null {
  if (!antwort || typeof antwort !== 'object' || Array.isArray(antwort)) return null;
  const codes = sammleFehlercodes(tool, antwort as Record<string, unknown>, args);
  if (!codes.length) return null;
  for (const e of FALL_SKILL_TABELLE) {
    if (e.tools && !e.tools.includes(tool)) continue;
    const code = e.codes.find((c) => codes.includes(c));
    if (!code) continue;
    const name = e.skill ?? (weg === 'ausweis' ? e.ausweis : e.legacy);
    if (!name) continue; // Variante gibt es fuer diesen Weg nicht - nie die andere zeigen
    return { name, ausloeser: code, weg: e.skill ? 'beide' : weg };
  }
  return null;
}

export const FALL_SKILL_FELD = 'fall_skill' as const;
const GEZEIGT = new Set<string>();
/** P23-T7: Sitzung + Tool + Fehlercode, zu denen der Agent den Fall-Skill schon hat (gezeigt bzw. entprellt). */
const GEZEIGT_CODE = new Set<string>();
/** P23-T7: Sitzung + Tool + Fehlercode, die schon als Tool-Fall gemeldet wurden (einmal je Lauf). */
const GEMELDET = new Set<string>();
const GEZEIGT_MAX = 20_000;
const zaehler = { geprueft: 0, getroffen: 0, ausgeliefert: 0, entprellt: 0, schalter_aus: 0,
  fall_wiederholt: 0, fall_ohne_skill: 0, fall_schalter_aus: 0 };

/** Debug: Zaehler und Tabelle (fuer admin/intern-Diagnose und Tests). */
export function fallSkillDiagnose(): Record<string, unknown> {
  return { zaehler: { ...zaehler }, gemerkt: GEZEIGT.size, gemeldet: GEMELDET.size, tabelle: FALL_SKILL_TABELLE };
}
/** Tests: Entprellung und Zaehler zuruecksetzen. */
export function leereFallSkillEntprellung(): void {
  GEZEIGT.clear();
  GEZEIGT_CODE.clear();
  GEMELDET.clear();
  for (const k of Object.keys(zaehler) as Array<keyof typeof zaehler>) zaehler[k] = 0;
}
const merke = (menge: Set<string>, key: string): void => {
  if (menge.size >= GEZEIGT_MAX) menge.clear();
  menge.add(key);
};

const CODE_EXAKT = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ALLGEMEINE_CODES = new Set(['fehler', 'error', 'unbekannt', 'unknown', 'false', 'true', 'null']);

/** P23-T7: strukturierter Fehlercode einer Fehlerantwort (error_code/fehlercode/error/fehler/code als reiner Code), sonst null. */
export function primaererFehlercode(antwort: Record<string, unknown>): string | null {
  if (antwort.success !== false) return null;
  for (const k of ['error_code', 'fehlercode', 'error', 'fehler', 'code']) {
    const v = antwort[k];
    const roh = typeof v === 'string' ? v : v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>).code : undefined;
    const c = typeof roh === 'string' ? roh.trim() : '';
    if (c.length >= 3 && c.length <= 64 && CODE_EXAKT.test(c) && !ALLGEMEINE_CODES.has(c)) return c;
  }
  return null;
}

const GEHEIM_SCHLUESSEL = /token|passw|secret|geheim|api_?key|cookie|authori|bestaetig|credential/i;
/** Anhaenge anderer Hinweisquellen gehoeren nicht in den Fall. */
const FREMDE_FELDER = new Set([FALL_SKILL_FELD, 'skill_suggestions', 'skill_hook_metrics', 'shell_activity', 'unread_channels', 'unreadChat',
  'agentOnboarding', 'tool_guide', 'werkzeug_regeln', 'fehlermuster', 'open_plans', 'pending_events', 'hinweis_agent_id']);

/** Werte kuerzen und begrenzen; Geheimnis-Schluessel entfernen (geschwaerzt wird zusaetzlich im Erklaerungs-Topf). */
function schlank(v: unknown, tiefe = 0): unknown {
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 199) + '…' : v;
  if (Array.isArray(v)) {
    if (tiefe >= 3) return `[${v.length} Eintraege]`;
    return [...v.slice(0, 5).map((x) => schlank(x, tiefe + 1)), ...(v.length > 5 ? [`… +${v.length - 5}`] : [])];
  }
  if (v && typeof v === 'object') {
    if (tiefe >= 3) return '{…}';
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 20)
      .map(([k, x]) => [k, GEHEIM_SCHLUESSEL.test(k) ? '[ENTFERNT]' : schlank(x, tiefe + 1)]));
  }
  return v;
}

/** Ausschnitt eines Tool-Falls: Kopf, dann je Argument und je Antwortfeld eine Zeile (je hoechstens 15). */
export function toolFallText(k: ToolFallKontext, args: Record<string, unknown>, antwort: Record<string, unknown>): string {
  const zeile = (n: string, w: unknown) => `  ${n}: ${GEHEIM_SCHLUESSEL.test(n) ? '[ENTFERNT]' : String(JSON.stringify(schlank(w)) ?? '')}`;
  return [
    `Tool: ${k.tool}`, `Aktion: ${k.aktion ?? '-'}`, `Fehlercode: ${k.code}`,
    `Fall-Skill: ${k.fall_skill ? `${k.fall_skill} (gezeigt; derselbe Fehlercode trat danach im selben Lauf erneut auf)` : 'keiner fuer diesen Fehlercode und Weg'}`,
    `Weg: ${k.weg}`, `Agent: ${k.agent_id ?? '-'} | Identitaet: ${k.identity_id ?? '-'} | Lauf: ${k.lauf_id ?? '-'}`,
    'Argumente:', ...Object.entries(args).slice(0, 15).map(([n, w]) => zeile(n, w)),
    'Fehlerantwort:', ...Object.entries(antwort).filter(([n]) => !FREMDE_FELDER.has(n)).slice(0, 15).map(([n, w]) => zeile(n, w)),
  ].join('\n');
}

/**
 * P23-T7: meldet einen Tool-Fall an den Erklaerungs-Topf (Familie tool:<tool>:<code>) - einmal je Lauf, Tool und Code.
 * Asynchron und nur bei wirksamem Schalter fall_skill_faelle; die Antwort an den Agenten wartet nie darauf. Wirft nie.
 */
function meldeToolFall(tool: string, code: string, skill: string | null, art: ToolFallKontext['art'], antwort: Record<string, unknown>, opt: FallSkillOptionen): void {
  const lauf = opt.schluessel ? opt.schluessel + '\u0000' + tool + '\u0000' + code : null;
  if (lauf && GEMELDET.has(lauf)) return;
  const principal = aktuellerAgentPrincipal();
  void (async () => {
    try {
      const project = opt.project ?? principal?.project ?? null;
      if (!project) return;
      if (!(await leseFallSkillSchalter('faelle', project)).aktiv) { zaehler.fall_schalter_aus++; return; }
      if (lauf) {
        if (GEMELDET.has(lauf)) return;
        merke(GEMELDET, lauf);
      }
      const args = opt.args ?? {};
      const ident = principal?.art === 'identity' ? principal : null;
      const agentId = principal?.agent_id ?? (typeof args.agent_id === 'string' && args.agent_id ? args.agent_id : null);
      const kontext: ToolFallKontext = {
        tool, aktion: typeof args.action === 'string' ? args.action : null, code, fall_skill: skill, art, weg: opt.weg,
        agent_id: agentId, identity_id: ident?.identity_id ?? null, lauf_id: ident?.lauf_id ?? null,
      };
      const ergebnis = toolFallText(kontext, args, antwort);
      meldeFehlerfall({
        project, agent_id: agentId, owner_identity_id: kontext.identity_id, familie: toolFamilie(tool, code), weg: 'einzelweg',
        basis: '', ergebnis, tool_fall: kontext,
        befund: {
          quelle: 'muster', pruefer: 'fall-skill', severity: 'error', datei: `tool-fall/${tool}/${code}`, zeilen: [1, 1], code, wo: [],
          bemerkt_bei: { zeile: ergebnis.split('\n').length },
          was: `${tool}${kontext.aktion ? '.' + kontext.aktion : ''}: ${code} - `
            + (skill ? `Fall-Skill ${skill} reichte nicht (erneut im selben Lauf)` : 'kein Fall-Skill fuer diesen Fehlercode'),
        },
      });
      zaehler[art === 'wiederholt' ? 'fall_wiederholt' : 'fall_ohne_skill']++;
    } catch { /* Sammeln darf die fachliche Antwort nie brechen. */ }
  })();
}

export interface FallSkillOptionen {
  /** Principal vorhanden (Ausweis/token) -> 'ausweis', sonst 'legacy'. */
  weg: FallSkillWeg;
  /** Sitzungsschluessel des Aufrufers (Identitaet+Epoch, agent_id oder Verbindung); ohne = keine Entprellung. */
  schluessel?: string | null;
  project?: string | null;
  args?: Record<string, unknown>;
}

/**
 * Haengt bei passender Fehlbedienung EINMAL je Sitzung und Skill fall_skill an (neues Objekt).
 * Wirft nie; ohne Treffer, bei Schalter AUS oder bereits gezeigt: unveraendertes Objekt (gleiche Identitaet).
 */
export async function haengeFallSkillHinweisAn<T>(antwort: T, tool: string, opt: FallSkillOptionen): Promise<T> {
  try {
    if (!antwort || typeof antwort !== 'object' || Array.isArray(antwort)) return antwort;
    if (FALL_SKILL_FELD in (antwort as Record<string, unknown>)) return antwort;
    zaehler.geprueft++;
    const treffer = ermittleFallSkill(tool, antwort, opt.weg, opt.args ?? {});
    if (!treffer) {
      // P23-T7: strukturierter Fehlercode ohne Fall-Skill (fuer diesen Weg) -> offener Tool-Fall.
      const code = primaererFehlercode(antwort as Record<string, unknown>);
      if (code) meldeToolFall(tool, code, null, 'ohne_skill', antwort as Record<string, unknown>, opt);
      return antwort;
    }
    zaehler.getroffen++;
    if (!(await leseFallSkillSchalter('hinweis', opt.project ?? null)).aktiv) { zaehler.schalter_aus++; return antwort; }
    if (opt.schluessel) {
      const key = opt.schluessel + '\u0000' + treffer.name;
      const codeKey = opt.schluessel + '\u0000' + tool + '\u0000' + treffer.ausloeser;
      if (GEZEIGT.has(key)) {
        zaehler.entprellt++;
        // P23-T7: derselbe Fehlercode trotz Hinweis im selben Lauf erneut -> der Fall-Skill reichte nicht.
        if (GEZEIGT_CODE.has(codeKey)) meldeToolFall(tool, treffer.ausloeser, treffer.name, 'wiederholt', antwort as Record<string, unknown>, opt);
        else merke(GEZEIGT_CODE, codeKey);
        return antwort;
      }
      merke(GEZEIGT, key);
      merke(GEZEIGT_CODE, codeKey);
    }
    zaehler.ausgeliefert++;
    return { ...(antwort as Record<string, unknown>), [FALL_SKILL_FELD]: {
      name: treffer.name,
      abruf: `skills(action:"get_full", skill_name:"${treffer.name}")`,
      ausloeser: treffer.ausloeser,
    } } as T;
  } catch {
    return antwort; // Eine Zugabe darf die fachliche Antwort nie brechen.
  }
}

/** stdio: JSON im ersten Textblock anreichern; Nicht-JSON bleibt unveraendert. */
export async function haengeFallSkillTextHinweisAn<R extends { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }>(
  resp: R, tool: string, opt: FallSkillOptionen,
): Promise<R> {
  const block = resp?.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return resp;
  try {
    const roh: unknown = JSON.parse(block.text);
    const neu = await haengeFallSkillHinweisAn(roh, tool, opt);
    if (neu !== roh) {
      block.text = JSON.stringify(neu, null, 2);
      if (resp.structuredContent && neu && typeof neu === 'object' && !Array.isArray(neu)) resp.structuredContent = neu as Record<string, unknown>;
    }
  } catch { /* Nicht-JSON: nichts anhaengen */ }
  return resp;
}

/** tools/list: kurze Beschreibungen, wenn der Schalter wirkt. Kopien; Struktur unveraendert. */
export async function wendeKurzeBeschreibungenAn<T extends { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }>(
  defs: T[], project?: string | null,
): Promise<T[]> {
  try {
    if (!(await leseFallSkillSchalter('kurz', project ?? null)).aktiv) return defs;
    return defs.map((d) => kuerzeToolDefinition(d));
  } catch {
    return defs;
  }
}
