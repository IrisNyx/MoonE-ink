// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/touch_manager.hpp"

#include <cstring>

#include "mooneink/board_profile.hpp"

namespace mooneink {
namespace {

DispatchResult blockedResult() {
  return DispatchResult{true, false, InputLayer::none, 0, Point{0, 0}};
}

DispatchResult noMatchResult(const Point logical) {
  return DispatchResult{false, false, InputLayer::none, 0, logical};
}

}  // namespace

bool TouchManager::copyOwner(const char* owner,
                             std::array<char, owner_capacity>& destination) {
  if (owner == nullptr || *owner == '\0') return false;
  const std::size_t length = std::strlen(owner);
  if (length >= destination.size()) return false;
  destination.fill('\0');
  std::memcpy(destination.data(), owner, length);
  return true;
}

bool TouchManager::contains(const HitRegion& region, const Point point) {
  return point.x >= region.x && point.y >= region.y &&
         point.x < static_cast<std::int32_t>(region.x) + region.width &&
         point.y < static_cast<std::int32_t>(region.y) + region.height;
}

bool TouchManager::overlaps(const HitRegion& lhs, const HitRegion& rhs) {
  return lhs.x < static_cast<std::int32_t>(rhs.x) + rhs.width &&
         rhs.x < static_cast<std::int32_t>(lhs.x) + lhs.width &&
         lhs.y < static_cast<std::int32_t>(rhs.y) + rhs.height &&
         rhs.y < static_cast<std::int32_t>(lhs.y) + lhs.height;
}

bool TouchManager::validateRegions(const HitRegion* regions, const std::size_t count,
                                   const Orientation orientation) {
  if (count > 0 && regions == nullptr) return false;
  const std::int32_t canvas_width = orientation == Orientation::portrait
                                        ? BoardProfile::portrait_width
                                        : BoardProfile::portrait_height;
  const std::int32_t canvas_height = orientation == Orientation::portrait
                                         ? BoardProfile::portrait_height
                                         : BoardProfile::portrait_width;
  for (std::size_t i = 0; i < count; ++i) {
    const HitRegion& region = regions[i];
    if (region.x < 0 || region.y < 0 || region.width == 0 || region.height == 0 ||
        region.action_id == 0 ||
        static_cast<std::int32_t>(region.x) + region.width > canvas_width ||
        static_cast<std::int32_t>(region.y) + region.height > canvas_height) {
      return false;
    }
    for (std::size_t j = 0; j < i; ++j) {
      if (overlaps(region, regions[j]) || region.action_id == regions[j].action_id) return false;
    }
  }
  return true;
}

bool TouchManager::bindApp(const char* owner, const FrameIdentity& frame,
                           const HitRegion* regions, const std::size_t count) {
  if (count > max_app_regions || !display_.canDispatchAppInput(owner, frame) ||
      !validateRegions(regions, count, frame.orientation)) {
    return false;
  }
  std::array<char, owner_capacity> copied_owner{};
  if (!copyOwner(owner, copied_owner)) return false;
  app_owner_ = copied_owner;
  app_frame_ = frame;
  app_region_count_ = count;
  for (std::size_t i = 0; i < count; ++i) app_regions_[i] = regions[i];
  return true;
}

bool TouchManager::bindOverlay(const char* owner, const Orientation orientation,
                               const HitRegion* regions, const std::size_t count) {
  if (count > max_overlay_regions || !display_.canDispatchOverlayInput(owner) ||
      !validateRegions(regions, count, orientation)) {
    return false;
  }
  std::array<char, owner_capacity> copied_owner{};
  if (!copyOwner(owner, copied_owner)) return false;
  overlay_owner_ = copied_owner;
  overlay_orientation_ = orientation;
  overlay_composition_generation_ = display_.snapshot().composition_generation;
  overlay_region_count_ = count;
  for (std::size_t i = 0; i < count; ++i) overlay_regions_[i] = regions[i];
  return true;
}

void TouchManager::clearApp() {
  app_owner_.fill('\0');
  app_frame_ = FrameIdentity{};
  app_region_count_ = 0;
}

void TouchManager::clearOverlay() {
  overlay_owner_.fill('\0');
  overlay_composition_generation_ = 0;
  overlay_region_count_ = 0;
}

DispatchResult TouchManager::dispatch(const Point portrait_hardware) {
  const DisplayPolicySnapshot display = display_.snapshot();
  if (display.state != DisplayState::idle || !display.physical_known) {
    events_.publish(EventKind::input_blocked, static_cast<std::int32_t>(display.state));
    return blockedResult();
  }

  if (display.overlay_open) {
    if (display.composition_generation != overlay_composition_generation_ ||
        !display_.canDispatchOverlayInput(overlay_owner_.data())) {
      events_.publish(EventKind::input_blocked, 2);
      return blockedResult();
    }
    const Point logical = TouchTransform::toLogical(portrait_hardware, overlay_orientation_);
    for (std::size_t i = 0; i < overlay_region_count_; ++i) {
      if (contains(overlay_regions_[i], logical)) {
        events_.publish(EventKind::input_dispatched, overlay_regions_[i].action_id,
                        static_cast<std::int32_t>(InputLayer::overlay));
        return DispatchResult{true, true, InputLayer::overlay,
                              overlay_regions_[i].action_id, logical};
      }
    }
    events_.publish(EventKind::input_blocked, 3);
    return DispatchResult{true, false, InputLayer::overlay, 0, logical};
  }

  if (!display_.canDispatchAppInput(app_owner_.data(), app_frame_)) {
    events_.publish(EventKind::input_blocked, 4);
    return blockedResult();
  }
  const Point logical = TouchTransform::toLogical(portrait_hardware, app_frame_.orientation);
  for (std::size_t i = 0; i < app_region_count_; ++i) {
    if (contains(app_regions_[i], logical)) {
      events_.publish(EventKind::input_dispatched, app_regions_[i].action_id,
                      static_cast<std::int32_t>(InputLayer::app));
      return DispatchResult{true, true, InputLayer::app, app_regions_[i].action_id, logical};
    }
  }
  return noMatchResult(logical);
}

}  // namespace mooneink
