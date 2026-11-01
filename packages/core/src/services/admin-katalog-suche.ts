/**
 * P23-T10 (User 01.11.2026, Koordinator-Sitzung): ADMIN SCHLANK - Katalogsuche statt Komplettlisten.
 *
 * Kataloge (Produkt-Schalter, reverse/hex/shell_ausgabe-Einstellungen, runtime_ueberwachung, agentennetzwerk) werden im
 * admin-Tool (MCP stdio + REST /mcp) nicht mehr komplett ausgegeben:
 *   - ohne query/Filter/voll: nur Zusammenfassung (Anzahl je Bereich) + Hinweis;
 *   - query: zuerst exakter Name, dann Namensteile (alle Woerter im Namen, z. B. "editor leinwand" -> editor_plan_leinwand),
 *     erst danach Semantik ueber Name + Zweck + Bereich + Begruendung (vorhandene Embedding-Infrastruktur, Vektoren je Prozess
 *     gepuffert). Spezifischere Anfrage = weniger Treffer: Score-Schwelle UND Abstand zum besten Treffer;
 *   - Filter nur_aktiv, nur_abweichend (vom Standard), fehlend_gegenueber_projekt (nur Produkt-Schalter);
 *   - voll:true = Komplettliste seitenweise (limit/offset).
 * Die REST-Routen der Web-UI (agent-profil.ts, agent-runtimes.ts) bleiben unveraendert vollstaendig.
 *
 * EINSTELLWERTE (kein Hardcode): runtime_ueberwachung admin_suche_schwelle_promille, admin_suche_abstand_promille,
 *   admin_suche_max_treffer, admin_suche_seite, admin_suche_einbetten_ms (global; admin runtime_ueberwachung setzen).
 * DEBUG: jede Suchantwort nennt suche (exakt|name|semantisch|woerter|leer) und bei Rueckfall suche_grund;
 *   katalogSucheDiagnose() liefert Zaehler und Puffergroesse.
 */
import { createHash } from 'node:crypto';
import { embed } from '../embeddings/index.js';
import { embeddingModellKennung } from '../embeddings/modell-profil.js';

export interface KatalogEintrag {
  name: string;
  /** schalter: wert ist aktiv (boolean); wert: Einstellwert. */
  art: 'schalter' | 'wert';
  wert: unknown;
  ebene?: string | null;
  quelle?: string | null;
  /** Eine Zeile Zweck. */
  zweck?: string | null;
  bereich: string;
  standard?: unknown;
  abweichend?: boolean;
  begruendung?: string | null;
}

export interface KatalogSuchWerte {
  schwelle_promille: number;
  abstand_promille: number;
  max_treffer: number;
  seite: number;
  einbetten_ms: number;
}

/** Neue admin-Parameter (in W1B_ADMIN_PARAMETER eingehaengt, damit stdio und REST dasselbe Schema haben). */
export const ADMIN_SUCHE_PARAMETER: Record<string, Record<string, unknown>> = {
  query: { type: 'string', description: 'Katalogsuche (profil_schalter_status, reverse/hex/shell_ausgabe_einstellungen status, runtime_ueberwachung status, agentennetzwerk status): Name, Namensteile oder Thema (fall-admin-schalter-suchen)' },
  nur_aktiv: { type: 'boolean', description: 'Katalogsuche: nur eingeschaltete Schalter' },
  nur_abweichend: { type: 'boolean', description: 'Katalogsuche: nur Eintraege mit Wert abweichend vom Standard' },
  fehlend_gegenueber_projekt: { type: 'string', description: 'profil_schalter_status: Schalter, die im genannten Projekt an sind, hier aber nicht' },
  voll: { type: 'boolean', description: 'Katalogsuche: Komplettliste seitenweise (limit/offset)' },
  limit: { type: 'number', description: 'Katalogsuche: Eintraege je Seite' },
  offset: { type: 'number', description: 'Katalogsuche: Startposition' },
};

