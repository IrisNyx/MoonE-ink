// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/display_manager.hpp"
#include "mooneink/event_bus.hpp"
#include "mooneink/touch_transform.hpp"

namespace mooneink {

enum class InputLayer : std::uint8_t { none, app, overlay };

struct HitRegion final {
  std::int16_t x;
  std::int16_t y;
  std::uint16_t width;
  std::uint16_t height;
  std::uint16_t action_id;
};

struct DispatchResult final {
  bool consumed;
  bool matched;
  InputLayer layer;
  std::uint16_t action_id;
  Point logical;
};

class TouchManager final {
 public:
  static constexpr std::size_t max_app_regions = 24;
  static constexpr std::size_t max_overlay_regions = 8;

  TouchManager(DisplayManager& display, EventBus& events) : display_(display), events_(events) {}

  bool bindApp(const char* owner, const FrameIdentity& frame, const HitRegion* regions,
               std::size_t count);
  bool bindOverlay(const char* owner, Orientation orientation, const HitRegion* regions,
                   std::size_t count);
  void clearApp();
  void clearOverlay();
  DispatchResult dispatch(Point portrait_hardware);

 private:
  static constexpr std::size_t owner_capacity = 65;

  static bool validateRegions(const HitRegion* regions, std::size_t count,
                              Orientation orientation);
  static bool copyOwner(const char* owner, std::array<char, owner_capacity>& destination);
  static bool contains(const HitRegion& region, Point point);
  static bool overlaps(const HitRegion& lhs, const HitRegion& rhs);

  DisplayManager& display_;
  EventBus& events_;
  std::array<char, owner_capacity> app_owner_{};
  std::array<char, owner_capacity> overlay_owner_{};
  FrameIdentity app_frame_{};
  Orientation overlay_orientation_ = Orientation::portrait;
  std::uint32_t overlay_composition_generation_ = 0;
  std::array<HitRegion, max_app_regions> app_regions_{};
  std::array<HitRegion, max_overlay_regions> overlay_regions_{};
  std::size_t app_region_count_ = 0;
  std::size_t overlay_region_count_ = 0;
};

}  // namespace mooneink
