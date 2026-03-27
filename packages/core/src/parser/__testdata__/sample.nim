import std/[json, strutils, tables, asyncdispatch]

const
  MaxRetries = 3
  DefaultModel = "claude-opus-4-6"
  BufferSize = 4096

type
  Status* = enum
    Active, Idle, Stopped, Error

  AgentConfig* = object
    model*: string
    maxTokens*: int
    temperature*: float

  Agent* = ref object
    name*: string
    config*: AgentConfig
    status*: Status
    tools: seq[string]

  AgentError* = object of CatchableError

proc newAgentConfig*(model = DefaultModel, maxTokens = 4096, temperature = 0.7): AgentConfig =
  AgentConfig(model: model, maxTokens: maxTokens, temperature: temperature)

proc newAgent*(name: string, config: AgentConfig = newAgentConfig()): Agent =
  Agent(
    name: name,
    config: config,
    status: Idle,
    tools: @["search", "read", "write"]
  )

proc callModel(self: Agent, message: string): string =
  # TODO: implement actual API call
  "Response to: " & message

proc process*(self: Agent, message: string): string =
  assert message.len > 0, "Empty message"
  self.status = Active
  result = self.callModel(message)
  self.status = Idle

proc getTools*(self: Agent): seq[string] =
  self.tools

proc validate(input: string): bool =
  input.strip().len > 0

proc `$`*(self: Agent): string =
  self.name & " [" & $self.status & "]"

template withAgent*(name: string, body: untyped) =
  let agent = newAgent(name)
  body

iterator activeAgents*(agents: seq[Agent]): Agent =
  for a in agents:
    if a.status == Active:
      yield a

# FIXME: add async support for process
