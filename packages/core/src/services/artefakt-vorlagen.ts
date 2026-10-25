/**
 * P22-T154 (User 25.10.2026, Entwurf 689abb81, GO mit R1-R9): Artefakte als Datenvorlagen.
 *
 * SPEICHER (Schema 152): agent_artifacts traegt optional vorlage + quellen + modus (fest|stand|live) + standard_project; global
 *   gespeichert, eine Wahrheit, session_id optional. artefakt_renderungen haelt je (Artefakt, Projekt) die letzte Momentaufnahme.
 *   agent_artifacts.html = Renderung im standard_project (Bewertung P22-T141/T147, Liste, Livebild unveraendert).
 * QUELLEN: nur feste, lesende Vertraege aus dem Katalog (regel-alles-ueber-api-vertraege-erweitern), keine freien SQL/Shell.
 *   project steht NIE in den args, es wird beim Rendern injiziert (dieselbe Vorlage in jedem Projekt). deploy.stand ist als
 *   'geplant' reserviert (R1, eigene Task). Weitere Quellen registriert die API (agentennetzwerk.snapshot).
 * RECHTE (R6): Web-UI-User alle Projekte, Main projektuebergreifend, Agent mit Ausweis nur im eigenen Projekt.
 *   Ersetzen (Vorlage/Quellen/HTML) nur Urheber (created_by_identity_id) bzw. Main-Session (R8); neu zeichnen jeder mit Leserecht.
 * LIVE (R5): neu gerendert wird nur, wenn jemand zusieht (API artefakt-live.ts) oder beim naechsten Anzeigen; Drossel und
 *   Buendelung sind PG-Einstellungen. Eine neue Revision entsteht nur bei geaendertem HTML (daten_hash gegen Revisionsflut).
 * SCHALTER (global, Standard AUS, nur ausdruecklich): artefakt_vorlagen (Vorlage/Quellen/neu zeichnen), artefakt_vorlagen_live
 *   (AUS = live verhaelt sich wie stand), artefakt_ausweis_zeigen (zeigen ohne Main-Session, Ziel eigener Verlauf).
 * DEBUG: jede Render-Antwort traegt debug {quellen:[{name,vertrag,ms,bytes,gekappt,fehler}], daten_hash, schalter_quelle,
 *   render_ms, gekappt, anlass, wiederverwendet}.
 * P22-T165 (Entwurf ba4ebbc0, GO F1-F6): Quelle plan.alle = alle Plaene MIT Tasks kompakt; kappt selbst (erledigte Tasks zuerst,
 *   aelteste zuerst, dann offene vom Ende; Plaene bleiben immer), debug_quelle im Ergebnis. Schalter artefakt_verweise (global,
 *   Standard AUS, nur ausdruecklich): Klick auf data-synapse-verweis / href="#verweis:" im Artefakt oeffnet das Lesefenster der
 *   Web-UI, Radio-/details-Zustand bleibt ueber neue Revisionen erhalten (Web-UI kios/verweis-klick-logik.ts).
 * P22-T169 (User 25.10.2026, thought 403c12bd): plan.alle/plan.list/plan.get liefern zusaetzlich nummer (Zahl aus der Kurz-ID: P12 -> 12,
 *   P22-T169 -> 169, ohne Kurz-ID null), damit Vorlagen numerisch statt lexikalisch (P1, P10, P2) ordnen koennen. renderArtefakt nimmt
 *   optional ausloeser (die NOTIFY-Anlaesse des Live-Dienstes) und zeigt sie im debug. meldeArtefaktImVerlauf: kurze Zeile
 *   'aktualisiert'/'fehler' im Verlauf des Absenders beim Ersetzen (User-Befund thought c4858305).
 */
import { createHash, randomUUID } from 'node:crypto';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ARTEFAKT_HTML_MAX } from './artefakt.js';
import { renderVorlage, pruefeVorlage } from './artefakt-vorlage.js';
import { listPlans, getPlan, listPlansDetail, getAllePlaene, filtereWiedervorlageTasks } from './plans.js';
import { planNummer, taskNummer } from './plan-kurz-ids.js';
import { getChannelMessages } from './channels.js';
import { leseVerlaufSchalter } from './hauptagent-verlauf.js';

export const ARTEFAKT_VORLAGEN_FUNKTION = 'artefakt_vorlagen' as const;
export const ARTEFAKT_VORLAGEN_LIVE_FUNKTION = 'artefakt_vorlagen_live' as const;
export const ARTEFAKT_AUSWEIS_ZEIGEN_FUNKTION = 'artefakt_ausweis_zeigen' as const;
/** P22-T165: Verweise im Artefakt anklickbar (Lesefenster) + Zustand ueber Live-Updates; wirkt in der Web-UI. */
export const ARTEFAKT_VERWEISE_FUNKTION = 'artefakt_verweise' as const;
export const ARTEFAKT_MODI = ['fest', 'stand', 'live'] as const;
export type ArtefaktModus = typeof ARTEFAKT_MODI[number];

export class ArtefaktVorlagenFehler extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const fehler = (code: string, message: string, status = 400): never => { throw new ArtefaktVorlagenFehler(code, message, status); };

// ---------------------------------------------------------------------------------------------
// Schalter + Einstellungen
// ---------------------------------------------------------------------------------------------
type VorlagenFunktion = typeof ARTEFAKT_VORLAGEN_FUNKTION | typeof ARTEFAKT_VORLAGEN_LIVE_FUNKTION | typeof ARTEFAKT_AUSWEIS_ZEIGEN_FUNKTION
  | typeof ARTEFAKT_VERWEISE_FUNKTION;
