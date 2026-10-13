/**
 * MODUL: Intern-Ollama (P14-T3, 11.10.2026)
 * ZWECK: Das Ollama des Servers (OLLAMA_URL aus der Config) fuer das intern-Tool: Status, Modell aus dem
 *        VRAM entladen, Modell vorladen — z. B. um vor einer Messung qwen zu entladen und das
 *        Messmodell sauber zu laden.
 *
 * HTTP-API: GET /api/ps (geladen), /api/version, /api/tags (installiert), POST /api/show (capabilities),
 *   POST /api/embed bzw. /api/generate mit keep_alive (laden/entladen; leere Eingabe = nur laden).
 * GRENZEN: laedt nichts herunter, loescht nichts. Entladen nur, was laut /api/ps geladen ist — ein
 *   keep_alive-0-Aufruf auf ein nicht geladenes Modell wuerde es erst in den VRAM holen. Laden nur, was
 *   laut /api/tags installiert ist (sonst wuerde Ollama nichts tun bzw. einen Fehler melden).
 * CPU/GPU-ANTEIL: aus size_vram / size von /api/ps (so rechnet auch "ollama ps"). nvidia-smi-Werte gibt
 *   die Ollama-API nicht her; sie fehlen deshalb bewusst.
 */

import { getConfig } from '../config.js';
import { leseSchalter } from './intern-schalter.js';
import {computeAdmissionAktiv,mitComputeAdmissionKontext,mitComputeAdmission,observeLocalComputeModelAbsent,localComputeModelObservation} from './compute-admission.js';

export class InternOllamaFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface ModellDetails {
  family?: string;
  families?: string[] | null;
  parameter_size?: string;
  quantization_level?: string;
}
interface PsModell { name: string; size?: number; size_vram?: number; expires_at?: string; context_length?: number; details?: ModellDetails }
interface TagModell { name: string; size?: number; modified_at?: string; details?: ModellDetails }

