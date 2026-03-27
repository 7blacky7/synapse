module synapse.agent;

import std.stdio;
import std.string;
import std.conv;
import std.algorithm;

enum MAX_RETRIES = 3;
enum DEFAULT_MODEL = "claude-opus-4-6";
immutable BUFFER_SIZE = 4096;

enum Status { Active, Idle, Stopped, Error }

struct AgentConfig {
    string model = DEFAULT_MODEL;
    int maxTokens = 4096;
    double temperature = 0.7;
}

interface IAgent {
    string process(string message);
    string[] getTools();
    @property Status status();
}

abstract class BaseAgent : IAgent {
    protected string name;
    protected AgentConfig config;
    protected Status _status = Status.Idle;

    this(string name, AgentConfig config = AgentConfig()) {
        this.name = name;
        this.config = config;
    }

    @property Status status() { return _status; }

    protected bool validate(string input) {
        return input.strip().length > 0;
    }
}

class SynapseAgent : BaseAgent {
    this(string name, AgentConfig config = AgentConfig()) {
        super(name, config);
    }

    override string process(string message) {
        assert(validate(message), "Empty message");
        _status = Status.Active;
        scope(exit) _status = Status.Idle;
        return callModel(message);
    }

    override string[] getTools() {
        return ["search", "read", "write"];
    }

    private string callModel(string message) {
        // TODO: implement actual API call
        return "Response to: " ~ message;
    }
}

SynapseAgent createAgent(string name) {
    return new SynapseAgent(name);
}

template AgentFactory(T : IAgent) {
    T create(string name) {
        return new T(name);
    }
}

mixin template HasLogging() {
    void log(string msg) {
        writefln("[%s] %s", this.name, msg);
    }
}

unittest {
    auto agent = createAgent("test");
    assert(agent.status == Status.Idle);
}

// FIXME: add proper error handling
