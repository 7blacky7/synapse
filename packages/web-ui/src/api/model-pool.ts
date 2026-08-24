import { apiFetch } from './auth';

export type CostClass = 'free' | 'paid' | 'unknown';
export type Reachability = 'ready' | 'unverified' | 'blocked' | 'no_credential';
export type FreeType = 'recurring' | 'uncapped' | 'signup_credit' | 'keyless' | 'paid';
export type Decision = 'allow' | 'deny' | 'reset';

export interface PoolModel {
  ref: string;
  provider: string;
  modelId: string;
  name?: string;
  family: string | null;
  costClass: CostClass;
  priceInPerMTok: number | null;
  priceOutPerMTok: number | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  inputModalities: string[];
  /** Ob das Modell benutzt werden darf. */
  allowed: boolean;
  /** Standardregel oder ausdrueckliche Entscheidung. */
  allowedSource: 'default' | 'explicit';
  reachability: Reachability;
  reachabilityNote: string | null;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  deprecated: boolean;
  reasoningEfforts: string[];
  metadataSource: 'provider' | 'models.dev' | 'none';
  baseUrl: string;
  freeType: FreeType;
}

export interface PoolProvider {
  id: string;
  label: string;
  enabled: boolean;
  freeType: FreeType;
  baseUrl: string;
  envVar: string;
  credentialPresent: boolean;
  modelCount: number;
  freeCount: number;
  error: string | null;
  reachability: Reachability;
  reachabilityNote: string | null;
  probedAt: string | null;
  signupUrl?: string;
  note?: string;
}

export interface PoolCooldown {
  ref: string;
  until: string;
  reason: string;
  message: string;
}

async function lies(response: Response): Promise<string> {
  const fallback = response.status + ' ' + response.statusText;
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function anfrage<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await apiFetch(url, { ...init, headers });
  if (!response.ok) throw new Error(await lies(response));
  return response.json() as Promise<T>;
}

export interface ModelFilter {
  cost?: CostClass | 'any';
  provider?: string;
  query?: string;
  minContext?: number;
  capabilities?: string[];
  sort?: 'context' | 'name' | 'price';
  limit?: number;
  /** Nur aufrufbare und freigegebene Modelle. Standard: alles zeigen. */
  onlyUsable?: boolean;
}

export async function listModels(filter: ModelFilter = {}): Promise<{ models: PoolModel[]; matched: number; total: number; fetchedAt: string }> {
  const params = new URLSearchParams();
  if (filter.cost && filter.cost !== 'any') params.set('cost', filter.cost);
  if (filter.provider) params.set('provider', filter.provider);
  if (filter.query) params.set('query', filter.query);
  if (filter.minContext) params.set('min_context', String(filter.minContext));
  if (filter.capabilities?.length) params.set('capabilities', filter.capabilities.join(','));
  if (filter.sort) params.set('sort', filter.sort);
  if (filter.limit) params.set('limit', String(filter.limit));
  if (filter.onlyUsable) params.set('only_usable', 'true');
  const query = params.toString();
  return anfrage('/api/model-pool/models' + (query ? '?' + query : ''));
}

export async function listProviders(): Promise<{ providers: PoolProvider[] }> {
  return anfrage('/api/model-pool/providers');
}

/** Freigabe setzen. "reset" stellt die Standardregel wieder her. */
export async function setAllowed(ref: string, decision: Decision, reason?: string): Promise<{ model: PoolModel }> {
  return anfrage('/api/model-pool/allowed', {
    method: 'PUT',
    body: JSON.stringify({ ref, decision, ...(reason ? { reason } : {}) }),
  });
}

export async function setDataUse(ref: string, dataUse: 'private' | 'retained' | 'training' | 'unknown'): Promise<void> {
  await anfrage('/api/model-pool/data-use', { method: 'PUT', body: JSON.stringify({ ref, data_use: dataUse }) });
}

export async function probeProvider(provider: string): Promise<{ provider: PoolProvider }> {
  return anfrage('/api/model-pool/providers/' + encodeURIComponent(provider) + '/probe', { method: 'POST' });
}

export async function refreshCatalog(): Promise<{ models: number; free: number; fetchedAt: string }> {
  return anfrage('/api/model-pool/refresh', { method: 'POST' });
}

export async function listCooldowns(): Promise<{ cooldowns: PoolCooldown[] }> {
  return anfrage('/api/model-pool/cooldowns');
}

export async function clearCooldowns(): Promise<{ cleared: number }> {
  return anfrage('/api/model-pool/cooldowns', { method: 'DELETE' });
}
