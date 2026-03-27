"""Synapse Agent module for managing AI agents."""

import os
import json
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field
from abc import ABC, abstractmethod
from enum import Enum

MAX_RETRIES = 3
DEFAULT_MODEL = "claude-opus-4-6"
_internal_cache: Dict[str, Any] = {}

class AgentStatus(Enum):
    ACTIVE = "active"
    IDLE = "idle"
    STOPPED = "stopped"
    ERROR = "error"

@dataclass
class AgentConfig:
    model: str = DEFAULT_MODEL
    max_tokens: int = 4096
    temperature: float = 0.7
    tools: List[str] = field(default_factory=list)

class BaseAgent(ABC):
    """Abstract base class for all agents."""

    def __init__(self, name: str, config: Optional[AgentConfig] = None):
        self.name = name
        self.config = config or AgentConfig()
        self._status = AgentStatus.IDLE

    @abstractmethod
    async def process(self, message: str) -> str:
        """Process an incoming message."""
        ...

    @abstractmethod
    def get_tools(self) -> List[str]:
        ...

    def reset(self) -> None:
        self._status = AgentStatus.IDLE

    @property
    def status(self) -> AgentStatus:
        return self._status

    @staticmethod
    def from_config(path: str) -> "BaseAgent":
        with open(path) as f:
            data = json.load(f)
        return create_agent(data["name"], AgentConfig(**data.get("config", {})))

class SynapseAgent(BaseAgent):
    """Main Synapse agent implementation."""

    async def process(self, message: str) -> str:
        self._status = AgentStatus.ACTIVE
        result = await self._call_model(message)
        self._status = AgentStatus.IDLE
        return result

    def get_tools(self) -> List[str]:
        return self.config.tools

    async def _call_model(self, message: str) -> str:
        # TODO: implement actual model call
        return f"Response to: {message}"

def create_agent(name: str, config: Optional[AgentConfig] = None) -> SynapseAgent:
    """Factory function for creating agents."""
    return SynapseAgent(name, config)

def load_agents(directory: str) -> List[BaseAgent]:
    agents = []
    for fname in os.listdir(directory):
        if fname.endswith(".json"):
            agents.append(BaseAgent.from_config(os.path.join(directory, fname)))
    return agents

# FIXME: race condition in concurrent agent access
