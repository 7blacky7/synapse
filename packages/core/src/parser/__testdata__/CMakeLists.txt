cmake_minimum_required(VERSION 3.20)
project(synapse VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(BUILD_TESTS "Build test suite" ON)
option(BUILD_DOCS "Build documentation" OFF)
option(ENABLE_SANITIZERS "Enable ASan/UBSan" OFF)

set(MAX_RETRIES 3 CACHE STRING "Maximum retry count")

find_package(Boost 1.80 REQUIRED COMPONENTS json system)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)
find_package(GTest QUIET)

include(FetchContent)
FetchContent_Declare(
    spdlog
    GIT_REPOSITORY https://github.com/gabime/spdlog.git
    GIT_TAG v1.12.0
)
FetchContent_MakeAvailable(spdlog)

add_library(synapse_core
    src/agent.cpp
    src/config.cpp
    src/utils.cpp
)

target_include_directories(synapse_core
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(synapse_core
    PUBLIC Boost::json Boost::system
    PRIVATE OpenSSL::SSL Threads::Threads spdlog::spdlog
)

add_executable(synapse_cli src/main.cpp)
target_link_libraries(synapse_cli PRIVATE synapse_core)

if(BUILD_TESTS AND GTest_FOUND)
    enable_testing()
    add_executable(synapse_tests tests/test_agent.cpp tests/test_config.cpp)
    target_link_libraries(synapse_tests PRIVATE synapse_core GTest::gtest_main)
    add_test(NAME unit_tests COMMAND synapse_tests)
endif()

install(TARGETS synapse_core synapse_cli
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)

install(DIRECTORY include/ DESTINATION include)

function(add_synapse_agent name)
    add_executable(agent_${name} agents/${name}.cpp)
    target_link_libraries(agent_${name} PRIVATE synapse_core)
endfunction()

macro(configure_sanitizers target)
    if(ENABLE_SANITIZERS)
        target_compile_options(${target} PRIVATE -fsanitize=address,undefined)
        target_link_options(${target} PRIVATE -fsanitize=address,undefined)
    endif()
endmacro()

# TODO: add CPack configuration
# FIXME: handle missing optional dependencies gracefully
