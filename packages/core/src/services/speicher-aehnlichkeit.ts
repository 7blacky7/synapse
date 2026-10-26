/**
 * P10-T88 N2 (Befund P10-T81 Nachtrag d0080771; User 26.10.2026 ~02:15; Bestandsaufnahme thought 3f904578):
 * AEHNLICHKEITSPRUEFUNG BEIM SPEICHERN. Vor thought add/add_batch, memory write, proposal create und plan add_task/add_tasks_batch
 * sucht Synapse EINMAL semantisch im Projekt nach aehnlichen Eintraegen und legt die Treffer als 'aehnlich' in die Antwort.
 *
 * WARUM KEIN FALL DER HINWEISQUELLE (P10-T84, ausloeser-hinweise.ts): Die Registry hat 30 ms Budget und hoechstens zwei Textzeilen;
 *   eine Embedding-Suche dauert laenger, die Treffer sind eine Liste (Score/ID/Vorschau), und pruefen_vor_anlegen muss VOR dem
 *   Schreiben entscheiden. Deshalb ein Wrapper um den Schreibaufruf nach dem Muster mitFileTaskWarnung (file-task-zuordnung.ts),
 *   eingehaengt auf beiden Strecken (REST mcp.ts handleAuthentifiziertenToolCall, stdio server.ts).
 * QUELLEN: thoughts + memories + tasks (searchThoughts/searchMemories/searchTasks). Bei plan nur thoughts + memories, die Tasks
 *   liefert wie bisher taskDublettenHinweis (P3-T15/P22-T50); die Wissens-Treffer werden an dessen aehnlich angehaengt.
 * SCHWELLE: Modellprofil-Zweck speicher_aehnlich (intern modellprofil_kalibrieren), Rueckfall auf den Zweck tasks; kein Wert im Code.
 * USER-IDEEN: Tags user-idee/user-entscheidung/user-grundsatz -> zusaetzlich aehnlich_ergaenzen ('vorhandenen Eintrag ergaenzen').
 * SCHALTER (Produkt-Schalter, projekt > global, Standard AUS, nur ausdruecklich; intern-Override gleichen Namens nur mit intern-Tool):
 *   speicher_aehnlichkeit          aehnlich-Liste in der Antwort. AUS = Altverhalten (keine Suche, keine Zusatzfelder).
 *   speicher_aehnlichkeit_pruefen  Modus pruefen_vor_anlegen: User-Idee mit Treffern wird NICHT angelegt, nur mit bestaetigt:true.
 *                                  Wirkt nur zusammen mit speicher_aehnlichkeit.
 * EINSTELLUNGEN (Regel 7): Tabelle speicher_aehnlichkeit_einstellungen (Schema 162), Code-Standard SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN,
 *   Quelle je Wert; setzen nur der User (REST PUT /api/main-agent/speicher-aehnlichkeit/einstellungen).
 * DEBUG: aehnlich_debug (eine Zeile: Schalter mit Quelle, Schwelle mit Quelle, Quellen, Treffer, Dauer, Fehler je Quelle).
 * Eine fehlende Kalibrierung, ein Suchfehler oder das Zeitlimit blockieren das Anlegen nie.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { scoreSchwelleMitQuelle } from '../embeddings/modell-profil.js';
import { searchThoughts } from './thoughts.js';
import { searchMemories } from './memory.js';
import { searchTasks } from './plan-suche.js';

type Q = import('pg').QueryConfig & { query_timeout: number };

export const SPEICHER_AEHNLICHKEIT_FUNKTION = 'speicher_aehnlichkeit' as const;
export const SPEICHER_AEHNLICHKEIT_PRUEFEN_FUNKTION = 'speicher_aehnlichkeit_pruefen' as const;
/** Tags, mit denen eine User-Idee/-Entscheidung gespeichert wird (Vorgabe User 26.10.2026). */
export const USER_IDEE_TAGS = ['user-idee', 'user-entscheidung', 'user-grundsatz'] as const;

