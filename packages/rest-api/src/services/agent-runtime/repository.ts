import { randomUUID } from 'node:crypto';
import { getPool } from '@synapse/core';
import type { MainAgentSession, RuntimeConfiguration, RuntimeName } from './types.js';

const DEFAULT_CODEX_ROOT = '/mnt/user/synapse-agent-runtime/codex';
const DEFAULT_CODEX_IMAGE = 'node:22-bookworm-slim';

interface RuntimeRow {
  runtime: RuntimeName;
  role: 'main';
  root_path: string;
  image: string;
  container_name: string;
  assigned_to_main: boolean;
}

export class AgentRuntimeRepository {
  async get(runtime: RuntimeName): Promise<RuntimeConfiguration | null> {
    const result = await getPool().query(
      'SELECT runtime, role, root_path, image, container_name, assigned_to_main FROM agent_runtime_instances WHERE runtime=$1',
      [runtime],
    );
    const row = result.rows[0] as RuntimeRow | undefined;
    if (!row) return null;
    return {
      runtime: row.runtime,
      role: row.role,
      rootPath: row.root_path,
      image: row.image,
      containerName: row.container_name,
      assignedToMain: row.assigned_to_main,
    };
  }

  async ensureCodex(): Promise<RuntimeConfiguration> {
    await getPool().query(
      'INSERT INTO agent_runtime_instances (runtime, driver, role, root_path, image, container_name) VALUES ($1,$1,\'main\',$2,$3,\'synapse-runtime-codex\') ON CONFLICT (runtime) DO NOTHING',
      ['codex', DEFAULT_CODEX_ROOT, DEFAULT_CODEX_IMAGE],
    );
    const config = await this.get('codex');
    if (!config) throw new Error('Codex-Runtime-Konfiguration konnte nicht angelegt werden');
    return config;
  }

  async configure(runtime: RuntimeName, rootPath: string, image: string): Promise<RuntimeConfiguration> {
    await getPool().query(
      'INSERT INTO agent_runtime_instances (runtime,driver,role,root_path,image,container_name,updated_at) VALUES ($1,$1,\'main\',$2,$3,$4,NOW()) ON CONFLICT (runtime) DO UPDATE SET root_path=EXCLUDED.root_path,image=EXCLUDED.image,last_error=NULL,updated_at=NOW()',
      [runtime, rootPath, image, 'synapse-runtime-' + runtime],
    );
    const config = await this.get(runtime);
    if (!config) throw new Error('Runtime-Konfiguration konnte nicht gespeichert werden');
    return config;
  }

  async updateObserved(runtime: RuntimeName, input: {
    containerId?: string | null;
    status?: string;
    installed?: boolean;
    authStatus?: string;
    authMethod?: string | null;
    version?: string | null;
    lastError?: string | null;
  }): Promise<void> {
    const columns = new Map<string, unknown>([
      ['container_id', input.containerId],
      ['status', input.status],
      ['installed', input.installed],
      ['auth_status', input.authStatus],
      ['auth_method', input.authMethod],
      ['version', input.version],
      ['last_error', input.lastError],
    ]);
    const assignments: string[] = [];
    const values: unknown[] = [runtime];
    for (const [column, value] of columns) {
      if (value === undefined) continue;
      values.push(value);
      assignments.push(column + '=$' + values.length);
    }
    if (assignments.length === 0) return;
    await getPool().query(
      'UPDATE agent_runtime_instances SET ' + assignments.join(',') + ',updated_at=NOW() WHERE runtime=$1',
      values,
    );
  }

  async clearContainer(runtime: RuntimeName, status = 'stopped'): Promise<void> {
    await getPool().query(
      'UPDATE agent_runtime_instances SET container_id=NULL,status=$2,updated_at=NOW() WHERE runtime=$1',
      [runtime, status],
    );
  }

  async assignMain(runtime: RuntimeName | null): Promise<void> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE agent_runtime_instances SET assigned_to_main=FALSE,updated_at=NOW() WHERE assigned_to_main=TRUE');
      if (runtime) {
        const result = await client.query(
          'UPDATE agent_runtime_instances SET assigned_to_main=TRUE,updated_at=NOW() WHERE runtime=$1 AND role=\'main\'',
          [runtime],
        );
        if ((result.rowCount ?? 0) !== 1) throw new Error('Runtime ist nicht als Main-Agent-Runtime konfiguriert');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getAssignedMain(): Promise<RuntimeConfiguration | null> {
    const result = await getPool().query(
      'SELECT runtime FROM agent_runtime_instances WHERE assigned_to_main=TRUE AND role=\'main\' LIMIT 1',
    );
    const runtime = result.rows[0]?.runtime as RuntimeName | undefined;
    return runtime ? this.get(runtime) : null;
  }

  async claimSession(id: string): Promise<boolean> {
    const result = await getPool().query(
      "UPDATE agent_runtime_sessions SET status='running',last_error=NULL,updated_at=NOW() WHERE id=$1 AND agent_role='main' AND status <> 'running'",
      [id],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async createSession(runtime: RuntimeName): Promise<MainAgentSession> {
    const id = randomUUID();
    const result = await getPool().query(
      'INSERT INTO agent_runtime_sessions (id,agent_role,runtime,status) VALUES ($1,\'main\',$2,\'ready\') RETURNING id,runtime,runtime_session_id,status,context,created_at',
      [id, runtime],
    );
    return this.mapSession(result.rows[0]);
  }

  async getSession(id: string): Promise<MainAgentSession | null> {
    const result = await getPool().query(
      'SELECT id,runtime,runtime_session_id,status,context,created_at FROM agent_runtime_sessions WHERE id=$1 AND agent_role=\'main\'',
      [id],
    );
    return result.rows[0] ? this.mapSession(result.rows[0]) : null;
  }

  async updateSession(id: string, input: {
    runtimeSessionId?: string | null;
    status?: MainAgentSession['status'];
    context?: Record<string, unknown> | null;
    lastError?: string | null;
  }): Promise<void> {
    await getPool().query(
      'UPDATE agent_runtime_sessions SET runtime_session_id=COALESCE($2,runtime_session_id),status=COALESCE($3,status),context=COALESCE($4,context),last_error=$5,updated_at=NOW() WHERE id=$1',
      [id, input.runtimeSessionId, input.status, input.context ? JSON.stringify(input.context) : null, input.lastError ?? null],
    );
  }

  private mapSession(row: Record<string, unknown>): MainAgentSession {
    return {
      id: String(row.id),
      runtime: row.runtime as RuntimeName,
      runtimeSessionId: row.runtime_session_id ? String(row.runtime_session_id) : null,
      status: row.status as MainAgentSession['status'],
      context: (row.context as Record<string, unknown> | null) ?? null,
      createdAt: new Date(String(row.created_at)).toISOString(),
    };
  }
}
