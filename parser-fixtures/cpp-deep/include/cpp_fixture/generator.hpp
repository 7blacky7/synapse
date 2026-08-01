#pragma once

#include <coroutine>
#include <exception>
#include <utility>

namespace synapse::parser_fixture::async {

template <typename T>
class Generator {
public:
    struct promise_type {
        T current{};
        std::exception_ptr error{};

        [[nodiscard]] Generator get_return_object() noexcept {
            return Generator{std::coroutine_handle<promise_type>::from_promise(*this)};
        }

        [[nodiscard]] std::suspend_always initial_suspend() const noexcept {
            return {};
        }

        [[nodiscard]] std::suspend_always final_suspend() const noexcept {
            return {};
        }

        [[nodiscard]] std::suspend_always yield_value(T value) noexcept {
            current = std::move(value);
            return {};
        }

        void return_void() const noexcept {}

        void unhandled_exception() noexcept {
            error = std::current_exception();
        }
    };

    Generator(const Generator&) = delete;
    Generator& operator=(const Generator&) = delete;

    Generator(Generator&& other) noexcept : handle_(std::exchange(other.handle_, {})) {}

    Generator& operator=(Generator&& other) noexcept {
        if (this != &other) {
            if (handle_) {
                handle_.destroy();
            }
            handle_ = std::exchange(other.handle_, {});
        }
        return *this;
    }

    ~Generator() {
        if (handle_) {
            handle_.destroy();
        }
    }

    [[nodiscard]] bool next() {
        if (!handle_ || handle_.done()) {
            return false;
        }
        handle_.resume();
        if (handle_.promise().error) {
            std::rethrow_exception(handle_.promise().error);
        }
        return !handle_.done();
    }

    [[nodiscard]] const T& value() const noexcept {
        return handle_.promise().current;
    }

private:
    explicit Generator(std::coroutine_handle<promise_type> handle) noexcept : handle_(handle) {}

    std::coroutine_handle<promise_type> handle_{};
};

}  // namespace synapse::parser_fixture::async
