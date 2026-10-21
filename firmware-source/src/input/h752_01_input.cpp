// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/h752_01_input.hpp"

#include <Arduino.h>
#include <TouchDrvGT911.hpp>
#include <Wire.h>

#include "mooneink/board_profile.hpp"

namespace mooneink {
namespace {

TouchDrvGT911 gt911;
volatile bool home_pending = false;

void onHome(void*) {
  home_pending = true;
}

}  // namespace

bool H75201Input::readFunctionButton(bool& pressed) {
  Wire.beginTransmission(BoardProfile::pca9535_address);
  Wire.write(BoardProfile::pca9535_input_port_1);
  if (Wire.endTransmission(false) != 0 ||
      Wire.requestFrom(static_cast<int>(BoardProfile::pca9535_address), 1) != 1) {
    return false;
  }
  const std::uint8_t value = static_cast<std::uint8_t>(Wire.read());
  pressed = (value & (1U << BoardProfile::pca9535_function_button_bit)) == 0;
  return true;
}

bool H75201Input::begin() {
  pinMode(BoardProfile::boot_button, INPUT_PULLUP);
  pinMode(BoardProfile::pca9535_interrupt, INPUT_PULLUP);
  bool function_pressed = false;
  function_button_ready_ = readFunctionButton(function_pressed);
  decoder_.begin(digitalRead(BoardProfile::boot_button) == LOW,
                 function_button_ready_ && function_pressed, millis());

  gt911.setPins(BoardProfile::touch_reset, BoardProfile::touch_irq);
  touch_ready_ = gt911.begin(Wire, GT911_SLAVE_ADDRESS_L, BoardProfile::i2c_sda,
                             BoardProfile::i2c_scl);
  if (touch_ready_) {
    gt911.setHomeButtonCallback(onHome, nullptr);
    gt911.setInterruptMode(LOW_LEVEL_QUERY);
    gt911.setMaxCoordinates(BoardProfile::portrait_width - 1,
                            BoardProfile::portrait_height - 1);
  }
  return true;  // BOOT remains usable if either optional I2C input is absent.
}

bool H75201Input::poll(H75201InputEvent& output) {
  output = H75201InputEvent{};
  const std::uint32_t now = millis();
  ButtonEvent button{};
  if (decoder_.update(PhysicalButton::boot,
                      digitalRead(BoardProfile::boot_button) == LOW, now, button)) {
    output.kind = H75201InputKind::button;
    output.button = button;
    return true;
  }

  bool function_pressed = false;
  if (function_button_ready_ && readFunctionButton(function_pressed) &&
      decoder_.update(PhysicalButton::function, function_pressed, now, button)) {
    output.kind = H75201InputKind::button;
    output.button = button;
    return true;
  }

  if (!touch_ready_) return false;
  if (!gt911.isPressed()) {
    touch_latched_ = false;
    if (home_active_) {
      home_active_ = false;
      if (!home_long_emitted_) {
        output.kind = H75201InputKind::button;
        output.button = ButtonEvent{PhysicalButton::home,
                                    ButtonGesture::short_press};
        return true;
      }
    }
    return false;
  }

  std::int16_t x[5]{};
  std::int16_t y[5]{};
  const std::uint8_t count = gt911.getPoint(x, y, gt911.getSupportTouchPoint());
  if (home_pending) {
    home_pending = false;
    if (!home_active_) {
      home_active_ = true;
      home_long_emitted_ = false;
      home_pressed_ms_ = now;
    }
    touch_latched_ = true;
  }
  if (home_active_) {
    if (!home_long_emitted_ &&
        now - home_pressed_ms_ >= ButtonGestureDecoder::long_press_ms) {
      home_long_emitted_ = true;
      output.kind = H75201InputKind::button;
      output.button = ButtonEvent{PhysicalButton::home,
                                  ButtonGesture::long_press};
      return true;
    }
    return false;
  }
  if (count == 0 || touch_latched_) return false;
  touch_latched_ = true;
  output.kind = H75201InputKind::touch;
  output.touch = Point{x[0], y[0]};
  return true;
}

}  // namespace mooneink
