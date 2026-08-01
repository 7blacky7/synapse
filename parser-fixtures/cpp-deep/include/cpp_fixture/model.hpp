#pragma once

#include "cpp_fixture/meta.hpp"

#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <ostream>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace synapse::parser_fixture::domain {

enum class State : std::uint8_t {
    idle,
    ready,
    running,
    paused,
    failed,
    complete,
};

struct Flags {
    std::uint8_t visible : 1 {1};
    std::uint8_t dirty : 1 {0};
    std::uint8_t urgent : 1 {0};
    std::uint8_t reserved : 5 {0};
};

union Scalar {
    std::int64_t integer;
    double floating;

    constexpr Scalar() : integer(0) {}
    constexpr explicit Scalar(std::int64_t value) : integer(value) {}
    constexpr explicit Scalar(double value) : floating(value) {}
};

struct Metric {
    std::string key;
    Scalar value{};
    bool is_floating{false};
};

class Entity {
public:
    using Id = std::uint64_t;
    using Transform = std::function<void(Entity&)>;
    using RawTransform = void (*)(Entity&, int);

    class Builder {
    public:
        Builder& id(Id value) noexcept;
        Builder& name(std::string value);
        Builder& state(State value) noexcept;
        Builder& metric(Metric value);
        [[nodiscard]] Entity build();

    private:
        Id id_{0};
        std::string name_{"unnamed"};
        State state_{State::idle};
        std::vector<Metric> metrics_{};
    };

    Entity(Id id, std::string name, State state, std::vector<Metric> metrics = {});
    Entity(const Entity& other);
    Entity(Entity&& other) noexcept;
    Entity& operator=(const Entity& other);
    Entity& operator=(Entity&& other) noexcept;
    ~Entity();

    [[nodiscard]] Id id() const noexcept;
    [[nodiscard]] std::string_view name() const noexcept;
    [[nodiscard]] State state() const noexcept;
    [[nodiscard]] const Flags& flags() const noexcept;
    [[nodiscard]] std::span<const Metric> metrics() const noexcept;

    void transition(State next);
    void apply(const Transform& transform);
    void apply_raw(RawTransform transform, int factor);
    void add_metric(Metric metric);

    [[nodiscard]] explicit operator bool() const noexcept;
    [[nodiscard]] bool operator==(const Entity& other) const noexcept;
    [[nodiscard]] auto operator<=>(const Entity& other) const noexcept;

    friend std::ostream& operator<<(std::ostream& out, const Entity& entity);

private:
    [[nodiscard]] bool transition_allowed(State next) const noexcept;
    void copy_from(const Entity& other);

    Id id_;
    std::string name_;
    State state_;
    Flags flags_{};
    std::vector<Metric> metrics_;
};

class Processor {
public:
    virtual ~Processor() = default;
    [[nodiscard]] virtual std::string_view processor_name() const noexcept = 0;
    virtual void process(Entity& entity) = 0;
};

template <typename T, std::size_t Capacity>
class RingBuffer {
public:
    static_assert(Capacity > 0, "Capacity must be positive");

    void push(T value) {
        values_[write_index_] = std::move(value);
        write_index_ = (write_index_ + 1) % Capacity;
        size_ = size_ < Capacity ? size_ + 1 : Capacity;
    }

    [[nodiscard]] const T& newest() const {
        if (size_ == 0) {
            throw std::logic_error("RingBuffer is empty");
        }
        const auto index = (write_index_ + Capacity - 1) % Capacity;
        return values_[index];
    }

    [[nodiscard]] std::size_t size() const noexcept {
        return size_;
    }

private:
    std::array<T, Capacity> values_{};
    std::size_t write_index_{0};
    std::size_t size_{0};
};

[[nodiscard]] std::string_view to_string(State state) noexcept;
void multiply_entity_id(Entity& entity, int factor);

}  // namespace synapse::parser_fixture::domain
