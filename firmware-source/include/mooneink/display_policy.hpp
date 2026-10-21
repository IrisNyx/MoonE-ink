// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/touch_transform.hpp"

namespace mooneink {

enum class DisplayState : std::uint8_t { offline, idle, refreshing, fault };
enum class SurfaceKind : std::uint8_t { none, app_frame, modal_overlay };

struct FrameIdentity final {
  // Device Channel v1 permits opaque identifiers up to 128 ASCII bytes.
  static constexpr std::size_t id_capacity = 129;

  std::array<char, id_capacity> binding_id{};
  std::array<char, id_capacity> frame_id{};
  std::uint16_t page_index = 0;
  Orientation orientation = Orientation::portrait;

  static bool create(const char* binding, const char* frame, std::uint16_t page,
                     Orientation orientation, FrameIdentity& output);
  bool valid() const;
};

bool operator==(const FrameIdentity& lhs, const FrameIdentity& rhs);
bool operator!=(const FrameIdentity& lhs, const FrameIdentity& rhs);

struct DisplayPolicySnapshot final {
  DisplayState state;
  SurfaceKind visible_surface;
  bool physical_known;
  bool overlay_open;
  std::uint32_t composition_generation;
  std::uint8_t consecutive_failures;
  FrameIdentity desired;
  FrameIdentity cached;
  FrameIdentity presented;
  FrameIdentity last_good;
};

class DisplayPolicy final {
 public:
  static constexpr std::uint8_t max_consecutive_failures = 3;

  bool markBackendReady();
  bool markBackendFailed();
  bool acquire(const char* owner);
  bool release(const char* owner);
  bool selectDesired(const char* owner, const FrameIdentity& frame);
  bool commitCached(const char* owner, const FrameIdentity& frame);
  bool beginFramePresentation(const char* owner, const FrameIdentity& frame);
  bool finishPresentation(const char* owner, bool success);
  bool openModalOverlay(const char* app_owner, const char* overlay_owner);
  bool beginOverlayPresentation(const char* overlay_owner);
  bool closeModalOverlay(const char* overlay_owner);
  bool invalidatePhysicalState();
  bool resetFault();

  bool canDispatchAppInput(const char* owner, const FrameIdentity& frame) const;
  bool canDispatchOverlayInput(const char* overlay_owner) const;
  bool canSkipRefresh(const char* owner, const FrameIdentity& frame) const;

  DisplayPolicySnapshot snapshot() const;
  DisplayState state() const { return state_; }
  const char* owner() const { return owner_; }

 private:
  bool ownerMatches(const char* owner) const;
  void clearVisible();

  DisplayState state_ = DisplayState::offline;
  SurfaceKind visible_surface_ = SurfaceKind::none;
  SurfaceKind pending_surface_ = SurfaceKind::none;
  const char* owner_ = nullptr;
  const char* return_owner_ = nullptr;
  bool physical_known_ = false;
  bool backend_ready_ = false;
  bool overlay_open_ = false;
  std::uint32_t composition_generation_ = 0;
  std::uint32_t presented_composition_generation_ = 0;
  std::uint8_t consecutive_failures_ = 0;
  FrameIdentity desired_{};
  FrameIdentity cached_{};
  FrameIdentity presented_{};
  FrameIdentity last_good_{};
  FrameIdentity return_target_{};
  FrameIdentity pending_frame_{};
};

}  // namespace mooneink
