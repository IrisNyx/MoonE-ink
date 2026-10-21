// SPDX-License-Identifier: AGPL-3.0-only
#pragma once
#include <cstdint>

namespace mooneink {
// Manual light sleep retains the UI/PSRAM. Short RTC slices let the Arduino
// scheduler run between sleeps and notice USB power without waking the radio.
inline std::uint32_t batterySleepSliceMs(std::uint32_t now,
                                        std::uint32_t sync_at,
                                        std::uint32_t power_check_at) {
  const auto sync_left = static_cast<std::int32_t>(sync_at - now);
  const auto power_left = static_cast<std::int32_t>(power_check_at - now);
  if (sync_left <= 0 || power_left <= 0) return 0;
  std::uint32_t result = 2000U;
  if (static_cast<std::uint32_t>(sync_left) < result) result = sync_left;
  if (static_cast<std::uint32_t>(power_left) < result) result = power_left;
  return result;
}
}  // namespace mooneink
