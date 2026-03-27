#version 450

#define MAX_AGENTS 1024
#define PI 3.14159265

layout(local_size_x = 64) in;

struct AgentData {
    vec3 position;
    float status;
    vec3 velocity;
    float padding;
};

layout(std430, binding = 0) readonly buffer AgentsIn {
    AgentData agents_in[];
};

layout(std430, binding = 1) buffer AgentsOut {
    AgentData agents_out[];
};

layout(std140, binding = 2) uniform SimParams {
    float deltaTime;
    float maxSpeed;
    uint agentCount;
    uint padding;
} params;

layout(binding = 3) uniform sampler2D texInput;

shared vec4 sharedData[64];

vec3 clampSpeed(vec3 velocity, float maxSpeed) {
    float speed = length(velocity);
    if (speed > maxSpeed) {
        return normalize(velocity) * maxSpeed;
    }
    return velocity;
}

vec3 computeForce(AgentData a, AgentData b) {
    vec3 diff = b.position - a.position;
    float dist = length(diff);
    if (dist < 0.001) return vec3(0.0);
    return normalize(diff) / (dist * dist);
}

void main() {
    uint idx = gl_GlobalInvocationID.x;
    if (idx >= params.agentCount) return;

    AgentData agent = agents_in[idx];
    vec3 force = vec3(0.0);

    for (uint i = 0; i < params.agentCount; i++) {
        if (i == idx) continue;
        force += computeForce(agent, agents_in[i]);
    }

    agent.velocity += force * params.deltaTime;
    agent.velocity = clampSpeed(agent.velocity, params.maxSpeed);
    agent.position += agent.velocity * params.deltaTime;

    agents_out[idx] = agent;
}

// TODO: add spatial partitioning
// FIXME: handle boundary conditions
