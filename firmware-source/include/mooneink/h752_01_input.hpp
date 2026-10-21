// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstdint>

#include "mooneink/button_input.hpp"
#include "mooneink/touch_transform.hpp"

namespace mooneink {

enum class H75201InputKind : std::uint8_t {
  none,
  touch,
  button,
};

struct H75201InputEvent final {
  H75201InputKind kind = H75201InputKind::none;
  Point touch{};
  ButtonEvent button{};
};

// Hardware adapter for the application-capable controls on H752-01. RST/EN is
// intentionally absent: it is a hard reset. The PMIC/QON long-press remains a
// hardware power/recovery path and is not consumed by this class.
class H75201Input final {
 public:
  bool begin();
  bool poll(H75201InputEvent& output);
  bool touchReady() const { return touch_ready_; }
  bool functionButtonReady() const { return function_button_ready_; }
  bool pendingGesture() const {
    return decoder_.pendingGesture() || home_active_ || touch_latched_;
  }

 private:
  bool readFunctionButton(bool& pressed);

  ButtonGestureDecoder decoder_{};
  bool touch_ready_ = false;
  bool function_button_ready_ = false;
  bool touch_latched_ = false;
  bool home_active_ = false;
  bool home_long_emitted_ = false;
  std::uint32_t home_pressed_ms_ = 0;
};

}  // namespace mooneink
