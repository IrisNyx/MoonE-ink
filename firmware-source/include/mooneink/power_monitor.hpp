// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstdint>

namespace mooneink {

struct PowerSnapshot final {
  bool charger_reachable = false;
  bool external_power = false;
  bool battery_reachable = false;
  std::uint16_t battery_millivolts = 0;
  std::uint8_t battery_percent = 0;
  bool gauge_details_reachable = false;
  std::int16_t current_ma = 0;
  std::int16_t average_current_ma = 0;
  std::uint16_t remaining_mah = 0;
  std::uint16_t full_mah = 0;

  bool lowBattery() const {
    return battery_reachable && battery_percent <= 10;
  }
};

struct PowerSafetyState final {
  bool reachable = false;
  std::uint8_t reg00 = 0;
  std::uint8_t reg03 = 0;
  std::uint8_t reg07 = 0;
  std::uint8_t reg09 = 0;

  bool wakeable() const {
    // BQ25896: EN_HIZ=0, OTG_CONFIG=0, WATCHDOG=00 and BATFET_DIS=0.
    return reachable && (reg00 & 0x80U) == 0 && (reg03 & 0x20U) == 0 &&
           (reg07 & 0x30U) == 0 && (reg09 & 0x20U) == 0;
  }
};

// Read-only access to the H752-01 charger and fuel gauge.  It deliberately
// never changes charge limits or PMIC configuration.
class PowerMonitor final {
 public:
  bool read(PowerSnapshot& output) const;
  // Keep battery power connected and disable charger modes which can make an
  // otherwise wakeable ESP sleep look like a powered-off device.  Only these
  // four safety bits are changed; charge voltage/current policy is untouched.
  bool prepareWakeableSleep(PowerSafetyState& output) const;

 private:
  static bool read8(std::uint8_t address, std::uint8_t reg,
                    std::uint8_t& output);
  static bool write8(std::uint8_t address, std::uint8_t reg,
                     std::uint8_t value);
  static bool read16(std::uint8_t address, std::uint8_t reg,
                     std::uint16_t& output);
};

}  // namespace mooneink
