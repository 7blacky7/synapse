const std = @import("std");
const Allocator = std.mem.Allocator;

pub const max_retries: u32 = 3;
pub const default_model = "claude-opus-4-6";
const buffer_size: usize = 4096;

pub const Status = enum {
    active,
    idle,
    stopped,
    err,
};

pub const AgentConfig = struct {
    model: []const u8 = default_model,
    max_tokens: u32 = 4096,
    temperature: f64 = 0.7,
};

pub const AgentError = error{
    InvalidMessage,
    ModelError,
    Timeout,
};

pub const Agent = struct {
    name: []const u8,
    config: AgentConfig,
    status: Status,
    allocator: Allocator,

    const Self = @This();

    pub fn init(allocator: Allocator, name: []const u8, config: ?AgentConfig) Self {
        return .{
            .name = name,
            .config = config orelse AgentConfig{},
            .status = .idle,
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *Self) void {
        _ = self;
    }

    pub fn process(self: *Self, message: []const u8) AgentError![]const u8 {
        if (message.len == 0) return AgentError.InvalidMessage;
        self.status = .active;
        defer self.status = .idle;
        return self.callModel(message);
    }

    pub fn getTools(self: Self) [3][]const u8 {
        _ = self;
        return .{ "search", "read", "write" };
    }

    fn callModel(self: Self, message: []const u8) []const u8 {
        _ = self;
        // TODO: implement actual model call
        return message;
    }

    fn validate(self: Self, input: []const u8) bool {
        _ = self;
        return input.len > 0;
    }
};

pub fn createAgent(allocator: Allocator, name: []const u8) Agent {
    return Agent.init(allocator, name, null);
}

test "agent creation" {
    const agent = createAgent(std.testing.allocator, "test-agent");
    try std.testing.expectEqual(Status.idle, agent.status);
}

// FIXME: memory management for response strings
