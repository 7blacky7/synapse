$version: "2.0"

namespace com.synapse.api

use smithy.api#String
use smithy.api#Integer
use aws.protocols#restJson1

/// The main Synapse service
@restJson1
service SynapseService {
    version: "2026-03-27"
    resources: [AgentResource, SessionResource]
    operations: [HealthCheck]
}

resource AgentResource {
    identifiers: { agentId: AgentId }
    read: GetAgent
    list: ListAgents
    create: CreateAgent
    delete: DeleteAgent
}

resource SessionResource {
    identifiers: { sessionId: SessionId }
    read: GetSession
    operations: [SendMessage]
}

@readonly
@http(method: "GET", uri: "/health")
operation HealthCheck {
    output: HealthCheckOutput
}

@readonly
@http(method: "GET", uri: "/agents/{agentId}")
operation GetAgent {
    input: GetAgentInput
    output: GetAgentOutput
    errors: [NotFoundError, ValidationError]
}

@http(method: "POST", uri: "/agents")
operation CreateAgent {
    input: CreateAgentInput
    output: CreateAgentOutput
}

@readonly
operation ListAgents {
    input: ListAgentsInput
    output: ListAgentsOutput
}

@idempotent
operation DeleteAgent {
    input: DeleteAgentInput
}

operation GetSession {
    input: GetSessionInput
    output: GetSessionOutput
}

operation SendMessage {
    input: SendMessageInput
    output: SendMessageOutput
}

// --- Shapes ---

string AgentId
string SessionId

structure GetAgentInput {
    @required
    @httpLabel
    agentId: AgentId
}

structure GetAgentOutput {
    @required
    agent: Agent
}

structure CreateAgentInput {
    @required
    name: String
    model: String
    config: AgentConfig
}

structure CreateAgentOutput {
    @required
    agent: Agent
}

structure ListAgentsInput {
    maxResults: Integer
    nextToken: String
}

structure ListAgentsOutput {
    @required
    agents: AgentList
    nextToken: String
}

structure DeleteAgentInput {
    @required
    agentId: AgentId
}

structure Agent {
    @required
    id: AgentId
    @required
    name: String
    model: String
    status: AgentStatus
    createdAt: Timestamp
}

structure AgentConfig {
    maxTokens: Integer
    temperature: Float
}

structure GetSessionInput {
    @required
    sessionId: SessionId
}

structure GetSessionOutput {
    @required
    session: SessionData
}

structure SendMessageInput {
    @required
    sessionId: SessionId
    @required
    content: String
}

structure SendMessageOutput {
    @required
    messageId: String
    response: String
}

structure SessionData {
    id: SessionId
    agentId: AgentId
    messages: MessageList
}

structure HealthCheckOutput {
    @required
    status: String
    version: String
}

union AgentResponse {
    text: String
    error: ErrorDetail
    toolCall: ToolCallData
}

structure ErrorDetail {
    code: String
    message: String
}

structure ToolCallData {
    toolName: String
    input: String
}

intEnum AgentStatus {
    ACTIVE = 1
    IDLE = 2
    STOPPED = 3
    ERROR = 4
}

enum MessageRole {
    USER
    ASSISTANT
    SYSTEM
}

list AgentList {
    member: Agent
}

list MessageList {
    member: Message
}

structure Message {
    role: MessageRole
    content: String
}

@error("client")
@httpError(404)
structure NotFoundError {
    @required
    message: String
}

@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String
    field: String
}

// TODO: add pagination support for sessions
// FIXME: rate limiting not implemented yet

apply SynapseService @documentation("Main API for Synapse agent management")
apply AgentResource @documentation("Agent lifecycle management")
