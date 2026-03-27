use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub const MAX_RETRIES: u32 = 3;
pub const DEFAULT_MODEL: &str = "claude-opus-4-6";
static INSTANCE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Status {
    Active,
    Idle,
    Stopped,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub model: String,
    pub max_tokens: usize,
    pub temperature: f64,
}

pub trait Agent: Send + Sync {
    fn process(&self, message: &str) -> Result<String, AgentError>;
    fn get_tools(&self) -> Vec<String>;
    fn status(&self) -> Status;
}

pub trait Configurable {
    fn configure(&mut self, config: Config) -> Result<(), AgentError>;
}

#[derive(Debug)]
pub struct AgentError {
    pub message: String,
    pub code: u32,
}

pub struct SynapseAgent {
    name: String,
    config: Config,
    status: Arc<Mutex<Status>>,
    tools: Vec<String>,
}

impl SynapseAgent {
    pub fn new(name: &str, config: Config) -> Self {
        Self {
            name: name.to_string(),
            config,
            status: Arc::new(Mutex::new(Status::Idle)),
            tools: vec!["search".into(), "read".into()],
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    fn validate_message(&self, msg: &str) -> bool {
        !msg.is_empty()
    }
}

impl Agent for SynapseAgent {
    fn process(&self, message: &str) -> Result<String, AgentError> {
        if !self.validate_message(message) {
            return Err(AgentError { message: "Empty message".into(), code: 400 });
        }
        *self.status.lock().unwrap() = Status::Active;
        let result = format!("Response to: {}", message);
        *self.status.lock().unwrap() = Status::Idle;
        Ok(result)
    }

    fn get_tools(&self) -> Vec<String> {
        self.tools.clone()
    }

    fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            model: DEFAULT_MODEL.to_string(),
            max_tokens: 4096,
            temperature: 0.7,
        }
    }
}

pub mod utils {
    pub fn sanitize(input: &str) -> String {
        input.trim().to_string()
    }
}

// TODO: implement async trait methods
// FIXME: status lock contention under load
