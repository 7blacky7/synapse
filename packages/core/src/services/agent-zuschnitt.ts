/**
 * P22-T13 Paket C: EIN Resolver fuer das wirksame Profil und die gemeinsame Antwortpipeline (REST + stdio).
 *
 * RESOLVER (K15.6/K16.6): Standard -> globaler Typ -> Projekttyp -> Profil-Override (agent_identitaeten.profil),
 * je Top-Level-Feld ersetzt, Herkunft je Feld (gleiche Vererbung wie leseWirksamenTypInhalt aus Paket A, hier in
 * EINER PG-Abfrage zusammen mit der aktuellen Profilrevision - K16.8). Kein Cache: jede Aenderung wirkt beim
 * naechsten Aufruf, auch ueber mehrere API-Prozesse. Fehler = Ablehnung, nie 'kein Profil'.
 * Legacy- und ID-Pfad: Legacy-Aufrufe (ohne Token) haben keinen Snapshot und behalten unveraendert ihre
 * bisherigen Filter (kontextprofil_* / ausloeser_hinweis_profile, project(hinweise)). Fuer Token-Identitaeten
 * gelten diese Legacy-Filter WEITER (ausloeser_hinweis_profile mit exact_identity_id bzw. Namensmuster) und
 * zusaetzlich das ID-Profil; eine Art erscheint nur, wenn beide sie erlauben (restriktiv, keine automatische
 * Identitaetsuebernahme durch Namensgleichheit). Ohne aktives Profil (profil_revision 0, kein Typ) = heutiges Verhalten.
 *
 * PIPELINE (K16.4): 1 Transport-Auth/Originalargumente (Transport) -> 2 F3 + EIN Gate (agent-token-tools) ->
 * 3 Fachhandler -> 4 Antworthuellen/Hooks; optionale Produzenten fragen hinweisAktiv() VOR Suche/Claim ->
 * 5 Audit/tool_calls mit dem vollstaendigen Ergebnis (Transport, vor der Projektion) -> 6 projiziereToolAntwort:
 * nur die Agentenauslieferung (neues Objekt, keine Mutation des auditierten Ergebnisses), Pflichtanteile bleiben,
 * Kuerzung (Mengenparameter VOR dem Handler) erkennbar mit Nachladeweg in antwort_zuschnitt.
 * Reverse wird in der API einmal verarbeitet; stdio reicht das fertige Ergebnis ohne zweiten Durchlauf durch.
 *
 * Alles hinter W1b-Schaltern: Gate nur bei w1b_durchsetzung, Hinweise/Projektion/Limits nur bei
 * w1b_antwortanpassung (Standard AUS -> projiziereToolAntwort gibt das Eingangsobjekt unveraendert zurueck).
 */
import { performance } from 'node:perf_hooks';
import { getPool } from '../db/client.js';
import type { IdentitaetsAgentPrincipal } from './agent-bezug.js';
import {
  registriereZuschnittResolver, type WirksamesProfil, type ProfilInhalt, type FeldHerkunft, type W1bAkteur,
  type AntwortpipelineEingabe,
} from './agent-profil-vertrag.js';
import type { ToolZuschnitt, ZugriffsRegel } from './tool-gate.js';
import {
  setzeZuschnittSnapshot, aktuellerZuschnittSnapshot, hinweisAktiv, merkeZuschnittMessung, hinweisBudgetMs,
  type ZuschnittSnapshot, type ZuschnittStufe,
} from './agent-zuschnitt-kontext.js';
import { HINWEIS_KATALOG, pflichtAnteil } from './hinweis-katalog.js';

export class ZuschnittFehler extends Error {
  constructor(public readonly code: string) { super(code); }
}

interface ProfilZeile {
  id: string;
  project: string;
  profil: Record<string, unknown> | null;
  profil_revision: number;
  typ_id: string | null;
  typ_revision: number | null;
  scope: 'global' | 'projekt' | null;
  schluessel: string | null;
  aktuelle_revision: number | null;
  typ_inhalt: Record<string, unknown> | null;
  global_inhalt: Record<string, unknown> | null;
}

