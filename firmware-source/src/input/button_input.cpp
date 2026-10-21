// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/button_input.hpp"

namespace mooneink {

std::size_t ButtonGestureDecoder::index(const PhysicalButton button) {
  return button == PhysicalButton::boot ? 0U : 1U;
}

bool ButtonGestureDecoder::begin(const bool boot_pressed,
                                 const bool function_pressed,
                                 const std::uint32_t now_ms) {
  states_ = {};
  states_[0].sampled = boot_pressed;
  states_[0].stable = boot_pressed;
  states_[0].sample_changed_ms = now_ms;
  states_[0].pressed_ms = now_ms;
  states_[1].sampled = function_pressed;
  states_[1].stable = function_pressed;
  states_[1].sample_changed_ms = now_ms;
  states_[1].pressed_ms = now_ms;
  initialized_ = true;
  return true;
}

bool ButtonGestureDecoder::update(const PhysicalButton button, const bool pressed,
                                  const std::uint32_t now_ms,
                                  ButtonEvent& output) {
  if (!initialized_ || button == PhysicalButton::home) return false;
  State& state = states_[index(button)];
  if (pressed != state.sampled) {
    state.sampled = pressed;
    state.sample_changed_ms = now_ms;
  }

  if (state.sampled != state.stable &&
      now_ms - state.sample_changed_ms >= debounce_ms) {
    state.stable = state.sampled;
    if (state.stable) {
      state.pressed_ms = now_ms;
      state.long_emitted = false;
      if (button == PhysicalButton::boot) {
        output = ButtonEvent{button, ButtonGesture::short_press};
        return true;
      }
    } else if (button == PhysicalButton::function && !state.long_emitted) {
      output = ButtonEvent{button, ButtonGesture::short_press};
      return true;
    }
  }

  if (state.stable && !state.long_emitted &&
      now_ms - state.pressed_ms >= long_press_ms) {
    state.long_emitted = true;
    output = ButtonEvent{button, ButtonGesture::long_press};
    return true;
  }
  return false;
}

}  // namespace mooneink
