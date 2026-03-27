load("@rules_python//python:defs.bzl", "py_binary", "py_library", "py_test")
load("@rules_docker//container:container.bzl", "container_image", "container_push")
load(":synapse.bzl", "synapse_agent")

package(default_visibility = ["//visibility:public"])

MAX_RETRIES = 3
DEFAULT_MODEL = "claude-opus-4-6"
VERSION = "1.0.0"

py_library(
    name = "agent_lib",
    srcs = glob(["src/**/*.py"]),
    deps = [
        "//lib/config",
        "//lib/utils",
        "@pip//anthropic",
        "@pip//pydantic",
    ],
)

py_binary(
    name = "agent_server",
    srcs = ["src/main.py"],
    main = "src/main.py",
    deps = [":agent_lib"],
    data = ["config.yaml"],
)

py_test(
    name = "agent_test",
    srcs = ["tests/test_agent.py"],
    deps = [
        ":agent_lib",
        "@pip//pytest",
    ],
    size = "small",
    timeout = "short",
)

container_image(
    name = "agent_image",
    base = "@python3_image//image",
    files = [":agent_server"],
    entrypoint = ["/agent_server"],
    ports = ["3000"],
)

container_push(
    name = "push_image",
    image = ":agent_image",
    registry = "ghcr.io",
    repository = "synapse/agent",
    tag = VERSION,
)

synapse_agent(
    name = "coordinator",
    model = DEFAULT_MODEL,
    tools = ["search", "read", "write"],
)

def _create_agents(names):
    for name in names:
        synapse_agent(name = name, model = DEFAULT_MODEL)

_create_agents(["worker-1", "worker-2", "analyst"])

# TODO: add integration test target
# FIXME: pin dependency versions
