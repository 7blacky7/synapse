#pragma once

#include <array>
#include <concepts>
#include <cstddef>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

namespace synapse::parser_fixture::meta {

template <typename T>
concept Arithmetic = std::integral<T> || std::floating_point<T>;

template <typename T>
concept Named = requires(const T& value) {
    { value.name() } -> std::convertible_to<std::string_view>;
};

template <typename T>
struct TypeLabel {
    static constexpr std::string_view value = "unknown";
};

template <std::integral T>
struct TypeLabel<T> {
    static constexpr std::string_view value = "integral";
};

template <std::floating_point T>
struct TypeLabel<T> {
    static constexpr std::string_view value = "floating";
};

template <typename T, std::size_t N>
class StaticBox {
public:
    using value_type = T;
    using storage_type = std::array<T, N>;

    constexpr StaticBox() = default;

    template <typename... Args>
        requires(sizeof...(Args) == N && (std::convertible_to<Args, T> && ...))
    constexpr explicit StaticBox(Args&&... args)
        : values_{static_cast<T>(std::forward<Args>(args))...} {}

    [[nodiscard]] constexpr std::size_t size() const noexcept {
        return values_.size();
    }

    [[nodiscard]] constexpr const T& operator[](std::size_t index) const {
        return values_.at(index);
    }

    [[nodiscard]] constexpr T& operator[](std::size_t index) {
        return values_.at(index);
    }

    template <typename Fn>
    constexpr void visit(Fn&& fn) {
        for (auto& value : values_) {
            std::forward<Fn>(fn)(value);
        }
    }

private:
    storage_type values_{};
};

template <Arithmetic... Values>
[[nodiscard]] constexpr auto sum(Values... values) {
    using Result = std::common_type_t<Values...>;
    return (Result{} + ... + static_cast<Result>(values));
}

template <typename T>
constexpr bool always_false_v = false;

}  // namespace synapse::parser_fixture::meta
