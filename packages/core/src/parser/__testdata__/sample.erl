-module(synapse_agent).
-behaviour(gen_server).

-export([start_link/2, process/2, get_tools/1, get_status/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2]).

-define(MAX_RETRIES, 3).
-define(DEFAULT_MODEL, <<"claude-opus-4-6">>).
-define(TIMEOUT, 30000).

-record(config, {
    model = ?DEFAULT_MODEL :: binary(),
    max_tokens = 4096 :: non_neg_integer(),
    temperature = 0.7 :: float()
}).

-record(state, {
    name :: binary(),
    config :: #config{},
    status = idle :: active | idle | stopped | error
}).

-type status() :: active | idle | stopped | error.
-type agent_result() :: {ok, binary()} | {error, term()}.

-spec start_link(binary(), #config{} | undefined) -> {ok, pid()}.
start_link(Name, Config) ->
    gen_server:start_link({local, Name}, ?MODULE, [Name, Config], []).

-spec process(pid(), binary()) -> agent_result().
process(Agent, Message) ->
    gen_server:call(Agent, {process, Message}, ?TIMEOUT).

get_tools(_Agent) ->
    [<<"search">>, <<"read">>, <<"write">>].

get_status(Agent) ->
    gen_server:call(Agent, get_status).

init([Name, Config]) ->
    Cfg = case Config of
        undefined -> #config{};
        C -> C
    end,
    {ok, #state{name = Name, config = Cfg, status = idle}}.

handle_call({process, Message}, _From, State) ->
    case validate(Message) of
        true ->
            State1 = State#state{status = active},
            Result = call_model(Message, State1#state.config),
            State2 = State1#state{status = idle},
            {reply, {ok, Result}, State2};
        false ->
            {reply, {error, empty_message}, State}
    end;

handle_call(get_status, _From, State) ->
    {reply, State#state.status, State}.

handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info(_Info, State) ->
    {noreply, State}.

terminate(_Reason, _State) ->
    ok.

call_model(Message, _Config) ->
    %% TODO: implement actual API call
    <<"Response to: ", Message/binary>>.

validate(Message) when is_binary(Message), byte_size(Message) > 0 -> true;
validate(_) -> false.

%% FIXME: add supervisor support
