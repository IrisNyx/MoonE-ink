// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/display_manager.hpp"

namespace mooneink {

bool DisplayManager::begin() {
  if (!backend_.begin()) {
    policy_.markBackendFailed();
    events_.publish(EventKind::display_failed);
    return false;
  }
  return policy_.markBackendReady();
}

bool DisplayManager::acquire(const char* owner) {
  return policy_.acquire(owner);
}

bool DisplayManager::release(const char* owner) {
  return policy_.release(owner);
}

bool DisplayManager::selectDesired(const char* owner, const FrameIdentity& frame) {
  if (!policy_.selectDesired(owner, frame)) return false;
  events_.publish(EventKind::desired_changed, frame.page_index,
                  static_cast<std::int32_t>(frame.orientation));
  return true;
}

bool DisplayManager::commitCached(const char* owner, const FrameIdentity& frame) {
  if (!policy_.commitCached(owner, frame)) return false;
  events_.publish(EventKind::cached_committed, frame.page_index,
                  static_cast<std::int32_t>(frame.orientation));
  return true;
}

bool DisplayManager::presentDiagnostics(const char* owner, const FrameIdentity& frame,
                                        const DiagnosticsSnapshot& snapshot) {
  if (!policy_.beginFramePresentation(owner, frame)) return false;
  events_.publish(EventKind::display_started);
  const bool ok = backend_.presentDiagnostics(snapshot);
  if (!policy_.finishPresentation(owner, ok)) return false;
  events_.publish(ok ? EventKind::display_presented : EventKind::display_failed);
  if (!ok && policy_.state() == DisplayState::fault) {
    events_.publish(EventKind::display_fault_latched);
  }
  return ok;
}

bool DisplayManager::presentComposedFrame(const char* owner, const FrameIdentity& frame) {
  if (!policy_.beginFramePresentation(owner, frame)) return false;
  events_.publish(EventKind::display_started);
  const bool ok = backend_.presentComposedFrame();
  if (!policy_.finishPresentation(owner, ok)) return false;
  events_.publish(ok ? EventKind::display_presented : EventKind::display_failed);
  if (!ok && policy_.state() == DisplayState::fault) {
    events_.publish(EventKind::display_fault_latched);
  }
  return ok;
}

bool DisplayManager::presentGray4Frame(const char* owner, const FrameIdentity& frame,
                                       const std::uint8_t* pixels,
                                       const std::size_t byte_length,
                                       const std::uint16_t width,
                                       const std::uint16_t height,
                                       const std::uint16_t stride_bytes) {
  if (!policy_.beginFramePresentation(owner, frame)) return false;
  events_.publish(EventKind::display_started);
  const bool composed = backend_.composeGray4Frame(pixels, byte_length, width, height,
                                                    stride_bytes);
  const bool ok = composed && backend_.presentComposedFrame();
  if (!policy_.finishPresentation(owner, ok)) return false;
  events_.publish(ok ? EventKind::display_presented : EventKind::display_failed);
  if (!ok && policy_.state() == DisplayState::fault) {
    events_.publish(EventKind::display_fault_latched);
  }
  return ok;
}

bool DisplayManager::presentGray4FrameWithUnreadBadge(
    const char* owner, const FrameIdentity& frame, const std::uint8_t* pixels,
    const std::size_t byte_length, const std::uint16_t width,
    const std::uint16_t height, const std::uint16_t stride_bytes,
    const std::uint32_t other_unread) {
  if (!policy_.beginFramePresentation(owner, frame)) return false;
  events_.publish(EventKind::display_started);
  const bool composed = backend_.composeGray4FrameWithUnreadBadge(
      pixels, byte_length, width, height, stride_bytes, other_unread);
  const bool ok = composed && backend_.presentComposedFrame();
  if (!policy_.finishPresentation(owner, ok)) return false;
  events_.publish(ok ? EventKind::display_presented : EventKind::display_failed);
  if (!ok && policy_.state() == DisplayState::fault) {
    events_.publish(EventKind::display_fault_latched);
  }
  return ok;
}

bool DisplayManager::presentEphemeraLocalView(const char* owner,
                                               const FrameIdentity& frame,
                                               const EphemeraLocalView& view) {
  if (!policy_.beginFramePresentation(owner, frame)) return false;
  events_.publish(EventKind::display_started);
  const bool composed = backend_.composeEphemeraLocalView(view);
  const bool ok = composed && backend_.presentComposedFrame();
  if (!policy_.finishPresentation(owner, ok)) return false;
  events_.publish(ok ? EventKind::display_presented : EventKind::display_failed);
  if (!ok && policy_.state() == DisplayState::fault) {
    events_.publish(EventKind::display_fault_latched);
  }
  return ok;
}

bool DisplayManager::openModalOverlay(const char* app_owner, const char* overlay_owner) {
  if (!policy_.openModalOverlay(app_owner, overlay_owner)) return false;
  events_.publish(EventKind::overlay_opened);
  return true;
}

bool DisplayManager::presentOverlayComposedFrame(const char* overlay_owner) {
  if (!policy_.beginOverlayPresentation(overlay_owner)) return false;
  events_.publish(EventKind::display_started);
  const bool ok = backend_.presentComposedFrame();
  if (!policy_.finishPresentation(overlay_owner, ok)) return false;
  events_.publish(ok ? EventKind::display_presented : EventKind::display_failed);
  if (!ok && policy_.state() == DisplayState::fault) {
    events_.publish(EventKind::display_fault_latched);
  }
  return ok;
}

bool DisplayManager::beginOverlayPresentation(const char* overlay_owner) {
  if (!policy_.beginOverlayPresentation(overlay_owner)) return false;
  events_.publish(EventKind::display_started);
  return true;
}

bool DisplayManager::finishOverlayPresentation(const char* overlay_owner, const bool success) {
  if (!policy_.finishPresentation(overlay_owner, success)) return false;
  events_.publish(success ? EventKind::display_presented : EventKind::display_failed);
  if (!success && policy_.state() == DisplayState::fault) {
    events_.publish(EventKind::display_fault_latched);
  }
  return true;
}

bool DisplayManager::closeModalOverlay(const char* overlay_owner) {
  if (!policy_.closeModalOverlay(overlay_owner)) return false;
  events_.publish(EventKind::overlay_closed);
  return true;
}

bool DisplayManager::invalidatePhysicalState() { return policy_.invalidatePhysicalState(); }

bool DisplayManager::resetFault() { return policy_.resetFault(); }

bool DisplayManager::canDispatchAppInput(const char* owner, const FrameIdentity& frame) const {
  return policy_.canDispatchAppInput(owner, frame);
}

bool DisplayManager::canDispatchOverlayInput(const char* overlay_owner) const {
  return policy_.canDispatchOverlayInput(overlay_owner);
}

bool DisplayManager::canSkipRefresh(const char* owner, const FrameIdentity& frame) const {
  return policy_.canSkipRefresh(owner, frame);
}

}  // namespace mooneink

