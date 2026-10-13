import { apiFeatureKatalog, parseApiContract, type ApiContract, type ApiObjektReferenz, type ApiVertragUmgebung } from './api-vertrag.js';

/** Metadaten sind Beobachtungen, niemals Consent oder Admission. CPU-only bleibt separat gated. */
export interface ComputeMeasurement {
  value: number | null;
  measuredAt: string | null;
  serverReceivedAt: string;
  scope: 'host' | 'container' | 'device' | null;
  quality: 'measured' | 'estimated' | 'unknown';
  freshness: 'fresh' | 'stale' | 'unknown';
}
export interface ComputeResources {
  cpu: { cores: ComputeMeasurement; loadPercent: ComputeMeasurement };
  ram: { totalMb: ComputeMeasurement; availableMb: ComputeMeasurement };
  gpus: Array<{ deviceId: string; origin: string | null; totalMb: ComputeMeasurement; freeMb: ComputeMeasurement;
    residentOwnModelMb: ComputeMeasurement; utilizationPercent: ComputeMeasurement }>;
}
/** Clientberichte enthalten keine vom Server gefälschten Empfangs-/Frischezusagen. */
export type ComputeMeasurementReport = Omit<ComputeMeasurement, 'serverReceivedAt' | 'freshness'>;
export interface ComputeResourceReport {
  cpu?: Partial<Record<'cores' | 'loadPercent', ComputeMeasurementReport | null>>;
  ram?: Partial<Record<'totalMb' | 'availableMb', ComputeMeasurementReport | null>>;
  gpus?: Array<{ deviceId: string; origin?: string | null; totalMb?: ComputeMeasurementReport | null;
    freeMb?: ComputeMeasurementReport | null; residentOwnModelMb?: ComputeMeasurementReport | null;
    utilizationPercent?: ComputeMeasurementReport | null }>;
}
export interface ComputeCapability { id: string; profileRef: ApiObjektReferenz; parameters?: Record<string, unknown> }
export interface ComputeNodeExtension extends Partial<ApiContract> {
  location?: string; hostResourceDomain?: string; resources?: ComputeResourceReport; capabilities?: ComputeCapability[];
}
export interface NormalizedComputeNodeExtension extends Omit<ComputeNodeExtension, 'resources'> { resources?: ComputeResources }
export interface ComputeResourceBinding { hostResourceDomain: string; deviceIds: string[]; location?: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Objekt erwartet');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) throw new TypeError('Nichtleere ID erwartet');
  return value;
}
/**
 * Vom API-Betreiber gepflegte Zuordnung der vertrauenswürdig ausgegebenen node_id.
 * Client-host/ollamaUrl sind KEINE Herkunftsbeweise. Ohne Zuordnung keine ResourceDomain.
 * Mehrere Prozesse dürfen denselben domain/device-Schlüssel melden, niemals summieren.
 * SYNAPSE_COMPUTE_RESOURCE_BINDINGS = {"node-id":{"hostResourceDomain":"host-id","deviceIds":["GPU-uuid"],"location":"pc"}}
 */
