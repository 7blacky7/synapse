<?php

namespace Synapse\Core;

use Synapse\Config\AgentConfig;
use Psr\Log\LoggerInterface;

define('MAX_RETRIES', 3);
const DEFAULT_MODEL = 'claude-opus-4-6';

enum Status: string {
    case Active = 'active';
    case Idle = 'idle';
    case Stopped = 'stopped';
    case Error = 'error';
}

interface AgentInterface {
    public function process(string $message): string;
    public function getTools(): array;
    public function getStatus(): Status;
}

interface Configurable {
    public function configure(AgentConfig $config): void;
}

trait HasLogging {
    private LoggerInterface $logger;

    protected function log(string $message): void {
        $this->logger->info("[{$this->name}] {$message}");
    }
}

abstract class BaseAgent implements AgentInterface {
    use HasLogging;

    protected Status $status = Status::Idle;
    public const VERSION = '1.0.0';

    public function __construct(
        protected readonly string $name,
        protected AgentConfig $config,
    ) {}

    abstract public function process(string $message): string;

    protected function validate(string $input): bool {
        return !empty(trim($input));
    }
}

class SynapseAgent extends BaseAgent implements Configurable {
    public function process(string $message): string {
        $this->status = Status::Active;
        $result = $this->callModel($message);
        $this->status = Status::Idle;
        return $result;
    }

    public function getTools(): array {
        return ['search', 'read', 'write'];
    }

    public function getStatus(): Status {
        return $this->status;
    }

    public function configure(AgentConfig $config): void {
        $this->config = $config;
    }

    private function callModel(string $message): string {
        // TODO: implement actual model call
        return "Response to: {$message}";
    }

    public static function create(string $name): self {
        return new self($name, new AgentConfig());
    }
}

function createAgent(string $name, ?AgentConfig $config = null): SynapseAgent {
    return new SynapseAgent($name, $config ?? new AgentConfig());
}

// FIXME: add retry logic for model calls