/** Wirksamer Stand (global); Lesefehler = AUS mit letzter_fehler. Wirft nie. */
export async function artefaktVorlagenSchalter(funktion: VorlagenFunktion = ARTEFAKT_VORLAGEN_FUNKTION): Promise<{ aktiv: boolean; quelle: string; letzter_fehler: string | null }> {
  try {
    const s = await leseProfilProduktSchalter(funktion, null);
    return { aktiv: s.aktiv && !s.letzter_fehler, quelle: s.quelle, letzter_fehler: s.letzter_fehler };
  } catch (error) {
    return { aktiv: false, quelle: 'standard', letzter_fehler: 'schalter_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

/** Code-Standards; wirksam sind die PG-Einstellungen (artefakt_vorlagen_einstellungen). */
export const ARTEFAKT_VORLAGEN_EINSTELLUNGEN = {
  /** Mindestabstand zweier Live-Renderungen je Artefakt und Projekt. */
  drossel_ms: { standard: 15000, min: 1000, max: 600000 },
  /** Ereignisse so lange sammeln, bevor neu gezeichnet wird. */
  buendel_ms: { standard: 2000, min: 0, max: 60000 },
  /** Kappung je Quelle (JSON-Bytes). */
  quelle_max_bytes: { standard: 262144, min: 1024, max: 2000000 },
  /** Frist je Quelle. */
  quelle_timeout_ms: { standard: 3000, min: 200, max: 30000 },
  /** Quellen je Artefakt. */
  max_quellen: { standard: 8, min: 1, max: 20 },
  /** Renderzeit der Vorlage. */
  render_max_ms: { standard: 500, min: 50, max: 5000 },
} as const;
export type ArtefaktVorlagenEinstellung = keyof typeof ARTEFAKT_VORLAGEN_EINSTELLUNGEN;
export type ArtefaktVorlagenWerte = Record<ArtefaktVorlagenEinstellung, number>;
export interface ArtefaktVorlagenEinstellungenStand {
  werte: ArtefaktVorlagenWerte;
  einstellungen: Record<string, { wert: number; quelle: 'standard' | 'einstellung'; min: number; max: number; gesetzt_von?: string; gesetzt_am?: string }>;
  letzter_fehler: string | null;
}

function gueltigeEinstellung(name: string, wert: unknown): number | null {
  const d = ARTEFAKT_VORLAGEN_EINSTELLUNGEN[name as ArtefaktVorlagenEinstellung];
  const n = typeof wert === 'number' ? wert : typeof wert === 'string' && wert.trim() ? Number(wert) : NaN;
  return d && Number.isInteger(n) && n >= d.min && n <= d.max ? n : null;
}

/** Wirksame Einstellungen (PG vor Code-Standard). Lesefehler -> Standard mit letzter_fehler. Wirft nie. */
export async function leseArtefaktVorlagenEinstellungen(): Promise<ArtefaktVorlagenEinstellungenStand> {
  const werte = {} as ArtefaktVorlagenWerte;
  const einstellungen: ArtefaktVorlagenEinstellungenStand['einstellungen'] = {};
  for (const [name, d] of Object.entries(ARTEFAKT_VORLAGEN_EINSTELLUNGEN)) {
    werte[name as ArtefaktVorlagenEinstellung] = d.standard;
    einstellungen[name] = { wert: d.standard, quelle: 'standard', min: d.min, max: d.max };
  }
  const stand: ArtefaktVorlagenEinstellungenStand = { werte, einstellungen, letzter_fehler: null };
  try {
    const r = await getPool().query<{ name: string; wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(
      'SELECT name, wert, gesetzt_von, gesetzt_am FROM artefakt_vorlagen_einstellungen');
    const ungueltig: string[] = [];
    for (const z of r.rows) {
      const w = gueltigeEinstellung(z.name, z.wert);
      if (w === null) { ungueltig.push(z.name); continue; }
      const d = ARTEFAKT_VORLAGEN_EINSTELLUNGEN[z.name as ArtefaktVorlagenEinstellung];
      werte[z.name as ArtefaktVorlagenEinstellung] = w;
      einstellungen[z.name] = { wert: w, quelle: 'einstellung', min: d.min, max: d.max, gesetzt_von: z.gesetzt_von,
        gesetzt_am: z.gesetzt_am instanceof Date ? z.gesetzt_am.toISOString() : String(z.gesetzt_am) };
    }
    if (ungueltig.length) stand.letzter_fehler = 'einstellung_ungueltig: ' + ungueltig.join(', ');
  } catch (error) {
    stand.letzter_fehler = 'einstellungen_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error));
  }
  return stand;
}

/** Einstellungen setzen (nur der User, die Route prueft das). werte {name: zahl|null}; null = Code-Standard. */
export async function setzeArtefaktVorlagenEinstellungen(werte: unknown, grund: unknown, von: string): Promise<ArtefaktVorlagenEinstellungenStand> {
  if (!werte || typeof werte !== 'object' || Array.isArray(werte)) fehler('werte_fehlen', 'werte {name: zahl|null} angeben; erlaubt: ' + Object.keys(ARTEFAKT_VORLAGEN_EINSTELLUNGEN).join(', '));
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < 5) fehler('grund_fehlt', 'grund (mind. 5 Zeichen) angeben');
  const eintraege = Object.entries(werte as Record<string, unknown>);
  for (const [name, wert] of eintraege) {
    const d = ARTEFAKT_VORLAGEN_EINSTELLUNGEN[name as ArtefaktVorlagenEinstellung];
    if (!d) fehler('einstellung_unbekannt', name + ' ist keine Einstellung; erlaubt: ' + Object.keys(ARTEFAKT_VORLAGEN_EINSTELLUNGEN).join(', '));
    if (wert !== null && gueltigeEinstellung(name, wert) === null) fehler('wert_ungueltig', name + ' muss eine Ganzzahl von ' + d.min + ' bis ' + d.max + ' sein');
  }
  const pool = getPool();
  const setzen = eintraege.filter(([, w]) => w !== null).map(([n, w]) => [n, gueltigeEinstellung(n, w)] as const);
  const entfernen = eintraege.filter(([, w]) => w === null).map(([n]) => n);
  if (setzen.length) {
    await pool.query(
      `INSERT INTO artefakt_vorlagen_einstellungen (name, wert, grund, gesetzt_von)
       SELECT n, to_jsonb(w), $3, $4 FROM unnest($1::text[], $2::int[]) AS t(n, w)
       ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW()`,
      [setzen.map(([n]) => n), setzen.map(([, w]) => w), g, von]);
  }
  if (entfernen.length) await pool.query('DELETE FROM artefakt_vorlagen_einstellungen WHERE name = ANY($1::text[])', [entfernen]);
  return leseArtefaktVorlagenEinstellungen();
}

// ---------------------------------------------------------------------------------------------
// Quellenkatalog
// ---------------------------------------------------------------------------------------------
export type QuellArgTyp = 'string' | 'number' | 'boolean';
export interface ArtefaktQuellDefinition {
  vertrag: string;
  beschreibung: string;
  args: Record<string, { typ: QuellArgTyp; pflicht?: boolean; max?: number }>;
  /** NOTIFY-Kanaele, auf die eine Live-Renderung reagiert (Payload traegt project). */
  kanaele: string[];
  /** Reserviert, noch ohne Vertrag (R1: deploy.stand). */
  geplant?: boolean;
  /** max_bytes = wirksame Kappung je Quelle (P22-T165), damit eine Quelle selbst sinnvoll kuerzen kann statt null zu werden. */
  lade?: (k: { project: string; args: Record<string, unknown>; max_bytes?: number }) => Promise<unknown>;
}
export interface ArtefaktQuelle { name: string; vertrag: string; args: Record<string, unknown> }

const KATALOG = new Map<string, ArtefaktQuellDefinition>();

/** Weitere Quelle anmelden (API: agentennetzwerk.snapshot). Gleicher Vertrag ersetzt den alten Eintrag. */
export function registriereArtefaktQuelle(def: ArtefaktQuellDefinition): void {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(def.vertrag)) throw new Error('Vertragsname ungueltig: ' + def.vertrag);
  KATALOG.set(def.vertrag, def);
}

/** Katalog fuer Tool-Antworten und Debug (ohne Ladefunktion). */
export function artefaktQuellenKatalog(): Array<Omit<ArtefaktQuellDefinition, 'lade'>> {
  return [...KATALOG.values()].map(({ lade: _lade, ...rest }) => rest).sort((a, b) => a.vertrag.localeCompare(b.vertrag));
}

const PLAN_ALLE_JE_PLAN = { standard: 300, max: 1000 } as const;
const kurz = (v: unknown, n: number): unknown => (typeof v === 'string' && v.length > n ? v.slice(0, n - 1) + '…' : v);
const iso = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);

registriereArtefaktQuelle({
  vertrag: 'plan.list', beschreibung: 'Plaene des Projekts ohne Tasks (wie plan list): kurz_id, nummer, name, ziel, aktiv, prioritaet, tasks_gesamt/offen/erledigt',
  args: { alle: { typ: 'boolean' } }, kanaele: ['synapse_plan'],
  // P22-T169: nummer = Zahl aus der Kurz-ID (numerisch sortierbar).
  lade: async ({ project, args }) => (await listPlans(project, { alle: args.alle === true })).map((p) => ({ ...p, nummer: planNummer(p.kurz_id) })),
});
registriereArtefaktQuelle({
  vertrag: 'plan.get', beschreibung: 'Ein Plan mit Tasks (ohne plan_id der aktive): id, kurz_id, nummer, name, description, goals, tasks[{kurz_id,nummer,title,status,priority,createdAt,updatedAt}]',
  args: { plan_id: { typ: 'string' }, status: { typ: 'string' } }, kanaele: ['synapse_plan'],
  lade: async ({ project, args }) => {
    const p = await getPlan(project, typeof args.plan_id === 'string' ? args.plan_id : null);
    if (!p) return null;
    const status = typeof args.status === 'string' ? args.status : null;
    const tasks = (p.tasks ?? []).filter((t) => !status || t.status === status).map((t) => {
      const r = t as unknown as Record<string, unknown>;
      return { id: r.id, kurz_id: r.kurz_id ?? null, nummer: taskNummer(r.kurz_id)?.task ?? null, title: r.title, status: r.status, priority: r.priority, createdAt: r.createdAt, updatedAt: r.updatedAt };
    });
    const r = p as unknown as Record<string, unknown>;
    return { id: p.id, kurz_id: r.kurz_id ?? null, nummer: planNummer(r.kurz_id), name: p.name, description: kurz(p.description, 2000), goals: p.goals, aktiv: r.aktiv ?? null,
      createdAt: p.createdAt, updatedAt: p.updatedAt, tasks };
  },
});
registriereArtefaktQuelle({
  vertrag: 'plan.alle', beschreibung: 'Alle Plaene MIT Tasks kompakt: {plaene[{kurz_id,nummer,name,ziel,aktiv,prioritaet,tasks_gesamt,tasks_offen,tasks_erledigt,'
    + 'updated_at,tasks[{kurz_id,nummer,title,status,priority,updatedAt}],tasks_ausgelassen}],gesamt,gekappt,hinweis}. Zu gross: zuerst erledigte Tasks raus, Plaene bleiben',
  args: { alle: { typ: 'boolean' }, offen: { typ: 'boolean' }, status: { typ: 'string' }, max_tasks_je_plan: { typ: 'number', max: PLAN_ALLE_JE_PLAN.max } },
  kanaele: ['synapse_plan'],
  lade: async ({ project, args, max_bytes }) => ladePlanAlle(project, args, max_bytes),
});
registriereArtefaktQuelle({
  vertrag: 'channel.feed', beschreibung: 'Juengste Nachrichten eines Channels (neueste zuerst): id, sender, content (gekuerzt 2000), createdAt',
  args: { channel: { typ: 'string', pflicht: true }, limit: { typ: 'number', max: 100 } }, kanaele: ['synapse_channel'],
  lade: async ({ project, args }) => {
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limit) || 20)));
    const nachrichten = await getChannelMessages(project, String(args.channel), { limit, order: 'desc' });
    return nachrichten.map((m) => {
      const r = m as unknown as Record<string, unknown>;
      return { id: r.id, sender: r.sender, content: kurz(r.content, 2000), createdAt: iso(r.createdAt ?? r.created_at) };
    });
  },
});
registriereArtefaktQuelle({
  vertrag: 'deploy.stand', beschreibung: 'Deploy-Stand (live Commit, Web-UI-Version) - GEPLANT, noch kein lesender Vertrag (P22-T154 R1)',
  args: {}, kanaele: [], geplant: true,
});

