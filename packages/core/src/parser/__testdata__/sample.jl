module SynapseAgent

using JSON3
using HTTP

export Agent, AgentConfig, process, get_tools, create_agent

const MAX_RETRIES = 3
const DEFAULT_MODEL = "claude-opus-4-6"

@enum Status begin
    Active
    Idle
    Stopped
    Error
end

struct AgentConfig
    model::String
    max_tokens::Int
    temperature::Float64
end

AgentConfig(; model=DEFAULT_MODEL, max_tokens=4096, temperature=0.7) =
    AgentConfig(model, max_tokens, temperature)

mutable struct Agent
    name::String
    config::AgentConfig
    status::Status
    tools::Vector{String}
end

abstract type AbstractAgent end

function Agent(name::String; config=nothing)
    cfg = isnothing(config) ? AgentConfig() : config
    Agent(name, cfg, Idle, ["search", "read", "write"])
end

function process(agent::Agent, message::String)::String
    @assert !isempty(strip(message)) "Empty message"
    agent.status = Active
    result = call_model(message, agent.config)
    agent.status = Idle
    return result
end

function get_tools(agent::Agent)::Vector{String}
    return agent.tools
end

function call_model(message::String, config::AgentConfig)::String
    # TODO: implement actual API call
    return "Response to: $message"
end

function validate(input::String)::Bool
    return !isempty(strip(input))
end

macro agent_str(name)
    :(create_agent($name))
end

function create_agent(name::String; config=nothing)::Agent
    Agent(name; config=config)
end

end # module

# FIXME: add proper error types
