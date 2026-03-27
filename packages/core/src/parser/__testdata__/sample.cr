require "json"
require "http/client"

MAX_RETRIES = 3
DEFAULT_MODEL = "claude-opus-4-6"

enum Status
  Active
  Idle
  Stopped
  Error
end

struct AgentConfig
  include JSON::Serializable

  property model : String = DEFAULT_MODEL
  property max_tokens : Int32 = 4096
  property temperature : Float64 = 0.7
end

abstract class BaseAgent
  getter name : String
  getter status : Status = Status::Idle
  property config : AgentConfig

  def initialize(@name : String, @config : AgentConfig = AgentConfig.new)
  end

  abstract def process(message : String) : String
  abstract def get_tools : Array(String)

  protected def validate(input : String) : Bool
    !input.strip.empty?
  end
end

class SynapseAgent < BaseAgent
  def process(message : String) : String
    raise ArgumentError.new("Empty message") unless validate(message)
    @status = Status::Active
    result = call_model(message)
    @status = Status::Idle
    result
  end

  def get_tools : Array(String)
    ["search", "read", "write"]
  end

  private def call_model(message : String) : String
    # TODO: implement actual API call
    "Response to: #{message}"
  end
end

module AgentFactory
  def self.create(name : String, config : AgentConfig? = nil) : SynapseAgent
    SynapseAgent.new(name, config || AgentConfig.new)
  end
end

macro define_agent(name, &block)
  class {{name.id}}Agent < BaseAgent
    {{block.body}}
  end
end

annotation Cacheable; end

# FIXME: add proper error types
