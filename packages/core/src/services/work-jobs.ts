/**
 * P20-T14/R2.1: additive PG-Job-Leases. Kein Executor/Admission-Gate.
 * Policy/Input-/Staging-Hooks sind serverseitig und PG-only. Fehlende Hooks sperren Claims.
 * Lockreihenfolge: Host -> Knoten -> Registry -> Job -> fachliche Input-/Output-Authority.
 * Keine HTTP-/Docker-/Dateioperationen unter diesen Locks.
 * Eine abgelaufene Lease ist nur ein logischer Fence, niemals ein physischer Freigabenachweis.
 */
import { createHash, randomUUID } from 'node:crypto';
import {computePolicyAktiv,pruefeComputeZuteilung} from './compute-policy.js';
import { getPool } from '../db/client.js';
import {lockComputeAdmissionDomain,computeAdmissionAllowsWork} from './compute-admission.js';
import {lockWorkJobClaimGuards,allowWorkJobClaim} from './work-job-guards.js';
import type { ApiObjektReferenz } from '../vertrag/api-vertrag.js';

export interface WorkJobResult<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[]; rowCount?: number | null;
}
export interface WorkNodeAuthority extends Record<string, unknown> {
  node_id: string; boot_id: string; service_token_hash: string; status: string;
  gesperrt_vom_user: boolean; letzter_kontakt: Date; work_now: Date;
}
interface WorkJobRow extends Record<string, unknown> {
  id: string; kind: string; capability: string; profile_id: string | null; project: string; scope: string;
  input_ref: ApiObjektReferenz; resource_need: WorkResourceNeed; priority: WorkPriority; state: string;
  owner_node: string | null; boot_generation: string | null; owner_auth_hash: string | null;
  resource_domain: string | null; claim_token: string | null; attempt: number;
  lease_until: Date | null; deadline: Date | null; staged_output_ref: ApiObjektReferenz | null;
  output_ref: ApiObjektReferenz | null; error_code: string | null; resource_unconfirmed: boolean;
  request_hash: string; created_at: Date; updated_at: Date; work_now: Date;
}
export interface WorkJobClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<WorkJobResult<T>>;
  release(): void;
}
export interface WorkJobPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<WorkJobResult<T>>;
  connect(): Promise<WorkJobClient>;
}
export type WorkPriority = 'interaktiv' | 'hintergrund' | 'nachzug';
export interface WorkResourceNeed { cpu: number; ram: number; vram: number; gpu: boolean }
export interface WorkJobInput {
  kind: string; capability: string; profileId?: string | null; project: string; scope: string;
  inputRef: ApiObjektReferenz; resourceNeed: WorkResourceNeed; priority?: WorkPriority;
  idempotencyKey: string; deadline?: string | null;
}
export interface WorkJob {
  id: string; kind: string; capability: string; profileId: string | null; project: string; scope: string;
  inputRef: ApiObjektReferenz; resourceNeed: WorkResourceNeed; priority: WorkPriority;
  state: string; ownerNode: string | null; bootGeneration: string | null;
  claimToken: string | null; attempt: number; leaseUntil: string | null; deadline: string | null;
  stagedOutputRef: ApiObjektReferenz | null; outputRef: ApiObjektReferenz | null;
  resourceDomain: string | null; resourceUnconfirmed: boolean; errorCode: string | null;
  createdAt: string; updatedAt: string;
}
export interface WorkIdentity { nodeId: string; bootGeneration: string; authHash: string }
export interface WorkJobGrant { resourceDomain: string; maxConcurrent: number; budget: WorkResourceNeed }
export interface WorkJobConfig {
  leaseSeconds: number; maxLeaseSeconds: number; agingSeconds: number;
  interactiveReserve: number; maxClaimsPerCall: number; scanLimit: number; nodeFreshnessSeconds: number;
}
export interface WorkJobHooks {
  /** Nur aus API-Konfiguration/vertrauenswürdiger Registrybindung; niemals aus Clientbody. */
  resourceDomain?: (nodeId: string) => string | undefined;
  /** PG-only; Capability, Profil, Consent/Usersperren und echte Ressourcen hier prüfen. */
  authorizeJob?: (node: WorkNodeAuthority, job: WorkJob, client: WorkJobClient) => Promise<WorkJobGrant | null>;
  /** Fachliche Authority-Zeile FOR SHARE sperren; keine HTTP-/FS-Nachprüfung unter Joblock. */
  inputStillCurrent?: (job: WorkJob, client: WorkJobClient) => Promise<boolean>;
  /** Output gehört zu diesem Auftrag/Scope und ist serverseitig bereits vollständig staged. */
  outputIsStaged?: (job: WorkJob, output: ApiObjektReferenz, client: WorkJobClient) => Promise<boolean>;
}
export interface WorkJobDependencies extends WorkJobHooks { pool?: WorkJobPool; config?: Partial<WorkJobConfig> }
let registeredHooks: WorkJobHooks = {};
/** Nach R1.2/A3/RV-Adapter registrieren; ohne Hooks keine Ausführungsfreigabe. */
export function configureWorkJobHooks(hooks: WorkJobHooks): void { registeredHooks = { ...hooks }; }
export class WorkJobError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WorkJobError'; }
}
function fail(code: string): never { throw new WorkJobError(code); }
const uuid = (value: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function validateWorkReference(value: unknown): ApiObjektReferenz {
  if (!object(value) || Object.keys(value).some(k => !['scope','id','revision','sha256'].includes(k)) ||
      !id(value.scope) || typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value.id) ||
      typeof value.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.revision) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('invalid_work_reference');
  return { scope: value.scope, id: value.id, revision: value.revision, sha256: value.sha256 };
}
export function validateWorkResources(value: unknown): WorkResourceNeed {
  if (!object(value) || Object.keys(value).some(k => !['cpu','ram','vram','gpu'].includes(k)) ||
      typeof value.cpu !== 'number' || !Number.isFinite(value.cpu) || value.cpu < 0 ||
      typeof value.ram !== 'number' || !Number.isSafeInteger(value.ram) || value.ram < 0 || typeof value.vram !== 'number' || !Number.isSafeInteger(value.vram) || value.vram < 0 ||
      typeof value.gpu !== 'boolean' || (!value.gpu && value.vram !== 0)) fail('invalid_work_resources');
  // CPU in Kernen (Bruchteile möglich), RAM/VRAM in MiB.
  return { cpu: value.cpu, ram: value.ram, vram: value.vram, gpu: value.gpu };
}
function date(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string).toISOString();
}
function job(row: WorkJobRow): WorkJob {
  return { id: row.id, kind: row.kind, capability: row.capability, profileId: row.profile_id,
    project: row.project, scope: row.scope, inputRef: row.input_ref, resourceNeed: row.resource_need,
    priority: row.priority, state: row.state, ownerNode: row.owner_node,
    bootGeneration: row.boot_generation, claimToken: row.claim_token, attempt: row.attempt,
    leaseUntil: date(row.lease_until), deadline: date(row.deadline),
    stagedOutputRef: row.staged_output_ref, outputRef: row.output_ref, resourceDomain: row.resource_domain,
    resourceUnconfirmed: row.resource_unconfirmed, errorCode: row.error_code,
    createdAt: date(row.created_at)!, updatedAt: date(row.updated_at)! };
}
const sameRef = (a: ApiObjektReferenz, b: ApiObjektReferenz): boolean =>
  a.scope === b.scope && a.id === b.id && a.revision === b.revision && a.sha256 === b.sha256;
