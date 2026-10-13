#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {installComputeAdmissionClient,withComputeAdmissionFeature} from './admission.js';
import { renameSync, writeFileSync } from 'node:fs';
import { lokalerModellDigest, probeNodeCapabilities,gpuInfo, type EmbeddingReference } from './probe.js';
import {ComputeNodeControl} from './control.js';
import type {ComputeControlResponse} from '@synapse/core';

const token = process.env.SYNAPSE_API_TOKEN || '';
const heartbeatMs = Number(process.env.SYNAPSE_NODE_HEARTBEAT_MS) || 30_000;
const retryMs = Number(process.env.SYNAPSE_NODE_RETRY_MS) || 2_000;

/** HTTP nur auf Loopback und im privaten Netz (RFC 1918, IPv4-Literal) - wie der Tray selbst. */
function privatesNetz(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Prueft eine API-Adresse; liefert sie ohne Schraegstrich am Ende oder einen Grund fuer die Ablehnung. */
function pruefeApiUrl(roh: string): { url: string } | { fehler: string } {
  const url = roh.trim().replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { fehler: 'must be a valid absolute URL' };
  }
  const loopbackHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (loopbackHost || privatesNetz(parsed.hostname)))) {
    return { fehler: 'must use HTTPS (HTTP is allowed only on loopback or a private LAN address)' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { fehler: 'must not contain credentials, query parameters, or fragments' };
  }
  return { url };
}

if (!process.env.SYNAPSE_API_URL || !token) {
  console.error('SYNAPSE_API_URL and SYNAPSE_API_TOKEN are required');
  process.exit(1);
}

// P15-T11: Der Tray gibt die bevorzugte Adresse (synapse_api_url aus config.json, im LAN) als
// SYNAPSE_API_URL und den oeffentlichen Aussteller als SYNAPSE_API_URL_RUECKFALL. Gemessen am
// 11.10.2026: ueber Cloudflare 120-160 ms Antwortzeit je Anfrage, zwei Anfragen je Stapel.
// SYNAPSE_API_URL_ART sagt, was die bevorzugte Adresse ist ('lan' | 'oeffentlich'); der Rueckfall ist
// immer die oeffentliche Adresse des Ausstellers. Nur fuer die Statusanzeige, nicht fuer Entscheidungen.
const apiBasen: string[] = [];
const apiArten: string[] = [];
for (const [name, roh, art] of [
  ['SYNAPSE_API_URL', process.env.SYNAPSE_API_URL || '', process.env.SYNAPSE_API_URL_ART || 'oeffentlich'],
  ['SYNAPSE_API_URL_RUECKFALL', process.env.SYNAPSE_API_URL_RUECKFALL || '', 'oeffentlich'],
] as const) {
  if (!roh.trim()) continue;
  const geprueft = pruefeApiUrl(roh);
  if ('fehler' in geprueft) {
    console.error(`${name} ${geprueft.fehler} - Adresse wird nicht benutzt`);
    continue;
  }
  if (apiBasen.includes(geprueft.url)) continue;
  apiBasen.push(geprueft.url);
  apiArten.push(art);
}
if (apiBasen.length === 0) {
  console.error('Keine gueltige API-Adresse (SYNAPSE_API_URL / SYNAPSE_API_URL_RUECKFALL)');
  process.exit(1);
}
/** Index der Adresse, ueber die gerade gesprochen wird; 0 = bevorzugt. */
let aktiveBasis = 0;

/**
 * P15-T11: Status fuer Tray und KI (SYNAPSE_NODE_STATUS_DATEI, setzt der Tray): welche API-Adresse
 * gerade aktiv ist, ob der Rueckfall greift und mit welcher Embed-Pause der Helfer laeuft. Atomar
 * geschrieben (tmp + rename), bei jedem Adresswechsel und nach der Registrierung. Best effort.
 */
