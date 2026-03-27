require 'json'
require 'logger'
require_relative 'config'

MAX_RETRIES = 3
DEFAULT_MODEL = 'claude-opus-4-6'

module Synapse
  module Core
    class AgentError < StandardError; end

    class Config
      attr_accessor :model, :max_tokens, :temperature

      def initialize(model: DEFAULT_MODEL, max_tokens: 4096, temperature: 0.7)
        @model = model
        @max_tokens = max_tokens
        @temperature = temperature
      end
    end

    class BaseAgent
      attr_reader :name, :status

      def initialize(name, config: nil)
        @name = name
        @config = config || Config.new
        @status = :idle
        @logger = Logger.new($stdout)
      end

      def process(message)
        raise NotImplementedError
      end

      def self.from_json(path)
        data = JSON.parse(File.read(path))
        new(data['name'], config: Config.new(**data.fetch('config', {}).transform_keys(&:to_sym)))
      end

      protected

      def validate(input)
        raise AgentError, 'Empty input' if input.nil? || input.empty?
        true
      end

      private

      def log_activity(action)
        @logger.info("[#{@name}] #{action}")
      end
    end

    class SynapseAgent < BaseAgent
      def process(message)
        validate(message)
        @status = :active
        result = call_model(message)
        @status = :idle
        result
      end

      def tools
        %w[search read write]
      end

      private

      def call_model(message)
        # TODO: implement actual API call
        "Response to: #{message}"
      end
    end
  end
end

# FIXME: thread safety for status changes