// ---------------------------------------------------------------------------------------------
// Einstellungen (Regel 7: PG vor Code-Standard, Quelle je Wert)
// ---------------------------------------------------------------------------------------------
export const SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN = {
  /** Hoechstens so viele Treffer je gespeichertem Eintrag (ueber alle Quellen, bester Score zuerst). */
  max_treffer: { standard: 5, min: 1, max: 20 },
  /** Laenge der Vorschau je Treffer in Zeichen. */
  vorschau_zeichen: { standard: 160, min: 40, max: 600 },
  /** Zeitlimit der Suche; danach wird ohne Treffer gespeichert (aehnlich_hinweis nennt das). */
  zeitlimit_ms: { standard: 3000, min: 200, max: 30000 },
} as const;
export type SpeicherAehnlichkeitEinstellung = keyof typeof SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN;
export interface SpeicherAehnlichkeitEinstellungenStand {
  werte: Record<SpeicherAehnlichkeitEinstellung, number>;
  einstellungen: Record<string, { wert: number; quelle: 'standard' | 'einstellung'; min: number; max: number; gesetzt_von?: string; gesetzt_am?: string }>;
  letzter_fehler: string | null;
}

function standardEinstellungen(): SpeicherAehnlichkeitEinstellungenStand {
  const werte = {} as Record<SpeicherAehnlichkeitEinstellung, number>;
  const einstellungen: SpeicherAehnlichkeitEinstellungenStand['einstellungen'] = {};
  for (const [name, d] of Object.entries(SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN)) {
    werte[name as SpeicherAehnlichkeitEinstellung] = d.standard;
    einstellungen[name] = { wert: d.standard, quelle: 'standard', min: d.min, max: d.max };
  }
  return { werte, einstellungen, letzter_fehler: null };
}

function gueltigerWert(name: string, wert: unknown): number | null {
  const d = SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN[name as SpeicherAehnlichkeitEinstellung];
  const n = typeof wert === 'number' ? wert : typeof wert === 'string' && wert.trim() ? Number(wert) : NaN;
  return d && Number.isInteger(n) && n >= d.min && n <= d.max ? n : null;
}

