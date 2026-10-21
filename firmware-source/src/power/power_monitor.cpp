// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/power_monitor.hpp"

#include <Wire.h>

namespace mooneink {
namespace {

constexpr std::uint8_t kBq25896Address = 0x6B;
constexpr std::uint8_t kBq25896InputControl = 0x00;
constexpr std::uint8_t kBq25896PowerControl = 0x03;
constexpr std::uint8_t kBq25896TimerControl = 0x07;
constexpr std::uint8_t kBq25896MiscControl = 0x09;
constexpr std::uint8_t kBq25896Status = 0x0B;
constexpr std::uint8_t kBq25896VbusMask = 0xE0;
constexpr std::uint8_t kBq25896PowerGood = 0x04;
constexpr std::uint8_t kBq27220Address = 0x55;
constexpr std::uint8_t kBq27220Voltage = 0x08;
constexpr std::uint8_t kBq27220StateOfCharge = 0x2C;

}  // namespace

bool PowerMonitor::read8(const std::uint8_t address, const std::uint8_t reg,
                         std::uint8_t& output) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0 ||
      Wire.requestFrom(static_cast<int>(address), 1) != 1) {
    return false;
  }
  output = static_cast<std::uint8_t>(Wire.read());
  return true;
}

bool PowerMonitor::write8(const std::uint8_t address, const std::uint8_t reg,
                          const std::uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission(true) == 0;
}

bool PowerMonitor::read16(const std::uint8_t address, const std::uint8_t reg,
                          std::uint16_t& output) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0 ||
      Wire.requestFrom(static_cast<int>(address), 2) != 2) {
    return false;
  }
  const std::uint8_t low = static_cast<std::uint8_t>(Wire.read());
  const std::uint8_t high = static_cast<std::uint8_t>(Wire.read());
  output = static_cast<std::uint16_t>(low | (high << 8U));
  return true;
}

bool PowerMonitor::read(PowerSnapshot& output) const {
  PowerSnapshot snapshot{};
  std::uint8_t charger = 0;
  snapshot.charger_reachable =
      read8(kBq25896Address, kBq25896Status, charger);
  if (snapshot.charger_reachable) {
    snapshot.external_power = (charger & kBq25896VbusMask) != 0 ||
                              (charger & kBq25896PowerGood) != 0;
  }
  std::uint16_t voltage = 0;
  std::uint16_t percent = 0;
  snapshot.battery_reachable =
      read16(kBq27220Address, kBq27220Voltage, voltage) &&
      read16(kBq27220Address, kBq27220StateOfCharge, percent);
  if (snapshot.battery_reachable) {
    snapshot.battery_millivolts = voltage;
    snapshot.battery_percent =
        static_cast<std::uint8_t>(percent > 100 ? 100 : percent);
    std::uint16_t current = 0;
    std::uint16_t average = 0;
    snapshot.gauge_details_reachable =
        read16(kBq27220Address, 0x0C, current) &&
        read16(kBq27220Address, 0x14, average) &&
        read16(kBq27220Address, 0x10, snapshot.remaining_mah) &&
        read16(kBq27220Address, 0x12, snapshot.full_mah);
    // BQ27220 currents are signed mA: positive charging, negative discharging.
    snapshot.current_ma = static_cast<std::int16_t>(current);
    snapshot.average_current_ma = static_cast<std::int16_t>(average);
  }
  output = snapshot;
  return snapshot.charger_reachable || snapshot.battery_reachable;
}

bool PowerMonitor::prepareWakeableSleep(PowerSafetyState& output) const {
  PowerSafetyState state{};
  if (!read8(kBq25896Address, kBq25896InputControl, state.reg00) ||
      !read8(kBq25896Address, kBq25896PowerControl, state.reg03) ||
      !read8(kBq25896Address, kBq25896TimerControl, state.reg07) ||
      !read8(kBq25896Address, kBq25896MiscControl, state.reg09)) {
    output = state;
    return false;
  }
  state.reachable = true;

  const std::uint8_t safe00 = static_cast<std::uint8_t>(state.reg00 & ~0x80U);
  const std::uint8_t safe03 = static_cast<std::uint8_t>(state.reg03 & ~0x20U);
  const std::uint8_t safe07 = static_cast<std::uint8_t>(state.reg07 & ~0x30U);
  const std::uint8_t safe09 = static_cast<std::uint8_t>(state.reg09 & ~0x20U);
  if ((safe00 != state.reg00 &&
       !write8(kBq25896Address, kBq25896InputControl, safe00)) ||
      (safe03 != state.reg03 &&
       !write8(kBq25896Address, kBq25896PowerControl, safe03)) ||
      (safe07 != state.reg07 &&
       !write8(kBq25896Address, kBq25896TimerControl, safe07)) ||
      (safe09 != state.reg09 &&
       !write8(kBq25896Address, kBq25896MiscControl, safe09)) ||
      !read8(kBq25896Address, kBq25896InputControl, state.reg00) ||
      !read8(kBq25896Address, kBq25896PowerControl, state.reg03) ||
      !read8(kBq25896Address, kBq25896TimerControl, state.reg07) ||
      !read8(kBq25896Address, kBq25896MiscControl, state.reg09)) {
    state.reachable = false;
    output = state;
    return false;
  }
  output = state;
  return state.wakeable();
}

}  // namespace mooneink
