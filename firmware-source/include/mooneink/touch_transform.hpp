// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstdint>

namespace mooneink {

enum class Orientation : std::uint8_t { portrait, landscape };

struct Point final { std::int16_t x; std::int16_t y; };

class TouchTransform final {
 public:
  static Point toLogical(Point portrait_hardware, Orientation orientation);
  static bool selfTest();
};

}  // namespace mooneink

