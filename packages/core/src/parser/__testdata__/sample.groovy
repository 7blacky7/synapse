package com.synapse.core

import groovy.transform.CompileStatic
import groovy.transform.ToString

@CompileStatic
class AgentConfig {
    String model = 'claude-opus-4-6'
    int maxTokens = 4096
    double temperature = 0.7
}

enum Status {
    ACTIVE, IDLE, STOPPED, ERROR
}

interface Agent {
    String process(String message)
    List<String> getTools()
    Status getStatus()
}

trait HasLogging {
    void log(String message) {
        println "[${this.class.simpleName}] $message"
    }
}

@ToString(includeNames = true)
abstract class BaseAgent implements Agent, HasLogging {
    final String name
    AgentConfig config
    protected Status status = Status.IDLE

    BaseAgent(String name, AgentConfig config = null) {
        this.name = name
        this.config = config ?: new AgentConfig()
    }

    protected boolean validate(String input) {
        input?.trim()
    }
}

class SynapseAgent extends BaseAgent {
    SynapseAgent(String name, AgentConfig config = null) {
        super(name, config)
    }

    @Override
    String process(String message) {
        assert validate(message): 'Empty message'
        status = Status.ACTIVE
        def result = callModel(message)
        status = Status.IDLE
        result
    }

    @Override
    List<String> getTools() {
        ['search', 'read', 'write']
    }

    @Override
    Status getStatus() { status }

    private String callModel(String message) {
        // TODO: implement actual model call
        "Response to: $message"
    }
}

static SynapseAgent createAgent(String name) {
    new SynapseAgent(name)
}

def MAX_RETRIES = 3

// FIXME: add proper error handling