/** Wirksame Einstellungen (PG vor Code-Standard). Lesefehler -> Standard mit letzter_fehler. Wirft nie. */
export async function leseSpeicherAehnlichkeitEinstellungen(): Promise<SpeicherAehnlichkeitEinstellungenStand> {
  const stand = standardEinstellungen();
  try {
    const r = await getPool().query<{ name: string; wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(
      'SELECT name, wert, gesetzt_von, gesetzt_am FROM speicher_aehnlichkeit_einstellungen');
    const ungueltig: string[] = [];
    for (const z of r.rows) {
      const w = gueltigerWert(z.name, z.wert);
      if (w === null) { ungueltig.push(z.name); continue; }
      stand.werte[z.name as SpeicherAehnlichkeitEinstellung] = w;
      const d = SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN[z.name as SpeicherAehnlichkeitEinstellung];
      stand.einstellungen[z.name] = { wert: w, quelle: 'einstellung', min: d.min, max: d.max, gesetzt_von: z.gesetzt_von,
        gesetzt_am: z.gesetzt_am instanceof Date ? z.gesetzt_am.toISOString() : String(z.gesetzt_am) };
    }
    if (ungueltig.length) stand.letzter_fehler = 'einstellung_ungueltig: ' + ungueltig.join(', ');
  } catch (error) {
    stand.letzter_fehler = 'einstellungen_nicht_lesbar: ' + (error instanceof Error ? error.message : String(error));
  }
  return stand;
}

/** Einstellungen setzen (nur der User, die Route prueft das). werte {name: zahl|null}; null = zurueck auf den Code-Standard. */
export async function setzeSpeicherAehnlichkeitEinstellungen(werte: unknown, grund: unknown, von: string): Promise<SpeicherAehnlichkeitEinstellungenStand> {
  const erlaubt = Object.keys(SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN);
  if (!werte || typeof werte !== 'object' || Array.isArray(werte)) throw new ProfilVerwaltungFehler('werte_fehlen', { erlaubt });
  const g = typeof grund === 'string' ? grund.trim() : '';
  if (g.length < 5) throw new ProfilVerwaltungFehler('grund_fehlt');
  const eintraege = Object.entries(werte as Record<string, unknown>);
  for (const [name, wert] of eintraege) {
    if (!(name in SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN)) throw new ProfilVerwaltungFehler('einstellung_unbekannt', { name, erlaubt });
    if (wert !== null && gueltigerWert(name, wert) === null) {
      const d = SPEICHER_AEHNLICHKEIT_EINSTELLUNGEN[name as SpeicherAehnlichkeitEinstellung];
      throw new ProfilVerwaltungFehler('wert_ungueltig', { name, min: d.min, max: d.max });
    }
  }
  const setzen = eintraege.filter(([, w]) => w !== null).map(([n, w]) => [n, gueltigerWert(n, w)] as const);
  const entfernen = eintraege.filter(([, w]) => w === null).map(([n]) => n);
  const pool = getPool();
  if (setzen.length) {
    await pool.query(
      `INSERT INTO speicher_aehnlichkeit_einstellungen (name, wert, grund, gesetzt_von)
       SELECT n, to_jsonb(w), $3, $4 FROM unnest($1::text[], $2::int[]) AS t(n, w)
       ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW()`,
      [setzen.map(([n]) => n), setzen.map(([, w]) => w), g, von]);
  }
  if (entfernen.length) await pool.query('DELETE FROM speicher_aehnlichkeit_einstellungen WHERE name = ANY($1::text[])', [entfernen]);
  return leseSpeicherAehnlichkeitEinstellungen();
}

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface SpeicherAehnlichkeitSchalter {
  funktion: string; aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; ebene: 'global' | 'projekt' | null;
  bis: string | null; letzter_fehler: string | null;
}

/** Produkt-Schalter (projekt > global) mit befristetem intern-Override gleichen Namens; eine Lesestelle je Funktion. Wirft nie. */
export async function leseSpeicherAehnlichkeitSchalter(
  funktion: typeof SPEICHER_AEHNLICHKEIT_FUNKTION | typeof SPEICHER_AEHNLICHKEIT_PRUEFEN_FUNKTION, project: string | null,
): Promise<SpeicherAehnlichkeitSchalter> {
  const p = await leseProfilProduktSchalter(funktion, project);
  let stand: SpeicherAehnlichkeitSchalter = { funktion, aktiv: p.aktiv, quelle: p.quelle, ebene: p.ebene, bis: null, letzter_fehler: p.letzter_fehler };
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date }>({
        text: "SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND bis > NOW()",
        values: [funktion], query_timeout: 2000 } as Q);
      const z = r.rows[0];
      if (z) stand = { ...stand, aktiv: z.aktiv, quelle: 'intern', bis: new Date(z.bis).toISOString(), letzter_fehler: null };
    } catch { stand.letzter_fehler = funktion + '_override_nicht_lesbar'; }
  }
  return stand;
}

/** Schwelle: eigener Zweck speicher_aehnlich, sonst der kalibrierte Dubletten-Zweck tasks; Quelle steht im Ergebnis. */
export async function speicherAehnlichkeitSchwelle(): Promise<{ schwelle: number | null; quelle: string; hinweis?: string }> {
  const eigen = await scoreSchwelleMitQuelle('speicher_aehnlich');
  if (eigen.schwelle !== null) return eigen;
  const tasks = await scoreSchwelleMitQuelle('tasks');
  if (tasks.schwelle !== null) return { schwelle: tasks.schwelle, quelle: 'rueckfall_tasks:' + tasks.quelle };
  return { schwelle: null, quelle: 'nicht_kalibriert', hinweis: eigen.hinweis ?? tasks.hinweis };
}

/** Stand fuer REST GET und Diagnose: beide Schalter, Einstellungen, Schwelle (jeweils mit Quelle). Wirft nie. */
export async function leseSpeicherAehnlichkeitStand(project: string | null) {
  const [schalter, pruefen, einstellungen, schwelle] = await Promise.all([
    leseSpeicherAehnlichkeitSchalter(SPEICHER_AEHNLICHKEIT_FUNKTION, project),
    leseSpeicherAehnlichkeitSchalter(SPEICHER_AEHNLICHKEIT_PRUEFEN_FUNKTION, project),
    leseSpeicherAehnlichkeitEinstellungen(),
    speicherAehnlichkeitSchwelle().catch((e) => ({ schwelle: null, quelle: 'fehler', hinweis: String(e) })),
  ]);
  return { aktiv: schalter.aktiv, schalter, pruefen, einstellungen, schwelle, user_tags: USER_IDEE_TAGS };
}