const PROFIL_SQL = `SELECT i.id, i.project, i.profil, i.profil_revision, i.typ_id, i.typ_revision,
    t.scope, t.schluessel, t.aktuelle_revision, tr.inhalt AS typ_inhalt, gr.inhalt AS global_inhalt
  FROM agent_identitaeten i
  LEFT JOIN agent_typen t ON t.id = i.typ_id
  LEFT JOIN agent_typ_revisionen tr ON tr.typ_id = t.id AND tr.revision = COALESCE(i.typ_revision, t.aktuelle_revision)
  LEFT JOIN agent_typen g ON t.scope = 'projekt' AND g.scope = 'global' AND g.schluessel = t.schluessel AND g.status = 'aktiv'
  LEFT JOIN agent_typ_revisionen gr ON gr.typ_id = g.id AND gr.revision = g.aktuelle_revision
  WHERE i.id = $1`;

const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function regel(v: unknown, feld: string): ZugriffsRegel | undefined {
  if (v === undefined) return undefined;
  if (v === 'erlaubt' || v === 'verweigert') return v;
  throw new ZuschnittFehler('zuschnitt_ungueltig:' + feld);
}

function regelMap(m: unknown, feld: string): Record<string, ZugriffsRegel> | undefined {
  if (m === undefined) return undefined;
  if (!istObjekt(m)) throw new ZuschnittFehler('zuschnitt_ungueltig:' + feld);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, regel(v, feld + '.' + k) as ZugriffsRegel]));
}

/** Zuschnitt fuer das Gate; ungueltige Regelwerte lehnen ab (fail-closed), statt still zu erlauben. */
function zuschnittAus(w: ProfilInhalt, revision: string, quelle: string | undefined): ToolZuschnitt | null {
  const z = w.zuschnitt as unknown;
  if (z === undefined || z === null) return null;
  if (!istObjekt(z)) throw new ZuschnittFehler('zuschnitt_ungueltig');
  const standard = regel(z.standard, 'standard');
  const tools = regelMap(z.tools, 'tools');
  const aktionen = regelMap(z.aktionen, 'aktionen');
  const iu = z.intern_user_festgelegt;
  const intern = istObjekt(iu) && typeof iu.user_auftrag === 'string' && iu.user_auftrag.trim() !== '';
  return { revision, ...(quelle ? { quelle } : {}), ...(standard ? { standard } : {}), ...(tools ? { tools } : {}),
    ...(aktionen ? { aktionen } : {}), intern_user_festgelegt: intern };
}

/**
 * Wirksames Profil (Vertrag ProfilDienst.leseWirksamesProfil). Eine PG-Abfrage, konsistenter Snapshot aus
 * Profil-Override, aktueller Profilrevision und (Projekt-/globaler) Typrevision. Akteur nur Signaturtreue:
 * Lesen fuer die eigene Pipeline braucht keine Verwaltungsrechte; Verwaltungsdiagnosen pruefen Paket D.
 */
