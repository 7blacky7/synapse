/**
 * P13-T19/A1: gemeinsamer additiver API-Vertragskern für P13/P18/P20.
 * Fehlende/unsupported Version = Legacy, Metadaten niemals Rechenfreigabe.
 * Katalog und Aktivierung sind getrennt; Features sind kein geschlossenes Enum.
 */
export const API_CONTRACT_VERSION = 1;
export const API_CONTRACT_HEADER = 'x-synapse-contract-version';
export interface ApiContract {
  contractVersion: number;
  features: string[];
  capabilityRevision?: number;
  policyRevision?: number;
}
/** Nur Typen; Tabellen/Uploadrouten folgen in A2/A6/A7. */
export interface ApiUploadSitzung {
  bereich: 'projekt' | 'reverse';
  ziel_ref: string;
  /** Bereichsrelativ, niemals ein absoluter PC-Pfad. */
  logischer_pfad: string;
  groesse: number;
  sha256: string;
  offset: number;
  lease_bis: string;
  idempotency_key: string;
  status: string;
}
/** String-Revision erhält BIGINT-Werte ohne Präzisionsverlust. */
export interface ApiObjektReferenz {
  scope: string;
  id: string;
  revision: string;
  sha256: string;
}
export type ApiVertragUmgebung = Readonly<Record<string, string | undefined>>;
/** Serverkonfiguration ersetzt/erweitert diesen offenen Startkatalog. */
const START_FEATURE_KATALOG: readonly string[] = [
  'asset_sync', 'reverse_bibliothek', 'compute_resources', 'compute_control',
  'compute_cpu_only', 'tool_container', 'compute_admission',
];
function ids(roh: string | undefined): string[] {
  return [...new Set((roh ?? '').split(',').map(s => s.trim()).filter(Boolean))];
}
export function apiFeatureKatalog(env: ApiVertragUmgebung = process.env): ReadonlySet<string> {
  return new Set(env.SYNAPSE_API_FEATURE_CATALOG === undefined
    ? START_FEATURE_KATALOG : ids(env.SYNAPSE_API_FEATURE_CATALOG));
}
function revision(wert: unknown, feld: string): number {
  if (typeof wert !== 'number' || !Number.isSafeInteger(wert) || wert < 0) {
    throw new TypeError(feld + ' muss eine nichtnegative sichere Ganzzahl sein');
  }
  return wert;
}
/** Unbekannte IDs/Felder ignorieren; ungültige Felder unterstützter Version ablehnen. */
export function parseApiContract(
  eingang: unknown,
  knownFeatures: ReadonlySet<string>,
): ApiContract | undefined {
  if (eingang === undefined || eingang === null) return undefined;
  if (typeof eingang !== 'object' || Array.isArray(eingang)) throw new TypeError('API-Vertrag muss ein Objekt sein');
  const a = eingang as Record<string, unknown>;
  if (a.contractVersion === undefined) return undefined;
  const version = revision(a.contractVersion, 'contractVersion');
  if (version !== API_CONTRACT_VERSION) return undefined;
  const roh = a.features === undefined ? [] : a.features;
  if (!Array.isArray(roh) || roh.some(f => typeof f !== 'string' || !f.trim())) {
    throw new TypeError('features muss eine Liste nichtleerer String-IDs sein');
  }
  const features = [...new Set((roh as string[]).filter(f => knownFeatures.has(f)))];
  return {
    contractVersion: version, features,
    ...(a.capabilityRevision !== undefined ? { capabilityRevision: revision(a.capabilityRevision, 'capabilityRevision') } : {}),
    ...(a.policyRevision !== undefined ? { policyRevision: revision(a.policyRevision, 'policyRevision') } : {}),
  };
}
function envRevision(env: ApiVertragUmgebung, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError(key + ' muss eine nichtnegative Ganzzahl sein');
  return revision(Number(raw), key);
}
/**
 * Ohne explizite Client-Verhandlung keine Zusatzfelder. Neue Features default AUS.
 * SYNAPSE_API_FEATURE_CATALOG: CSV-Katalog; SYNAPSE_API_FEATURES: aktivierte CSV-IDs.
 * Revisionen: SYNAPSE_API_CAPABILITY_REVISION / SYNAPSE_API_POLICY_REVISION.
 * Unterstützung ist keine Freigabe: Consent/Token-/Projektprüfung bleibt separat.
 */
export function apiCapabilitiesForClient(
  requestedVersion: unknown,
  env: ApiVertragUmgebung = process.env,
): ApiContract | undefined {
  if (requestedVersion !== String(API_CONTRACT_VERSION)) return undefined;
  const capabilityRevision = envRevision(env, 'SYNAPSE_API_CAPABILITY_REVISION');
  const policyRevision = envRevision(env, 'SYNAPSE_API_POLICY_REVISION');
  return parseApiContract({
    contractVersion: API_CONTRACT_VERSION,
    features: ids(env.SYNAPSE_API_FEATURES),
    ...(capabilityRevision !== undefined ? { capabilityRevision } : {}),
    ...(policyRevision !== undefined ? { policyRevision } : {}),
  }, apiFeatureKatalog(env));
}
