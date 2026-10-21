// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/device_protocol.hpp"

namespace mooneink {

struct ProtocolLimits final {
  std::uint16_t max_pages_per_edition = 16;
  std::uint32_t max_pages_response_bytes = 262144;
  std::uint32_t max_history_response_bytes = 262144;
  std::uint8_t max_actions_per_frame = 6;
  std::uint16_t max_string_bytes = 4096;
  std::uint8_t max_json_depth = 8;
  std::uint32_t max_event_body_bytes = 32768;
  std::uint8_t max_history_items = 50;
  std::uint32_t request_timeout_ms = 15000;
  std::uint32_t asset_download_timeout_ms = 30000;

  bool supportsV1() const;
};

struct DeviceBinding final {
  std::array<char, DeviceProtocol::identifier_capacity> device_id{};
  std::array<char, DeviceProtocol::identifier_capacity> binding_id{};
  std::array<char, DeviceProtocol::identifier_capacity> instance_id{};
  std::array<char, DeviceProtocol::identifier_capacity> channel_id{};
  std::array<char, DeviceProtocol::identifier_capacity> epoch{};
  std::array<char, DeviceProtocol::identifier_capacity> device_secret{};
  ProtocolLimits limits{};

  bool valid() const;
};

enum class ScreenAvailability : std::uint8_t { empty, ready, unsupported_profile };

struct ScreenOffer final {
  std::array<char, DeviceProtocol::identifier_capacity> delivery_id{};
  std::array<char, DeviceProtocol::identifier_capacity> publication_id{};
  RemoteFrameDescriptor frame{};
};

struct LibrarySummary final {
  std::uint64_t revision = 0;
  std::uint32_t unread_count = 0;
  bool has_selected_read_status = false;
  std::array<char, DeviceProtocol::identifier_capacity> selected_publication_id{};
  bool selected_unread = false;
};

struct ScreenResponse final {
  std::uint64_t revision = 0;
  ScreenAvailability availability = ScreenAvailability::empty;
  bool has_offer = false;
  ScreenOffer offer{};
  bool has_library = false;
  LibrarySummary library{};
};

struct HistoryItem final {
  std::array<char, DeviceProtocol::identifier_capacity> publication_id{};
  std::array<char, DeviceProtocol::identifier_capacity> delivery_id{};
  std::array<char, DeviceProtocol::identifier_capacity> edition_id{};
  std::array<char, DeviceProtocol::identifier_capacity> profile{};
  std::array<char, 97> label{};
  std::array<char, 181> summary{};
  std::array<char, 49> genre{};
  std::array<char, 33> display_date{};
  std::uint64_t acceptance_seq = 0;
  std::uint16_t page_count = 0;
  bool unread = false;
  bool presentable = false;

  bool valid() const;
};

struct HistoryResponse final {
  static constexpr std::size_t item_capacity = 20;

  std::array<HistoryItem, item_capacity> items{};
  std::size_t item_count = 0;
  bool has_next_cursor = false;
  std::array<char, DeviceProtocol::identifier_capacity> next_cursor{};
  bool has_library = false;
  std::uint64_t library_revision = 0;
  std::uint32_t unread_count = 0;

  // These bounded responses are intentionally large and live in PSRAM-backed
  // owner objects. Reset them in place so the ESP32 loop task never creates a
  // response-sized aggregate temporary on its stack.
  void clear();
};

struct PagesResponse final {
  std::array<char, DeviceProtocol::identifier_capacity> publication_id{};
  std::array<char, DeviceProtocol::identifier_capacity> edition_id{};
  std::array<char, DeviceProtocol::identifier_capacity> profile{};
  std::uint16_t page_count = 0;
  std::array<RemoteFrameDescriptor, DeviceProtocol::max_pages_per_edition> frames{};
  std::size_t frame_count = 0;

  void clear();
  bool valid() const;
};

enum class DeviceEventKind : std::uint8_t {
  cached,
  presented,
  acknowledged,
  status,
  interaction,
};

enum class DevicePowerSource : std::uint8_t { unknown, external, battery };
enum class DevicePowerMode : std::uint8_t {
  external_online,
  active,
  battery_idle,
  retry_backoff,
  low_battery,
};

struct DevicePowerReport final {
  DevicePowerSource source = DevicePowerSource::unknown;
  DevicePowerMode mode = DevicePowerMode::active;
  bool has_battery = false;
  std::uint8_t battery_percent = 0;
  std::uint16_t battery_millivolts = 0;
  bool has_gauge_details = false;
  std::int16_t current_ma = 0;
  std::int16_t average_current_ma = 0;
  std::uint16_t remaining_mah = 0;
  std::uint16_t full_mah = 0;
  std::uint64_t light_sleep_seconds = 0;
  std::uint64_t uptime_seconds = 0;

  bool valid() const;
};

struct DeviceFrameReference final {
  std::array<char, DeviceProtocol::identifier_capacity> publication_id{};
  std::array<char, DeviceProtocol::identifier_capacity> page_id{};
  std::array<char, DeviceProtocol::identifier_capacity> frame_id{};

  bool valid() const;
};

struct DeviceEvent final {
  std::array<char, DeviceProtocol::identifier_capacity> event_id{};
  std::uint64_t seq = 0;
  DeviceEventKind kind = DeviceEventKind::status;
  bool has_subject = false;
  DeviceFrameReference subject{};
  bool has_delivery_id = false;
  std::array<char, DeviceProtocol::identifier_capacity> delivery_id{};
  bool has_action = false;
  RemoteActionKind action = RemoteActionKind::previous_page;
  std::array<char, 32> active_app{};
  bool history_mode = false;
  std::uint8_t pending_count = 0;
  bool has_presented_frame = false;
  DeviceFrameReference presented_frame{};

  bool valid() const;
};

enum class DeviceJsonError : std::uint8_t {
  none,
  body_too_large,
  malformed_json,
  invalid_schema,
  unsupported_protocol,
  scope_mismatch,
  unsupported_profile,
  invalid_descriptor,
  output_too_small,
};

bool writePairRequest(char* output, std::size_t capacity, std::size_t& written,
                      const char* request_id, const char* device_id,
                      const char* enrollment_code);
bool parsePairResponse(const char* input, std::size_t length, const char* expected_device_id,
                       DeviceBinding& output, DeviceJsonError& error);
bool parseScreenResponse(const char* input, std::size_t length, const DeviceBinding& binding,
                         ScreenResponse& output, DeviceJsonError& error);
bool parseHistoryResponse(const char* input, std::size_t length,
                          const DeviceBinding& binding, HistoryResponse& output,
                          DeviceJsonError& error);
bool parsePagesResponse(const char* input, std::size_t length,
                        const DeviceBinding& binding, PagesResponse& output,
                        DeviceJsonError& error);
bool writeEventRequest(char* output, std::size_t capacity, std::size_t& written,
                       const DeviceBinding& binding, const DeviceEvent& event,
                       const DevicePowerReport* power,
                       DeviceJsonError& error);
bool parseEventResponse(const char* input, std::size_t length, const char* expected_event_id,
                        DeviceJsonError& error);
bool deviceJsonSelfTest();

}  // namespace mooneink