// ---------------------------------------------------------------------------------------------
// P22-T165: plan.alle - alle Plaene mit ihren Tasks kompakt (ohne Beschreibung), eigene Kappung
// ---------------------------------------------------------------------------------------------
const PLAN_ALLE_TITEL_MAX = 160;
/** Reserve fuer gesamt/hinweis/debug_quelle neben den Plaenen (die Kappung misst nur plaene). */
const PLAN_ALLE_RESERVE = 2048;
const OFFENE_STATUS = new Set(['todo', 'in_progress', 'blocked']);

export interface PlanAlleTask {
  kurz_id: string | null; /** P22-T169: m aus P<n>-T<m>, ohne Kurz-ID null */ nummer: number | null; id?: string; title: unknown; status: unknown; priority: unknown; updatedAt: unknown; zurueckgestellt_bis?: string;
}
export interface PlanAllePlan {
  kurz_id: string | null; /** P22-T169: n aus P<n> */ nummer: number | null; name: string; ziel: string; aktiv: boolean; prioritaet: string; tasks_gesamt: number; tasks_offen: number;
  tasks_erledigt: number; updated_at: string; zurueckgestellt?: boolean; tasks: PlanAlleTask[]; tasks_ausgelassen: number;
}
export interface PlanAlleErgebnis {
  plaene: PlanAllePlan[];
  gesamt: { plaene: number; tasks: number; ausgelassen: number };
  gekappt: boolean;
  hinweis?: string;
  debug_quelle: { bytes: number; max_bytes: number; filter: Record<string, unknown>; ausgelassen_je_grund: { je_plan: number; kappung: number } };
}

const bytesVon = (v: unknown): number => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');
const zeitVon = (v: unknown): number => { const t = new Date(String(v ?? '')).getTime(); return Number.isNaN(t) ? 0 : t; };

/** Wegfall-Reihenfolge bei Platzmangel (Indizes): erst erledigte (aelteste zuerst), dann offene vom Ende. Rein. */
export function wegfallReihenfolge(tasks: Array<{ status: unknown; updatedAt: unknown }>): number[] {
  const mit = tasks.map((t, i) => ({ t, i }));
  const erledigt = mit.filter((x) => x.t.status === 'done').sort((a, b) => zeitVon(a.t.updatedAt) - zeitVon(b.t.updatedAt) || a.i - b.i).map((x) => x.i);
  const offen = mit.filter((x) => x.t.status !== 'done').map((x) => x.i).reverse();
  return [...erledigt, ...offen];
}

/**
 * P22-T165: alle Plaene (Reihenfolge wie plan list) mit ihren Tasks kompakt. args: alle (auch zurueckgestellte Plaene/Tasks),
 * offen (nur todo/in_progress/blocked), status (genau dieser), max_tasks_je_plan (Standard 300, max 1000). Groesser als
 * maxBytes: projektweit zuerst erledigte Tasks (aelteste zuerst), dann offene vom Ende (niedrigster Plan zuerst); Plaene bleiben.
 */
