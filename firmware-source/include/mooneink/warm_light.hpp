// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstdint>

namespace mooneink {

class WarmLightController final {
 public:
  static constexpr std::uint8_t default_brightness = 128;

  bool begin(std::uint8_t brightness = default_brightness);
  bool setEnabled(bool enabled);
  bool toggle();
  bool setBrightness(std::uint8_t brightness);

  bool ready() const { return ready_; }
  bool enabled() const { return enabled_; }
  std::uint8_t brightness() const { return brightness_; }

 private:
  void apply();

  bool ready_ = false;
  bool enabled_ = false;
  std::uint8_t brightness_ = default_brightness;
};

}  // namespace mooneink
