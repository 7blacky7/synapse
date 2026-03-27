SHELL := /bin/bash
.PHONY: all build test clean install deploy help

VERSION := 1.0.0
BUILD_DIR := dist
SRC_DIR := src
NODE_ENV ?= production

all: build test

build:
	@echo "Building v$(VERSION)..."
	pnpm build

test: build
	pnpm test

clean:
	rm -rf $(BUILD_DIR) node_modules/.cache

install:
	pnpm install --frozen-lockfile

deploy: build test
	docker build -t synapse:$(VERSION) .
	docker push synapse:$(VERSION)

lint:
	pnpm lint

format:
	pnpm format

help:
	@echo "Available targets:"
	@echo "  build   - Build the project"
	@echo "  test    - Run tests"
	@echo "  clean   - Remove build artifacts"
	@echo "  deploy  - Build and deploy"

# TODO: add release target
# FIXME: clean should also remove dist