export async function ladePlanAlle(project: string, args: Record<string, unknown> = {}, maxBytes: number = ARTEFAKT_VORLAGEN_EINSTELLUNGEN.quelle_max_bytes.standard,
  jetzt: Date = new Date()): Promise<PlanAlleErgebnis> {
  const alle = args.alle === true;
  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : null;
  const nurOffen = args.offen === true;
  const jePlan = Math.min(PLAN_ALLE_JE_PLAN.max, Math.max(1, Math.trunc(Number(args.max_tasks_je_plan)) || PLAN_ALLE_JE_PLAN.standard));
  const [{ plaene: liste }, voll] = await Promise.all([listPlansDetail(project, { alle, jetzt }), getAllePlaene(project)]);
  const tasksJePlan = new Map(voll.map((p) => [p.id, p.tasks ?? []]));
  let jePlanWeg = 0;
  const vorher: number[] = [];
  const plaene: PlanAllePlan[] = liste.map((p) => {
    const sichtbar = filtereWiedervorlageTasks(tasksJePlan.get(p.id) ?? [], { alle, jetzt }).tasks;
    const kompakt = sichtbar.map((t) => t as unknown as Record<string, unknown>)
      .filter((t) => (!status || t.status === status) && (!nurOffen || OFFENE_STATUS.has(String(t.status))))
      .map((t): PlanAlleTask => ({
        kurz_id: typeof t.kurz_id === 'string' ? t.kurz_id : null, nummer: taskNummer(t.kurz_id)?.task ?? null, ...(typeof t.kurz_id === 'string' ? {} : { id: String(t.id) }),
        title: kurz(t.title, PLAN_ALLE_TITEL_MAX), status: t.status, priority: t.priority, updatedAt: iso(t.updatedAt),
        ...(t.zurueckgestellt === true && t.zurueckgestellt_bis ? { zurueckgestellt_bis: String(iso(t.zurueckgestellt_bis)) } : {}),
      }));
    vorher.push(kompakt.length);
    let tasks = kompakt;
    if (kompakt.length > jePlan) {
      const weg = new Set(wegfallReihenfolge(kompakt).slice(0, kompakt.length - jePlan));
      tasks = kompakt.filter((_, i) => !weg.has(i));
      jePlanWeg += weg.size;
    }
    const r = p as unknown as Record<string, unknown>;
    return {
      kurz_id: p.kurz_id, nummer: planNummer(p.kurz_id), name: p.name, ziel: p.ziel, aktiv: p.aktiv, prioritaet: p.prioritaet, tasks_gesamt: p.tasks_gesamt,
      tasks_offen: p.tasks_offen, tasks_erledigt: p.tasks_erledigt, updated_at: p.updated_at, ...(r.zurueckgestellt === true ? { zurueckgestellt: true } : {}),
      tasks, tasks_ausgelassen: 0,
    };
  });
  // Kappung: grob abziehen, exakt nachmessen; bis es passt oder keine Task mehr uebrig ist.
  const budget = Math.max(512, maxBytes - PLAN_ALLE_RESERVE);
  let bytes = bytesVon(plaene);
  let kappungWeg = 0;
  if (bytes > budget) {
    const kandidaten = plaene.flatMap((pl, pi) => pl.tasks.map((t, ti) => ({ pi, ti, t, erledigt: t.status === 'done', zeit: zeitVon(t.updatedAt) })));
    kandidaten.sort((a, b) => (a.erledigt === b.erledigt ? 0 : a.erledigt ? -1 : 1)
      || (a.erledigt ? a.zeit - b.zeit || a.pi - b.pi || a.ti - b.ti : b.pi - a.pi || b.ti - a.ti));
    const weg = new Set<PlanAlleTask>();
    let i = 0;
    while (bytes > budget && i < kandidaten.length) {
      let schaetzung = bytes;
      while (schaetzung > budget && i < kandidaten.length) { weg.add(kandidaten[i].t); schaetzung -= bytesVon(kandidaten[i].t) + 1; i++; }
      for (const pl of plaene) pl.tasks = pl.tasks.filter((t) => !weg.has(t));
      bytes = bytesVon(plaene);
    }
    kappungWeg = weg.size;
  }
  plaene.forEach((pl, i) => { pl.tasks_ausgelassen = vorher[i] - pl.tasks.length; });
  const ausgelassen = jePlanWeg + kappungWeg;
  const erg: PlanAlleErgebnis = {
    plaene,
    gesamt: { plaene: plaene.length, tasks: plaene.reduce((n, pl) => n + pl.tasks.length, 0), ausgelassen },
    gekappt: ausgelassen > 0,
    ...(ausgelassen ? { hinweis: ausgelassen + ' Tasks ausgelassen (' + jePlanWeg + ' ueber max_tasks_je_plan ' + jePlan + ', ' + kappungWeg
      + ' wegen Kappung ' + maxBytes + ' Bytes): zuerst erledigte (aelteste zuerst), dann offene vom Ende. Eingrenzen: offen:true, status, max_tasks_je_plan.' } : {}),
    debug_quelle: { bytes: 0, max_bytes: maxBytes, filter: { alle, offen: nurOffen, status, max_tasks_je_plan: jePlan }, ausgelassen_je_grund: { je_plan: jePlanWeg, kappung: kappungWeg } },
  };
  // zweimal: die Zahl selbst aendert die Laenge (0 -> fuenfstellig), danach ist sie stabil.
  erg.debug_quelle.bytes = bytesVon(erg);
  erg.debug_quelle.bytes = bytesVon(erg);
  return erg;
}

const QUELLEN_TEXT_HINWEIS = ' Kommt quellen als Text an, kennt dein MCP-Client das aktuelle Tool-Schema noch nicht (zwischengespeichert'
  + ' vom Sitzungsstart): MCP neu verbinden bzw. Sitzung neu starten, dann geht die Liste als Liste durch.';

/** P22-T160: quellen als JSON-Text -> Liste; kaputter Text oder keine Liste -> quellen_ungueltig mit Hinweis. */
function quellenAusText(text: string): unknown[] {
  let wert: unknown;
  try {
    wert = JSON.parse(text.trim());
  } catch (error) {
    return fehler('quellen_ungueltig', 'quellen kam als Text an und ist kein gueltiges JSON (' + (error instanceof Error ? error.message : String(error))
      + '). Erwartet: Liste [{name, vertrag, args?}].' + QUELLEN_TEXT_HINWEIS);
  }
  if (!Array.isArray(wert)) fehler('quellen_ungueltig', 'quellen kam als Text an, der JSON-Text ist aber keine Liste [{name, vertrag, args?}].' + QUELLEN_TEXT_HINWEIS);
  return wert as unknown[];
}

