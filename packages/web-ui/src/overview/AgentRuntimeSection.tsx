// DIND-6 v1 — Einstellungen-Sektion 'Agenten-Runtime' (CLI-Container auf Unraid).
// Reine Verwaltungs-UI gegen /api/cli-agents (CliAgentOrchestrator, feature-gated
// via SYNAPSE_DIND_ENABLED). Komplett abgekoppelt vom lokalen Spezialisten-System.
// Auth v1 ohne Web-Terminal:
//  - codex: Device-Login (URL+Code aus Container-Log) oder API-Key (base64 -> stdin)
//  - claude: Token lokal per 'claude setup-token' erzeugen und hier hinterlegen
//    (v1: Datei auf dem Auth-Volume; ab DIND-5 injiziert der Wrapper ihn als ENV).

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/auth';

interface AgentRow {
  name: string;
  cliType: string;
  status: string;
  image?: string;
  containerId?: string | null;
  autoUpdate?: boolean;
}

function normAgent(raw: any): AgentRow {
  return {
    name: raw?.name ?? '?',
    cliType: raw?.cliType ?? raw?.cli_type ?? '?',
    status: raw?.status ?? 'unbekannt',
    image: raw?.image ?? undefined,
    containerId: raw?.containerId ?? raw?.container_id ?? null,
    autoUpdate: raw?.autoUpdate ?? raw?.auto_update ?? undefined,
  };
}

function normExec(r: any): string {
  if (r == null) return '(keine Ausgabe)';
  const out = [r.stdout, r.output, r.stderr].filter((x) => typeof x === 'string' && x.trim()).join('\n');
  if (out.trim()) return out.trim();
  const { success, name, ...rest } = r;
  return JSON.stringify(rest, null, 2);
}

const V1_CLIS: Array<{ type: string; label: string; binary: string }> = [
  { type: 'claude', label: 'Claude Code', binary: 'claude' },
  { type: 'codex', label: 'OpenAI Codex', binary: 'codex' },
];

