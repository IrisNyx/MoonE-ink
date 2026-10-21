// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/device_protocol.hpp"

#include <cstdio>
#include <cstring>

namespace mooneink {

constexpr const char* DeviceProtocol::portrait_profile;
constexpr const char* DeviceProtocol::landscape_profile;
constexpr const char* DeviceProtocol::gray4_format;

namespace {

bool boundedLength(const char* value, const std::size_t capacity, std::size_t& length) {
  if (value == nullptr || capacity == 0) return false;
  for (std::size_t i = 0; i < capacity; ++i) {
    if (value[i] == '\0') {
      length = i;
      return true;
    }
  }
  return false;
}

bool validId(const char* value, const std::size_t capacity) {
  std::size_t length = 0;
  if (!boundedLength(value, capacity, length) || length == 0 || length > 128) return false;
  for (std::size_t i = 0; i < length; ++i) {
    const char c = value[i];
    const bool alphanumeric = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                              (c >= '0' && c <= '9');
    if (!alphanumeric && c != '.' && c != '_' && c != ':' && c != '-') return false;
  }
  return true;
}

bool validDigest(const char* value) {
  std::size_t length = 0;
  if (!boundedLength(value, DeviceProtocol::digest_capacity, length) || length != 64) return false;
  for (std::size_t i = 0; i < length; ++i) {
    const char c = value[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool overlaps(const RemoteAction& lhs, const RemoteAction& rhs) {
  return lhs.x < static_cast<std::int32_t>(rhs.x) + rhs.width &&
         rhs.x < static_cast<std::int32_t>(lhs.x) + lhs.width &&
         lhs.y < static_cast<std::int32_t>(rhs.y) + rhs.height &&
         rhs.y < static_cast<std::int32_t>(lhs.y) + lhs.height;
}

std::uint8_t hexNibble(const char value) {
  return value <= '9' ? static_cast<std::uint8_t>(value - '0')
                      : static_cast<std::uint8_t>(value - 'a' + 10);
}

bool digestMatches(const std::uint8_t actual[32], const char* expected) {
  std::uint8_t difference = 0;
  for (std::size_t i = 0; i < 32; ++i) {
    const std::uint8_t wanted = static_cast<std::uint8_t>((hexNibble(expected[i * 2]) << 4U) |
                                                          hexNibble(expected[i * 2 + 1]));
    difference |= static_cast<std::uint8_t>(actual[i] ^ wanted);
  }
  return difference == 0;
}

bool copyId(const char* value, std::array<char, FrameIdentity::id_capacity>& output) {
  std::size_t length = 0;
  if (!boundedLength(value, DeviceProtocol::identifier_capacity, length) ||
      length == 0 || length >= output.size()) {
    return false;
  }
  output.fill('\0');
  std::memcpy(output.data(), value, length);
  return true;
}

}  // namespace

bool parseRemoteActionKind(const char* value, RemoteActionKind& output) {
  if (value == nullptr) return false;
  struct Entry final {
    const char* name;
    RemoteActionKind kind;
  };
  constexpr Entry entries[] = {
      {"previous_page", RemoteActionKind::previous_page},
      {"next_page", RemoteActionKind::next_page},
      {"previous_publication", RemoteActionKind::previous_publication},
      {"next_publication", RemoteActionKind::next_publication},
      {"acknowledge", RemoteActionKind::acknowledge},
      {"return_latest", RemoteActionKind::return_latest},
  };
  for (const Entry& entry : entries) {
    if (std::strcmp(value, entry.name) == 0) {
      output = entry.kind;
      return true;
    }
  }
  return false;
}

bool isProtocolIdentifier(const char* value) {
  return validId(value, DeviceProtocol::identifier_capacity);
}

bool isProtocolCursor(const char* value) {
  std::size_t length = 0;
  if (!boundedLength(value, DeviceProtocol::identifier_capacity, length) ||
      length < 32 || length > 128) {
    return false;
  }
  for (std::size_t i = 0; i < length; ++i) {
    const char c = value[i];
    const bool alphanumeric = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                              (c >= '0' && c <= '9');
    if (!alphanumeric && c != '_' && c != '-') return false;
  }
  return true;
}

bool isSupportedProfile(const char* value) {
  return value != nullptr &&
         (std::strcmp(value, DeviceProtocol::portrait_profile) == 0 ||
          std::strcmp(value, DeviceProtocol::landscape_profile) == 0);
}

const char* remoteActionName(const RemoteActionKind kind) {
  switch (kind) {
    case RemoteActionKind::previous_page: return "previous_page";
    case RemoteActionKind::next_page: return "next_page";
    case RemoteActionKind::previous_publication: return "previous_publication";
    case RemoteActionKind::next_publication: return "next_publication";
    case RemoteActionKind::acknowledge: return "acknowledge";
    case RemoteActionKind::return_latest: return "return_latest";
  }
  return nullptr;
}

std::uint16_t remoteActionId(const RemoteActionKind kind) {
  return static_cast<std::uint16_t>(kind);
}

bool validateRemoteFrameDescriptor(const RemoteFrameDescriptor& descriptor,
                                   DescriptorError& error) {
  error = DescriptorError::none;
  const bool ids_ok = validId(descriptor.frame_id.data(), descriptor.frame_id.size()) &&
                      validId(descriptor.publication_id.data(), descriptor.publication_id.size()) &&
                      validId(descriptor.edition_id.data(), descriptor.edition_id.size()) &&
                      validId(descriptor.part_id.data(), descriptor.part_id.size()) &&
                      validId(descriptor.page_id.data(), descriptor.page_id.size());
  if (!ids_ok) {
    error = DescriptorError::invalid_identifier;
    return false;
  }
  if (!isSupportedProfile(descriptor.profile.data())) {
    error = DescriptorError::unsupported_profile;
    return false;
  }
  if (std::strcmp(descriptor.format.data(), DeviceProtocol::gray4_format) != 0) {
    error = DescriptorError::invalid_format;
    return false;
  }
  const bool portrait_geometry =
      std::strcmp(descriptor.profile.data(), DeviceProtocol::portrait_profile) == 0 &&
      descriptor.width == BoardProfile::portrait_width &&
      descriptor.height == BoardProfile::portrait_height &&
      descriptor.stride_bytes == DeviceProtocol::portrait_stride_bytes;
  const bool landscape_geometry =
      std::strcmp(descriptor.profile.data(), DeviceProtocol::landscape_profile) == 0 &&
      descriptor.width == BoardProfile::portrait_height &&
      descriptor.height == BoardProfile::portrait_width &&
      descriptor.stride_bytes == DeviceProtocol::landscape_stride_bytes;
  if ((!portrait_geometry && !landscape_geometry) ||
      descriptor.byte_length != BoardProfile::gray4_frame_bytes) {
    error = DescriptorError::invalid_geometry;
    return false;
  }
  if (descriptor.page_count == 0 ||
      descriptor.page_count > DeviceProtocol::max_pages_per_edition ||
      descriptor.page_index >= descriptor.page_count) {
    error = DescriptorError::invalid_pagination;
    return false;
  }
  if (!validDigest(descriptor.sha256.data())) {
    error = DescriptorError::invalid_digest;
    return false;
  }
  char expected_asset[DeviceProtocol::asset_path_capacity]{};
  const int asset_length = std::snprintf(expected_asset, sizeof(expected_asset),
                                         "/device/v1/assets/%s.bin", descriptor.sha256.data());
  if (asset_length <= 0 || static_cast<std::size_t>(asset_length) >= sizeof(expected_asset) ||
      std::strcmp(descriptor.asset.data(), expected_asset) != 0) {
    error = DescriptorError::invalid_asset_path;
    return false;
  }
  if (descriptor.action_count > DeviceProtocol::max_actions_per_frame) {
    error = DescriptorError::too_many_actions;
    return false;
  }
  for (std::size_t i = 0; i < descriptor.action_count; ++i) {
    const RemoteAction& action = descriptor.actions[i];
    if (remoteActionName(action.kind) == nullptr || remoteActionId(action.kind) == 0) {
      error = DescriptorError::invalid_action;
      return false;
    }
    if (action.x < 0 || action.y < 0 || action.width == 0 || action.height == 0 ||
        static_cast<std::int32_t>(action.x) + action.width > descriptor.width ||
        static_cast<std::int32_t>(action.y) + action.height > descriptor.height) {
      error = DescriptorError::invalid_action_bounds;
      return false;
    }
    for (std::size_t j = 0; j < i; ++j) {
      if (overlaps(action, descriptor.actions[j]) || action.kind == descriptor.actions[j].kind) {
        error = DescriptorError::overlapping_actions;
        return false;
      }
    }
  }
  return true;
}

bool makeFrameIdentity(const char* binding_id, const RemoteFrameDescriptor& descriptor,
                       FrameIdentity& output) {
  DescriptorError error = DescriptorError::none;
  if (!validateRemoteFrameDescriptor(descriptor, error) ||
      !validId(binding_id, DeviceProtocol::identifier_capacity)) {
    return false;
  }
  FrameIdentity candidate{};
  if (!copyId(binding_id, candidate.binding_id) ||
      !copyId(descriptor.frame_id.data(), candidate.frame_id)) {
    return false;
  }
  candidate.page_index = descriptor.page_index;
  candidate.orientation = std::strcmp(descriptor.profile.data(), DeviceProtocol::landscape_profile) == 0
                              ? Orientation::landscape
                              : Orientation::portrait;
  if (!candidate.valid()) return false;
  output = candidate;
  return true;
}

bool makeHitRegions(const RemoteFrameDescriptor& descriptor,
                    std::array<HitRegion, DeviceProtocol::max_actions_per_frame>& output,
                    std::size_t& count) {
  DescriptorError error = DescriptorError::none;
  if (!validateRemoteFrameDescriptor(descriptor, error)) return false;
  output.fill(HitRegion{});
  count = descriptor.action_count;
  for (std::size_t i = 0; i < count; ++i) {
    const RemoteAction& action = descriptor.actions[i];
    output[i] = HitRegion{action.x, action.y, action.width, action.height,
                          remoteActionId(action.kind)};
  }
  return true;
}

void FrameTransfer::fail() {
  state_ = FrameTransferState::failed;
  storage_ = nullptr;
  capacity_ = 0;
}

bool FrameTransfer::begin(const RemoteFrameDescriptor& descriptor, std::uint8_t* storage,
                          const std::size_t capacity) {
  reset();
  DescriptorError error = DescriptorError::none;
  if (!validateRemoteFrameDescriptor(descriptor, error) || storage == nullptr ||
      capacity < descriptor.byte_length) {
    fail();
    return false;
  }
  descriptor_ = descriptor;
  storage_ = storage;
  capacity_ = capacity;
  sha_.reset();
  state_ = FrameTransferState::receiving;
  return true;
}

bool FrameTransfer::append(const std::uint8_t* data, const std::size_t length) {
  if (state_ != FrameTransferState::receiving || (length > 0 && data == nullptr) ||
      length > descriptor_.byte_length - bytes_written_ ||
      bytes_written_ + length > capacity_) {
    fail();
    return false;
  }
  if (length == 0) return true;
  std::memcpy(storage_ + bytes_written_, data, length);
  if (!sha_.update(data, length)) {
    fail();
    return false;
  }
  bytes_written_ += length;
  return true;
}

bool FrameTransfer::finish() {
  if (state_ != FrameTransferState::receiving ||
      bytes_written_ != descriptor_.byte_length) {
    fail();
    return false;
  }
  std::array<std::uint8_t, 32> digest{};
  if (!sha_.finish(digest) || !digestMatches(digest.data(), descriptor_.sha256.data())) {
    fail();
    return false;
  }
  state_ = FrameTransferState::verified;
  return true;
}

void FrameTransfer::reset() {
  state_ = FrameTransferState::empty;
  descriptor_ = RemoteFrameDescriptor{};
  storage_ = nullptr;
  capacity_ = 0;
  bytes_written_ = 0;
  sha_.reset();
}

bool sha256Hex(const std::uint8_t* data, const std::size_t length,
               std::array<char, DeviceProtocol::digest_capacity>& output) {
  if (length > 0 && data == nullptr) return false;
  std::array<std::uint8_t, 32> digest{};
  if (!sha256(data, length, digest)) return false;
  constexpr char digits[] = "0123456789abcdef";
  output.fill('\0');
  for (std::size_t i = 0; i < 32; ++i) {
    output[i * 2] = digits[digest[i] >> 4U];
    output[i * 2 + 1] = digits[digest[i] & 0x0FU];
  }
  return true;
}

}  // namespace mooneink
