// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/device_json.hpp"

#include <cstring>
#include <type_traits>

namespace mooneink {

bool ProtocolLimits::supportsV1() const {
  // These are allocation and parser ceilings advertised by this firmware, not
  // server-controlled hints. A larger echoed value could otherwise make a
  // compromised peer drive an unbounded reserve/parse attempt.
  return max_pages_per_edition == 16 && max_pages_response_bytes == 262144 &&
         max_history_response_bytes == 262144 && max_actions_per_frame == 6 &&
         max_string_bytes == 4096 && max_json_depth == 8 &&
         max_event_body_bytes == 32768 && max_history_items == 50 &&
         request_timeout_ms == 15000 && asset_download_timeout_ms == 30000;
}

bool DeviceBinding::valid() const {
  return isProtocolIdentifier(device_id.data()) && isProtocolIdentifier(binding_id.data()) &&
         isProtocolIdentifier(instance_id.data()) && isProtocolIdentifier(channel_id.data()) &&
         isProtocolIdentifier(epoch.data()) && isProtocolCursor(device_secret.data()) &&
         limits.supportsV1();
}

bool DeviceFrameReference::valid() const {
  return isProtocolIdentifier(publication_id.data()) &&
         isProtocolIdentifier(page_id.data()) && isProtocolIdentifier(frame_id.data());
}

bool HistoryItem::valid() const {
  return isProtocolIdentifier(publication_id.data()) &&
         isProtocolIdentifier(delivery_id.data()) &&
         isProtocolIdentifier(edition_id.data()) &&
         isSupportedProfile(profile.data()) &&
         acceptance_seq > 0 && page_count > 0 &&
         page_count <= DeviceProtocol::max_pages_per_edition;
}

void HistoryResponse::clear() {
  static_assert(std::is_trivially_copyable<HistoryResponse>::value,
                "HistoryResponse must remain safe for bounded in-place reset");
  std::memset(static_cast<void*>(this), 0, sizeof(*this));
}

void PagesResponse::clear() {
  static_assert(std::is_trivially_copyable<PagesResponse>::value,
                "PagesResponse must remain safe for bounded in-place reset");
  std::memset(static_cast<void*>(this), 0, sizeof(*this));
}

bool PagesResponse::valid() const {
  if (!isProtocolIdentifier(publication_id.data()) ||
      !isProtocolIdentifier(edition_id.data()) ||
      !isSupportedProfile(profile.data()) ||
      page_count == 0 || page_count > DeviceProtocol::max_pages_per_edition ||
      frame_count != page_count) {
    return false;
  }
  for (std::size_t i = 0; i < frame_count; ++i) {
    DescriptorError descriptor_error = DescriptorError::none;
    const RemoteFrameDescriptor& frame = frames[i];
    if (!validateRemoteFrameDescriptor(frame, descriptor_error) ||
        frame.page_index != i || frame.page_count != page_count ||
        std::strcmp(frame.publication_id.data(), publication_id.data()) != 0 ||
        std::strcmp(frame.edition_id.data(), edition_id.data()) != 0 ||
        std::strcmp(frame.profile.data(), profile.data()) != 0) {
      return false;
    }
  }
  return true;
}

bool DeviceEvent::valid() const {
  if (!isProtocolIdentifier(event_id.data()) || seq == 0 || active_app[0] == '\0' ||
      pending_count > 1 || (has_presented_frame && !presented_frame.valid())) {
    return false;
  }
  if (std::memchr(active_app.data(), '\0', active_app.size()) == nullptr) return false;
  const bool subject_required = kind == DeviceEventKind::cached ||
                                kind == DeviceEventKind::presented ||
                                kind == DeviceEventKind::acknowledged;
  if (subject_required && !has_subject) return false;
  if (has_subject && !subject.valid()) return false;
  if (has_delivery_id && (!has_subject || !isProtocolIdentifier(delivery_id.data()))) {
    return false;
  }
  const bool action_required = kind == DeviceEventKind::interaction;
  if (action_required != has_action ||
      (has_action && remoteActionName(action) == nullptr)) {
    return false;
  }
  return true;
}

bool DevicePowerReport::valid() const {
  return !has_battery || (battery_percent <= 100U && battery_millivolts > 0U);
}

}  // namespace mooneink
