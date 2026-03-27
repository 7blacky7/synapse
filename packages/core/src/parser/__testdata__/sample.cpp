#include <iostream>
#include <string>
#include <vector>
#include <memory>
#include "agent.hpp"

#define MAX_RETRIES 3
#define BUFFER_SIZE 4096

namespace synapse {

const std::string DEFAULT_MODEL = "claude-opus-4-6";

enum class Status { Active, Idle, Stopped, Error };

struct Config {
    std::string model = DEFAULT_MODEL;
    int max_tokens = 4096;
    double temperature = 0.7;
};

class IAgent {
public:
    virtual ~IAgent() = default;
    virtual std::string process(const std::string& msg) = 0;
    virtual std::vector<std::string> getTools() const = 0;
    virtual Status status() const = 0;
};

template<typename T>
class AgentPool {
public:
    void add(std::shared_ptr<T> agent) {
        agents_.push_back(std::move(agent));
    }

    size_t size() const { return agents_.size(); }

private:
    std::vector<std::shared_ptr<T>> agents_;
};

class SynapseAgent : public IAgent {
public:
    explicit SynapseAgent(const std::string& name, Config config = {})
        : name_(name), config_(std::move(config)), status_(Status::Idle) {}

    std::string process(const std::string& msg) override {
        status_ = Status::Active;
        auto result = "Response to: " + msg;
        status_ = Status::Idle;
        return result;
    }

    std::vector<std::string> getTools() const override {
        return {"search", "read", "write"};
    }

    Status status() const override { return status_; }
    const std::string& name() const { return name_; }

private:
    std::string name_;
    Config config_;
    Status status_;

    bool validate(const std::string& input) const {
        return !input.empty();
    }
};

} // namespace synapse

// TODO: add move semantics for AgentPool
// FIXME: thread safety for status
