package com.synapse.core;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

public class AgentManager {

    public static final int MAX_RETRIES = 3;
    public static final String DEFAULT_MODEL = "claude-opus-4-6";
    private final Map<String, Agent> agents;

    public enum Status {
        ACTIVE, IDLE, STOPPED, ERROR
    }

    public interface Agent {
        CompletableFuture<String> process(String message);
        List<String> getTools();
        Status getStatus();
    }

    public record AgentConfig(String model, int maxTokens, double temperature) {
        public AgentConfig {
            if (maxTokens <= 0) throw new IllegalArgumentException("maxTokens must be positive");
        }
    }

    public static class SynapseAgent implements Agent {
        private final String name;
        private final AgentConfig config;
        private volatile Status status = Status.IDLE;

        public SynapseAgent(String name, AgentConfig config) {
            this.name = name;
            this.config = config;
        }

        @Override
        public CompletableFuture<String> process(String message) {
            status = Status.ACTIVE;
            return CompletableFuture.supplyAsync(() -> {
                String result = "Response to: " + message;
                status = Status.IDLE;
                return result;
            });
        }

        @Override
        public List<String> getTools() {
            return List.of("search", "read", "write");
        }

        @Override
        public Status getStatus() {
            return status;
        }

        public String getName() {
            return name;
        }
    }

    public AgentManager() {
        this.agents = new java.util.concurrent.ConcurrentHashMap<>();
    }

    public void register(Agent agent) {
        agents.put(((SynapseAgent) agent).getName(), agent);
    }

    public Optional<Agent> get(String name) {
        return Optional.ofNullable(agents.get(name));
    }

    // TODO: add agent lifecycle management
    // FIXME: potential memory leak with completed futures
}
