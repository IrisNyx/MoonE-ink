// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/display_policy.hpp"

#include <cstring>

namespace mooneink {
namespace {

bool copyId(const char* source, std::array<char, FrameIdentity::id_capacity>& destination) {
  if (source == nullptr || *source == '\0') return false;
  const std::size_t length = std::strlen(source);
  if (length >= destination.size()) return false;
  destination.fill('\0');
  std::memcpy(destination.data(), source, length);
  return true;
}

bool sameOwner(const char* lhs, const char* rhs) {
  return lhs != nullptr && rhs != nullptr && std::strcmp(lhs, rhs) == 0;
}

}  // namespace

bool FrameIdentity::create(const char* binding, const char* frame, const std::uint16_t page,
                           const Orientation target_orientation, FrameIdentity& output) {
  FrameIdentity candidate{};
  if (!copyId(binding, candidate.binding_id) || !copyId(frame, candidate.frame_id)) return false;
  candidate.page_index = page;
  candidate.orientation = target_orientation;
  output = candidate;
  return true;
}

bool FrameIdentity::valid() const {
  return binding_id[0] != '\0' && frame_id[0] != '\0';
}

bool operator==(const FrameIdentity& lhs, const FrameIdentity& rhs) {
  return lhs.page_index == rhs.page_index && lhs.orientation == rhs.orientation &&
         std::strcmp(lhs.binding_id.data(), rhs.binding_id.data()) == 0 &&
         std::strcmp(lhs.frame_id.data(), rhs.frame_id.data()) == 0;
}

bool operator!=(const FrameIdentity& lhs, const FrameIdentity& rhs) { return !(lhs == rhs); }

bool DisplayPolicy::markBackendReady() {
  if (state_ != DisplayState::offline) return false;
  backend_ready_ = true;
  state_ = DisplayState::idle;
  return true;
}

bool DisplayPolicy::markBackendFailed() {
  if (state_ != DisplayState::offline) return false;
  backend_ready_ = false;
  state_ = DisplayState::fault;
  clearVisible();
  return true;
}

bool DisplayPolicy::ownerMatches(const char* owner) const { return sameOwner(owner_, owner); }

bool DisplayPolicy::acquire(const char* owner) {
  if (state_ != DisplayState::idle || overlay_open_ || owner == nullptr || *owner == '\0') {
    return false;
  }
  if (owner_ != nullptr && !sameOwner(owner_, owner)) return false;
  owner_ = owner;
  return true;
}

bool DisplayPolicy::release(const char* owner) {
  if (state_ != DisplayState::idle || overlay_open_ || !ownerMatches(owner)) return false;
  owner_ = nullptr;
  clearVisible();
  return true;
}

bool DisplayPolicy::selectDesired(const char* owner, const FrameIdentity& frame) {
  if (state_ != DisplayState::idle || overlay_open_ || !ownerMatches(owner) || !frame.valid()) {
    return false;
  }
  desired_ = frame;
  return true;
}

bool DisplayPolicy::commitCached(const char* owner, const FrameIdentity& frame) {
  if (state_ != DisplayState::idle || overlay_open_ || !ownerMatches(owner) || !frame.valid()) {
    return false;
  }
  cached_ = frame;
  return true;
}

bool DisplayPolicy::beginFramePresentation(const char* owner, const FrameIdentity& frame) {
  if (state_ != DisplayState::idle || overlay_open_ || !ownerMatches(owner) || !frame.valid() ||
      desired_ != frame || cached_ != frame) {
    return false;
  }
  pending_surface_ = SurfaceKind::app_frame;
  pending_frame_ = frame;
  state_ = DisplayState::refreshing;
  return true;
}

bool DisplayPolicy::finishPresentation(const char* owner, const bool success) {
  if (state_ != DisplayState::refreshing || !ownerMatches(owner) ||
      pending_surface_ == SurfaceKind::none) {
    return false;
  }

  if (success) {
    consecutive_failures_ = 0;
    physical_known_ = true;
    visible_surface_ = pending_surface_;
    presented_composition_generation_ = composition_generation_;
    if (pending_surface_ == SurfaceKind::app_frame) {
      presented_ = pending_frame_;
      last_good_ = pending_frame_;
    } else {
      presented_ = FrameIdentity{};
    }
    state_ = DisplayState::idle;
  } else {
    if (consecutive_failures_ < max_consecutive_failures) ++consecutive_failures_;
    clearVisible();
    state_ = consecutive_failures_ >= max_consecutive_failures ? DisplayState::fault
                                                               : DisplayState::idle;
  }
  pending_surface_ = SurfaceKind::none;
  pending_frame_ = FrameIdentity{};
  return true;
}

bool DisplayPolicy::openModalOverlay(const char* app_owner, const char* overlay_owner) {
  if (state_ != DisplayState::idle || overlay_open_ || !ownerMatches(app_owner) ||
      overlay_owner == nullptr || *overlay_owner == '\0' || sameOwner(app_owner, overlay_owner)) {
    return false;
  }
  return_owner_ = owner_;
  return_target_ = presented_;
  owner_ = overlay_owner;
  overlay_open_ = true;
  ++composition_generation_;
  clearVisible();
  return true;
}

bool DisplayPolicy::beginOverlayPresentation(const char* overlay_owner) {
  if (state_ != DisplayState::idle || !overlay_open_ || !ownerMatches(overlay_owner)) return false;
  pending_surface_ = SurfaceKind::modal_overlay;
  pending_frame_ = FrameIdentity{};
  state_ = DisplayState::refreshing;
  return true;
}

bool DisplayPolicy::closeModalOverlay(const char* overlay_owner) {
  if (state_ != DisplayState::idle || !overlay_open_ || !ownerMatches(overlay_owner) ||
      return_owner_ == nullptr) {
    return false;
  }
  owner_ = return_owner_;
  return_owner_ = nullptr;
  overlay_open_ = false;
  ++composition_generation_;
  if (return_target_.valid()) desired_ = return_target_;
  return_target_ = FrameIdentity{};
  clearVisible();
  return true;
}

bool DisplayPolicy::invalidatePhysicalState() {
  if (state_ == DisplayState::refreshing) return false;
  clearVisible();
  ++composition_generation_;
  return true;
}

bool DisplayPolicy::resetFault() {
  if (state_ != DisplayState::fault || !backend_ready_) return false;
  consecutive_failures_ = 0;
  clearVisible();
  state_ = DisplayState::idle;
  return true;
}

bool DisplayPolicy::canDispatchAppInput(const char* owner, const FrameIdentity& frame) const {
  return state_ == DisplayState::idle && !overlay_open_ && physical_known_ &&
         visible_surface_ == SurfaceKind::app_frame && ownerMatches(owner) && frame.valid() &&
         presented_ == frame;
}

bool DisplayPolicy::canDispatchOverlayInput(const char* overlay_owner) const {
  return state_ == DisplayState::idle && overlay_open_ && physical_known_ &&
         visible_surface_ == SurfaceKind::modal_overlay && ownerMatches(overlay_owner);
}

bool DisplayPolicy::canSkipRefresh(const char* owner, const FrameIdentity& frame) const {
  return canDispatchAppInput(owner, frame) &&
         presented_composition_generation_ == composition_generation_;
}

DisplayPolicySnapshot DisplayPolicy::snapshot() const {
  return DisplayPolicySnapshot{state_,
                               visible_surface_,
                               physical_known_,
                               overlay_open_,
                               composition_generation_,
                               consecutive_failures_,
                               desired_,
                               cached_,
                               presented_,
                               last_good_};
}

void DisplayPolicy::clearVisible() {
  physical_known_ = false;
  visible_surface_ = SurfaceKind::none;
  presented_ = FrameIdentity{};
}

}  // namespace mooneink