// ---------------------------------------------------------------------------------------------
// Pruefung
// ---------------------------------------------------------------------------------------------
type Art = 'thought' | 'memory' | 'task';
export interface AehnlicherEintrag { art: Art; id: string; score: number; vorschau: string; status?: string }
interface SpeicherEintrag { index: number; text: string; tags: string[]; name?: string }
interface SpeicherZiel { batch: boolean; quellen: Art[]; eintraege: SpeicherEintrag[] }

const objekt = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (...teile: unknown[]) => teile.filter((t): t is string => typeof t === 'string' && !!t.trim()).join('\n');
const tagsVon = (o: Record<string, unknown>) => Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [];
const liste = (v: unknown) => Array.isArray(v) ? v.filter(objekt) : [];

/** Welche Eintraege dieser Aufruf anlegt; null = kein Speicherweg (Lesen, Aendern, Loeschen). */
export function speicherZiel(tool: string, args: Record<string, unknown>): SpeicherZiel | null {
  const wissen: Art[] = ['thought', 'memory', 'task'];
  const ziel = (batch: boolean, quellen: Art[], roh: Array<Omit<SpeicherEintrag, 'index'>>): SpeicherZiel | null => {
    const eintraege = roh.map((e, index) => ({ ...e, index })).filter((e) => e.text.trim());
    return eintraege.length ? { batch, quellen, eintraege } : null;
  };
  const action = args.action;
  if (tool === 'thought' && action === 'add') return ziel(false, wissen, [{ text: text(args.content), tags: tagsVon(args) }]);
  if (tool === 'thought' && action === 'add_batch') return ziel(true, wissen, liste(args.items).map((i) => ({ text: text(i.content), tags: tagsVon(i) })));
  if (tool === 'memory' && action === 'write') {
    if (Array.isArray(args.items)) return ziel(true, wissen, liste(args.items).map((i) => ({ text: text(i.name, i.content), tags: tagsVon(i), name: typeof i.name === 'string' ? i.name : undefined })));
    return ziel(false, wissen, [{ text: text(args.name, args.content), tags: tagsVon(args), name: typeof args.name === 'string' ? args.name : undefined }]);
  }
  if (tool === 'proposal' && action === 'create') {
    if (Array.isArray(args.items)) return ziel(true, wissen, liste(args.items).map((i) => ({ text: text(i.description, i.file_path), tags: tagsVon(i) })));
    return ziel(false, wissen, [{ text: text(args.description, args.file_path), tags: tagsVon(args) }]);
  }
  // plan: Task-Dubletten liefert taskDublettenHinweis wie bisher, hier nur das Wissen (thoughts + memories).
  if (tool === 'plan' && action === 'add_task') return ziel(false, ['thought', 'memory'], [{ text: text(args.title, args.description), tags: [] }]);
  if (tool === 'plan' && action === 'add_tasks_batch') return ziel(true, ['thought', 'memory'], liste(args.tasks).map((t) => ({ text: text(t.title, t.description), tags: [] })));
  return null;
}

const istUserIdee = (e: SpeicherEintrag) => e.tags.some((t) => (USER_IDEE_TAGS as readonly string[]).includes(t.toLowerCase()));
const kurz = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const rund = (n: number) => Math.round(n * 100) / 100;

