local json = require("cjson")
local http = require("socket.http")

local MAX_RETRIES = 3
local DEFAULT_MODEL = "claude-opus-4-6"

---@class AgentConfig
---@field model string
---@field max_tokens number
local AgentConfig = {}
AgentConfig.__index = AgentConfig

function AgentConfig.new(model, max_tokens)
    local self = setmetatable({}, AgentConfig)
    self.model = model or DEFAULT_MODEL
    self.max_tokens = max_tokens or 4096
    return self
end

---@class Agent
local Agent = {}
Agent.__index = Agent

function Agent.new(name, config)
    local self = setmetatable({}, Agent)
    self.name = name
    self.config = config or AgentConfig.new()
    self.status = "idle"
    self._tools = {"search", "read", "write"}
    return self
end

function Agent:process(message)
    assert(type(message) == "string" and #message > 0, "Invalid message")
    self.status = "active"
    local result = self:_call_model(message)
    self.status = "idle"
    return result
end

function Agent:get_tools()
    return self._tools
end

function Agent:_call_model(message)
    -- TODO: implement actual API call
    return "Response to: " .. message
end

local function create_agent(name, config)
    return Agent.new(name, config)
end

local function load_config(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    return json.decode(content)
end

-- FIXME: error handling in load_config
return {
    Agent = Agent,
    AgentConfig = AgentConfig,
    create_agent = create_agent,
    MAX_RETRIES = MAX_RETRIES,
}
