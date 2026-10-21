// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/sha256.hpp"

#include "mooneink/board_profile.hpp"
#include "mooneink/display_policy.hpp"
#include "mooneink/touch_manager.hpp"

namespace mooneink {

struct DeviceProtocol final {
  static constexpr std::uint8_t version = 1;
  static constexpr const char* portrait_profile = "epaper-540x960-gray4-v1";
  static constexpr const char* landscape_profile = "epaper-960x540-gray4-v1";
  static constexpr const char* gray4_format = "gray4";
  static constexpr std::uint16_t portrait_stride_bytes = 270;
  static constexpr std::uint16_t landscape_stride_bytes = 480;
  static constexpr std::uint16_t max_pages_per_edition = 16;
  static constexpr std::size_t max_actions_per_frame = 6;
  static constexpr std::size_t identifier_capacity = 129;
  static constexpr std::size_t digest_capacity = 65;
  static constexpr std::size_t asset_path_capacity = 96;
};

enum class RemoteActionKind : std::uint8_t {
  previous_page = 1,
  next_page = 2,
  previous_publication = 3,
  next_publication = 4,
  acknowledge = 5,
  return_latest = 6,
};

struct RemoteAction final {
  RemoteActionKind kind = RemoteActionKind::previous_page;
  std::int16_t x = 0;
  std::int16_t y = 0;
  std::uint16_t width = 0;
  std::uint16_t height = 0;
};

struct RemoteFrameDescriptor final {
  std::array<char, DeviceProtocol::identifier_capacity> frame_id{};
  std::array<char, DeviceProtocol::identifier_capacity> publication_id{};
  std::array<char, DeviceProtocol::identifier_capacity> edition_id{};
  std::array<char, DeviceProtocol::identifier_capacity> part_id{};
  std::array<char, DeviceProtocol::identifier_capacity> page_id{};
  std::array<char, DeviceProtocol::identifier_capacity> profile{};
  std::array<char, 16> format{};
  std::array<char, DeviceProtocol::digest_capacity> sha256{};
  std::array<char, DeviceProtocol::asset_path_capacity> asset{};
  std::uint16_t page_index = 0;
  std::uint16_t page_count = 0;
  std::uint16_t width = 0;
  std::uint16_t height = 0;
  std::uint16_t stride_bytes = 0;
  std::uint32_t byte_length = 0;
  std::array<RemoteAction, DeviceProtocol::max_actions_per_frame> actions{};
  std::size_t action_count = 0;
};

enum class DescriptorError : std::uint8_t {
  none,
  invalid_identifier,
  unsupported_profile,
  invalid_format,
  invalid_geometry,
  invalid_pagination,
  invalid_digest,
  invalid_asset_path,
  too_many_actions,
  invalid_action,
  invalid_action_bounds,
  overlapping_actions,
};

bool parseRemoteActionKind(const char* value, RemoteActionKind& output);
bool isProtocolIdentifier(const char* value);
bool isProtocolCursor(const char* value);
bool isSupportedProfile(const char* value);
const char* remoteActionName(RemoteActionKind kind);
std::uint16_t remoteActionId(RemoteActionKind kind);
bool validateRemoteFrameDescriptor(const RemoteFrameDescriptor& descriptor,
                                   DescriptorError& error);
bool makeFrameIdentity(const char* binding_id, const RemoteFrameDescriptor& descriptor,
                       FrameIdentity& output);
bool makeHitRegions(const RemoteFrameDescriptor& descriptor,
                    std::array<HitRegion, DeviceProtocol::max_actions_per_frame>& output,
                    std::size_t& count);

enum class FrameTransferState : std::uint8_t { empty, receiving, verified, failed };

class FrameTransfer final {
 public:
  bool begin(const RemoteFrameDescriptor& descriptor, std::uint8_t* storage,
             std::size_t capacity);
  bool append(const std::uint8_t* data, std::size_t length);
  bool finish();
  void reset();

  FrameTransferState state() const { return state_; }
  std::size_t bytesWritten() const { return bytes_written_; }
  const std::uint8_t* data() const { return state_ == FrameTransferState::verified ? storage_ : nullptr; }
  const RemoteFrameDescriptor& descriptor() const { return descriptor_; }

 private:
  void fail();

  FrameTransferState state_ = FrameTransferState::empty;
  RemoteFrameDescriptor descriptor_{};
  std::uint8_t* storage_ = nullptr;
  std::size_t capacity_ = 0;
  std::size_t bytes_written_ = 0;
  Sha256 sha_{};
};

bool sha256Hex(const std::uint8_t* data, std::size_t length,
               std::array<char, DeviceProtocol::digest_capacity>& output);

}  // namespace mooneink
