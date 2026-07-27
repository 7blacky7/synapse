#include "cpp_fixture/pipeline.hpp"

#include "cpp_fixture/meta.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace synapse::parser_fixture::pipeline {

void ValidationStage::before(Entity& entity) {
    if (!entity) {
        throw std::invalid_argument("entity is not processable");
    }
}

void ValidationStage::execute(Entity& entity) {
    const auto has_name = !entity.name().empty();
    const auto has_metrics = !entity.metrics().empty();

    if (!has_name) {
        throw std::runtime_error("entity name is empty");
    } else if (!has_metrics) {
        entity.add_metric(domain::Metric{"validation", domain::Scalar{std::int64_t{1}}, false});
    }
}

void ValidationStage::after(Entity& entity) {
    if (entity.state() == State::idle) {
        entity.transition(State::ready);
    }
}

TransformationStage::TransformationStage(int factor) noexcept : factor_(factor) {}

void TransformationStage::before(Entity& entity) const {
    entity.apply([factor = factor_](Entity& current) {
        current.add_metric(domain::Metric{"factor", domain::Scalar{std::int64_t{factor}}, false});
    });
}

void TransformationStage::execute(Entity& entity) const {
    entity.apply_raw(&domain::multiply_entity_id, factor_);
    if (entity.state() == State::ready) {
        (entity.*transition_)(State::running);
    }
}

void TransformationStage::after(Entity& entity) const {
    auto score = meta::sum(entity.id(), static_cast<std::uint64_t>(entity.metrics().size()), factor_);
    entity.add_metric(domain::Metric{"score", domain::Scalar{static_cast<std::int64_t>(score)}, false});
}

DynamicPipeline::DynamicPipeline() = default;

DynamicPipeline::DynamicPipeline(std::vector<std::unique_ptr<Processor>> processors)
    : processors_(std::move(processors)) {}

DynamicPipeline::~DynamicPipeline() = default;

DynamicPipeline& DynamicPipeline::add(std::unique_ptr<Processor> processor) {
    if (!processor) {
        throw std::invalid_argument("processor must not be null");
    }
    processors_.push_back(std::move(processor));
    return *this;
}

std::string_view DynamicPipeline::processor_name() const noexcept {
    return "dynamic-pipeline";
}

void DynamicPipeline::process(Entity& entity) {
    std::size_t index = 0;
    while (index < processors_.size()) {
        try {
            process_one(*processors_[index], entity);
            ++statistics_.processed;
        } catch (const std::exception&) {
            ++statistics_.failures;
            if (statistics_.retries < 1 && entity.state() != State::failed) {
                ++statistics_.retries;
                entity.transition(State::failed);
            }
            throw;
        }
        ++index;
    }
}

const DynamicPipeline::Statistics& DynamicPipeline::statistics() const noexcept {
    return statistics_;
}

async::Generator<std::string> DynamicPipeline::trace(Entity entity) const {
    co_yield std::string{"begin:"} + std::string{entity.name()};

    for (const auto& processor : processors_) {
        co_yield std::string{"before:"} + std::string{processor->processor_name()};
        processor->process(entity);
        co_yield std::string{"after:"} + std::string{processor->processor_name()};
    }

    co_yield std::string{"end:"} + std::string{domain::to_string(entity.state())};
}

void DynamicPipeline::process_one(Processor& processor, Entity& entity) {
    processor.process(entity);
}

StateProcessor::StateProcessor(State target) noexcept : target_(target) {}

std::string_view StateProcessor::processor_name() const noexcept {
    return "state-processor";
}

void StateProcessor::process(Entity& entity) {
    if (entity.state() != target_) {
        entity.transition(target_);
    }
}

std::vector<Entity> run_batch(DynamicPipeline& pipeline, std::vector<Entity> entities, bool continue_on_error) {
    std::vector<Entity> completed;
    completed.reserve(entities.size());

    for (auto& entity : entities) {
        bool accepted = false;
        int attempt = 0;

        do {
            try {
                pipeline.process(entity);
                accepted = true;
            } catch (const std::exception&) {
                ++attempt;
                if (!continue_on_error || attempt >= 2) {
                    break;
                }
            }
        } while (!accepted);

        if (accepted) {
            completed.push_back(std::move(entity));
        } else if (!continue_on_error) {
            throw std::runtime_error("batch aborted");
        }
    }

    std::ranges::sort(completed, {}, &Entity::id);
    return completed;
}

}  // namespace synapse::parser_fixture::pipeline
