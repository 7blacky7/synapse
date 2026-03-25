export interface SpecialistConfig {
  name: string
  model: 'opus' | 'sonnet' | 'haiku' | 'opus[1m]' | 'sonnet[1m]'
  expertise: string
  task: string
  project: string
  cwd?: string
  channel?: string
  allowedTools?: string[]
  keepAlive?: boolean
}

export interface SpecialistStatus {
  name: string
  model: string
  status: 'running' | 'idle' | 'stopped' | 'crashed'
  pid: number
  wrapperPid: number
  socket: string
  tokens: { input: number; output: number; percent: number }
  contextCeiling: number
  lastActivity: string
  channels: string[]
  currentTask: string | null
}

export interface StatusFile {
  specialists: Record<string, SpecialistStatus>
  maxSpecialists: number
  lastUpdate: string
}

export interface WrapperMessage {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
  id?: number
}

export interface WrapperResponse {
  jsonrpc: '2.0'
  result?: Record<string, unknown>
  error?: { code: number; message: string }
  id?: number
}

export interface StreamEvent {
  type: string
  subtype?: string
  message?: { content: Array<{ type: string; text: string }> }
  result?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

export interface SendMessageResult {
  content: string
  inputTokens: number
  outputTokens: number
}

export interface ChannelMessage {
  id: number
  channelName: string
  sender: string
  content: string
  metadata?: Record<string, unknown>
  createdAt: Date
}

export interface InboxMessage {
  id: number
  fromAgent: string
  toAgent: string
  content: string
  processed: boolean
  createdAt: Date
}

export interface HeartbeatConfig {
  pollIntervalMs: number
  contextCeilings: Record<string, number>
  warnPercent: number
  rotationPercent: number
  autoRotation: boolean
}

export const CONTEXT_CEILINGS: Record<string, number> = {
  haiku: 200_000,
  sonnet: 200_000,
  opus: 200_000,
  'sonnet[1m]': 1_000_000,
  'opus[1m]': 1_000_000,
}

export const WARN_THRESHOLDS: Record<string, number> = {
  haiku: 160_000,
  sonnet: 160_000,
  opus: 160_000,
  'sonnet[1m]': 980_000,
  'opus[1m]': 980_000,
}