function integer(value: unknown, fallback: number, min = 1): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) fail('invalid_work_config');
  return n;
}
function config(overrides: Partial<WorkJobConfig> = {}): WorkJobConfig {
  const c = { leaseSeconds: integer(process.env.SYNAPSE_WORK_LEASE_SECONDS,120),
    maxLeaseSeconds: integer(process.env.SYNAPSE_WORK_MAX_LEASE_SECONDS,900),
    agingSeconds: integer(process.env.SYNAPSE_WORK_AGING_SECONDS,300),
    interactiveReserve: integer(process.env.SYNAPSE_WORK_INTERACTIVE_RESERVE,1,0),
    maxClaimsPerCall: integer(process.env.SYNAPSE_WORK_MAX_CLAIMS_PER_CALL,16),
    scanLimit: integer(process.env.SYNAPSE_WORK_SCAN_LIMIT,128),
    nodeFreshnessSeconds: integer(process.env.SYNAPSE_WORK_NODE_FRESHNESS_SECONDS,120), ...overrides };
  for (const [key,value] of Object.entries(c)) integer(value,0,key==='interactiveReserve'?0:1);
  if (c.leaseSeconds > c.maxLeaseSeconds || c.maxClaimsPerCall > c.scanLimit) fail('invalid_work_config');
  return c;
}
export function createWorkJobService(deps: WorkJobDependencies = {}) {
  const pool = deps.pool ?? getPool() as unknown as WorkJobPool;
  const c = config(deps.config);
  const hooks = (): WorkJobHooks => ({ ...registeredHooks, ...Object.fromEntries(
    Object.entries(deps).filter(([key,value]) => ['resourceDomain','authorizeJob','inputStillCurrent','outputIsStaged'].includes(key) && value !== undefined)) });
  async function tx<T>(run: (client: WorkJobClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await run(client);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  }
  async function audit(client: WorkJobClient, jobId: string | null, event: string, detail: object = {}) {
    await client.query('INSERT INTO work_job_audit(id,job_id,event,detail) VALUES($1,$2,$3,$4::jsonb)',
      [randomUUID(),jobId,event,JSON.stringify(detail)]);
  }
  async function lockAuthority(client: WorkJobClient, who: WorkIdentity, domain: string) {
    if (!id(who.nodeId) || !uuid(who.bootGeneration) || !who.authHash) return null;
    await lockComputeAdmissionDomain(client,who.nodeId);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['work-domain:'+domain]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['work-node:'+who.nodeId]);
    const r = await client.query<WorkNodeAuthority>('SELECT *, clock_timestamp() AS work_now FROM embedding_knoten WHERE node_id=$1 FOR SHARE',[who.nodeId]);
    const n = r.rows[0];
    return n?.boot_id === who.bootGeneration && n?.service_token_hash === who.authHash ? n : null;
  }
  function leaseSeconds(value?: number) {
    const n = integer(value,c.leaseSeconds);
    if (n > c.maxLeaseSeconds) fail('invalid_work_lease');
    return n;
  }
  async function leased(client: WorkJobClient, who: WorkIdentity, jobId: string, token: string) {
    if (!uuid(jobId) || !uuid(token)) return null;
    const r = await client.query<WorkJobRow>(
      "SELECT *,clock_timestamp() AS work_now FROM work_jobs WHERE id=$1 AND state IN ('leased','staged') FOR UPDATE",[jobId]);
    const row = r.rows[0];
    if (!row || row.owner_node !== who.nodeId || row.boot_generation !== who.bootGeneration ||
        row.owner_auth_hash !== who.authHash || row.claim_token !== token ||
        new Date(row.lease_until!).getTime() <= new Date(row.work_now).getTime() ||
        (row.deadline && new Date(row.deadline).getTime() <= new Date(row.work_now).getTime())) return null;
    return row;
  }
  async function withLease<T>(who: WorkIdentity, jobId: string, token: string,
    fallback: T, run: (client: WorkJobClient,row: WorkJobRow) => Promise<T>): Promise<T> {
    if (!uuid(jobId)) return fallback;
    // Nicht sperrende Domain-Leseprobe; unter Lock nochmal prüfen, nie eine Client-Domain verwenden.
    const hint = (await pool.query<{resource_domain:string|null}>('SELECT resource_domain FROM work_jobs WHERE id=$1',[jobId])).rows[0];
    if (!hint?.resource_domain) return fallback;
    const domain = hint.resource_domain;
    return tx(async client => {
      if (!await lockAuthority(client,who,domain)) return fallback;
      const row = await leased(client,who,jobId,token);
      if (!row || row.resource_domain !== domain) return fallback;
      return run(client,row);
    });
  }
  async function enqueue(input: WorkJobInput, transactionClient?: Pick<WorkJobClient,'query'>): Promise<WorkJob> {
    if (!input || !id(input.kind) || !id(input.capability) || !id(input.project) || !id(input.scope) ||
        !id(input.idempotencyKey) || (input.profileId != null && !id(input.profileId))) fail('invalid_work_input');
    const priority = input.priority ?? 'hintergrund';
    if (!['interaktiv','hintergrund','nachzug'].includes(priority)) fail('invalid_work_priority');
    const inputRef = validateWorkReference(input.inputRef);
    const resourceNeed = validateWorkResources(input.resourceNeed);
    let deadline: string | null;
    try { if (input.deadline != null && typeof input.deadline !== 'string') fail('invalid_work_deadline'); deadline = date(input.deadline); } catch { return fail('invalid_work_deadline'); }
    const normalized = { kind:input.kind,capability:input.capability,profileId:input.profileId??null,
      project:input.project,scope:input.scope,inputRef,resourceNeed,priority,deadline };
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const insert = async (client: Pick<WorkJobClient,'query'>): Promise<WorkJob> => {
      const r = await client.query<WorkJobRow>(
        `INSERT INTO work_jobs(id,kind,capability,profile_id,project,scope,input_ref,resource_need,
          priority,idempotency_key,request_hash,deadline) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
          ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,
        [randomUUID(),input.kind,input.capability,input.profileId??null,input.project,input.scope,
          JSON.stringify(inputRef),JSON.stringify(resourceNeed),priority,input.idempotencyKey,hash,deadline]);
      if (r.rows[0].request_hash !== hash) fail('idempotency_conflict');
      return job(r.rows[0]);
    };
    return transactionClient ? insert(transactionClient) : tx(insert);
  }
  async function claim(who: WorkIdentity, options: {limit?:number;leaseSeconds?:number} = {}): Promise<WorkJob[]> {
    const h = hooks();
    // Keine Policy/Inhalts-/Stagingprüfung vorhanden => keinerlei zusätzliche Arbeit freigeben.
    if (!h.authorizeJob || !h.inputStillCurrent || !h.outputIsStaged || !h.resourceDomain) return [];
    const authorize = h.authorizeJob;
    const checkInput = h.inputStillCurrent;
    const domain = h.resourceDomain(who.nodeId);
    if (!domain) return [];
    const limit = integer(options.limit,1);
    if (limit > c.maxClaimsPerCall) fail('invalid_work_claim_limit');
    const seconds = leaseSeconds(options.leaseSeconds);
    return tx(async client => {
      const node = await lockAuthority(client,who,domain);
      const contactMs = node ? new Date(node.letzter_kontakt).getTime() : NaN;
      if (!node || node.gesperrt_vom_user || !['ready','busy'].includes(node.status) ||
          !Number.isFinite(contactMs) || new Date(node.work_now).getTime()-contactMs > c.nodeFreshnessSeconds*1000) return [];
      await lockWorkJobClaimGuards(client); // R5.1: Domain/Knoten -> Lifecycle -> Joblocks.
      const selected = await client.query<WorkJobRow>(
        `SELECT *,clock_timestamp() AS work_now FROM work_jobs
         WHERE (state='pending' OR (state IN ('leased','staged') AND lease_until<=clock_timestamp()))
           AND (deadline IS NULL OR deadline>clock_timestamp())
         ORDER BY GREATEST(0,(CASE priority WHEN 'interaktiv' THEN 0 WHEN 'hintergrund' THEN 1 ELSE 2 END)
             -FLOOR(EXTRACT(EPOCH FROM (clock_timestamp()-created_at))/$1)),created_at,id
         LIMIT $2 FOR UPDATE SKIP LOCKED`,[c.agingSeconds,c.scanLimit]);
      const result: WorkJob[] = [];
      for (const row of selected.rows) {
        if (result.length >= limit) break;
        const current = job(row);
        if (!await allowWorkJobClaim(current,client)) continue;
        const grant = await authorize(node,current,client);
        if (!grant || grant.resourceDomain !== domain || !Number.isSafeInteger(grant.maxConcurrent) ||
            grant.maxConcurrent < 1 || !await checkInput(current,client)) continue;
        if(!await computeAdmissionAllowsWork(client,who.nodeId,current.resourceNeed,current.priority,grant.resourceDomain))continue;
        const budget = validateWorkResources(grant.budget);
        const active = await client.query<{n:number;cpu:number;ram:number;vram:number}>(
          `SELECT COUNT(*)::int AS n, COALESCE(SUM((resource_need->>'cpu')::numeric),0)::float8 AS cpu,
            COALESCE(SUM((resource_need->>'ram')::numeric),0)::float8 AS ram,
            COALESCE(SUM((resource_need->>'vram')::numeric),0)::float8 AS vram
            FROM work_jobs WHERE resource_domain=$1 AND state IN ('leased','staged') AND lease_until>clock_timestamp()`,[domain]);
        const used = active.rows[0];
        const reserve = current.priority === 'interaktiv' ? 0 : Math.min(c.interactiveReserve,grant.maxConcurrent);
        if (used.n >= grant.maxConcurrent-reserve || current.resourceNeed.cpu+used.cpu>budget.cpu ||
            current.resourceNeed.ram+used.ram>budget.ram || current.resourceNeed.vram+used.vram>budget.vram ||
            (current.resourceNeed.gpu && !budget.gpu)) continue;
        if (computePolicyAktiv() && !(await pruefeComputeZuteilung({nodeId:who.nodeId,project:current.project,capability:current.capability,profileId:current.profileId,profileCompatible:true,resourcesAvailable:true},client)).allowed) continue;
        const expired = ['leased','staged'].includes(row.state);
        if (expired) await audit(client,row.id,'lease_reclaimed',{ownerNode:row.owner_node,
          bootGeneration:row.boot_generation,resourceDomain:row.resource_domain,physicalResourceState:'unknown'});
        const update = await client.query<WorkJobRow>(
          `UPDATE work_jobs SET state='leased',owner_node=$2,boot_generation=$3,owner_auth_hash=$4,
            resource_domain=$5,claim_token=$6,attempt=attempt+1,lease_until=LEAST(clock_timestamp()+($7::int*INTERVAL '1 second'),COALESCE(deadline,'infinity'::timestamptz)),
            claimed_at=clock_timestamp(),updated_at=clock_timestamp(),staged_output_ref=NULL,error_code=NULL,
            resource_unconfirmed=resource_unconfirmed OR $8
            WHERE id=$1 AND (deadline IS NULL OR deadline>clock_timestamp()) RETURNING *`,[row.id,who.nodeId,who.bootGeneration,who.authHash,domain,randomUUID(),seconds,expired]);
        if (!update.rows[0]) continue;
        await audit(client,row.id,'claimed',{ownerNode:who.nodeId,attempt:update.rows[0].attempt});
        result.push(job(update.rows[0]));
      }
      return result;
    });
  }
  async function renew(who: WorkIdentity,jobId: string,token: string,seconds?: number): Promise<boolean> {
    const duration = leaseSeconds(seconds);
    return withLease(who,jobId,token,false,async (client,row) => {
      if (!hooks().inputStillCurrent || !await hooks().inputStillCurrent!(job(row),client)) return false;
      const updated = await client.query(`UPDATE work_jobs SET lease_until=LEAST(clock_timestamp()+($2::int*INTERVAL '1 second'),
        COALESCE(deadline,'infinity'::timestamptz)),updated_at=clock_timestamp()
        WHERE id=$1 AND lease_until>clock_timestamp() AND (deadline IS NULL OR deadline>clock_timestamp())`,[jobId,duration]);
      if (!updated.rowCount) return false;
      await audit(client,jobId,'renewed');
      return true;
    });
  }
  async function stage(who: WorkIdentity,jobId: string,token: string,output: ApiObjektReferenz): Promise<boolean> {
    const ref = validateWorkReference(output);
    return withLease(who,jobId,token,false,async (client,row) => {
      const h = hooks();
      if (!h.inputStillCurrent || !h.outputIsStaged ||
          !await h.inputStillCurrent(job(row),client) || !await h.outputIsStaged(job(row),ref,client)) return false;
      if (row.state === 'staged' && !sameRef(row.staged_output_ref!,ref)) return false;
      const updated = await client.query(`UPDATE work_jobs SET state='staged',staged_output_ref=$2::jsonb,
        updated_at=clock_timestamp() WHERE id=$1 AND lease_until>clock_timestamp()
        AND (deadline IS NULL OR deadline>clock_timestamp())`,[jobId,JSON.stringify(ref)]);
      if (!updated.rowCount) return false;
      await audit(client,jobId,'output_staged');
      return true;
    });
  }
  async function complete(who: WorkIdentity,jobId: string,token: string,input: ApiObjektReferenz): Promise<{completed:boolean}> {
    const ref = validateWorkReference(input);
    return withLease(who,jobId,token,{completed:false},async (client,row) => {
      const h = hooks();
      if (row.state !== 'staged' || !sameRef(row.input_ref,ref) || !h.inputStillCurrent || !h.outputIsStaged ||
          !await h.inputStillCurrent(job(row),client) || !await h.outputIsStaged(job(row),row.staged_output_ref!,client))
        return {completed:false};
      // Publikation ist der atomare Metadaten-Fence; Bytes wurden außerhalb dieser TX staged.
      const updated = await client.query(`UPDATE work_jobs SET state='completed',output_ref=staged_output_ref,
        completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_until=NULL WHERE id=$1
        AND lease_until>clock_timestamp() AND (deadline IS NULL OR deadline>clock_timestamp())`,[jobId]);
      if (!updated.rowCount) return {completed:false};
      await audit(client,jobId,'completed');
      return {completed:true};
    });
  }
  async function release(who: WorkIdentity,jobId: string,token: string): Promise<boolean> {
    return withLease(who,jobId,token,false,async (client,row) => {
      const updated = await client.query(`UPDATE work_jobs SET state='pending',
        owner_node=NULL,boot_generation=NULL,owner_auth_hash=NULL,claim_token=NULL,lease_until=NULL,
        staged_output_ref=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_until>clock_timestamp()
        AND (deadline IS NULL OR deadline>clock_timestamp())`,[jobId]);
      if (!updated.rowCount) return false;
      await audit(client,jobId,'released');
      return true;
    });
  }
  async function reclaim(limit = c.scanLimit): Promise<number> {
    const max = integer(limit,c.scanLimit);
    if (max > c.scanLimit) fail('invalid_work_reclaim_limit');
    return tx(async client => {
      const rows = await client.query<WorkJobRow>(
        `SELECT * FROM work_jobs WHERE state IN ('leased','staged') AND (lease_until<=clock_timestamp() OR deadline<=clock_timestamp())
          ORDER BY lease_until,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[max]);
      if (rows.rows.length) {
        await client.query(`UPDATE work_jobs SET state=CASE WHEN deadline<=clock_timestamp() THEN 'expired' ELSE 'pending' END,
          owner_node=NULL,boot_generation=NULL,owner_auth_hash=NULL,claim_token=NULL,lease_until=NULL,
          staged_output_ref=NULL,resource_unconfirmed=TRUE,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])`,
          [rows.rows.map(row=>row.id)]);
        await client.query(`INSERT INTO work_job_audit(id,job_id,event,detail)
          SELECT x.id,x.job_id,'lease_reclaimed',x.detail
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,job_id uuid,detail jsonb)`,[JSON.stringify(
            rows.rows.map(row=>({id:randomUUID(),job_id:row.id,detail:{
              ownerNode:row.owner_node,bootGeneration:row.boot_generation,resourceDomain:row.resource_domain,
              physicalResourceState:'unknown'}})))]);
      }
      return rows.rows.length;
    });
  }
  async function auditEmbedding(claims: Array<{chunkId:string;project:string;claimAttempt:number}>,nodeId: string): Promise<void> {
    return tx(async client => {
      if (!claims.length) return;
      await client.query(`INSERT INTO work_job_audit(id,job_id,event,detail)
        SELECT x.id,NULL,'embedding_shadow',x.detail
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,detail jsonb)`,[JSON.stringify(claims.map(item=>({
          id:randomUUID(),detail:{chunkId:item.chunkId,project:item.project,attempt:item.claimAttempt,nodeId,execution:false}})))]);

    });
  }
  async function get(jobId: string,project: string): Promise<WorkJob | null> {
    if (!uuid(jobId) || !id(project)) return null;
    const r = await pool.query<WorkJobRow>('SELECT * FROM work_jobs WHERE id=$1 AND project=$2',[jobId,project]);
    return r.rows[0] ? job(r.rows[0]) : null;
  }
  function ready(): boolean {
    const h = hooks();
    return !!(h.resourceDomain && h.authorizeJob && h.inputStillCurrent && h.outputIsStaged);
  }
  return {enqueue,claim,renew,stage,complete,release,reclaim,auditEmbedding,get,ready};
}
export type WorkJobService = ReturnType<typeof createWorkJobService>;
