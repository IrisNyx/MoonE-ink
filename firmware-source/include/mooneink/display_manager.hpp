// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include "mooneink/display_backend.hpp"
#include "mooneink/display_policy.hpp"
#include "mooneink/event_bus.hpp"

namespace mooneink {

class DisplayManager final {
 public:
  DisplayManager(DisplayBackend& backend, EventBus& events)
      : backend_(backend), events_(events) {}

  bool begin();
  bool acquire(const char* owner);
  bool release(const char* owner);
  bool selectDesired(const char* owner, const FrameIdentity& frame);
  bool commitCached(const char* owner, const FrameIdentity& frame);
  bool presentDiagnostics(const char* owner, const FrameIdentity& frame,
                          const DiagnosticsSnapshot& snapshot);
  bool presentComposedFrame(const char* owner, const FrameIdentity& frame);
  bool presentGray4Frame(const char* owner, const FrameIdentity& frame,
                         const std::uint8_t* pixels, std::size_t byte_length,
                         std::uint16_t width, std::uint16_t height,
                         std::uint16_t stride_bytes);
  bool presentGray4FrameWithUnreadBadge(
      const char* owner, const FrameIdentity& frame,
      const std::uint8_t* pixels, std::size_t byte_length,
      std::uint16_t width, std::uint16_t height, std::uint16_t stride_bytes,
      std::uint32_t other_unread);
  bool presentEphemeraLocalView(const char* owner, const FrameIdentity& frame,
                                const EphemeraLocalView& view);
  bool openModalOverlay(const char* app_owner, const char* overlay_owner);
  bool presentOverlayComposedFrame(const char* overlay_owner);
  bool beginOverlayPresentation(const char* overlay_owner);
  bool finishOverlayPresentation(const char* overlay_owner, bool success);
  bool closeModalOverlay(const char* overlay_owner);
  bool invalidatePhysicalState();
  bool resetFault();

  bool canDispatchAppInput(const char* owner, const FrameIdentity& frame) const;
  bool canDispatchOverlayInput(const char* overlay_owner) const;
  bool canSkipRefresh(const char* owner, const FrameIdentity& frame) const;
  DisplayPolicySnapshot snapshot() const { return policy_.snapshot(); }
  DisplayState state() const { return policy_.state(); }
  const char* owner() const { return policy_.owner(); }

 private:
  DisplayBackend& backend_;
  EventBus& events_;
  DisplayPolicy policy_;
};

}  // namespace mooneink