async function sucheAehnliche(project: string, e: SpeicherEintrag, quellen: Art[], schwelle: number, max: number, vorschau: number,
  fehler: Set<string>): Promise<AehnlicherEintrag[]> {
  const limit = max + 1;
  const quelle = <T>(art: Art, p: () => Promise<T[]>): Promise<T[]> => quellen.includes(art)
    ? p().catch((err) => { fehler.add(art + ':' + kurz(err instanceof Error ? err.message : String(err), 80)); return []; })
    : Promise.resolve([]);
  const [th, me, ta] = await Promise.all([
    quelle('thought', () => searchThoughts(e.text, project, limit)),
    quelle('memory', () => searchMemories(e.text, project, limit)),
    quelle('task', async () => (await searchTasks(e.text, project, { alle: true, limit })).results),
  ]);
  const treffer: AehnlicherEintrag[] = [
    ...th.map((t) => ({ art: 'thought' as const, id: String(t.id), score: t.score, vorschau: kurz(String((t.payload as { content?: unknown })?.content ?? ''), vorschau) })),
    // Memories werden ueber den Namen gelesen/ergaenzt; ein write mit gleichem Namen ueberschreibt sich selbst und zaehlt nicht.
    ...me.filter((m) => m.payload?.name !== e.name).map((m) => ({ art: 'memory' as const, id: String(m.payload?.name ?? m.id), score: m.score,
      vorschau: kurz(String(m.payload?.content ?? ''), vorschau) })),
    ...ta.map((t) => ({ art: 'task' as const, id: t.kurz_id ?? t.id, score: t.score, status: t.status, vorschau: kurz(t.title, vorschau) })),
  ];
  return treffer.filter((t) => t.score >= schwelle).sort((a, b) => b.score - a.score).slice(0, max).map((t) => ({ ...t, score: rund(t.score) }));
}