/** Prueft und normalisiert die Quellenliste eines Artefakts. Wirft ArtefaktVorlagenFehler. */
export function pruefeQuellen(roh: unknown, maxQuellen: number = ARTEFAKT_VORLAGEN_EINSTELLUNGEN.max_quellen.standard): ArtefaktQuelle[] {
  if (roh === undefined || roh === null) return [];
  // P22-T160: als JSON-Text gleichwertig zur Liste (MCP-Client mit Tool-Schema von vor dem Deploy reicht quellen als String).
  if (typeof roh === 'string') roh = quellenAusText(roh);
  if (!Array.isArray(roh)) fehler('quellen_ungueltig', 'quellen muss eine Liste [{name, vertrag, args?}] sein');
  const liste = roh as unknown[];
  if (liste.length > maxQuellen) fehler('quellen_zu_viele', 'hoechstens ' + maxQuellen + ' Quellen je Artefakt');
  const namen = new Set<string>();
  return liste.map((q, i) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) fehler('quellen_ungueltig', 'Quelle ' + i + ' ist kein Objekt');
    const o = q as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) fehler('quellen_ungueltig', 'Quelle ' + i + ': name (Buchstabe, dann Buchstaben/Ziffern/_; max 40) fehlt oder ist ungueltig');
    if (namen.has(name)) fehler('quellen_ungueltig', 'Quellname doppelt: ' + name);
    namen.add(name);
    const vertrag = typeof o.vertrag === 'string' ? o.vertrag.trim() : '';
    const def = KATALOG.get(vertrag);
    if (!def) fehler('quelle_unbekannt', 'Vertrag "' + vertrag + '" gibt es nicht; erlaubt: ' + [...KATALOG.keys()].filter((k) => !KATALOG.get(k)?.geplant).join(', '));
    if (def!.geplant) fehler('quelle_geplant', 'Vertrag "' + vertrag + '" ist reserviert, aber noch nicht gebaut');
    const argsRoh = o.args === undefined || o.args === null ? {} : o.args;
    if (typeof argsRoh !== 'object' || Array.isArray(argsRoh)) fehler('quellen_ungueltig', 'Quelle ' + name + ': args muss ein Objekt sein');
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(argsRoh as Record<string, unknown>)) {
      if (k === 'project') fehler('quellen_ungueltig', 'Quelle ' + name + ': project ist kein Argument, es wird beim Rendern eingesetzt');
      const a = def!.args[k];
      if (!a) fehler('quellen_ungueltig', 'Quelle ' + name + ': Argument ' + k + ' unbekannt; erlaubt: ' + (Object.keys(def!.args).join(', ') || 'keine'));
      if (typeof v !== a.typ) fehler('quellen_ungueltig', 'Quelle ' + name + ': ' + k + ' muss ' + a.typ + ' sein');
      if (a.typ === 'number' && a.max !== undefined && (v as number) > a.max) fehler('quellen_ungueltig', 'Quelle ' + name + ': ' + k + ' hoechstens ' + a.max);
      if (a.typ === 'string' && String(v).length > 200) fehler('quellen_ungueltig', 'Quelle ' + name + ': ' + k + ' zu lang');
      args[k] = v;
    }
    for (const [k, a] of Object.entries(def!.args)) if (a.pflicht && args[k] === undefined) fehler('quellen_ungueltig', 'Quelle ' + name + ': Argument ' + k + ' ist Pflicht');
    return { name, vertrag, args };
  });
}

/** Kanaele, auf die ein Artefakt live reagiert. */
export function kanaeleFuerQuellen(quellen: ArtefaktQuelle[]): string[] {
  return [...new Set(quellen.flatMap((q) => KATALOG.get(q.vertrag)?.kanaele ?? []))];
}

export interface QuellStand { name: string; vertrag: string; ms: number; bytes: number; gekappt: boolean; fehler: string | null }

async function mitFrist<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('Frist ' + ms + ' ms ueberschritten')), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

function kappe(wert: unknown, max: number): { wert: unknown; bytes: number; gekappt: boolean; fehler: string | null } {
  const groesse = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');
  const bytes = groesse(wert);
  if (bytes <= max) return { wert, bytes, gekappt: false, fehler: null };
  if (!Array.isArray(wert)) return { wert: null, bytes, gekappt: true, fehler: 'Ergebnis groesser als ' + max + ' Bytes' };
  let lo = 0, hi = wert.length;
  while (lo < hi) { const mitte = Math.ceil((lo + hi) / 2); if (groesse(wert.slice(0, mitte)) <= max) lo = mitte; else hi = mitte - 1; }
  const teil = wert.slice(0, lo);
  return { wert: teil, bytes: groesse(teil), gekappt: true, fehler: null };
}