export async function leseWirksamesProfil(identity_id: string, _akteur?: W1bAkteur): Promise<WirksamesProfil> {
  const r = await getPool().query<ProfilZeile>({ text: PROFIL_SQL, values: [identity_id], query_timeout: 2000 } as
    import('pg').QueryConfig & { query_timeout: number });
  const z = r.rows[0];
  if (!z) throw new ZuschnittFehler('identitaet_unbekannt');
  if (z.typ_id && !z.typ_inhalt) throw new ZuschnittFehler('typ_revision_unbekannt');
  const werte: Record<string, unknown> = {};
  const herkunft: Record<string, FeldHerkunft> = {};
  const anwenden = (quelle: Record<string, unknown> | null, h: FeldHerkunft) => {
    if (!istObjekt(quelle)) return;
    for (const [k, v] of Object.entries(quelle)) { werte[k] = v; herkunft[k] = h; }
  };
  if (z.scope === 'projekt') anwenden(z.global_inhalt, 'global_typ');
  anwenden(z.typ_inhalt, z.scope === 'global' ? 'global_typ' : 'projekt_typ');
  anwenden(z.profil, 'profil');
  const typRevision = z.typ_id ? (z.typ_revision ?? z.aktuelle_revision ?? 0) : null;
  const revision = `${z.id}:${z.profil_revision}:${z.typ_id ?? '-'}:${typRevision ?? 0}`;
  const inhalt = werte as ProfilInhalt;
  return {
    identity_id: z.id, project: z.project, profil_revision: z.profil_revision,
    typ: z.typ_id && z.scope && z.schluessel ? { id: z.typ_id, schluessel: z.schluessel, scope: z.scope, revision: typRevision ?? 0 } : null,
    werte: inhalt, herkunft: herkunft as WirksamesProfil['herkunft'],
    zuschnitt: zuschnittAus(inhalt, revision, herkunft.zuschnitt),
  };
}

function profilRevisionText(p: WirksamesProfil): string {
  return `${p.identity_id}:${p.profil_revision}:${p.typ?.id ?? '-'}:${p.typ?.revision ?? 0}`;
}

function boolMap(v: unknown): Record<string, boolean> {
  if (!istObjekt(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'boolean')) as Record<string, boolean>;
}