function mitZeitlimit<T>(p: Promise<T>, ms: number): Promise<T | 'zeitlimit'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<'zeitlimit'>((r) => { timer = setTimeout(() => r('zeitlimit'), ms); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

const ergaenzenText = (t: AehnlicherEintrag) => 'User-Idee: aehnlicher Eintrag vorhanden (' + t.art + ' ' + t.id + ', Score ' + t.score
  + '). Vorhandenen Eintrag ergaenzen statt neu anlegen (' + (t.art === 'memory' ? 'memory update' : t.art === 'task' ? 'plan update_task' : 'thought update') + ').';

/**
 * Wrapper um einen Speicheraufruf (beide Strecken). Schalter AUS oder kein Speicherweg: run() unveraendert, keine Suche.
 * Schalter EIN: Suche VOR dem Schreiben (der neue Eintrag kann sich nicht selbst finden), dann aehnlich/aehnlich_ergaenzen/
 * aehnlich_debug an die Antwort. Mit speicher_aehnlichkeit_pruefen und Treffern zu einer User-Idee ohne bestaetigt:true:
 * NICHT angelegt (success false, angelegt false, error aehnliche_eintraege_vorhanden).
 */
export async function mitSpeicherAehnlichkeit<T>(tool: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const ziel = speicherZiel(tool, args);
  const project = typeof args.project === 'string' ? args.project : '';
  if (!ziel || !project) return run();
  const schalter = await leseSpeicherAehnlichkeitSchalter(SPEICHER_AEHNLICHKEIT_FUNKTION, project);
  if (!schalter.aktiv) return run();
  const start = Date.now();
  const fehler = new Set<string>();
  const [einstellungen, schwelle] = await Promise.all([
    leseSpeicherAehnlichkeitEinstellungen(),
    speicherAehnlichkeitSchwelle().catch((e) => ({ schwelle: null, quelle: 'fehler', hinweis: String(e) })),
  ]);
  if (einstellungen.letzter_fehler) fehler.add(einstellungen.letzter_fehler);
  const w = einstellungen.werte;
  let treffer: AehnlicherEintrag[][] = ziel.eintraege.map(() => []);
  let hinweis: string | undefined;
  if (schwelle.schwelle === null) hinweis = 'Aehnlichkeitspruefung ohne Schwelle: ' + (schwelle.hinweis ?? schwelle.quelle);
  else {
    const s = schwelle.schwelle;
    const r = await mitZeitlimit(Promise.all(ziel.eintraege.map((e) => sucheAehnliche(project, e, ziel.quellen, s, w.max_treffer, w.vorschau_zeichen, fehler))), w.zeitlimit_ms);
    if (r === 'zeitlimit') hinweis = 'Aehnlichkeitspruefung nach ' + w.zeitlimit_ms + ' ms abgebrochen (Einstellwert zeitlimit_ms); gespeichert ohne Pruefung.';
    else treffer = r;
  }
  const userTreffer = ziel.eintraege.filter((e, i) => istUserIdee(e) && treffer[i].length);
  const pruefen = userTreffer.length ? await leseSpeicherAehnlichkeitSchalter(SPEICHER_AEHNLICHKEIT_PRUEFEN_FUNKTION, project) : null;
  const anzahl = treffer.reduce((n, t) => n + t.length, 0);
  const debug = (ergebnis: string) => 'speicher_aehnlichkeit an (' + schalter.quelle + (schalter.ebene ? '/' + schalter.ebene : '') + ')'
    + '; pruefen ' + (pruefen ? (pruefen.aktiv ? 'an' : 'aus') + ' (' + pruefen.quelle + ')' : 'nicht noetig')
    + '; schwelle ' + (schwelle.schwelle ?? '-') + ' (' + schwelle.quelle + '); quellen ' + ziel.quellen.join(',')
    + '; ' + ziel.eintraege.length + ' Eintrag/Eintraege, ' + anzahl + ' Treffer; ' + ergebnis + '; ' + (Date.now() - start) + ' ms'
    + (fehler.size ? '; fehler ' + [...fehler].join(' | ') : '');
  const aehnlichListe = ziel.batch
    ? ziel.eintraege.flatMap((e, i) => treffer[i].length ? [{ eintrag: e.index, treffer: treffer[i] }] : [])
    : treffer[0] ?? [];
  const ergaenzen = userTreffer.map((e) => ergaenzenText(treffer[ziel.eintraege.indexOf(e)][0]));
  if (pruefen?.aktiv && args.bestaetigt !== true) {
    return {
      success: false, angelegt: false, error: 'aehnliche_eintraege_vorhanden', aehnlich: aehnlichListe, aehnlich_ergaenzen: ergaenzen,
      message: 'Nicht angelegt: Zu dieser User-Idee gibt es schon aehnliche Eintraege. Vorhandenen Eintrag ergaenzen, oder bewusst neu anlegen mit bestaetigt:true.',
      aehnlich_debug: debug('nicht angelegt (pruefen_vor_anlegen)'),
    } as T;
  }
  const result = await run();
  if (!objekt(result)) return result;
  if (result.success === false) return { ...result, aehnlich_debug: debug('Speichern fehlgeschlagen') } as T;
  const felder: Record<string, unknown> = {};
  if (tool === 'plan') felder.aehnlich = planAehnlich(result, ziel, treffer);
  else if (anzahl) felder.aehnlich = aehnlichListe;
  if (felder.aehnlich === undefined) delete felder.aehnlich;
  if (ergaenzen.length) felder.aehnlich_ergaenzen = ergaenzen;
  if (hinweis && !result.aehnlich_hinweis) felder.aehnlich_hinweis = hinweis;
  felder.aehnlich_debug = debug(args.bestaetigt === true && userTreffer.length ? 'angelegt (bestaetigt)' : 'angelegt');
  return { ...result, ...felder } as T;
}

/** plan: Wissens-Treffer an das vorhandene aehnlich (Tasks, P22-T50) anhaengen; Batch je Task (task = Kurz-ID wie dort). */
function planAehnlich(result: Record<string, unknown>, ziel: SpeicherZiel, treffer: AehnlicherEintrag[][]): unknown {
  const vorhanden = Array.isArray(result.aehnlich) ? result.aehnlich as unknown[] : [];
  if (!ziel.batch) return treffer[0]?.length ? [...vorhanden, ...treffer[0]] : result.aehnlich;
  const tasks = liste(result.tasks);
  const gesammelt: Array<Record<string, unknown> & { treffer: unknown[] }> = vorhanden.filter(objekt)
    .map((a) => ({ ...a, treffer: Array.isArray(a.treffer) ? [...a.treffer] : [] }));
  ziel.eintraege.forEach((e, i) => {
    const t = tasks[e.index];
    if (!t || !treffer[i].length) return;
    const key = String(t.kurz_id ?? t.id);
    const eintrag = gesammelt.find((a) => a.task === key);
    if (eintrag) eintrag.treffer.push(...treffer[i]);
    else gesammelt.push({ task: key, treffer: [...treffer[i]] });
  });
  return gesammelt.length ? gesammelt : result.aehnlich;
}
