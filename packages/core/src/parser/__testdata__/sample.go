package synapse

import (
	"context"
	"fmt"
	"sync"
	"time"
)

const (
	MaxRetries    = 3
	DefaultModel  = "claude-opus-4-6"
	DefaultTimeout = 30 * time.Second
)

var (
	defaultConfig *Config
	mu            sync.RWMutex
)

type Status int

const (
	StatusActive Status = iota
	StatusIdle
	StatusStopped
)

type Config struct {
	Model      string `json:"model"`
	MaxTokens  int    `json:"max_tokens"`
	Temperature float64 `json:"temperature"`
}

type Agent interface {
	Process(ctx context.Context, msg string) (string, error)
	GetTools() []string
	Status() Status
}

type SynapseAgent struct {
	Name   string
	config *Config
	status Status
	mu     sync.RWMutex
}

func NewAgent(name string, cfg *Config) *SynapseAgent {
	if cfg == nil {
		cfg = &Config{Model: DefaultModel, MaxTokens: 4096}
	}
	return &SynapseAgent{Name: name, config: cfg, status: StatusIdle}
}

func (a *SynapseAgent) Process(ctx context.Context, msg string) (string, error) {
	a.mu.Lock()
	a.status = StatusActive
	a.mu.Unlock()

	defer func() {
		a.mu.Lock()
		a.status = StatusIdle
		a.mu.Unlock()
	}()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	default:
		return fmt.Sprintf("Response to: %s", msg), nil
	}
}

func (a *SynapseAgent) GetTools() []string {
	return []string{"search", "read", "write"}
}

func (a *SynapseAgent) Status() Status {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.status
}

func init() {
	defaultConfig = &Config{Model: DefaultModel, MaxTokens: 4096, Temperature: 0.7}
}

// TODO: add graceful shutdown
// FIXME: memory leak in long-running sessions