function statusSchreiben(): void {
  const datei = process.env.SYNAPSE_NODE_STATUS_DATEI;
  if (!datei) return;
  const pause = Number(process.env.EMBED_MIN_GAP_MS);
  const status = {
    pid: process.pid,
    adresse: apiBasen[aktiveBasis],
    art: apiArten[aktiveBasis],
    rueckfall_aktiv: aktiveBasis !== 0,
    adressen: apiBasen.map((url, i) => ({ url, art: apiArten[i] })),
    lan_bevorzugen: apiArten[0] === 'lan',
    embed_pause_ms: process.env.EMBED_MIN_GAP_MS !== undefined && process.env.EMBED_MIN_GAP_MS !== '' && Number.isFinite(pause) ? pause : null,
    aktualisiert: new Date().toISOString(),
  };
  try {
    writeFileSync(datei + '.tmp', JSON.stringify(status, null, 2));
    renameSync(datei + '.tmp', datei);
  } catch (error) {
    console.error('[ComputeNode] Statusdatei nicht schreibbar:', error);
  }
}

/** Verbindungsfehler, bei denen die Anfrage den Server sicher NICHT erreicht hat. */
function nichtAngekommen(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EAI_AGAIN';
}

/**
 * P15-T11: fetch gegen die API mit Rueckfall-Kette wie im Tray (api_client.go): Transportfehler und
 * 5xx schalten fuer die naechsten Aufrufe auf die andere Adresse. Hat die Anfrage den Server sicher
 * nicht erreicht (Verbindung abgelehnt, Name unbekannt), wird sie sofort ueber die andere Adresse
 * wiederholt - sonst nicht, damit ein Claim nie doppelt ausgefuehrt wird.
 */
