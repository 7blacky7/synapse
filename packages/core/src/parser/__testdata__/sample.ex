defmodule Synapse.Agent do
  @moduledoc """
  Core agent module for Synapse.
  """

  use GenServer
  require Logger
  alias Synapse.Config
  import Synapse.Utils, only: [sanitize: 1, validate: 1]

  @max_retries 3
  @default_model "claude-opus-4-6"
  @timeout 30_000

  defstruct [:name, :config, status: :idle, tools: []]

  @type status :: :active | :idle | :stopped | :error
  @type t :: %__MODULE__{name: String.t(), config: Config.t(), status: status()}

  @callback process(message :: String.t()) :: {:ok, String.t()} | {:error, term()}
  @callback get_tools() :: [String.t()]

  def start_link(name, opts \\ []) do
    config = Keyword.get(opts, :config, %Config{})
    GenServer.start_link(__MODULE__, %{name: name, config: config}, name: via(name))
  end

  def process(agent, message) do
    GenServer.call(agent, {:process, message}, @timeout)
  end

  def get_status(agent) do
    GenServer.call(agent, :get_status)
  end

  @impl true
  def init(state) do
    Logger.info("Agent #{state.name} starting")
    {:ok, Map.put(state, :status, :idle)}
  end

  @impl true
  def handle_call({:process, message}, _from, state) do
    state = %{state | status: :active}
    result = call_model(message, state.config)
    state = %{state | status: :idle}
    {:reply, {:ok, result}, state}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, state.status, state}
  end

  @impl true
  def handle_info(:timeout, state) do
    {:noreply, %{state | status: :idle}}
  end

  defp call_model(message, _config) do
    # TODO: implement actual API call
    "Response to: #{message}"
  end

  defp via(name), do: {:via, Registry, {Synapse.Registry, name}}

  defguard is_valid_message(msg) when is_binary(msg) and byte_size(msg) > 0

  defmacro __using__(_opts) do
    quote do
      import Synapse.Agent
    end
  end
end

defmodule Synapse.Config do
  defstruct model: "claude-opus-4-6", max_tokens: 4096, temperature: 0.7
end

defprotocol Synapse.Serializable do
  def serialize(data)
end

# FIXME: add supervision tree
