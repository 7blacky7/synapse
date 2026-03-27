// Synapse GPU Compute Shader

struct AgentData {
    position: vec3<f32>,
    velocity: vec3<f32>,
    status: u32,
    padding: u32,
};

struct SimParams {
    delta_time: f32,
    max_speed: f32,
    agent_count: u32,
    padding: u32,
};

@group(0) @binding(0) var<storage, read> agents_in: array<AgentData>;
@group(0) @binding(1) var<storage, read_write> agents_out: array<AgentData>;
@group(0) @binding(2) var<uniform> params: SimParams;
@group(1) @binding(0) var texture_in: texture_2d<f32>;
@group(1) @binding(1) var sampler_linear: sampler;

const PI: f32 = 3.14159265;
const MAX_AGENTS: u32 = 1024u;

var<private> local_id: u32;
var<workgroup> shared_data: array<vec4<f32>, 256>;

fn clamp_speed(velocity: vec3<f32>, max_speed: f32) -> vec3<f32> {
    let speed = length(velocity);
    if (speed > max_speed) {
        return normalize(velocity) * max_speed;
    }
    return velocity;
}

fn compute_force(a: AgentData, b: AgentData) -> vec3<f32> {
    let diff = b.position - a.position;
    let dist = length(diff);
    if (dist < 0.001) {
        return vec3<f32>(0.0);
    }
    return normalize(diff) / (dist * dist);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= params.agent_count) {
        return;
    }

    var agent = agents_in[idx];
    var force = vec3<f32>(0.0);

    for (var i = 0u; i < params.agent_count; i++) {
        if (i == idx) { continue; }
        force += compute_force(agent, agents_in[i]);
    }

    agent.velocity += force * params.delta_time;
    agent.velocity = clamp_speed(agent.velocity, params.max_speed);
    agent.position += agent.velocity * params.delta_time;

    agents_out[idx] = agent;
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(pos[idx], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = pos.xy / vec2<f32>(1920.0, 1080.0);
    return textureSample(texture_in, sampler_linear, uv);
}

// TODO: add spatial partitioning for O(n) force computation
// FIXME: handle boundary conditions
