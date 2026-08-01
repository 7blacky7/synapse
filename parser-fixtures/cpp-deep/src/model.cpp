#include "cpp_fixture/model.hpp"

#include <compare>
#include <stdexcept>
#include <utility>

namespace synapse::parser_fixture::domain {

Entity::Builder& Entity::Builder::id(Id value) noexcept {
    id_ = value;
    return *this;
}

Entity::Builder& Entity::Builder::name(std::string value) {
    name_ = std::move(value);
    return *this;
}

Entity::Builder& Entity::Builder::state(State value) noexcept {
    state_ = value;
    return *this;
}

Entity::Builder& Entity::Builder::metric(Metric value) {
    metrics_.push_back(std::move(value));
    return *this;
}

Entity Entity::Builder::build() {
    return Entity{id_, std::move(name_), state_, std::move(metrics_)};
}

Entity::Entity(Id id, std::string name, State state, std::vector<Metric> metrics)
    : id_(id), name_(std::move(name)), state_(state), metrics_(std::move(metrics)) {
    flags_.dirty = !metrics_.empty();
}

Entity::Entity(const Entity& other)
    : id_(other.id_), name_(other.name_), state_(other.state_), flags_(other.flags_), metrics_(other.metrics_) {}

Entity::Entity(Entity&& other) noexcept
    : id_(std::exchange(other.id_, 0)),
      name_(std::move(other.name_)),
      state_(std::exchange(other.state_, State::idle)),
      flags_(other.flags_),
      metrics_(std::move(other.metrics_)) {}

Entity& Entity::operator=(const Entity& other) {
    if (this != &other) {
        copy_from(other);
    }
    return *this;
}

Entity& Entity::operator=(Entity&& other) noexcept {
    if (this != &other) {
        id_ = std::exchange(other.id_, 0);
        name_ = std::move(other.name_);
        state_ = std::exchange(other.state_, State::idle);
        flags_ = other.flags_;
        metrics_ = std::move(other.metrics_);
    }
    return *this;
}

Entity::~Entity() = default;

Entity::Id Entity::id() const noexcept {
    return id_;
}

std::string_view Entity::name() const noexcept {
    return name_;
}

State Entity::state() const noexcept {
    return state_;
}

const Flags& Entity::flags() const noexcept {
    return flags_;
}

std::span<const Metric> Entity::metrics() const noexcept {
    return metrics_;
}

void Entity::transition(State next) {
    if (!transition_allowed(next)) {
        flags_.urgent = 1;
        throw std::logic_error("invalid state transition");
    }
    state_ = next;
    flags_.dirty = 1;
}

void Entity::apply(const Transform& transform) {
    if (transform) {
        transform(*this);
    }
}

void Entity::apply_raw(RawTransform transform, int factor) {
    if (transform == nullptr) {
        throw std::invalid_argument("transform must not be null");
    }
    transform(*this, factor);
}

void Entity::add_metric(Metric metric) {
    metrics_.push_back(std::move(metric));
    flags_.dirty = 1;
}

Entity::operator bool() const noexcept {
    return id_ != 0 && state_ != State::failed;
}

bool Entity::operator==(const Entity& other) const noexcept {
    return id_ == other.id_ && name_ == other.name_ && state_ == other.state_;
}

auto Entity::operator<=>(const Entity& other) const noexcept {
    return id_ <=> other.id_;
}

bool Entity::transition_allowed(State next) const noexcept {
    switch (state_) {
        case State::idle:
            return next == State::ready || next == State::failed;
        case State::ready:
            return next == State::running || next == State::failed;
        case State::running:
            return next == State::paused || next == State::complete || next == State::failed;
        case State::paused:
            return next == State::running || next == State::failed;
        case State::failed:
        case State::complete:
            return false;
    }
    return false;
}

void Entity::copy_from(const Entity& other) {
    id_ = other.id_;
    name_ = other.name_;
    state_ = other.state_;
    flags_ = other.flags_;
    metrics_ = other.metrics_;
}

std::ostream& operator<<(std::ostream& out, const Entity& entity) {
    return out << "Entity{" << entity.id_ << ", " << entity.name_ << ", " << to_string(entity.state_) << "}";
}

std::string_view to_string(State state) noexcept {
    switch (state) {
        case State::idle: return "idle";
        case State::ready: return "ready";
        case State::running: return "running";
        case State::paused: return "paused";
        case State::failed: return "failed";
        case State::complete: return "complete";
    }
    return "unknown";
}

void multiply_entity_id(Entity& entity, int factor) {
    entity.add_metric(Metric{"id_factor", Scalar{static_cast<std::int64_t>(entity.id() * factor)}, false});
}

}  // namespace synapse::parser_fixture::domain