export function computeResourceBinding(nodeId: string, env: ApiVertragUmgebung = process.env): ComputeResourceBinding | undefined {
  if (!env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS) return undefined;
  const all = object(JSON.parse(env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS));
  if (!Object.hasOwn(all, nodeId)) return undefined;
  const a = object(all[nodeId]);
  if (!Array.isArray(a.deviceIds)) throw new TypeError('deviceIds erwartet');
  return { hostResourceDomain: id(a.hostResourceDomain), deviceIds: [...new Set(a.deviceIds.map(id))],
    ...(a.location !== undefined ? { location: id(a.location) } : {}) };
}
export function computePhysicalDeviceKey(binding: ComputeResourceBinding, deviceId: string): string {
  if (!binding.deviceIds.includes(deviceId)) throw new TypeError('Ungebundenes Gerät');
  return JSON.stringify([binding.hostResourceDomain, deviceId]);
}
function measurement(raw: unknown, receivedAt: string, env: ApiVertragUmgebung, percentage = false, device = false): ComputeMeasurement {
  if (raw === undefined || raw === null) return { value: null, measuredAt: null, serverReceivedAt: receivedAt, scope: null, quality: 'unknown', freshness: 'unknown' };
  const a = object(raw);
  const value = a.value === undefined || a.value === null ? null : a.value;
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (percentage && value > 100))) throw new TypeError('Ungültiger Messwert');
  const scope = a.scope ?? null;
  if (scope !== null && !['host','container','device'].includes(String(scope))) throw new TypeError('Ungültiger Messscope');
  if (device && scope !== null && scope !== 'device') throw new TypeError('GPU-Messung braucht device-Scope');
  const quality = a.quality ?? 'unknown';
  if (!['unknown','measured','estimated'].includes(String(quality))) throw new TypeError('Ungültige Messqualität');
  const measuredAt = a.measuredAt === undefined || a.measuredAt === null ? null : String(a.measuredAt);
  const measuredMs = measuredAt === null ? NaN : Date.parse(measuredAt);
  if (measuredAt !== null && (!Number.isFinite(measuredMs) || measuredMs > Date.parse(receivedAt))) throw new TypeError('Ungültige Messzeit');
  if (value !== null && (scope === null || measuredAt === null || quality === 'unknown')) throw new TypeError('Messwert ohne Herkunft');
  const ttl = Number(env.SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS);
  const freshness = value === null || !Number.isFinite(measuredMs) || !(ttl > 0) ? 'unknown'
    : Date.parse(receivedAt) - measuredMs <= ttl ? 'fresh' : 'stale';
  // serverReceivedAt/freshness werden IMMER serverseitig gesetzt; fehlend bleibt unknown.
  return { value: value as number | null, measuredAt, serverReceivedAt: receivedAt, scope: scope as ComputeMeasurement['scope'],
    quality: value === null ? 'unknown' : quality as ComputeMeasurement['quality'], freshness };
}
export function parseComputeNodeExtension(raw: unknown, nodeId: string, env: ApiVertragUmgebung = process.env, receivedAt = new Date().toISOString()): NormalizedComputeNodeExtension | undefined {
  const a = object(raw);
  const contract = parseApiContract(a, apiFeatureKatalog(env));
  if (!contract) return undefined;
  const result: NormalizedComputeNodeExtension = { ...contract };
  const binding = computeResourceBinding(nodeId, env);
  if (a.hostResourceDomain !== undefined || a.location !== undefined || a.resources !== undefined) {
    if (!binding) throw new TypeError('Keine vertrauenswürdige Ressourcenbindung');
    if (a.hostResourceDomain !== undefined && a.hostResourceDomain !== binding.hostResourceDomain) throw new TypeError('Falsche ResourceDomain');
    if (a.location !== undefined && a.location !== binding.location) throw new TypeError('Falscher Standort');
    result.hostResourceDomain = binding.hostResourceDomain;
    if (binding.location !== undefined) result.location = binding.location;
  }
  if (a.resources !== undefined) {
    const r = object(a.resources), cpu = r.cpu === undefined ? {} : object(r.cpu), ram = r.ram === undefined ? {} : object(r.ram);
    const gpus = r.gpus ?? [];
    if (!Array.isArray(gpus)) throw new TypeError('GPU-Liste erwartet');
    const seen = new Set<string>();
    result.resources = {
      cpu: { cores: measurement(cpu.cores, receivedAt, env), loadPercent: measurement(cpu.loadPercent, receivedAt, env, true) },
      ram: { totalMb: measurement(ram.totalMb, receivedAt, env), availableMb: measurement(ram.availableMb, receivedAt, env) },
      gpus: gpus.map(rawGpu => {
        const g = object(rawGpu), deviceId = id(g.deviceId);
        if (!binding!.deviceIds.includes(deviceId) || seen.has(deviceId)) throw new TypeError('Ungebundenes/doppeltes Gerät');
        seen.add(deviceId);
        return { deviceId, origin: g.origin === undefined || g.origin === null ? null : id(g.origin),
          totalMb: measurement(g.totalMb, receivedAt, env, false, true), freeMb: measurement(g.freeMb, receivedAt, env, false, true),
          residentOwnModelMb: measurement(g.residentOwnModelMb, receivedAt, env, false, true),
          utilizationPercent: measurement(g.utilizationPercent, receivedAt, env, true, true) };
      }),
    };
  }
  if (a.capabilities !== undefined) {
    if (!Array.isArray(a.capabilities)) throw new TypeError('Fähigkeitsliste erwartet');
    const seen = new Set<string>();
    result.capabilities = a.capabilities.map(rawCapability => {
      const c = object(rawCapability), capabilityId = id(c.id), ref = object(c.profileRef);
      if (seen.has(capabilityId)) throw new TypeError('Doppelte Fähigkeit');
      seen.add(capabilityId);
      if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw new TypeError('Profilhash erwartet');
      return { id: capabilityId, profileRef: { scope: id(ref.scope), id: id(ref.id), revision: id(ref.revision), sha256: ref.sha256 },
        ...(c.parameters !== undefined ? { parameters: object(c.parameters) } : {}) };
    });
  }
  return result;
}
/** Frische beim Lesen neu bewerten: gespeicherte "fresh"-Werte sind keine dauerhafte Zusage. */
export function computeResourceSnapshot(resources: ComputeResources | null | undefined, nowMs = Date.now(), env: ApiVertragUmgebung = process.env): ComputeResources | null {
  if (!resources) return null;
  const ttl = Number(env.SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS);
  const refresh = (m: ComputeMeasurement): ComputeMeasurement => ({ ...m, freshness: m.value === null || !m.measuredAt || !(ttl > 0)
    ? 'unknown' : nowMs - Date.parse(m.measuredAt) <= ttl ? 'fresh' : 'stale' });
  return { cpu: { cores: refresh(resources.cpu.cores), loadPercent: refresh(resources.cpu.loadPercent) },
    ram: { totalMb: refresh(resources.ram.totalMb), availableMb: refresh(resources.ram.availableMb) },
    gpus: resources.gpus.map(g => ({ ...g, totalMb: refresh(g.totalMb), freeMb: refresh(g.freeMb),
      residentOwnModelMb: refresh(g.residentOwnModelMb), utilizationPercent: refresh(g.utilizationPercent) })) };
}