/** Laedt alle Quellen fuer ein Projekt. Fehler einer Quelle -> Wert null + fehler im Stand (die anderen laufen weiter). */
export async function ladeQuellen(quellen: ArtefaktQuelle[], project: string, w: ArtefaktVorlagenWerte): Promise<{ daten: Record<string, unknown>; stand: QuellStand[] }> {
  const daten: Record<string, unknown> = {};
  const stand = await Promise.all(quellen.map(async (q): Promise<QuellStand> => {
    const start = Date.now();
    const def = KATALOG.get(q.vertrag);
    try {
      if (!def?.lade) throw new Error(def?.geplant ? 'Vertrag ' + q.vertrag + ' ist noch nicht gebaut' : 'Vertrag ' + q.vertrag + ' unbekannt');
      const k = kappe(await mitFrist(def.lade({ project, args: q.args, max_bytes: w.quelle_max_bytes }), w.quelle_timeout_ms), w.quelle_max_bytes);
      daten[q.name] = k.wert;
      return { name: q.name, vertrag: q.vertrag, ms: Date.now() - start, bytes: k.bytes, gekappt: k.gekappt, fehler: k.fehler };
    } catch (error) {
      daten[q.name] = null;
      return { name: q.name, vertrag: q.vertrag, ms: Date.now() - start, bytes: 0, gekappt: false, fehler: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { daten, stand };
}

// ---------------------------------------------------------------------------------------------
// Rechte
// ---------------------------------------------------------------------------------------------
export type ArtefaktBetrachter =
  | { art: 'user' }
  | { art: 'agent'; identity_id: string | null; agent_id: string | null; project: string; main: boolean };

export function darfProjekt(b: ArtefaktBetrachter, project: string): boolean {
  return b.art === 'user' || b.main || b.project === project;
}

// ---------------------------------------------------------------------------------------------
// Zeilen
// ---------------------------------------------------------------------------------------------
export interface VorlagenZeile {
  id: string; title: string | null; html: string; revision: number; session_id: string | null; created_by: string | null;
  created_by_identity_id: string | null; vorlage: string | null; quellen: ArtefaktQuelle[] | null; modus: ArtefaktModus;
  standard_project: string | null; updated_at: Date;
}
// to_jsonb(a): funktioniert auch vor Schema 152 (fehlende Spalten = null), z. B. in Tests mit LIKE-Kopien.
const ZEILE_SQL = `SELECT a.id::text AS id, a.title, a.html, a.revision, a.session_id::text AS session_id, a.created_by,
  to_jsonb(a)->>'created_by_identity_id' AS created_by_identity_id, to_jsonb(a)->>'vorlage' AS vorlage, to_jsonb(a)->'quellen' AS quellen,
  COALESCE(to_jsonb(a)->>'modus', 'fest') AS modus, to_jsonb(a)->>'standard_project' AS standard_project, a.updated_at
  FROM agent_artifacts a WHERE a.id = $1::uuid`;

export async function ladeVorlagenZeile(id: string): Promise<VorlagenZeile | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await getPool().query<VorlagenZeile>(ZEILE_SQL, [id]);
  return r.rows[0] ?? null;
}

export interface RenderungZeile {
  artefakt_id: string; project: string; revision: number; html: string; daten_hash: string; quellen_stand: QuellStand[];
  fehler: string[]; gerendert_von: string | null; gerendert_am: Date;
}
async function ladeRenderung(id: string, project: string): Promise<RenderungZeile | null> {
  const r = await getPool().query<RenderungZeile>(
    'SELECT artefakt_id::text AS artefakt_id, project, revision, html, daten_hash, quellen_stand, fehler, gerendert_von, gerendert_am FROM artefakt_renderungen WHERE artefakt_id = $1::uuid AND project = $2',
    [id, project]);
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Speichern
// ---------------------------------------------------------------------------------------------
export interface VorlagenEingabe {
  artefaktId?: string | null;
  /** Main-Weg: Session der Hauptagenten-Verbindung (Ersetzen erlaubt bei gleicher Session). */
  sessionId?: string | null;
  /** Ausweis-Weg: Urheber-Identitaet (Ersetzen erlaubt bei gleicher Identitaet). */
  ownerIdentityId: string | null;
  createdBy: string | null;
  titel?: string | null;
  html?: string | null;
  vorlage?: string | null;
  quellen?: unknown;
  modus?: unknown;
  project?: string | null;
  column?: number | null; columnSpan?: number | null; row?: number | null; rowSpan?: number | null; minHeight?: number | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Legt ein Artefakt an oder ersetzt es (artefaktId). Mit vorlage: Schalter artefakt_vorlagen muss EIN sein, Vorlage und Quellen
 * werden geprueft, modus Standard 'stand'. Nur html: modus 'fest' (Bestand), eine vorhandene Vorlage wird entfernt.
 */
export async function speichereVorlagenArtefakt(e: VorlagenEingabe): Promise<VorlagenZeile> {
  const vorlage = typeof e.vorlage === 'string' && e.vorlage.trim() ? e.vorlage : null;
  const html = typeof e.html === 'string' && e.html.trim() ? e.html : null;
  if (!vorlage && !html) fehler('html_oder_vorlage', 'html (fertiger Block) oder vorlage (mit quellen) angeben');
  if (vorlage && html) fehler('html_und_vorlage', 'entweder html oder vorlage, nicht beides');
  let quellen: ArtefaktQuelle[] | null = null;
  let modus: ArtefaktModus = 'fest';
  if (vorlage) {
    const s = await artefaktVorlagenSchalter();
    if (!s.aktiv) fehler('funktion_aus', 'Vorlagen sind aus (Produkt-Schalter artefakt_vorlagen)', 409);
    if (vorlage.length > ARTEFAKT_HTML_MAX) fehler('vorlage_zu_gross', 'vorlage hoechstens ' + ARTEFAKT_HTML_MAX + ' Zeichen');
    const syntax = pruefeVorlage(vorlage);
    if (syntax) fehler('vorlage_ungueltig', syntax);
    quellen = pruefeQuellen(e.quellen, (await leseArtefaktVorlagenEinstellungen()).werte.max_quellen);
    modus = e.modus === undefined || e.modus === null ? 'stand' : (ARTEFAKT_MODI as readonly unknown[]).includes(e.modus) ? e.modus as ArtefaktModus
      : fehler('modus_ungueltig', 'modus: fest, stand oder live');
    if (modus === 'fest') fehler('modus_ungueltig', 'eine Vorlage braucht modus stand oder live');
  } else {
    if (html!.length > ARTEFAKT_HTML_MAX) fehler('html_zu_gross', 'html hoechstens ' + ARTEFAKT_HTML_MAX + ' Zeichen');
    if (e.modus !== undefined && e.modus !== null && e.modus !== 'fest') fehler('modus_ohne_vorlage', 'stand/live gibt es nur mit vorlage');
  }
  const project = text(e.project);
  const raster = [e.column ?? null, e.columnSpan ?? null, e.row ?? null, e.rowSpan ?? null, e.minHeight ?? null];
  const pool = getPool();
  if (e.artefaktId) {
    const alt = await ladeVorlagenZeile(e.artefaktId);
    if (!alt) fehler('artefakt_unbekannt', 'artefakt_id ' + e.artefaktId + ' existiert nicht - fuer ein neues Artefakt artefakt_id weglassen', 404);
    const urheber = (!!e.sessionId && alt!.session_id === e.sessionId) || (!!e.ownerIdentityId && alt!.created_by_identity_id === e.ownerIdentityId);
    if (!urheber) fehler('nicht_urheber', 'Ersetzen darf nur der Urheber (Identitaet) bzw. die Main-Session; neu zeichnen darf jeder mit Leserecht', 403);
    const r = await pool.query<{ id: string }>(
      `UPDATE agent_artifacts SET html = COALESCE($2, html), vorlage = $3, quellen = $4::jsonb, modus = $5,
              standard_project = COALESCE($6, standard_project), title = COALESCE($7, title),
              column_pos = COALESCE($8, column_pos), column_span = COALESCE($9, column_span), row_pos = COALESCE($10, row_pos),
              row_span = COALESCE($11, row_span), min_height = COALESCE($12, min_height), revision = revision + 1, updated_at = NOW()
        WHERE id = $1::uuid RETURNING id::text AS id`,
      [e.artefaktId, html, vorlage, quellen ? JSON.stringify(quellen) : null, modus, project, text(e.titel), ...raster]);
    if (vorlage) await pool.query('DELETE FROM artefakt_renderungen WHERE artefakt_id = $1::uuid', [e.artefaktId]);
    return (await ladeVorlagenZeile(r.rows[0].id))!;
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO agent_artifacts (id, session_id, title, html, column_pos, column_span, row_pos, row_span, min_height, created_by,
                                  created_by_identity_id, vorlage, quellen, modus, standard_project)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)`,
    [id, e.sessionId ?? null, text(e.titel), html ?? '<p>Artefakt wird gezeichnet …</p>', ...raster, e.createdBy, e.ownerIdentityId,
      vorlage, quellen ? JSON.stringify(quellen) : null, modus, project]);
  return (await ladeVorlagenZeile(id))!;
}

// ---------------------------------------------------------------------------------------------
// Rendern
// ---------------------------------------------------------------------------------------------
export type RenderAnlass = 'anzeigen' | 'neu_zeichnen' | 'live' | 'zeigen';
export interface ArtefaktRenderErgebnis {
  artefakt_id: string;
  project: string | null;
  modus: ArtefaktModus;
  vorlage: boolean;
  revision: number;
  html: string;
  titel: string | null;
  gerendert_am: string;
  /** true = in diesem Aufruf neu gezeichnet und gespeichert. */
  neu: boolean;
  fehler: string[];
  hinweis?: string;
  debug?: Record<string, unknown>;
}

function datenHash(vorlage: string, daten: Record<string, unknown>): string {
  return createHash('sha256').update(vorlage).update('\u0000').update(JSON.stringify(daten)).digest('hex');
}

/**
 * Rendert ein Artefakt fuer ein Projekt mit den Rechten des Betrachters. Ohne Vorlage: das fertige HTML (Bestand).
 * anzeigen: stand -> vorhandene Momentaufnahme (sonst erste Renderung); live -> neu, wenn die letzte aelter als die Drossel ist.
 * neu_zeichnen: immer neu (Schalter artefakt_vorlagen EIN). live: neu nur bei geaenderten Daten. Wirft ArtefaktVorlagenFehler.
 * P22-T169: ausloeser (Live-Dienst: Kanaele, ops, ids der gesammelten NOTIFYs) steht im debug, damit der Anlass sichtbar ist.
 */
export async function renderArtefakt(id: string, o: { project?: string | null; betrachter: ArtefaktBetrachter; anlass: RenderAnlass; jetzt?: Date; von?: string | null;
  ausloeser?: Record<string, unknown> | null }): Promise<ArtefaktRenderErgebnis> {
  const row = await ladeVorlagenZeile(id);
  if (!row) fehler('artefakt_unbekannt', 'Artefakt ' + id + ' gibt es nicht', 404);
  const z = row!;
  const basis = { artefakt_id: z.id, modus: z.modus, titel: z.title };
  if (!z.vorlage) {
    return { ...basis, project: z.standard_project, vorlage: false, revision: z.revision, html: z.html, gerendert_am: new Date(z.updated_at).toISOString(), neu: false, fehler: [] };
  }
  const schalter = await artefaktVorlagenSchalter();
  const project = text(o.project) ?? z.standard_project ?? (o.betrachter.art === 'agent' ? o.betrachter.project : null);
  if (!project) fehler('projekt_fehlt', 'project angeben (das Artefakt hat kein Standardprojekt)');
  if (!darfProjekt(o.betrachter, project!)) fehler('projekt_fremd', 'Rendern nur im eigenen Projekt (Ausweis); fremdes Projekt: ' + project, 403);
  const vorhanden = await ladeRenderung(z.id, project!);
  const ausVorhanden = (hinweis?: string, extra: Record<string, unknown> = {}): ArtefaktRenderErgebnis => ({
    ...basis, project, vorlage: true, revision: vorhanden!.revision, html: vorhanden!.html, gerendert_am: new Date(vorhanden!.gerendert_am).toISOString(),
    neu: false, fehler: vorhanden!.fehler ?? [], ...(hinweis ? { hinweis } : {}),
    ...(schalter.aktiv ? { debug: { quellen: vorhanden!.quellen_stand, daten_hash: vorhanden!.daten_hash, schalter_quelle: schalter.quelle, anlass: o.anlass, ...(o.ausloeser ? { ausloeser: o.ausloeser } : {}), wiederverwendet: true, ...extra } } : {}),
  });
  if (!schalter.aktiv) {
    if (o.anlass === 'neu_zeichnen' || o.anlass === 'live') fehler('funktion_aus', 'Vorlagen sind aus (Produkt-Schalter artefakt_vorlagen)', 409);
    if (vorhanden) return ausVorhanden('Produkt-Schalter artefakt_vorlagen AUS: letzte Momentaufnahme');
    return { ...basis, project, vorlage: true, revision: z.revision, html: z.html, gerendert_am: new Date(z.updated_at).toISOString(), neu: false, fehler: [],
      hinweis: 'Produkt-Schalter artefakt_vorlagen AUS: letzte gespeicherte Renderung (Standardprojekt)' };
  }
  const w = (await leseArtefaktVorlagenEinstellungen()).werte;
  const jetzt = o.jetzt ?? new Date();
  const alter = vorhanden ? jetzt.getTime() - new Date(vorhanden.gerendert_am).getTime() : Infinity;
  if (vorhanden && o.anlass === 'anzeigen' && (z.modus === 'stand' || alter < w.drossel_ms)) return ausVorhanden();
  if (vorhanden && o.anlass === 'live' && alter < w.drossel_ms) return ausVorhanden('gedrosselt', { drossel_bis: new Date(new Date(vorhanden.gerendert_am).getTime() + w.drossel_ms).toISOString() });
  const geladen = await ladeQuellen(z.quellen ?? [], project!, w);
  const hash = datenHash(z.vorlage, geladen.daten);
  if (vorhanden && vorhanden.daten_hash === hash && o.anlass !== 'neu_zeichnen') return ausVorhanden(undefined, { gleiche_daten: true });
  const daten = { ...geladen.daten, _meta: { project, artefakt_id: z.id, titel: z.title, modus: z.modus, standard_project: z.standard_project, gerendert_am: jetzt.toISOString() } };
  const erg = renderVorlage(z.vorlage, daten, { jetzt, max_ms: w.render_max_ms });
  const html = erg.html.length > ARTEFAKT_HTML_MAX ? erg.html.slice(0, ARTEFAKT_HTML_MAX) : erg.html;
  const pool = getPool();
  const r = await pool.query<{ revision: number; gerendert_am: Date }>(
    `INSERT INTO artefakt_renderungen (artefakt_id, project, revision, html, daten_hash, quellen_stand, fehler, gerendert_von, gerendert_am)
     VALUES ($1::uuid, $2, 1, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     ON CONFLICT (artefakt_id, project) DO UPDATE SET
       revision = CASE WHEN artefakt_renderungen.html = EXCLUDED.html THEN artefakt_renderungen.revision ELSE artefakt_renderungen.revision + 1 END,
       html = EXCLUDED.html, daten_hash = EXCLUDED.daten_hash, quellen_stand = EXCLUDED.quellen_stand, fehler = EXCLUDED.fehler,
       gerendert_von = EXCLUDED.gerendert_von, gerendert_am = EXCLUDED.gerendert_am
     RETURNING revision, gerendert_am`,
    [z.id, project, html, hash, JSON.stringify(geladen.stand), JSON.stringify(erg.fehler), o.von ?? o.anlass, jetzt]);
  const revision = r.rows[0].revision;
  if (!z.standard_project || z.standard_project === project) {
    await pool.query(
      `UPDATE agent_artifacts SET html = $2, standard_project = COALESCE(standard_project, $3),
              revision = CASE WHEN html = $2 THEN revision ELSE revision + 1 END, updated_at = NOW() WHERE id = $1::uuid`,
      [z.id, html, project]);
  }
  await aktualisiereVerlaufArtefakt(z.id, project!, { html, revision, gerendert_am: jetzt.toISOString() }).catch(() => 0);
  return {
    ...basis, project, vorlage: true, revision, html, gerendert_am: jetzt.toISOString(), neu: true, fehler: erg.fehler,
    debug: { quellen: geladen.stand, daten_hash: hash, schalter_quelle: schalter.quelle, render_ms: erg.statistik.ms, gekappt: erg.statistik.gekappt, anlass: o.anlass, ...(o.ausloeser ? { ausloeser: o.ausloeser } : {}), wiederverwendet: false },
  };
}

// ---------------------------------------------------------------------------------------------
// Zustellung in den eigenen Verlauf (Koordinator-Fenster, R7: Spalte artefakte)
// ---------------------------------------------------------------------------------------------
export interface VerlaufArtefakt { id: string; title: string | null; html: string; revision: number; modus: ArtefaktModus; project: string | null; vorlage: boolean; gerendert_am?: string }

/**
 * Legt das Artefakt als Verlaufszeile der Identitaet ab (rolle ausgabe, weg lauf, quelle_ref artefakt:<id>); ein zweites zeigen
 * desselben Artefakts aktualisiert die Zeile (rev steigt, das Fenster holt sie per seit_rev an Ort und Stelle). Schalter
 * hauptagent_verlauf AUS -> null. Wirft nie.
 */
export async function stelleArtefaktInVerlauf(identity_id: string, a: VerlaufArtefakt): Promise<{ verlauf_id: string | null; neu_angelegt?: boolean; erstellt_am?: string; hinweis?: string }> {
  try {
    if (!(await leseVerlaufSchalter()).aktiv) return { verlauf_id: null, hinweis: 'Verlauf ist aus (Schalter hauptagent_verlauf) - nur in Persoenliche Artefakte' };
    const eintrag = { id: a.id, html: a.html, revision: a.revision, ...(a.title ? { title: a.title } : {}), modus: a.modus, vorlage: a.vorlage,
      ...(a.project ? { project: a.project } : {}), ...(a.gerendert_am ? { gerendert_am: a.gerendert_am } : {}) };
    const r = await getPool().query<{ id: string; neu: boolean; erstellt_am: Date }>(
      `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, quelle_ref, status, text, artefakte, meta)
       VALUES ($1, 'ausgabe', 'aus', 'lauf', $2, 'fertig', '', $3::jsonb, $4::jsonb)
       ON CONFLICT (identity_id, quelle_ref) DO UPDATE SET artefakte = EXCLUDED.artefakte, meta = EXCLUDED.meta,
         rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
       RETURNING id::text AS id, (xmax = 0) AS neu, erstellt_am`,
      [identity_id, 'artefakt:' + a.id, JSON.stringify([eintrag]), JSON.stringify({ artefakt_id: a.id, project: a.project })]);
    const z = r.rows[0];
    // P22-T169: neu_angelegt/erstellt_am sagen dem Aufrufer, ob die Einbettung neu unten steht oder an ihrem alten Platz ersetzt wurde.
    return { verlauf_id: z?.id ?? null, ...(z ? { neu_angelegt: z.neu === true, erstellt_am: new Date(z.erstellt_am).toISOString() } : {}) };
  } catch (error) {
    return { verlauf_id: null, hinweis: 'Verlaufszeile nicht geschrieben: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * P22-T169 (User-Befund 26.10.2026, thought c4858305): kurze Zeile im Verlauf des Absenders zu einem Artefakt - 'aktualisiert' beim
 * Ersetzen (die Einbettung bleibt an ihrem Platz und zeichnet live neu) bzw. 'fehler', wenn das Ersetzen scheitert. Jede Meldung ist
 * eine eigene Zeile (quelle_ref artefakt-meldung:<id>:<uuid>), damit sie unten im Chat erscheint; aktualisiereVerlaufArtefakt
 * trifft sie nicht (kein HTML-Ballast). Schalter hauptagent_verlauf AUS -> verlauf_id null mit Hinweis. Wirft nie.
 */
export async function meldeArtefaktImVerlauf(identity_id: string, m: { artefakt_id: string; art: 'aktualisiert' | 'fehler'; text: string;
  titel?: string | null; revision?: number | null; project?: string | null; einbettung_verlauf_id?: string | null }): Promise<{ verlauf_id: string | null; hinweis?: string }> {
  try {
    if (!(await leseVerlaufSchalter()).aktiv) return { verlauf_id: null, hinweis: 'Verlauf ist aus (Schalter hauptagent_verlauf) - keine Zeile ' + m.art + ' im Chat' };
    const meta = { artefakt_id: m.artefakt_id, artefakt_meldung: m.art, ...(m.titel ? { titel: m.titel } : {}), ...(m.revision != null ? { revision: m.revision } : {}),
      ...(m.project ? { project: m.project } : {}), ...(m.einbettung_verlauf_id ? { einbettung_verlauf_id: m.einbettung_verlauf_id } : {}) };
    const r = await getPool().query<{ id: string }>(
      `INSERT INTO hauptagent_verlauf (identity_id, rolle, richtung, weg, quelle_ref, status, text, artefakte, meta)
       VALUES ($1, 'ausgabe', 'aus', 'lauf', $2, $3, $4, '[]'::jsonb, $5::jsonb) RETURNING id::text AS id`,
      [identity_id, 'artefakt-meldung:' + m.artefakt_id + ':' + randomUUID(), m.art === 'fehler' ? 'fehler' : 'fertig', m.text, JSON.stringify(meta)]);
    return { verlauf_id: r.rows[0]?.id ?? null };
  } catch (error) {
    return { verlauf_id: null, hinweis: 'Meldung ' + m.art + ' nicht in den Verlauf geschrieben: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

/** Neue Renderung in alle Verlaufszeilen dieses Artefakts (gleiches Projekt) eintragen; rev steigt. Rueckgabe: Anzahl. */
export async function aktualisiereVerlaufArtefakt(id: string, project: string, neu: { html: string; revision: number; gerendert_am: string }): Promise<number> {
  const r = await getPool().query(
    `UPDATE hauptagent_verlauf SET artefakte = (SELECT COALESCE(jsonb_agg(CASE WHEN e->>'id' = $1 THEN e || $3::jsonb ELSE e END), '[]'::jsonb)
                                                FROM jsonb_array_elements(artefakte) e),
            rev = nextval('hauptagent_verlauf_rev'), aktualisiert_am = NOW()
      WHERE quelle_ref = 'artefakt:' || $1 AND COALESCE(meta->>'project', '') = $2`,
    [id, project, JSON.stringify(neu)]);
  return r.rowCount ?? 0;
}

/** Fuer die Liste: welche Projekte haben schon eine Renderung (Auswahlfeld, R4). */
export async function renderungsProjekte(id: string): Promise<Array<{ project: string; revision: number; gerendert_am: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
  const r = await getPool().query<{ project: string; revision: number; gerendert_am: Date }>(
    'SELECT project, revision, gerendert_am FROM artefakt_renderungen WHERE artefakt_id = $1::uuid ORDER BY gerendert_am DESC', [id]);
  return r.rows.map((x) => ({ project: x.project, revision: x.revision, gerendert_am: new Date(x.gerendert_am).toISOString() }));
}
