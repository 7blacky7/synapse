namespace Synapse.Core

open System
open System.Threading.Tasks

[<Literal>]
let MaxRetries = 3

[<Literal>]
let DefaultModel = "claude-opus-4-6"

type Status =
    | Active
    | Idle
    | Stopped
    | Error of string

type AgentConfig =
    { Model: string
      MaxTokens: int
      Temperature: float }

[<Interface>]
type IAgent =
    abstract Process: string -> Task<Result<string, string>>
    abstract GetTools: unit -> string list
    abstract Status: Status

type Agent =
    { Name: string
      Config: AgentConfig
      mutable Status: Status
      Tools: string list }

module AgentConfig =
    let defaultConfig =
        { Model = DefaultModel
          MaxTokens = 4096
          Temperature = 0.7 }

module Agent =
    let create name config =
        { Name = name
          Config = config |> Option.defaultValue AgentConfig.defaultConfig
          Status = Idle
          Tools = [ "search"; "read"; "write" ] }

    let private callModel message _config =
        // TODO: implement actual API call
        sprintf "Response to: %s" message

    let process (agent: Agent) message =
        task {
            if String.IsNullOrWhiteSpace message then
                return Error "Empty message"
            else
                agent.Status <- Active
                let result = callModel message agent.Config
                agent.Status <- Idle
                return Ok result
        }

    let getTools (agent: Agent) = agent.Tools

    let validate input =
        not (String.IsNullOrWhiteSpace input)

let createAgent name =
    Agent.create name None

type AgentResult =
    | Success of string
    | Failure of string

let (|ValidMessage|InvalidMessage|) (msg: string) =
    if String.IsNullOrWhiteSpace msg then InvalidMessage
    else ValidMessage msg

// FIXME: add proper error handling
