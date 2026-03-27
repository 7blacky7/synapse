module synapse

import net.http
import json
import os

const (
	max_retries   = 3
	default_model = 'claude-opus-4-6'
	buffer_size   = 4096
)

enum Status {
	active
	idle
	stopped
	err
}

struct AgentConfig {
	model       string  = default_model
	max_tokens  int     = 4096
	temperature f64     = 0.7
}

struct Agent {
	name   string
	config AgentConfig
mut:
	status Status
	tools  []string
}

interface IAgent {
	process(message string) !string
	get_tools() []string
	status() Status
}

fn Agent.new(name string, config ?AgentConfig) Agent {
	return Agent{
		name:   name
		config: config or { AgentConfig{} }
		status: .idle
		tools:  ['search', 'read', 'write']
	}
}

fn (mut a Agent) process(message string) !string {
	if message.len == 0 {
		return error('Empty message')
	}
	a.status = .active
	defer { a.status = .idle }
	return a.call_model(message)
}

fn (a Agent) get_tools() []string {
	return a.tools
}

fn (a Agent) call_model(message string) string {
	// TODO: implement actual API call
	return 'Response to: ${message}'
}

fn validate(input string) bool {
	return input.trim_space().len > 0
}

pub fn create_agent(name string) Agent {
	return Agent.new(name, none)
}

// FIXME: add proper error handling