export interface GeladenesModell {
  name: string;
  groesse_mb: number | null;
  vram_mb: number | null;
  gpu_prozent: number | null;
  cpu_prozent: number | null;
  kontext: number | null;
  laeuft_ab: string | null;
  parameter: string | null;
  quantisierung: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const mb = (bytes?: number): number | null => (bytes === undefined ? null : Math.round(bytes / 1024 / 1024));
/** Modellnamen vergleichen; ohne Tag meint Ollama :latest. */
const normal = (name: string): string => (name.includes(':') ? name : `${name}:latest`);
export const gleichesModell = (a: string, b: string): boolean => normal(a) === normal(b);

export function ollamaBasis(): string {
  return getConfig().embeddings.ollama.url.replace(/\/+$/, '');
}

async function ollama<T>(pfad: string, opt: { body?: unknown; zeitlimitMs?: number } = {}): Promise<T> {
  const gpu=opt.body!==undefined&&['/api/embed','/api/generate'].includes(pfad);
  const model=(opt.body as {model?:string}|undefined)?.model;
  const run=async(ended:()=>void):Promise<T>=>{
  let antwort: Response;
  try {
    antwort = await fetch(ollamaBasis() + pfad, {
      method: opt.body !== undefined ? 'POST' : 'GET',
      headers: opt.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
      signal: gpu&&computeAdmissionAktiv()?undefined:AbortSignal.timeout(opt.zeitlimitMs ?? 10_000),
    });
  } catch (err) {
    throw new InternOllamaFehler('ollama_nicht_erreichbar', `Ollama unter ${ollamaBasis()} nicht erreichbar (${pfad}): ${(err as Error).message}`);
  }
  const text = await antwort.text();
  ended();
  if (!antwort.ok) {
    throw new InternOllamaFehler('ollama_fehler', `Ollama ${pfad} -> HTTP ${antwort.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new InternOllamaFehler('ollama_fehler', `Ollama ${pfad}: Antwort ist kein JSON.`);
  }
  };
  return gpu?mitComputeAdmissionKontext({source:'intern-ollama',priority:'interaktiv'},()=>mitComputeAdmission(model??'',run,ollamaBasis())):run(()=>{});
}

/** Geladene Modelle wie "ollama ps". */
export async function geladeneModelle(): Promise<GeladenesModell[]> {
  const ps = await ollama<{ models?: PsModell[] }>('/api/ps');
  return (ps.models ?? []).map((m) => {
    const gpu = m.size && m.size > 0 && m.size_vram !== undefined ? Math.round((m.size_vram / m.size) * 100) : null;
    return {
      name: m.name,
      groesse_mb: mb(m.size),
      vram_mb: mb(m.size_vram),
      gpu_prozent: gpu,
      cpu_prozent: gpu === null ? null : 100 - gpu,
      kontext: m.context_length ?? null,
      laeuft_ab: m.expires_at ?? null,
      parameter: m.details?.parameter_size ?? null,
      quantisierung: m.details?.quantization_level ?? null,
    };
  });
}

/** capabilities aus /api/show (neuere Ollama-Versionen), null wenn nicht lieferbar. */
async function faehigkeiten(name: string): Promise<string[] | null> {
  try {
    const s = await ollama<{ capabilities?: string[] }>('/api/show', { body: { model: name }, zeitlimitMs: 5_000 });
    return Array.isArray(s.capabilities) ? s.capabilities : null;
  } catch {
    return null;
  }
}

/** Ersatz ohne capabilities: Name bzw. BERT-Familie. */
function klingtNachEmbedding(name: string, details?: ModellDetails): boolean {
  const familien = [...(details?.families ?? []), details?.family ?? ''];
  return /embed|bge|minilm|gte|e5-/i.test(name) || familien.some((f) => /bert/i.test(f));
}

async function istEmbeddingModell(name: string, details?: ModellDetails): Promise<{ ja: boolean; quelle: string }> {
  const cap = await faehigkeiten(name);
  return cap ? { ja: cap.includes('embedding'), quelle: 'capabilities' } : { ja: klingtNachEmbedding(name, details), quelle: 'name' };
}

export async function ollamaStatus(): Promise<Record<string, unknown>> {
  const [version, geladen, tags] = await Promise.all([
    ollama<{ version?: string }>('/api/version').then((v) => v.version ?? null).catch(() => null),
    geladeneModelle(),
    ollama<{ models?: TagModell[] }>('/api/tags'),
  ]);
  const installiert = tags.models ?? [];
  const embedding = await Promise.all(installiert.map(async (m) => {
    const art = await istEmbeddingModell(m.name, m.details);
    return art.ja
      ? {
        name: m.name,
        groesse_mb: mb(m.size),
        parameter: m.details?.parameter_size ?? null,
        quantisierung: m.details?.quantization_level ?? null,
        geladen: geladen.some((g) => gleichesModell(g.name, m.name)),
        erkannt_ueber: art.quelle,
      }
      : null;
  }));
  return {
    ollama_url: ollamaBasis(),
    version,
    konfiguriertes_modell: getConfig().embeddings.ollama.model,
    geladen,
    vram_belegt_mb: geladen.reduce((s, m) => s + (m.vram_mb ?? 0), 0),
    installiert_gesamt: installiert.length,
    embedding_modelle: embedding.filter((e) => e !== null),
  };
}

/** Nimmt ein geladenes Modell aus dem Speicher (keep_alive 0). Nicht geladene werden nicht angefasst. */
export async function ollamaEntladen(modell: string): Promise<Record<string, unknown>> {
  const vorher = await geladeneModelle();
  const treffer = vorher.find((m) => gleichesModell(m.name, modell));
  if (!treffer) {
    return {
      entladen: false,
      war_geladen: false,
      modell,
      geladen: vorher.map((m) => m.name),
      hinweis: `${modell} ist nicht geladen — nichts zu tun (ein Entlade-Aufruf wuerde es erst laden).`,
    };
  }
  const art = await istEmbeddingModell(treffer.name);
  // P15-T5 (Befund B, thought cfa61811): der Entlade-Aufruf wartet, bis Ollama laufende Anfragen des
  // Modells abgearbeitet hat - bei grossen Modellen unter Last laenger als die frueheren 30 s. Das
  // Zeitlimit kam als ollama_nicht_erreichbar zurueck, obwohl das Modell danach entladen WAR.
  // Jetzt: laengeres Zeitlimit, und ein Zeitlimit/Abbruch ist kein Fehler mehr, solange /api/ps
  // danach zeigt, dass das Modell weg ist. Entscheidend ist der Zustand, nicht die Antwort des Aufrufs.
  let aufrufHinweis: string | null = null;
  try {
    if (art.ja) await ollama('/api/embed', { body: { model: treffer.name, input: [], keep_alive: 0 }, zeitlimitMs: 120_000 });
    else await ollama('/api/generate', { body: { model: treffer.name, keep_alive: 0 }, zeitlimitMs: 120_000 });
  } catch (err) {
    if (!(err instanceof InternOllamaFehler) || err.code !== 'ollama_nicht_erreichbar') throw err;
    aufrufHinweis = err.message;
  }

  // Ollama entlaedt asynchron — bis 5 s nachsehen, nach einem Zeitlimit bis 30 s
  const admissionObservation=await localComputeModelObservation(treffer.name);
  let nachher = await geladeneModelle();
  const runden = aufrufHinweis ? 60 : 10;
  for (let i = 0; i < runden && nachher.some((m) => gleichesModell(m.name, treffer.name)); i++) {
    await sleep(500);
    nachher = await geladeneModelle();
  }
  const weg = !nachher.some((m) => gleichesModell(m.name, treffer.name));
  if(weg)await observeLocalComputeModelAbsent(treffer.name,admissionObservation);
  if (!weg && aufrufHinweis) {
    throw new InternOllamaFehler('entladen_zeitlimit',
      'Der Entlade-Aufruf lief ins Zeitlimit und das Modell ist nach 30 s noch geladen (laufende Anfragen?). Ollama selbst antwortet (/api/ps). Aufruf: ' + aufrufHinweis);
  }
  const ergebnis: Record<string, unknown> = {
    entladen: weg,
    war_geladen: true,
    modell: treffer.name,
    vram_frei_mb: weg ? treffer.vram_mb : 0,
    geladen: nachher.map((m) => m.name),
  };
  if (!weg) ergebnis.hinweis = 'Ollama meldet das Modell nach 5 s noch als geladen (laufende Anfragen?).';
  if (weg && aufrufHinweis) ergebnis.hinweis_aufruf = 'Der Entlade-Aufruf lief ins Zeitlimit, das Modell ist laut /api/ps aber entladen.';
  // Das Embedding-Modell des Servers kommt mit der naechsten Anfrage zurueck, solange der Schalter aus ist.
  if (weg && gleichesModell(treffer.name, getConfig().embeddings.ollama.model) && !(await leseSchalter('embedding')).aktiv) {
    ergebnis.hinweis_schalter = 'Das ist das konfigurierte Embedding-Modell und der Schalter embedding ist aus — die naechste Embedding-Anfrage laedt es wieder. Vorher intern(schalter_setzen, name embedding, aktiv true) setzen.';
  }
  return ergebnis;
}

/** Laedt ein installiertes Modell vor (leere Eingabe mit keep_alive) und misst die Ladezeit. */
export async function ollamaLaden(modell: string, keepAlive: string | number = '30m'): Promise<Record<string, unknown>> {
  const tags = await ollama<{ models?: TagModell[] }>('/api/tags');
  const installiert = (tags.models ?? []).find((m) => gleichesModell(m.name, modell));
  if (!installiert) {
    throw new InternOllamaFehler(
      'modell_nicht_installiert',
      `${modell} ist auf ${ollamaBasis()} nicht installiert. Herunterladen macht das intern-Tool bewusst nicht (ollama pull auf dem Server).`,
    );
  }
  const art = await istEmbeddingModell(installiert.name, installiert.details);
  const vorher = (await geladeneModelle()).some((m) => gleichesModell(m.name, installiert.name));
  const t0 = Date.now();
  if (art.ja) await ollama('/api/embed', { body: { model: installiert.name, input: [], keep_alive: keepAlive }, zeitlimitMs: 180_000 });
  else await ollama('/api/generate', { body: { model: installiert.name, keep_alive: keepAlive }, zeitlimitMs: 180_000 });
  const ladezeitMs = Date.now() - t0;
  const geladen = await geladeneModelle();
  const stand = geladen.find((m) => gleichesModell(m.name, installiert.name)) ?? null;
  return {
    geladen: stand !== null,
    war_schon_geladen: vorher,
    modell: installiert.name,
    art: art.ja ? 'embedding' : 'sprachmodell',
    ladezeit_ms: ladezeitMs,
    keep_alive: keepAlive,
    stand,
    alle_geladen: geladen.map((m) => m.name),
  };
}

/** Kurze deutsche Beispieltexte fuer embedding_messen (Passagen typischer Laenge, echte Umlaute). */
const BEISPIELTEXTE = [
  'Die Datenbank speichert jede Notiz zuerst in PostgreSQL, der Suchindex wird danach ergänzt.',
  'Der Parser liest eine TypeScript-Datei und legt Funktionen, Variablen und Aufrufkanten an.',
  'Ein Agent reserviert die Dateien, plant seine Änderungen und wartet auf die Freigabe.',
  'Wenn die Grafikkarte voll ist, lädt Ollama das Modell teilweise in den Arbeitsspeicher.',
  'Die Suche kombiniert Volltext und semantische Ähnlichkeit zu einer gemeinsamen Rangfolge.',
  'Nach dem Deploy prüft das Skript die Gesundheit des Dienstes und die Authentifizierung.',
  'Ein Thought hält eine kurze Beobachtung fest, ein Memory beschreibt eine Regel ausführlich.',
  'Der Hintergrund-Pool verhindert, dass Nachträge die Verbindungen der Anfragen belegen.',
  'Context7 liefert aktuelle Dokumentation zu Bibliotheken und zählt jeden Abruf gegen das Kontingent.',
  'Die Warteschlange gibt interaktiven Embeddings immer Vorrang vor der Hintergrundarbeit.',
  'Ein abgelaufener Schalter gilt als aus, die Zeile bleibt zur Einsicht in der Tabelle.',
  'Beim Entladen eines Modells wird der Grafikspeicher sofort für andere Aufgaben frei.',
];

/** P15-T5: Ollama-Optionen fuer embedding_messen, um wie im Betrieb zu messen. */
export interface MessOptionen {
  num_ctx?: number;
  num_batch?: number;
}

function positiveGanzzahl(wert: unknown): number | undefined {
  const n = Number(wert);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * num_ctx/num_batch: Angabe im Aufruf, sonst EMBEDDING_NUM_CTX/EMBEDDING_NUM_BATCH der Server-Env, sonst
 * weggelassen (Ollama nimmt den Standard des Modells). Kein Wert im Code (Regel
 * regel-keine-festverdrahteten-modellwerte); die Antwort nennt Wert und Quelle.
 */
function messOptionen(vorgabe: MessOptionen): { options: Record<string, number>; quelle: Record<string, string> } {
  const options: Record<string, number> = {};
  const quelle: Record<string, string> = {};
  for (const [feld, env] of [['num_ctx', 'EMBEDDING_NUM_CTX'], ['num_batch', 'EMBEDDING_NUM_BATCH']] as const) {
    const aufruf = positiveGanzzahl(vorgabe[feld]);
    const ausEnv = positiveGanzzahl(process.env[env]);
    if (aufruf !== undefined) { options[feld] = aufruf; quelle[feld] = 'aufruf'; }
    else if (ausEnv !== undefined) { options[feld] = ausEnv; quelle[feld] = env; }
    else quelle[feld] = 'weggelassen (Ollama-Standard des Modells)';
  }
  return { options, quelle };
}

/**
 * P14-T5: Testmessung eines Embedding-Modells DIREKT gegen Ollama (an der Synapse-Queue vorbei, nichts in
 * PG/Qdrant): Ladezeit (falls nicht geladen), Latenz je Passage (Median/Max/Min), Passagen/s einzeln und als
 * ein Batch, Dimension, danach der ps-Auszug des Modells. Warnt, wenn ein anderes Modell geladen ist oder
 * der Schalter embedding aus ist — beides verfaelscht die Messung. Das Modell bleibt 10 min geladen.
 */
export async function embeddingMessen(
  modell: string,
  anzahl = 20,
  praefix = '',
  vorgabe: MessOptionen = {},
): Promise<Record<string, unknown>> {
  const tags = await ollama<{ models?: TagModell[] }>('/api/tags');
  const installiert = (tags.models ?? []).find((m) => gleichesModell(m.name, modell));
  if (!installiert) {
    throw new InternOllamaFehler(
      'modell_nicht_installiert',
      `${modell} ist auf ${ollamaBasis()} nicht installiert. Herunterladen macht das intern-Tool bewusst nicht (ollama pull auf dem Server).`,
    );
  }
  const name = installiert.name;
  const { options, quelle } = messOptionen(vorgabe);
  const ollamaOptionen = Object.keys(options).length > 0 ? { options } : {};
  const warnungen: string[] = [];
  const art = await istEmbeddingModell(name, installiert.details);
  if (!art.ja) warnungen.push(`${name} meldet sich nicht als Embedding-Modell (erkannt ueber ${art.quelle}) — die Messung kann scheitern.`);
  if (!(await leseSchalter('embedding')).aktiv) {
    warnungen.push('Schalter embedding ist aus — Hintergrund-Embeddings koennen parallel laufen. Empfehlung: schalter_setzen(name embedding, aktiv true) vor der Messung.');
  }

  const vorher = await geladeneModelle();
  const warSchonGeladen = vorher.some((m) => gleichesModell(m.name, name));
  let ladezeitMs: number | null = null;
  if (!warSchonGeladen) {
    const t0 = Date.now();
    await ollama('/api/embed', { body: { model: name, input: [], keep_alive: '10m', ...ollamaOptionen }, zeitlimitMs: 180_000 });
    ladezeitMs = Date.now() - t0;
  }

  const n = BEISPIELTEXTE.length;
  const texte = Array.from({ length: anzahl }, (_, i) => `${praefix}${BEISPIELTEXTE[i % n]}${i >= n ? ` (${Math.floor(i / n) + 1})` : ''}`);
  const latenzen: number[] = [];
  let dimension: number | null = null;
  const tEinzeln = Date.now();
  for (const text of texte) {
    const t0 = Date.now();
    const r = await ollama<{ embeddings?: number[][] }>('/api/embed', { body: { model: name, input: text, keep_alive: '10m', ...ollamaOptionen }, zeitlimitMs: 120_000 });
    latenzen.push(Date.now() - t0);
    dimension = r.embeddings?.[0]?.length ?? dimension;
  }
  const einzelnMs = Math.max(1, Date.now() - tEinzeln);
  const tBatch = Date.now();
  const batch = await ollama<{ embeddings?: number[][] }>('/api/embed', { body: { model: name, input: texte, keep_alive: '10m', ...ollamaOptionen }, zeitlimitMs: 300_000 });
  const batchMs = Math.max(1, Date.now() - tBatch);
  if ((batch.embeddings?.length ?? 0) !== anzahl) warnungen.push('Die Batch-Antwort hat nicht so viele Vektoren wie Eingaben.');

  const sortiert = [...latenzen].sort((x, y) => x - y);
  const mitte = Math.floor(sortiert.length / 2);
  const median = sortiert.length % 2 ? sortiert[mitte] : Math.round((sortiert[mitte - 1] + sortiert[mitte]) / 2);
  const nachher = await geladeneModelle();
  const stand = nachher.find((m) => gleichesModell(m.name, name)) ?? null;
  const andere = [...new Set([...vorher, ...nachher].filter((m) => !gleichesModell(m.name, name)).map((m) => m.name))];
  if (andere.length > 0) {
    warnungen.push(`Waehrend der Messung war ein anderes Modell geladen (${andere.join(', ')}) — Modellwechsel bzw. geteilter VRAM verfaelscht die Messung. Empfehlung: Schalter embedding setzen und ollama_entladen.`);
  }
  if (stand?.gpu_prozent !== null && stand?.gpu_prozent !== undefined && stand.gpu_prozent < 100) {
    warnungen.push(`Das Modell laeuft nur zu ${stand.gpu_prozent} % auf der GPU (Rest CPU).`);
  }
  const proSekunde = (ms: number) => Math.round((anzahl / (ms / 1000)) * 100) / 100;
  return {
    modell: name,
    anzahl,
    praefix: praefix || null,
    optionen: { num_ctx: options.num_ctx ?? null, num_batch: options.num_batch ?? null, quelle },
    war_schon_geladen: warSchonGeladen,
    ladezeit_ms: ladezeitMs,
    dimension,
    einzeln: { median_ms: median, max_ms: sortiert[sortiert.length - 1], min_ms: sortiert[0], gesamt_ms: einzelnMs, passagen_pro_s: proSekunde(einzelnMs) },
    batch: { gesamt_ms: batchMs, passagen_pro_s: proSekunde(batchMs) },
    ollama_ps: stand,
    andere_geladen: andere,
    warnungen,
    hinweis: 'Direkt gegen Ollama gemessen, nichts in PG/Qdrant geschrieben. Das Modell bleibt 10 min geladen (ollama_entladen gibt es frei).',
  };
}
