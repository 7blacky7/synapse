CXX ?= g++
CXXFLAGS ?= -std=c++20 -Wall -Wextra -Wpedantic -O2
CPPFLAGS ?= -Iinclude
TARGET := build/synapse_cpp_parser_fixture
SOURCES := src/main.cpp src/model.cpp src/pipeline.cpp

.PHONY: all run clean

all: $(TARGET)

$(TARGET): $(SOURCES) $(wildcard include/cpp_fixture/*.hpp)
	@mkdir -p build
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) $(SOURCES) -o $(TARGET)

run: $(TARGET)
	./$(TARGET)

clean:
	rm -rf build
