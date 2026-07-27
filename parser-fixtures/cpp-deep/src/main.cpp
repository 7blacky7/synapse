#include "cpp_fixture/meta.hpp"
#include "cpp_fixture/model.hpp"
#include "cpp_fixture/pipeline.hpp"

#include <iostream>
#include <memory>
#include <string>
#include <vector>

namespace fixture = synapse::parser_fixture;

namespace {

[[nodiscard]] fixture::domain::Entity make_entity(std::uint64_t id, std::string name) {
    return fixture::domain::Entity::Builder{}
        .id(id)
        .name(std::move(name))
        .state(fixture::domain::State::idle)
        .metric(fixture::domain::Metric{"seed", fixture::domain::Scalar{std::int64_t{7}}, false})
        .build();
}

void print_trace(fixture::pipeline::DynamicPipeline& pipeline, fixture::domain::Entity entity) {
    auto generator = pipeline.trace(std::move(entity));
    while (generator.next()) {
        std::cout << generator.value() << '\n';
    }
}

}  // namespace

int main() {
    using fixture::domain::Entity;
    using fixture::domain::State;
    using fixture::pipeline::DynamicPipeline;
    using fixture::pipeline::StateProcessor;
    using fixture::pipeline::StaticPipeline;
    using fixture::pipeline::TransformationStage;
    using fixture::pipeline::ValidationStage;

    fixture::meta::StaticBox<int, 3> values{1, 2, 3};
    values.visit([](int& value) {
        value *= 2;
    });

    StaticPipeline static_pipeline{ValidationStage{}, TransformationStage{3}};
    auto preview = make_entity(10, "preview");
    static_pipeline.process(preview);

    DynamicPipeline dynamic_pipeline;
    dynamic_pipeline
        .add(std::make_unique<StateProcessor>(State::ready))
        .add(std::make_unique<StateProcessor>(State::running))
        .add(std::make_unique<StateProcessor>(State::complete));

    std::vector<Entity> entities;
    for (std::uint64_t id = 1; id <= 4; ++id) {
        entities.push_back(make_entity(id, "entity-" + std::to_string(id)));
    }

    try {
        auto completed = fixture::pipeline::run_batch(dynamic_pipeline, std::move(entities), true);
        for (const auto& entity : completed) {
            std::cout << entity << '\n';
        }
        print_trace(dynamic_pipeline, make_entity(99, "trace"));
    } catch (const std::exception& error) {
        std::cerr << "fixture failed: " << error.what() << '\n';
        return 1;
    }

    return values.size() == 3 ? 0 : 2;
}
