// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

uint256 constant MAX_RETRIES = 3;
uint256 constant MAX_AGENTS = 100;

error AgentNotFound(uint256 agentId);
error InvalidMessage();
error Unauthorized();

event AgentCreated(uint256 indexed agentId, string name, address owner);
event AgentProcessed(uint256 indexed agentId, string message);
event StatusChanged(uint256 indexed agentId, Status oldStatus, Status newStatus);

enum Status { Active, Idle, Stopped, Error }

struct AgentConfig {
    string model;
    uint256 maxTokens;
    uint256 temperature;
}

struct Agent {
    uint256 id;
    string name;
    AgentConfig config;
    Status status;
    address owner;
}

interface IAgentManager {
    function createAgent(string calldata name, AgentConfig calldata config) external returns (uint256);
    function process(uint256 agentId, string calldata message) external returns (string memory);
    function getAgent(uint256 agentId) external view returns (Agent memory);
}

library AgentLib {
    function validate(string memory message) internal pure returns (bool) {
        return bytes(message).length > 0;
    }
}

abstract contract BaseAgentManager is Ownable, ReentrancyGuard {
    mapping(uint256 => Agent) internal agents;
    uint256 internal nextId;

    modifier onlyAgentOwner(uint256 agentId) {
        require(agents[agentId].owner == msg.sender, "Not agent owner");
        _;
    }

    function _createAgent(string memory name, AgentConfig memory config) internal returns (uint256) {
        uint256 id = nextId++;
        agents[id] = Agent(id, name, config, Status.Idle, msg.sender);
        emit AgentCreated(id, name, msg.sender);
        return id;
    }
}

contract SynapseManager is BaseAgentManager, IAgentManager {
    constructor() Ownable(msg.sender) {}

    function createAgent(string calldata name, AgentConfig calldata config) external override returns (uint256) {
        return _createAgent(name, config);
    }

    function process(uint256 agentId, string calldata message) external override nonReentrant onlyAgentOwner(agentId) returns (string memory) {
        if (!AgentLib.validate(message)) revert InvalidMessage();
        Agent storage agent = agents[agentId];
        emit StatusChanged(agentId, agent.status, Status.Active);
        agent.status = Status.Active;
        emit AgentProcessed(agentId, message);
        agent.status = Status.Idle;
        return string(abi.encodePacked("Response to: ", message));
    }

    function getAgent(uint256 agentId) external view override returns (Agent memory) {
        return agents[agentId];
    }

    receive() external payable {}
    fallback() external payable {}
}

// TODO: add agent deletion
// FIXME: gas optimization for process
