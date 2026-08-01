#pragma once

#include "cpp_fixture/generator.hpp"
#include "cpp_fixture/model.hpp"

#include <concepts>
#include <memory>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace synapse::parser_fixture::pipeline {

using domain::Entity;
using domain::Processor;
using domain::State;

template <typename Derived>
class StageBase {
public:
    void run(Entity& entity) {
        static_cast<Derived&>(*this).before(entity);
        static_cast<Derived&>(*this).execute(entity);
        static_cast<Derived&>(*this).after(entity);
    }

protected:
    ~StageBase() = default;
};

class ValidationStage final : public StageBase<ValidationStage> {
public:
    void before(Entity& entity);
    void execute(Entity& entity);
    void after(Entity& entity);
};

class TransformationStage final : public StageBase<TransformationStage> {
public:
    using MemberTransition = void (Entity::*)(State);

    explicit TransformationStage(int factor) noexcept;

    void before(Entity& entity) const;
    void execute(Entity& entity) const;
    void after(Entity& entity) const;

private:
    int factor_;
    MemberTransition transition_{&Entity::transition};
};

template <typename Stage>
concept ExecutableStage = requires(Stage stage, Entity& entity) {
    stage.run(entity);
};

template <ExecutableStage... Stages>
class StaticPipeline {
public:
    explicit StaticPipeline(Stages... stages) : stages_(std::move(stages)...) {}

    void process(Entity& entity) {
        std::apply(
            [&entity](auto&... stage) {
                (stage.run(entity), ...);
            },
            stages_);
    }

private:
    std::tuple<Stages...> stages_;
};

class DynamicPipeline final : public Processor {
public:
    struct Statistics {
        std::size_t processed{0};
        std::size_t failures{0};
        std::size_t retries{0};
    };

    DynamicPipeline();
    explicit DynamicPipeline(std::vector<std::unique_ptr<Processor>> processors);
    ~DynamicPipeline() override;

    DynamicPipeline& add(std::unique_ptr<Processor> processor);
    [[nodiscard]] std::string_view processor_name() const noexcept override;
    void process(Entity& entity) override;

    [[nodiscard]] const Statistics& statistics() const noexcept;
    [[nodiscard]] async::Generator<std::string> trace(Entity entity) const;

private:
    void process_one(Processor& processor, Entity& entity);

    std::vector<std::unique_ptr<Processor>> processors_;
    Statistics statistics_{};
};

class StateProcessor final : public Processor {
public:
    explicit StateProcessor(State target) noexcept;
    [[nodiscard]] std::string_view processor_name() const noexcept override;
    void process(Entity& entity) override;

private:
    State target_;
};

[[nodiscard]] std::vector<Entity> run_batch(
    DynamicPipeline& pipeline,
    std::vector<Entity> entities,
    bool continue_on_error);

}  // namespace synapse::parser_fixture::pipeline
