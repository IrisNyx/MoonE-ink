// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace mooneink {

enum class PhysicalButton : std::uint8_t {
  boot,
  function,
  home,
};

enum class ButtonGesture : std::uint8_t {
  short_press,
  long_press,
};

struct ButtonEvent final {
  constexpr ButtonEvent(PhysicalButton source = PhysicalButton::boot,
                        ButtonGesture kind = ButtonGesture::short_press)
      : button(source), gesture(kind) {}

  PhysicalButton button;
  ButtonGesture gesture;
};

// Converts noisy active/inactive samples into press gestures. BOOT keeps an
// immediate short action for fast previous-page navigation. S3 resolves its
// gesture on release so a light-toggle hold never first advances the page.
// Time comparisons deliberately use unsigned subtraction so millis() rollover
// remains well-defined.
class ButtonGestureDecoder final {
 public:
  static constexpr std::uint32_t debounce_ms = 30;
  static constexpr std::uint32_t long_press_ms = 800;

  bool begin(bool boot_pressed, bool function_pressed, std::uint32_t now_ms);
  bool update(PhysicalButton button, bool pressed, std::uint32_t now_ms,
              ButtonEvent& output);
  bool pendingGesture() const {
    for (const auto& state : states_) {
      if (state.sampled || state.stable) return true;
    }
    return false;
  }

 private:
  struct State final {
    bool sampled = false;
    bool stable = false;
    bool long_emitted = false;
    std::uint32_t sample_changed_ms = 0;
    std::uint32_t pressed_ms = 0;
  };

  static std::size_t index(PhysicalButton button);

  std::array<State, 2> states_{};
  bool initialized_ = false;
};

}  // namespace mooneink
