# FIXTURE MIT SOLLWERTEN — Zeilennummern der Parser-Ausgabe (julia.ts).
#
# WOFUER: Diese Datei enthaelt absichtlich die Faelle, bei denen die gemeldete
# Zeilennummer frueher falsch war. Das erste Feld eines struct bekam die
# Zeilennummer der struct-KOPFZEILE statt seiner eigenen. Ursache: das Muster
# beginnt mit \s+, das ueber den Zeilenumbruch greift, und die Zeile wurde vom
# Anfang des Treffers gerechnet statt vom ersten Nicht-Leerzeichen.
#
# SOLL (Stand ab dem trefferZeile-Fix, Symbol -> Zeile die es tragen MUSS):
#   struct-Feld [model]       -> Zeile 39   (erstes Feld von AgentConfig)
#   struct-Feld [max_tokens]  -> Zeile 40
#   struct-Feld [name]        -> Zeile 48   (erstes Feld von Agent)
#   struct-Feld [config]      -> Zeile 49
# Der ALTE Stand meldete fuer [model] und [name] jeweils EINE Zeile zu frueh,
# naemlich die Zeile des struct-Kopfes.
#
# PRUEFEN: parse() auf diese Datei anwenden und die line_start-Werte der
# Symbole mit parent_id gegen die Liste oben halten. Wenn du diese Datei
# aenderst, ZIEH DIE NUMMERN OBEN NACH — sie sind der Sollwert. MASCHINENLESBAR: jede Zeile der Form [name] -> Zeile N.

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