export const KATALOG_SKILL = 'fall-admin-schalter-suchen';
const SKILL_ABRUF = `skills(action:"get_full", skill_name:"${KATALOG_SKILL}")`;
export const KATALOG_HINWEIS = 'Keine Komplettliste. Suchen: query:"editor" (Namensteile, sonst Thema); Filter nur_aktiv, nur_abweichend, '
  + 'fehlend_gegenueber_projekt:"<projekt>" (nur Schalter); Komplettliste voll:true mit limit/offset. Details: ' + SKILL_ABRUF;

const zaehler = { suchen: 0, exakt: 0, name: 0, semantisch: 0, woerter: 0, leer: 0, rueckfall_zeit: 0, rueckfall_fehler: 0, eingebettet: 0 };

/** Wirksame Suchwerte (runtime_ueberwachung admin_suche_*; Lesefehler -> Code-Standard dort). */
export async function leseKatalogSuchWerte(): Promise<KatalogSuchWerte> {
  const { leseRuntimeUeberwachungWerte } = await import('./runtime-ueberwachung.js');
  const w = await leseRuntimeUeberwachungWerte();
  return {
    schwelle_promille: w.admin_suche_schwelle_promille,
    abstand_promille: w.admin_suche_abstand_promille,
    max_treffer: w.admin_suche_max_treffer,
    seite: w.admin_suche_seite,
    einbetten_ms: w.admin_suche_einbetten_ms,
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const woerterVon = (s: string): string[] => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

function kosinus(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

function dokText(e: KatalogEintrag): string {
  return [e.name.replace(/_/g, ' '), e.zweck, e.bereich ? `Bereich ${e.bereich}` : null, e.begruendung].filter((x) => typeof x === 'string' && x.trim()).join('. ');
}

// Vektoren je Prozess (Schluessel Modell + Text). Grosse Kataloge werden nur einmal eingebettet.
const VEKTOREN = new Map<string, number[]>();
const LAUFEND = new Map<string, Promise<void>>();
const VEKTOREN_MAX = 5000;
let modellKennung = '';

function vektorSchluessel(text: string): string {
  return createHash('sha1').update(modellKennung + '\u0000' + text).digest('hex');
}

async function dokVektor(text: string): Promise<void> {
  const k = vektorSchluessel(text);
  if (VEKTOREN.has(k)) return;
  let p = LAUFEND.get(k);
  if (!p) {
    p = embed(text, { art: 'dokument', priority: 'interactive' }).then((v) => {
      if (VEKTOREN.size >= VEKTOREN_MAX) VEKTOREN.clear();
      VEKTOREN.set(k, v);
      zaehler.eingebettet++;
    }).finally(() => { LAUFEND.delete(k); });
    LAUFEND.set(k, p);
  }
  await p;
}

/** Alle Dokumente einbetten, hoechstens 4 gleichzeitig (Warteschlangengrenze interaktiv). */
async function betteAlleEin(texte: string[]): Promise<void> {
  const offen = texte.filter((t) => !VEKTOREN.has(vektorSchluessel(t)));
  for (let i = 0; i < offen.length; i += 4) await Promise.all(offen.slice(i, i + 4).map(dokVektor));
}

export interface KatalogSuchErgebnis {
  art: 'exakt' | 'name' | 'semantisch' | 'woerter' | 'leer';
  treffer: Array<KatalogEintrag & { score?: number }>;
  grund?: string;
  naechste?: string[];
}

function waehle(bewertet: Array<{ e: KatalogEintrag; score: number }>, schwelle: number, abstand: number, max: number): Array<KatalogEintrag & { score: number }> {
  bewertet.sort((a, b) => b.score - a.score);
  const best = bewertet[0]?.score ?? 0;
  return bewertet.filter((x) => x.score >= schwelle && x.score >= best - abstand).slice(0, max)
    .map((x) => ({ ...x.e, score: Math.round(x.score * 1000) / 1000 }));
}

function wortSuche(eintraege: KatalogEintrag[], query: string, w: KatalogSuchWerte, grund: string): KatalogSuchErgebnis {
  // Rueckfall ohne Embedding: Wortueberlappung (Praefix 6) - Skala anders als Kosinus, daher nur Abstand zum Besten.
  const qw = new Set(woerterVon(query).map((x) => x.slice(0, 6)));
  const bewertet = eintraege.map((e) => {
    const dw = new Set(woerterVon(dokText(e)).map((x) => x.slice(0, 6)));
    let n = 0;
    for (const x of qw) if (dw.has(x)) n++;
    return { e, score: dw.size && qw.size ? n / Math.sqrt(dw.size * qw.size) : 0 };
  }).filter((x) => x.score > 0);
  const treffer = waehle(bewertet, 0, w.abstand_promille / 1000, w.max_treffer);
  zaehler[treffer.length ? 'woerter' : 'leer']++;
  return { art: treffer.length ? 'woerter' : 'leer', treffer, grund };
}

/** Suche in einem Katalog: exakt -> Namensteile -> Semantik (Rueckfall Woerter). */
export async function sucheKatalog(eintraege: KatalogEintrag[], query: string, w?: KatalogSuchWerte): Promise<KatalogSuchErgebnis> {
  zaehler.suchen++;
  const werte = w ?? await leseKatalogSuchWerte();
  const q = query.trim();
  const qn = norm(q).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const exakt = eintraege.filter((e) => norm(e.name) === qn);
  if (exakt.length) { zaehler.exakt++; return { art: 'exakt', treffer: exakt }; }
  const qw = woerterVon(q);
  if (qw.length) {
    const name = eintraege.filter((e) => { const n = norm(e.name); return qw.every((x) => n.includes(x)); });
    if (name.length) { zaehler.name++; return { art: 'name', treffer: name }; }
  }
  if (!eintraege.length) { zaehler.leer++; return { art: 'leer', treffer: [] }; }
  try {
    const qv = await embed(q.slice(0, 2000), { art: 'query', priority: 'interactive' });
    try { modellKennung = embeddingModellKennung(); } catch { /* Kennung bleibt; Laengenpruefung schuetzt */ }
    const texte = eintraege.map(dokText);
    const fuellen = betteAlleEin(texte);
    fuellen.catch(() => undefined);
    let zeitGeber: ReturnType<typeof setTimeout> | undefined;
    const fertig = await Promise.race([
      fuellen.then(() => true),
      new Promise<boolean>((r) => { zeitGeber = setTimeout(() => r(false), werte.einbetten_ms); }),
    ]).finally(() => { if (zeitGeber) clearTimeout(zeitGeber); });
    if (!fertig) {
      zaehler.rueckfall_zeit++;
      return wortSuche(eintraege, q, werte, `einbetten_laeuft (Katalog wird im Hintergrund eingebettet, Grenze admin_suche_einbetten_ms=${werte.einbetten_ms}); Wortsuche`);
    }
    const bewertet = eintraege.map((e, i) => {
      const v = VEKTOREN.get(vektorSchluessel(texte[i]));
      return { e, score: v && v.length === qv.length ? kosinus(qv, v) : 0 };
    });
    const treffer = waehle(bewertet, werte.schwelle_promille / 1000, werte.abstand_promille / 1000, werte.max_treffer);
    if (!treffer.length) {
      zaehler.leer++;
      const naechste = [...bewertet].sort((a, b) => b.score - a.score).slice(0, 3).map((x) => `${x.e.name} (${Math.round(x.score * 1000) / 1000})`);
      return { art: 'leer', treffer: [], naechste, grund: `kein Treffer ueber admin_suche_schwelle_promille=${werte.schwelle_promille}` };
    }
    zaehler.semantisch++;
    return { art: 'semantisch', treffer };
  } catch (err) {
    zaehler.rueckfall_fehler++;
    return wortSuche(eintraege, q, werte, `embedding_nicht_verfuegbar (${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)}); Wortsuche`);
  }
}

function trigramme(s: string): Set<string> {
  const t = `  ${norm(s)} `;
  const m = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) m.add(t.slice(i, i + 3));
  return m;
}

/** Aehnliche Namen fuer einen unbekannten Namen: Namensteile, dann Tippfehler-Naehe (Trigramme), dann die Katalogsuche. */
export async function aehnlicheNamen(eingabe: string, eintraege: KatalogEintrag[], max = 6): Promise<string[]> {
  const qw = woerterVon(eingabe);
  if (qw.length) {
    const name = eintraege.filter((e) => { const n = norm(e.name); return qw.every((x) => n.includes(x)); });
    if (name.length) return name.slice(0, max).map((e) => e.name);
  }
  const q = trigramme(eingabe);
  const tri = eintraege.map((e) => {
    const t = trigramme(e.name);
    let n = 0;
    for (const x of q) if (t.has(x)) n++;
    return { name: e.name, score: (2 * n) / (q.size + t.size) };
  }).filter((x) => x.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.name);
  if (tri.length) return tri;
  try {
    const s = await sucheKatalog(eintraege, eingabe);
    return s.treffer.slice(0, max).map((e) => e.name);
  } catch {
    return [];
  }
}

export interface KatalogArgs {
  query?: string;
  nur_aktiv: boolean;
  nur_abweichend: boolean;
  fehlend?: string;
  voll: boolean;
  limit?: number;
  offset: number;
}

export function katalogArgs(a: Record<string, unknown>): KatalogArgs {
  const text = (k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
  const zahl = (k: string) => (typeof a[k] === 'number' && Number.isFinite(a[k]) ? Math.max(0, Math.trunc(a[k] as number)) : undefined);
  const limit = zahl('limit');
  return {
    query: text('query'), nur_aktiv: a.nur_aktiv === true, nur_abweichend: a.nur_abweichend === true,
    fehlend: text('fehlend_gegenueber_projekt'), voll: a.voll === true, limit: limit && limit > 0 ? limit : undefined, offset: zahl('offset') ?? 0,
  };
}

/** Kompakte Zeile je Treffer: name, aktiv|wert, ebene, quelle, eine Zeile Zweck (Score nur bei Semantik/Woertern). */
export function katalogZeile(e: KatalogEintrag & { score?: number }): Record<string, unknown> {
  const o: Record<string, unknown> = { name: e.name, [e.art === 'schalter' ? 'aktiv' : 'wert']: e.wert };
  if (e.ebene) o.ebene = e.ebene;
  if (e.quelle) o.quelle = e.quelle;
  if (e.zweck) o.zweck = e.zweck.length > 160 ? e.zweck.slice(0, 157) + '...' : e.zweck;
  if (typeof e.score === 'number') o.score = e.score;
  return o;
}

export function katalogZusammenfassung(eintraege: KatalogEintrag[]): Record<string, unknown> {
  const je: Record<string, { anzahl: number; aktiv?: number; abweichend?: number }> = {};
  let aktiv = 0, abweichend = 0;
  const schalter = eintraege.some((e) => e.art === 'schalter');
  for (const e of eintraege) {
    const b = je[e.bereich] ?? (je[e.bereich] = { anzahl: 0 });
    b.anzahl++;
    if (e.art === 'schalter' && e.wert === true) { aktiv++; b.aktiv = (b.aktiv ?? 0) + 1; }
    if (e.abweichend) { abweichend++; b.abweichend = (b.abweichend ?? 0) + 1; }
  }
  return { gesamt: eintraege.length, ...(schalter ? { aktiv } : {}), abweichend, je_bereich: je };
}

/**
 * Antwort fuer einen Katalog nach query/Filtern/voll. fehlendIn liefert die Namen, die im genannten Projekt aktiv sind
 * (nur Produkt-Schalter); ohne fehlendIn wird der Filter mit Hinweis ignoriert.
 */
export async function katalogAntwort(
  katalog: string, eintraege: KatalogEintrag[], a: Record<string, unknown>,
  opt: { fehlendIn?: (projekt: string) => Promise<Set<string>> } = {},
): Promise<Record<string, unknown>> {
  const k = katalogArgs(a);
  if (!k.query && !k.nur_aktiv && !k.nur_abweichend && !k.fehlend && !k.voll) {
    return { katalog, zusammenfassung: katalogZusammenfassung(eintraege), hinweis: KATALOG_HINWEIS };
  }
  const werte = await leseKatalogSuchWerte();
  const hinweise: string[] = [];
  const filter: string[] = [];
  let menge = eintraege;
  if (k.nur_aktiv) { menge = menge.filter((e) => e.wert === true); filter.push('nur_aktiv'); }
  if (k.nur_abweichend) { menge = menge.filter((e) => e.abweichend === true); filter.push('nur_abweichend'); }
  if (k.fehlend) {
    if (!opt.fehlendIn) hinweise.push('fehlend_gegenueber_projekt gilt nur fuer profil_schalter_status, ignoriert.');
    else {
      const an = await opt.fehlendIn(k.fehlend);
      menge = menge.filter((e) => an.has(e.name) && e.wert !== true);
      filter.push(`fehlend_gegenueber_projekt:${k.fehlend}`);
    }
  }
  let suche: KatalogSuchErgebnis | null = null;
  if (k.query) { suche = await sucheKatalog(menge, k.query, werte); menge = suche.treffer; }
  const gesamt = menge.length;
  const limit = k.limit ?? (k.voll ? werte.seite : werte.max_treffer);
  const seite = menge.slice(k.offset, k.offset + limit);
  const rest = gesamt - k.offset - seite.length;
  if (rest > 0) hinweise.push(`Weitere ${rest}: offset:${k.offset + seite.length}${k.query ? ' oder genauere query' : ''}.`);
  if (suche && !suche.treffer.length) hinweise.push('Kein Treffer: andere Woerter, Namensteile oder voll:true. ' + SKILL_ABRUF);
  return {
    katalog,
    ...(suche ? { suche: suche.art, ...(suche.grund ? { suche_grund: suche.grund } : {}), ...(suche.naechste ? { naechste: suche.naechste } : {}) } : {}),
    ...(filter.length ? { filter } : {}),
    anzahl: gesamt,
    treffer: seite.map(katalogZeile),
    ...(rest > 0 ? { weitere: rest, naechster_offset: k.offset + seite.length } : {}),
    ...(hinweise.length ? { hinweis: hinweise.join(' ') } : {}),
  };
}

/**
 * Schema: grosse enums (action, profil_funktion, ueberwachung_namen ...) werden freie Strings - der Server prueft und nennt
 * bei unbekanntem Namen aehnliche Treffer. Kopie; kleine enums (Modi, Ebenen) bleiben.
 */
export const ADMIN_ENUM_MAX = 12;
export function ohneGrosseEnums(props: Record<string, unknown>, max = ADMIN_ENUM_MAX): Record<string, Record<string, unknown>> {
  const aus: Record<string, Record<string, unknown>> = {};
  for (const [name, roh] of Object.entries(props)) {
    if (!roh || typeof roh !== 'object' || Array.isArray(roh)) continue;
    const p = { ...(roh as Record<string, unknown>) };
    if (Array.isArray(p.enum) && p.enum.length > max) delete p.enum;
    const items = p.items;
    if (items && typeof items === 'object' && !Array.isArray(items) && Array.isArray((items as Record<string, unknown>).enum)
      && ((items as Record<string, unknown>).enum as unknown[]).length > max) {
      const { enum: _weg, ...rest } = items as Record<string, unknown>;
      p.items = rest;
    }
    aus[name] = p;
  }
  return aus;
}

export function katalogSucheDiagnose(): Record<string, unknown> {
  return { ...zaehler, vektoren: VEKTOREN.size, laufend: LAUFEND.size, modell: modellKennung || null };
}
