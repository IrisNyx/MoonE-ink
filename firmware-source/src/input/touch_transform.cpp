// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/touch_transform.hpp"

#include "mooneink/board_profile.hpp"

namespace mooneink {

Point TouchTransform::toLogical(Point point, Orientation orientation) {
  if (orientation == Orientation::portrait) return point;
  return Point{point.y, static_cast<std::int16_t>(BoardProfile::portrait_width - 1 - point.x)};
}

bool TouchTransform::selfTest() {
  const Point portrait{0, 0};
  const Point landscape = toLogical(portrait, Orientation::landscape);
  const Point far = toLogical(Point{539, 959}, Orientation::landscape);
  return landscape.x == 0 && landscape.y == 539 && far.x == 959 && far.y == 0;
}

}  // namespace mooneink

