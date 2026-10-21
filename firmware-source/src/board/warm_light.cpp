// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/warm_light.hpp"

#include <Arduino.h>

#include "mooneink/board_profile.hpp"

namespace mooneink {
namespace {

constexpr std::uint8_t kLedcChannel = 7;
constexpr std::uint32_t kPwmFrequencyHz = 800;
constexpr std::uint8_t kPwmResolutionBits = 8;

}  // namespace

void WarmLightController::apply() {
  ledcWrite(kLedcChannel, enabled_ ? brightness_ : 0);
}

bool WarmLightController::begin(const std::uint8_t brightness) {
  if (brightness == 0 ||
      ledcSetup(kLedcChannel, kPwmFrequencyHz, kPwmResolutionBits) == 0) {
    return false;
  }
  ledcAttachPin(BoardProfile::warm_light, kLedcChannel);
  brightness_ = brightness;
  enabled_ = false;
  ready_ = true;
  apply();
  return true;
}

bool WarmLightController::setEnabled(const bool enabled) {
  if (!ready_) return false;
  enabled_ = enabled;
  apply();
  return true;
}

bool WarmLightController::toggle() { return setEnabled(!enabled_); }

bool WarmLightController::setBrightness(const std::uint8_t brightness) {
  if (!ready_ || brightness == 0) return false;
  brightness_ = brightness;
  apply();
  return true;
}

}  // namespace mooneink