function zahlMap(v: unknown): Record<string, number> {
  if (!istObjekt(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) as Record<string, number>;
}

function stufeAus(v: unknown): ZuschnittStufe | null {
  return v === 'normal' || v === 'kompakt' || v === 'minimal' ? v : null;
}

/**
 * K16.8: requestweiter Snapshot fuer Gate, Hinweise und Projektion (eine PG-Lesung). Wirft bei Fehler; der
 * Aufrufer lehnt dann vor dem Handler ab (ausser den nicht sperrbaren Anmelde-/Sitzungsaktionen, C1).
 */
export async function bereiteZuschnittSnapshotVor(p: IdentitaetsAgentPrincipal, o: { anpassung: boolean }): Promise<ZuschnittSnapshot> {
  const start = performance.now();
  const profil = await leseWirksamesProfil(p.identity_id);
  if (profil.project !== p.project) throw new ZuschnittFehler('profil_projekt_abweichend');
  const w = profil.werte;
  const s: ZuschnittSnapshot = {
    identity_id: p.identity_id, agent_id: p.agent_id, project: p.project,
    revision: profil.zuschnitt?.revision ?? profilRevisionText(profil), anpassung: o.anpassung,
    hinweise: boolMap(w.hinweise), stufe: stufeAus(w.kontext_stufe), limits: zahlMap(w.zuschnitt?.limits),
    kontext_budget: typeof w.kontext_budget === 'number' && w.kontext_budget > 0 ? w.kontext_budget : null,
    herkunft: profil.herkunft as Record<string, string>, zuschnitt: profil.zuschnitt,
    zeiten: { start, revision_ms: performance.now() - start, erster_hinweis: null }, entscheidungen: {}, limit_anpassungen: [],
  };
  setzeZuschnittSnapshot(s);
  return s;
}

/** Registrierter Gate-Resolver: nutzt den Snapshot des laufenden Aufrufs, sonst frische PG-Lesung (tools/list). */
export async function wirksamerZuschnittResolver(p: IdentitaetsAgentPrincipal): Promise<ToolZuschnitt | null> {
  const s = aktuellerZuschnittSnapshot();
  if (s && s.identity_id === p.identity_id) return s.zuschnitt;
  return (await leseWirksamesProfil(p.identity_id)).zuschnitt;
}
registriereZuschnittResolver(wirksamerZuschnittResolver);

const LIMIT_SCHLUESSEL = /^([^.]+)\.([^.]+)\.([^.:]+)(:standard)?$/;

/**
 * K15.6: Antwortdefault ('<tool>.<action>.<param>:standard') und harte Obergrenze ('<tool>.<action>.<param>'),
 * Aktion '*' = alle Aktionen des Tools. Nur Parameter, die die Tool-Definition anbietet (PA-1). Wirkt VOR dem
 * Handler auf die vorhandenen Mengen-/Paginierungsparameter des Tools - der Fachkern wird nie hinterher
 * verlustbehaftet abgeschnitten; die Antwort nennt die Anpassung samt Nachladeweg (antwort_zuschnitt).
 */
export function wendeProfilLimitsAn(tool: string, action: string | undefined, args: Record<string, unknown>, erlaubt?: Set<string>): void {
  const s = aktuellerZuschnittSnapshot();
  if (!s?.anpassung) return;
  const aktion = action ?? '*';
  const parameter = new Set<string>();
  for (const k of Object.keys(s.limits)) {
    const m = LIMIT_SCHLUESSEL.exec(k);
    if (m && m[1] === tool && (m[2] === '*' || m[2] === aktion)) parameter.add(m[3]);
  }
  for (const p of parameter) {
    if (erlaubt && !erlaubt.has(p)) continue;
    const lies = (a: string, std: boolean): number | undefined => s.limits[`${tool}.${a}.${p}${std ? ':standard' : ''}`];
    const grenze = lies(aktion, false) ?? lies('*', false) ?? null;
    const standard = lies(aktion, true) ?? lies('*', true) ?? null;
    const roh = args[p];
    const angefragt = typeof roh === 'number' && Number.isFinite(roh) ? roh : null;
    let wirksam = angefragt ?? standard ?? grenze;
    if (wirksam === null) continue;
    if (grenze !== null && wirksam > grenze) wirksam = grenze;
    if (wirksam === angefragt) continue;
    args[p] = wirksam;
    s.limit_anpassungen.push({ parameter: p, angefragt, wirksam, grenze, standard });
  }
}

const EXPLIZITES_ONBOARDING = (tool: string, action: string | undefined) =>
  (tool === 'chat' && (action === 'register' || action === 'anmelden')) || (tool === 'admin' && action === 'index_stats');

const runde = (x: number) => Math.round(x * 100) / 100;

function messe(s: ZuschnittSnapshot, tool: string, action: string | undefined): void {
  const jetzt = performance.now();
  const hinweise = s.zeiten.erster_hinweis === null ? null : jetzt - s.zeiten.erster_hinweis;
  merkeZuschnittMessung({ tool, action: action ?? null, revision_ms: runde(s.zeiten.revision_ms),
    hinweise_ms: hinweise === null ? null : runde(hinweise), gesamt_ms: runde(jetzt - s.zeiten.start),
    ueber_budget: (hinweise ?? 0) > hinweisBudgetMs(), zeit: new Date().toISOString() });
}

/**
 * K16.4 Schritt 6 / K16.7: Agentenauslieferung projizieren. Eingang = vollstaendiges (bereits auditiertes) Ergebnis.
 * Liefert ein NEUES Objekt (Eingang unveraendert) oder - ohne Snapshot/Schalter - exakt den Eingang.
 * Sicherheitsnetz: Felder abgeschalteter optionaler Arten, die ein Produzent ohne Vorabentscheidung geliefert hat
 * (lesende Hinweise ohne Claim, Onboarding-Unterfelder), entfallen bzw. werden auf ihren Pflichtanteil reduziert.
 */
export function projiziereToolAntwort<T>(ergebnis: T, tool: string, action?: string): T {
  const s = aktuellerZuschnittSnapshot();
  if (!s?.anpassung) return ergebnis;
  if (!istObjekt(ergebnis)) { messe(s, tool, action); return ergebnis; }
  const aus: Record<string, unknown> = { ...ergebnis };
  let geaendert = false;
  for (const e of HINWEIS_KATALOG) {
    if (e.klasse === 'pflicht') continue;
    for (const feld of e.felder ?? []) {
      const [kopf, unter] = feld.split('.');
      if (!(kopf in aus) || hinweisAktiv(e.schluessel)) continue;
      if (unter) {
        const o = aus[kopf];
        if (istObjekt(o) && unter in o) { const kopie = { ...o }; delete kopie[unter]; aus[kopf] = kopie; geaendert = true; }
        continue;
      }
      if (kopf === 'agentOnboarding' && EXPLIZITES_ONBOARDING(tool, action)) continue;
      const rest = pflichtAnteil(e.schluessel, aus[kopf]);
      if (rest === undefined) delete aus[kopf]; else aus[kopf] = rest;
      geaendert = true;
    }
  }
  const zuschnitt: Record<string, unknown> = {};
  if (s.limit_anpassungen.length) {
    zuschnitt.gekuerzt = true;
    zuschnitt.limit = s.limit_anpassungen;
    zuschnitt.nachladen = 'Vollstaendig: denselben Aufruf mit groesserem Wert (bis grenze) bzw. ueber die Paginierung des Tools wiederholen (offset/match_skip/since_id/from_line). Profilgrenzen legen Koordinator/User fest.';
  }
  if (s.kontext_budget) {
    const geschaetzt = Math.ceil(JSON.stringify(aus).length / 4);
    if (geschaetzt > s.kontext_budget) {
      zuschnitt.budget = { kontext_budget: s.kontext_budget, geschaetzt_tokens: geschaetzt, ueberschritten: true,
        hinweis: 'Fachkern nicht verlustbehaftet gekuerzt (kein verlaesslicher Nachladeweg); kleinere Mengen ueber limit/Paginierung abrufen.' };
    }
  }
  if (Object.keys(zuschnitt).length) { aus.antwort_zuschnitt = { profil_revision: s.revision, ...zuschnitt }; geaendert = true; }
  messe(s, tool, action);
  return (geaendert ? aus : ergebnis) as T;
}

/** stdio: Text-JSON in content[0] projizieren; Nicht-JSON und weitere Bloecke (Medien) bleiben unveraendert. */
export function projiziereTextAntwort<T extends { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }>(
  resp: T, tool: string, action?: string,
): T {
  if (!aktuellerZuschnittSnapshot()?.anpassung) return resp;
  const block = resp?.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return resp;
  let roh: unknown;
  try { roh = JSON.parse(block.text); } catch { return resp; }
  const neu = projiziereToolAntwort(roh, tool, action);
  if (neu !== roh) {
    block.text = JSON.stringify(neu);
    if (resp.structuredContent && istObjekt(neu)) resp.structuredContent = neu;
  }
  return resp;
}

/** Vertrag AntwortpipelineDienst.projiziereAgentAntwort (W1B_DIENSTE.antwort). */
export async function projiziereAgentAntwort(e: AntwortpipelineEingabe): Promise<{ agent: unknown; gekuerzt: boolean; nachladen?: Record<string, unknown> }> {
  const agent = projiziereToolAntwort(e.vollstaendig, e.tool, e.action ?? undefined);
  const z = istObjekt(agent) && istObjekt(agent.antwort_zuschnitt) ? agent.antwort_zuschnitt : undefined;
  return { agent, gekuerzt: z?.gekuerzt === true,
    ...(z?.nachladen ? { nachladen: { hinweis: z.nachladen, limit: z.limit } } : {}) };
}

/** Nachvollziehbarkeit (bfade8a8 §3): wirksame Einstellungen und Entscheidungen des laufenden Aufrufs, ohne Tokenwerte. */
export function zuschnittDiagnose(): Record<string, unknown> | null {
  const s = aktuellerZuschnittSnapshot();
  if (!s) return null;
  return { identity_id: s.identity_id, revision: s.revision, anpassung: s.anpassung, stufe: s.stufe, herkunft: s.herkunft,
    hinweise: s.hinweise, entscheidungen: s.entscheidungen, limit_anpassungen: s.limit_anpassungen,
    zuschnitt: s.zuschnitt ? { revision: s.zuschnitt.revision, quelle: s.zuschnitt.quelle ?? null } : null };
}