async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  for (let versuch = 0; ; versuch++) {
    const index = aktiveBasis;
    const basis = apiBasen[index];
    const wechsle = (grund: string): void => {
      if (apiBasen.length < 2 || aktiveBasis !== index) return;
      aktiveBasis = (index + 1) % apiBasen.length;
      console.error(`[ComputeNode] API ${basis} ${grund}, weiter ueber ${apiBasen[aktiveBasis]}`);
      statusSchreiben();
    };
    try {
      const response = await fetch(basis + path, { ...init,headers:{authorization:`Bearer ${token}`,'x-synapse-contract-version':'1',...init.headers}, signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (response.status >= 500) wechsle(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      wechsle('nicht erreichbar');
      if (versuch === 0 && apiBasen.length > 1 && nichtAngekommen(error)) continue;
      throw error;
    }
  }
}

// Der Compute-Prozess ist strikt lokal: kein getEmbeddingProvider() und damit
// kein stiller OpenAI-Fallback. Die Stapelgroesse des Knotens (P15-T9) legt der
// Server bei der Registrierung fest und veraendert EMBED_MAX_CONCURRENT nicht.
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.SYNAPSE_COMPUTE_NODE = '1';

interface EmbeddingClaim {
  chunkId: string;
  claimToken: string;
  content: string;
  contentHash: string;
}

interface ClaimResponse {
  control?:ComputeControlResponse;
  claims?: EmbeddingClaim[];
  reference?: EmbeddingReference;
}

interface RegisterResponse {
  control?:ComputeControlResponse;
  /** P15-T9: vom Server autorisierte Zahl gleichzeitig offener Claims dieses Knotens. */
  claimBatch?: number;
}

interface StapelAbschlussResponse {
  abgeschlossen?: string[];
  abgelehnt?: Array<{ chunkId: string; grund: string }>;
}

type Faehigkeit = Awaited<ReturnType<typeof probeNodeCapabilities>>;
type Fingerprint = Pick<EmbeddingReference, 'model' | 'modelDigest' | 'nativeDimension' | 'targetDimension' | 'numCtx' | 'quantization'>;

function digestNormal(digest: string | null | undefined): string {
  return (digest ?? '').toLowerCase().replace(/^sha256:/, '');
}

function sameFingerprint(capability: Faehigkeit, reference: Fingerprint): boolean {
  return capability.model === reference.model &&
    digestNormal(capability.modelDigest) === digestNormal(reference.modelDigest) &&
    capability.nativeDimension === reference.nativeDimension &&
    capability.targetDimension === reference.targetDimension &&
    capability.numCtx === reference.numCtx &&
    (!reference.quantization || capability.quantization === reference.quantization);
}

/** Schluessel der Vertragsfelder, die den Fingerprint bestimmen - aendert er sich, wird neu gemessen. */
function fingerprintSchluessel(reference: Fingerprint): string {
  return JSON.stringify([reference.model, digestNormal(reference.modelDigest), reference.nativeDimension,
    reference.targetDimension, reference.numCtx, reference.quantization ?? null]);
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Synapse API ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * P15-T6: Referenzvertrag der API (oeffentlich, ohne Token). Ohne erreichbare API gibt es KEINE
 * Altwerte — der Aufrufer meldet den Fehler und versucht es spaeter erneut.
 */
async function holeReferenz(): Promise<EmbeddingReference> {
  const response = await apiFetch('/api/embedding-nodes/reference', { method: 'GET' });
  const payload = await response.json().catch(() => ({})) as { reference?: EmbeddingReference };
  if (!response.ok || !payload.reference) {
    throw new Error('Referenzvertrag der API nicht abrufbar (HTTP ' + response.status + '): ' + JSON.stringify(payload));
  }
  return payload.reference;
}

/**
 * P15-T11: Laeuft der Knoten ueber die Rueckfall-Adresse, probiert der Heartbeat die bevorzugte
 * (LAN) wieder - sonst bliebe er nach einem kurzen LAN-Aussetzer dauerhaft auf dem Tunnel.
 */
async function zurueckZurBevorzugtenBasis(): Promise<void> {
  if (aktiveBasis === 0) return;
  try {
    const response = await fetch(apiBasen[0] + '/api/embedding-nodes/reference', {
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (response.ok) {
      aktiveBasis = 0;
      console.error(`[ComputeNode] API ${apiBasen[0]} wieder erreichbar, zurueck auf die bevorzugte Adresse`);
      statusSchreiben();
    }
  } catch {
    // weiter ueber die Rueckfall-Adresse
  }
}

/**
 * core/embed() liest Modell, Zieldimension, num_ctx, Praefixe und Stueckgroesse aus der Env (OLLAMA_MODEL,
 * EMBEDDING_TARGET_DIM, EMBEDDING_NUM_CTX, EMBEDDING_QUERY_PREFIX/_DOC_PREFIX, EMBEDDING_MAX_INPUT_CHARS). Der Knoten setzt sie aus dem Vertrag, BEVOR core
 * geladen wird — so rechnet er genau das, was er meldet, ohne eigene Vorgaben.
 */
function uebernehmeReferenz(reference: EmbeddingReference): void {
  // P15-T8: Praefixe und Stueckgroesse kommen aus dem Modellprofil der API. Fehlen sie (API vor
  // P15-T8), wuerde der Knoten ohne Praefix andere Vektoren rechnen als der Server -> nicht starten.
  if (typeof reference.queryPraefix !== 'string' || typeof reference.dokPraefix !== 'string') {
    throw new Error('Referenzvertrag ohne queryPraefix/dokPraefix (API zu alt oder Modell nicht kalibriert) - Knoten startet nicht.');
  }
  process.env.OLLAMA_MODEL = reference.model;
  process.env.EMBEDDING_TARGET_DIM = String(reference.targetDimension);
  process.env.EMBEDDING_NUM_CTX = String(reference.numCtx);
  process.env.EMBEDDING_QUERY_PREFIX = reference.queryPraefix;
  process.env.EMBEDDING_DOC_PREFIX = reference.dokPraefix;
  if (reference.maxStueckZeichen) process.env.EMBEDDING_MAX_INPUT_CHARS = String(reference.maxStueckZeichen);
  else delete process.env.EMBEDDING_MAX_INPUT_CHARS;
}

/** Hat sich der Vertrag in einem Punkt geaendert, den core beim Laden uebernommen hat? */
function vertragGewechselt(alt: EmbeddingReference, neu: EmbeddingReference): boolean {
  return alt.model !== neu.model || alt.targetDimension !== neu.targetDimension || alt.numCtx !== neu.numCtx
    || alt.queryPraefix !== neu.queryPraefix || alt.dokPraefix !== neu.dokPraefix || alt.maxStueckZeichen !== neu.maxStueckZeichen;
}

const bootId = randomUUID();
const bootStartedAt = new Date().toISOString();
let sequence = 0;
let stopped = false;
let activeJobs = 0;
let claimRequests=0;
let uncertainClaims=0; // verlorene Claimantwort ist keine bestätigte Rückgabe
let capabilities: Faehigkeit | null = null;
let startReferenz: EmbeddingReference | null = null;
let claimBatch = 0;
let control:ComputeNodeControl|undefined;
/** P15-T9: Claims, die dieser Prozess gerade haelt (vorausgeholt, in Arbeit, im Abschluss) - beim Beenden gehen ALLE zurueck. */
const offeneClaims = new Map<string, string>();

/**
 * P15-T9: Gibt eigene Claims an den Server zurueck (geordnetes Beenden, gescheiterter Stapel). Ohne das
 * blieben sie bis zum Lease-Ende (bis 15 min) blockiert. Best effort: ein Fehler wird gemeldet, nicht geworfen.
 */
async function gibClaimsFrei(claims: Array<{ chunkId: string; claimToken: string }>): Promise<boolean> {
  if(claims.length===0)return true;if(!capabilities)return false;
  try{
    await api(`/api/embedding-nodes/${encodeURIComponent(capabilities.nodeId)}/claims/release`,{claims});
    return true;
  }catch(error){
    console.error('[ComputeNode] claim release failed (lease expires on its own):',error);
    return false;
  }
}

let beendet = false;
const stop = (): void => {
  stopped = true;
  if (beendet) return;
  beendet = true;
  // Geordnetes Beenden (Tray "Helfer stoppen", SIGTERM): offene Claims zurueckgeben, dann raus.
  const offen = [...offeneClaims].map(([chunkId, claimToken]) => ({ chunkId, claimToken }));
  void gibClaimsFrei(offen).finally(() => {
    if (offen.length > 0) console.error(`[ComputeNode] ${offen.length} offene Claims beim Beenden freigegeben`);
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopped) {
  try {
    // P15-T6: erst der Vertrag der API, dann die Messung dagegen.
    const reference = await holeReferenz();
    uebernehmeReferenz(reference);
    // Einzige Stelle mit harter Schwellenpruefung: vor der Registrierung.
    capabilities = await probeNodeCapabilities(reference, true);
    startReferenz = reference;
    const antwort = await api<RegisterResponse>('/api/embedding-nodes/register', withComputeAdmissionFeature({ ...capabilities, bootId, bootStartedAt }));
    await installComputeAdmissionClient({nodeId:capabilities.nodeId,bootId,transport:apiFetch,stopped:()=>stopped||!!control&&!control.canClaim()});
    // P15-T9: die Kapazitaet kommt vom Server (SYNAPSE_NODE_MAX_CLAIMS bzw. unser Wunsch) - kein eigener Default.
    if (!Number.isInteger(antwort.claimBatch) || (antwort.claimBatch as number) <= 0) {
      throw new Error('Registrierung ohne claimBatch (API zu alt?) - Knoten arbeitet nicht mit geratener Stapelgroesse.');
    }
    claimBatch = antwort.claimBatch as number;
    if(capabilities.deviceId){
      const device=capabilities.deviceId;
      const {parseComputeControlCommand}=await import('@synapse/core');
      control=new ComputeNodeControl(bootId,device,capabilities.model,capabilities.modelDigest,capabilities.ollamaUrl,
       async()=>{const gpu=await gpuInfo();return gpu.deviceId===device&&!!gpu.name&&gpu.totalMb>0;},parseComputeControlCommand);
      control.receive(antwort.control);
    }else if(antwort.control)throw Error('control_device_missing');
    break;
  } catch (error) {
    console.error('[ComputeNode] registration failed, retrying:', error);
    await sleep(heartbeatMs);
  }
}

if (!capabilities) process.exit(0);

const { embedBatch } = await import('@synapse/core');
const registered = capabilities;
const registrierteReferenz = startReferenz!;

/**
 * P15-T11: Vorausholen. claimBatch ist die vom Server autorisierte Zahl GLEICHZEITIG offener Claims
 * (embedding-claims.ts: capacity = maxConcurrent - aktive Claims). Damit der naechste Stapel geclaimt
 * werden kann, waehrend der aktuelle rechnet, holt der Knoten Stapel der halben Kapazitaet - zwei
 * Stapel zusammen bleiben innerhalb der Server-Grenze, und die Bedeutung von SYNAPSE_NODE_MAX_CLAIMS
 * ("so viele Claims haelt ein Knoten hoechstens") bleibt unveraendert. Wer 16er-Stapel will, setzt
 * die Kapazitaet auf das Doppelte. Bei Kapazitaet 1 gibt es nichts zu teilen: dann seriell.
 */
const vorlaufTiefe = claimBatch >= 2 ? 2 : 1;
const stapelGroesse = Math.floor(claimBatch / vorlaufTiefe);
console.error(`[ComputeNode] registered ${registered.nodeId} (${registered.modelDigest}) via ${apiBasen[aktiveBasis]}, ` +
  `claimBatch ${claimBatch} -> Stapel ${stapelGroesse}, ${vorlaufTiefe === 2 ? 'mit Vorausholen' : 'ohne Vorausholen'}`);
statusSchreiben();

/**
 * P15-T11: Stand der letzten VOLLEN Modellpruefung (nvidia-smi, /api/tags, /api/show) gegen den Vertrag.
 * Bis P15-T9 lief sie vor UND nach jedem Stapel (gemessen ca. 40 ms je Stapel). Jetzt:
 * - beim Start (Registrierung),
 * - wenn der Vertrag in der Claim-Antwort einen anderen Fingerprint traegt,
 * - periodisch (spaetestens nach heartbeatMs),
 * - nach jedem Fehler (vollpruefungFaellig).
 * Je Stapel bleibt die Digest-Pruefung NACH dem Rechnen (lokalerModellDigest, ein /api/tags): ein
 * Modellwechsel waehrend des Rechnens faellt damit weiter vor dem Abschluss auf, der Stapel wird
 * freigegeben statt mit falschen Vektoren gemeldet.
 */
let geprueft: { faehigkeit: Faehigkeit; schluessel: string; zeit: number } | null =
  sameFingerprint(registered, registrierteReferenz)
    ? { faehigkeit: registered, schluessel: fingerprintSchluessel(registrierteReferenz), zeit: Date.now() }
    : null;
let vollpruefungFaellig = false;

async function sichereModell(reference: EmbeddingReference): Promise<Faehigkeit> {
  const schluessel = fingerprintSchluessel(reference);
  if (geprueft && !vollpruefungFaellig && geprueft.schluessel === schluessel && Date.now() - geprueft.zeit < heartbeatMs) {
    return geprueft.faehigkeit;
  }
  const faehigkeit = await probeNodeCapabilities(reference);
  if (!sameFingerprint(faehigkeit, reference)) {
    geprueft = null;
    vollpruefungFaellig = true;
    throw new Error('local model fingerprint differs from claim reference');
  }
  geprueft = { faehigkeit, schluessel, zeit: Date.now() };
  vollpruefungFaellig = false;
  return faehigkeit;
}

async function heartbeatLoop(): Promise<void> {
  while (!stopped) {
    await sleep(heartbeatMs);
    if (stopped) return;
    try {
      await zurueckZurBevorzugtenBasis();
      const reference = await holeReferenz();
      if (vertragGewechselt(registrierteReferenz, reference)) {
        // core hat Modell/Dimension/num_ctx beim Laden uebernommen -> sauber neu starten statt
        // mit dem alten Stand weiterzurechnen. Der Dienst-Supervisor startet den Agenten neu.
        console.error('[ComputeNode] Referenzvertrag der API hat sich geaendert, Agent beendet sich fuer einen Neustart:',
          JSON.stringify({ alt: registrierteReferenz, neu: reference }));
        stop();
        return;
      }
      await control?.settle(offeneClaims.size+claimRequests+uncertainClaims);
      const current = await probeNodeCapabilities(reference);
      if (!sameFingerprint(current, reference)) vollpruefungFaellig = true;
      const heartbeat=await api<{control?:ComputeControlResponse}>(`/api/embedding-nodes/${encodeURIComponent(registered.nodeId)}/heartbeat`, {
        contractVersion:1,features:withComputeAdmissionFeature(current).features,resources:current.resources,
        ...(control?.report()?{controlObservation:control.report()}:{}),
        status: activeJobs > 0 ? 'busy' : 'ready',
        vramFreeMb: current.vramFreeMb,
        activeJobs,
        bootId,
        sequence: ++sequence,
        model: current.model,
        modelDigest: current.modelDigest,
        quantization: current.quantization,
        nativeDimension: current.nativeDimension,
        targetDimension: current.targetDimension,
        numCtx: current.numCtx,
      });
      control?.receive(heartbeat.control);
    } catch (error) {
      console.error('[ComputeNode] heartbeat failed, will retry:', error);
    }
  }
}

interface Stapel {
  claims: EmbeddingClaim[];
  reference: EmbeddingReference;
}

/** Claims eines Stapels, die noch offen sind, aus der Verfolgung nehmen und an den Server zurueckgeben. */
async function gibStapelFrei(claims: EmbeddingClaim[]): Promise<void> {
  const haengend = claims.filter((c) => offeneClaims.has(c.chunkId));
  if(await gibClaimsFrei(haengend.map((c) => ({ chunkId: c.chunkId, claimToken: c.claimToken }))))
    for(const c of haengend)offeneClaims.delete(c.chunkId);
}

/** Holt einen Stapel; null = nichts frei. Jeder Claim wird SOFORT verfolgt (SIGTERM gibt ihn frei). */
async function holeStapel(): Promise<Stapel | null> {
  if(control&&!control.canClaim())return null;
  claimRequests++;
  try{
  let response:ClaimResponse;
  try{response = await api<ClaimResponse>(
    `/api/embedding-nodes/${encodeURIComponent(registered.nodeId)}/claims`,
    { limit: stapelGroesse,bootId },
  );}catch(error){
    if(!(error instanceof Error)||!/^Synapse API [0-9]+:/.test(error.message))uncertainClaims++;
    throw error;
  }
  const claims = response.claims ?? [];
  for (const c of claims) offeneClaims.set(c.chunkId, c.claimToken);
  try{control?.receive(response.control);}catch(error){await gibStapelFrei(claims);throw error;}
  if (claims.length === 0) return null;
  if(control&&!control.canClaim()){await gibStapelFrei(claims);return null;}
  if (!response.reference) {
    await gibStapelFrei(claims);
    throw new Error('claim response has no embedding reference');
  }
  return { claims, reference: response.reference };
  }finally{claimRequests--;}
}

/**
 * Abschluss eines gerechneten Stapels: Digest-Pruefung, dann EIN Stapel-Abschluss. Wirft nie - ein
 * Fehler gibt die Claims frei und erzwingt vor dem naechsten Stapel eine volle Modellpruefung.
 */
async function schliesseAb(stapel: Stapel, vectors: number[][], faehigkeit: Faehigkeit): Promise<void> {
  try {
    const digest = await lokalerModellDigest(faehigkeit.model);
    if (digestNormal(digest) !== digestNormal(faehigkeit.modelDigest)) {
      throw new Error('local model fingerprint changed while embedding');
    }
    const ergebnis = await api<StapelAbschlussResponse>(
      `/api/embedding-nodes/${encodeURIComponent(registered.nodeId)}/claims/complete`,
      {
        items: stapel.claims.map((c, i) => ({
          chunkId: c.chunkId,
          claimToken: c.claimToken,
          contentHash: c.contentHash,
          vector: vectors[i],
        })),
        model: faehigkeit.model,
        modelDigest: faehigkeit.modelDigest,
        quantization: faehigkeit.quantization,
        nativeDimension: faehigkeit.nativeDimension,
        targetDimension: faehigkeit.targetDimension,
        numCtx: faehigkeit.numCtx,
      },
    );
    // Abgelehnte gibt der Server selbst frei; aus unserer Sicht ist der ganze Stapel erledigt.
    for (const c of stapel.claims) offeneClaims.delete(c.chunkId);
    if ((ergebnis.abgelehnt?.length ?? 0) > 0) {
      console.error(`[ComputeNode] ${ergebnis.abgelehnt!.length} von ${stapel.claims.length} abgelehnt, z. B. ${ergebnis.abgelehnt![0].grund}`);
    }
  } catch (error) {
    console.error('[ComputeNode] batch completion failed, releasing claims:', error);
    vollpruefungFaellig = true;
    await gibStapelFrei(stapel.claims);
  }
}

/**
 * P15-T9/P15-T11: Stapel-Schleife mit Vorausholen. Waehrend Stapel N in Ollama rechnet, laufen
 * nacheinander der Abschluss von Stapel N-1 (gibt dessen Kapazitaet frei) und der Claim von Stapel
 * N+1. Ollama-Aufrufe bleiben seriell (llama-server rechnet ohnehin nur einen gleichzeitig) - es
 * ueberlappen nur Netz, Server und Pruefungen mit der GPU. Gemessen vorher (P15-T9, 11.10.2026):
 * Zyklus 1092 ms, davon 660-840 ms GPU, ca. 30 % GPU-Leerlauf.
 */
async function claimLoop(): Promise<void> {
  // Wartezeit waechst, solange es nichts zu holen gibt, und faellt beim ersten
  // Treffer sofort zurueck. Grund (User-Vorgabe 01.08.2026): ein Knoten ohne
  // Arbeit soll pausieren statt anzuklopfen — gemessen wurden 16 ergebnislose
  // Anfragen in 20 Sekunden, die nur das Serverlog fuellten.
  // ⚠️ Der Backoff verschweigt KEINEN Fehler: er greift nur bei einer leeren
  // Antwort ("nichts frei"), nicht bei einer abgelehnten. Wer ihn benutzt, um
  // 403-Ketten leiser zu machen, verdeckt den eigentlichen Befund.
  const wartezeitMax = Number(process.env.SYNAPSE_NODE_IDLE_MAX_MS) || 60_000;
  let wartezeit = retryMs;
  let vorrat: Stapel | null = null;
  let abschluss: Promise<void> = Promise.resolve();
  while (!stopped) {
    if(control&&!control.canClaim()){
      await abschluss;
      if(vorrat){await gibStapelFrei(vorrat.claims);vorrat=null;}
      if(offeneClaims.size)await gibStapelFrei([...offeneClaims].map(([chunkId,claimToken])=>({chunkId,claimToken,content:'',contentHash:''})));
      await control.settle(offeneClaims.size+claimRequests+uncertainClaims);
      await sleep(retryMs);continue;
    }
    if (!vorrat) {
      try {
        vorrat = await holeStapel();
      } catch (error) {
        console.error('[ComputeNode] claim failed, retrying:', error);
        await sleep(retryMs);
        continue;
      }
      if (!vorrat) {
        await sleep(wartezeit);
        wartezeit = Math.min(wartezeit * 2, wartezeitMax);
        continue;
      }
    }
    wartezeit = retryMs;
    const aktuell: Stapel = vorrat;
    vorrat = null;

    let faehigkeit: Faehigkeit;
    try {
      faehigkeit = await sichereModell(aktuell.reference);
    } catch (error) {
      console.error('[ComputeNode] model check failed, releasing claims and retrying:', error);
      await gibStapelFrei(aktuell.claims);
      await sleep(retryMs);
      continue;
    }

    if(control&&!control.begin()){await gibStapelFrei(aktuell.claims);continue;}
    // Vorausholen: erst den vorherigen Abschluss fertig senden (Kapazitaet), dann den naechsten Stapel.
    // Ein Fehler hier kostet nur den Vorlauf - der naechste Durchlauf claimt dann selbst.
    const voraus: Promise<Stapel | null> = vorlaufTiefe > 1
      ? abschluss
        .then(() => (stopped ? null : holeStapel()))
        .catch((error) => {
          console.error('[ComputeNode] prefetch claim failed:', error);
          return null;
        })
      : Promise.resolve(null);

    activeJobs += aktuell.claims.length;
    let vectors: number[][] | null = null;
    try {
      vectors = await embedBatch(aktuell.claims.map((c) => c.content), {
        priority: 'background',
        strictOllama: true,
        admissionSource:'compute-node',
        admissionClaims:aktuell.claims.map(c=>({chunkId:c.chunkId,claimToken:c.claimToken,contentHash:c.contentHash})),
      });
    } catch (error) {
      console.error('[ComputeNode] embedding failed, releasing claims and retrying:', error);
      vollpruefungFaellig = true;
    } finally {
      activeJobs -= aktuell.claims.length;
    }

    vorrat = await voraus;
    if (vectors) {
      abschluss = schliesseAb(aktuell, vectors, faehigkeit).finally(()=>control?.end());
      // Ohne Vorausholen reicht die Kapazitaet nur fuer einen Stapel: erst abschliessen, dann weiter.
      if (vorlaufTiefe === 1) await abschluss;
    } else {
      await gibStapelFrei(aktuell.claims);
      control?.end();
      await sleep(retryMs);
    }
  }
}

await Promise.all([heartbeatLoop(), claimLoop()]);
