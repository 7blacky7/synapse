open Lwt.Infix
open Printf

let max_retries = 3
let default_model = "claude-opus-4-6"

type status =
  | Active
  | Idle
  | Stopped
  | Error of string

type config = {
  model : string;
  max_tokens : int;
  temperature : float;
}

type agent = {
  name : string;
  config : config;
  mutable status : status;
  tools : string list;
}

module type AGENT = sig
  type t
  val create : string -> config option -> t
  val process : t -> string -> (string, string) result Lwt.t
  val get_tools : t -> string list
  val status : t -> status
end

module SynapseAgent : AGENT = struct
  type t = agent

  let create name config_opt =
    let config = match config_opt with
      | Some c -> c
      | None -> { model = default_model; max_tokens = 4096; temperature = 0.7 }
    in
    { name; config; status = Idle; tools = ["search"; "read"; "write"] }

  let process agent message =
    if String.length message = 0 then
      Lwt.return (Error "Empty message")
    else begin
      agent.status <- Active;
      let result = call_model message agent.config in
      agent.status <- Idle;
      Lwt.return (Ok result)
    end

  let get_tools agent = agent.tools
  let status agent = agent.status
end

and call_model message _config =
  (* TODO: implement actual API call *)
  sprintf "Response to: %s" message

let default_config = {
  model = default_model;
  max_tokens = 4096;
  temperature = 0.7;
}

let validate input =
  String.length (String.trim input) > 0

let () =
  let agent = SynapseAgent.create "test" None in
  match Lwt_main.run (SynapseAgent.process agent "hello") with
  | Ok msg -> print_endline msg
  | Error e -> eprintf "Error: %s\n" e

(* FIXME: add proper error types *)