export default function AgentRuntimeSection() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [dockerOk, setDockerOk] = useState(false);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ title: string; text: string } | null>(null);
  const [codexKey, setCodexKey] = useState('');
  const [claudeTok, setClaudeTok] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await apiFetch('/api/cli-agents');
      if (res.status === 503) { setAvailable(false); setAgents([]); return; }
      const d = await res.json();
      setAvailable(true);
      setDockerOk(!!d.docker_available);
      setAgents(Array.isArray(d.agents) ? d.agents.map(normAgent) : []);
    } catch (e) {
      setAvailable(false);
      setErr(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const call = async (label: string, path: string, init?: RequestInit): Promise<any | null> => {
    setBusy(label);
    setErr(null);
    try {
      const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...init });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.success === false) {
        setErr(d?.error?.message ?? `HTTP ${res.status}`);
        return null;
      }
      return d;
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      return null;
    } finally {
      setBusy(null);
      load();
    }
  };

  const exec = async (label: string, name: string, command: string, timeoutMs = 30000) => {
    const d = await call(label, `/api/cli-agents/${encodeURIComponent(name)}/exec`, {
      body: JSON.stringify({ command, timeoutMs }),
    });
    if (d) setPanel({ title: label, text: normExec(d) });
  };

  const agentFor = (cliType: string): AgentRow | undefined => agents.find((a) => a.cliType === cliType);

  const createAgent = (cliType: string) =>
    call(`${cliType} anlegen`, '/api/cli-agents', { body: JSON.stringify({ cliType, autoUpdate: true }) });

  const codexDeviceLogin = (name: string) => exec(
    'Codex Device-Login', name,
    "sh -lc 'rm -f /tmp/device-auth.log; nohup codex login --device-auth >/tmp/device-auth.log 2>&1 & sleep 5; cat /tmp/device-auth.log'",
    20000,
  );

  const codexApiKeyLogin = (name: string) => {
    const key = codexKey.trim();
    if (!key) return;
    const b64 = btoa(key);
    setCodexKey('');
    return exec('Codex API-Key-Login', name, `sh -lc 'echo ${b64} | base64 -d | codex login --with-api-key && echo LOGIN_OK'`);
  };

  const claudeSaveToken = (name: string) => {
    const tok = claudeTok.trim();
    if (!tok) return;
    const b64 = btoa(tok);
    setClaudeTok('');
    return exec('Claude Token speichern', name,
      `sh -lc 'mkdir -p /root/.claude && echo ${b64} | base64 -d > /root/.claude/synapse-oauth-token && chmod 600 /root/.claude/synapse-oauth-token && echo TOKEN_GESPEICHERT'`);
  };

  const dot = (status: string) => (
    <span style={{
      display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 8,
      background: status === 'running' ? 'var(--kios-ok, #3ddc84)' : status === 'stopped' ? '#8d99c4' : '#f0a742',
    }} />
  );

  const btn = (label: string, onClick: () => void, primary = false, disabled = false) => (
    <button type="button" onClick={onClick} disabled={disabled || busy !== null}
      style={primary ? { fontWeight: 600 } : undefined}>
      {busy === label ? '…' : label}
    </button>
  );

  return (
    <section className="kios-cell">
      <span className="kios-stub-tag">Agenten-Runtime — CLI-Container auf dem Server</span>
      <p className="kios-cat-hint">
        Persistente CLI-Container (Claude Code, Codex) laufen direkt auf Unraid, verwaltet von Synapse —
        mit Self-Update beim Start. Abgekoppelt vom lokalen Spezialisten-System: hier passiert nur Verwaltung + Auth.
      </p>

      {available === null && <p className="kios-cat-hint">Lade Runtime-Status…</p>}

      {available === false && (
        <div className="kios-settings-stack">
          <p className="kios-cat-hint" style={{ color: '#f0a742' }}>
            Runtime deaktiviert — am synapse-api-Container <code>SYNAPSE_DIND_ENABLED=1</code> setzen (Deploy-Prozedur).
            {err ? ` (${err})` : ''}
          </p>
          <div className="kios-tok-add">{btn('Erneut pruefen', load)}</div>
        </div>
      )}

      {available && (
        <div className="kios-settings-stack">
          <p className="kios-cat-hint">
            Docker: {dockerOk ? 'erreichbar ✓' : 'NICHT erreichbar — Socket pruefen'} · {agents.length} Agent(en) registriert
          </p>

          {V1_CLIS.map(({ type, label, binary }) => {
            const a = agentFor(type);
            return (
              <div key={type} className="kios-tok-row" style={{ flexWrap: 'wrap', rowGap: 8 }}>
                <span className="kios-tok-scope">{type}</span>
                <span className="kios-tok-label">{label}</span>
                {a ? (
                  <>
                    <span className="kios-tok-host">{dot(a.status)}{a.status}{a.image ? ` · ${a.image}` : ''}</span>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {a.status !== 'running'
                        ? btn('Start', () => call(`${type} Start`, `/api/cli-agents/${encodeURIComponent(a.name)}/start`))
                        : btn('Stop', () => call(`${type} Stop`, `/api/cli-agents/${encodeURIComponent(a.name)}/stop`))}
                      {btn('Update', () => call(`${type} Update`, `/api/cli-agents/${encodeURIComponent(a.name)}/update`))}
                      {btn('Version', () => exec(`${label} Version`, a.name, `${binary} --version`))}
                      <button type="button" className="kios-tok-del" disabled={busy !== null}
                        onClick={() => { if (window.confirm(`${a.name} entfernen? (Auth-Volumes bleiben erhalten)`)) call(`${type} entfernen`, `/api/cli-agents/${encodeURIComponent(a.name)}`, { method: 'DELETE', body: undefined }); }}>
                        ✕
                      </button>
                    </span>
                  </>
                ) : (
                  <span>{btn(`Container anlegen`, () => createAgent(type), true, !dockerOk)}</span>
                )}
              </div>
            );
          })}

          {/* Auth: Codex */}
          {agentFor('codex')?.status === 'running' && (
            <div className="kios-tok-add" style={{ alignItems: 'center' }}>
              <span className="kios-tok-scope">codex</span>
              {btn('Abo: Device-Login starten', () => codexDeviceLogin(agentFor('codex')!.name), true)}
              <input value={codexKey} onChange={(e) => setCodexKey(e.target.value)} type="password"
                placeholder="…oder OPENAI_API_KEY (sk-…)" aria-label="OpenAI API-Key" />
              {btn('Key-Login', () => codexApiKeyLogin(agentFor('codex')!.name))}
              {btn('Auth-Status', () => exec('Codex Auth-Status', agentFor('codex')!.name, 'codex login status'))}
            </div>
          )}

          {/* Auth: Claude */}
          {agentFor('claude')?.status === 'running' && (
            <div className="kios-tok-add" style={{ alignItems: 'center' }}>
              <span className="kios-tok-scope">claude</span>
              <input value={claudeTok} onChange={(e) => setClaudeTok(e.target.value)} type="password"
                placeholder="OAuth-Token (lokal: claude setup-token)" aria-label="Claude OAuth-Token" />
              {btn('Token speichern', () => claudeSaveToken(agentFor('claude')!.name), true)}
            </div>
          )}

          {err && <p className="kios-cat-hint" style={{ color: '#ff5252' }}>Fehler: {err}</p>}

          {panel && (
            <div className="kios-settings-stack">
              <span className="kios-stub-tag">{panel.title}</span>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, margin: 0, maxHeight: 260, overflow: 'auto' }}>{panel.text}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
