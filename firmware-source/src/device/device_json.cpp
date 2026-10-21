// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/device_json.hpp"

#include <ArduinoJson.h>

#include <cstring>

namespace mooneink {
namespace {

constexpr std::size_t kMaxObjectBodyBytes = 32768;

template <std::size_t Size>
bool copyText(const JsonVariantConst value, std::array<char, Size>& destination) {
  if (!value.is<const char*>()) return false;
  const char* text = value.as<const char*>();
  if (text == nullptr) return false;
  const std::size_t length = std::strlen(text);
  if (length == 0 || length >= destination.size()) return false;
  destination.fill('\0');
  std::memcpy(destination.data(), text, length);
  return true;
}

template <std::size_t Size>
bool copyOptionalText(const JsonVariantConst value,
                      std::array<char, Size>& destination) {
  destination.fill('\0');
  if (value.isNull()) return true;
  if (!value.is<const char*>()) return false;
  const char* text = value.as<const char*>();
  if (text == nullptr) return false;
  const std::size_t length = std::strlen(text);
  if (length >= destination.size()) return false;
  std::memcpy(destination.data(), text, length);
  return true;
}

bool readUnsigned(const JsonVariantConst value, std::uint64_t& output) {
  if (!value.is<std::uint64_t>()) return false;
  output = value.as<std::uint64_t>();
  return true;
}

bool scopeMatches(const JsonObjectConst root, const DeviceBinding& binding) {
  return root["instance_id"].is<const char*>() && root["channel_id"].is<const char*>() &&
         root["epoch"].is<const char*>() &&
         std::strcmp(root["instance_id"].as<const char*>(), binding.instance_id.data()) == 0 &&
         std::strcmp(root["channel_id"].as<const char*>(), binding.channel_id.data()) == 0 &&
         std::strcmp(root["epoch"].as<const char*>(), binding.epoch.data()) == 0;
}

bool readLimit(const JsonObjectConst limits, const char* key, std::uint64_t& value) {
  return readUnsigned(limits[key], value);
}

bool parseLimits(const JsonObjectConst object, ProtocolLimits& output) {
  std::uint64_t values[10]{};
  const char* keys[10] = {"max_pages_per_edition", "max_pages_response_bytes",
                          "max_history_response_bytes", "max_actions_per_frame",
                          "max_string_bytes", "max_json_depth", "max_event_body_bytes",
                          "max_history_items", "request_timeout_ms",
                          "asset_download_timeout_ms"};
  for (std::size_t i = 0; i < 10; ++i) {
    if (!readLimit(object, keys[i], values[i])) return false;
  }
  if (values[0] > UINT16_MAX || values[1] > UINT32_MAX || values[2] > UINT32_MAX ||
      values[3] > UINT8_MAX || values[4] > UINT16_MAX || values[5] > UINT8_MAX ||
      values[6] > UINT32_MAX || values[7] > UINT8_MAX || values[8] > UINT32_MAX ||
      values[9] > UINT32_MAX) {
    return false;
  }
  output.max_pages_per_edition = static_cast<std::uint16_t>(values[0]);
  output.max_pages_response_bytes = static_cast<std::uint32_t>(values[1]);
  output.max_history_response_bytes = static_cast<std::uint32_t>(values[2]);
  output.max_actions_per_frame = static_cast<std::uint8_t>(values[3]);
  output.max_string_bytes = static_cast<std::uint16_t>(values[4]);
  output.max_json_depth = static_cast<std::uint8_t>(values[5]);
  output.max_event_body_bytes = static_cast<std::uint32_t>(values[6]);
  output.max_history_items = static_cast<std::uint8_t>(values[7]);
  output.request_timeout_ms = static_cast<std::uint32_t>(values[8]);
  output.asset_download_timeout_ms = static_cast<std::uint32_t>(values[9]);
  return output.supportsV1();
}

bool parseFrame(const JsonObjectConst frame, RemoteFrameDescriptor& output) {
  RemoteFrameDescriptor descriptor{};
  if (!copyText(frame["frame_id"], descriptor.frame_id) ||
      !copyText(frame["publication_id"], descriptor.publication_id) ||
      !copyText(frame["edition_id"], descriptor.edition_id) ||
      !copyText(frame["part_id"], descriptor.part_id) ||
      !copyText(frame["page_id"], descriptor.page_id) ||
      !copyText(frame["profile"], descriptor.profile) ||
      !copyText(frame["format"], descriptor.format) ||
      !copyText(frame["sha256"], descriptor.sha256) ||
      !copyText(frame["asset"], descriptor.asset)) {
    return false;
  }
  std::uint64_t page_index = 0;
  std::uint64_t page_count = 0;
  std::uint64_t width = 0;
  std::uint64_t height = 0;
  std::uint64_t stride = 0;
  std::uint64_t bytes = 0;
  if (!readUnsigned(frame["page_index"], page_index) ||
      !readUnsigned(frame["page_count"], page_count) ||
      !readUnsigned(frame["width"], width) || !readUnsigned(frame["height"], height) ||
      !readUnsigned(frame["stride_bytes"], stride) ||
      !readUnsigned(frame["byte_length"], bytes) || page_index > UINT16_MAX ||
      page_count > UINT16_MAX || width > UINT16_MAX || height > UINT16_MAX ||
      stride > UINT16_MAX || bytes > UINT32_MAX) {
    return false;
  }
  descriptor.page_index = static_cast<std::uint16_t>(page_index);
  descriptor.page_count = static_cast<std::uint16_t>(page_count);
  descriptor.width = static_cast<std::uint16_t>(width);
  descriptor.height = static_cast<std::uint16_t>(height);
  descriptor.stride_bytes = static_cast<std::uint16_t>(stride);
  descriptor.byte_length = static_cast<std::uint32_t>(bytes);

  const JsonArrayConst actions = frame["actions"].as<JsonArrayConst>();
  if (actions.isNull() || actions.size() > DeviceProtocol::max_actions_per_frame) return false;
  for (const JsonVariantConst item : actions) {
    if (!item.is<JsonObjectConst>()) return false;
    const JsonObjectConst action_object = item.as<JsonObjectConst>();
    if (!action_object["id"].is<const char*>()) return false;
    RemoteActionKind kind = RemoteActionKind::previous_page;
    if (!parseRemoteActionKind(action_object["id"].as<const char*>(), kind)) return false;
    std::uint64_t x = 0;
    std::uint64_t y = 0;
    std::uint64_t action_width = 0;
    std::uint64_t action_height = 0;
    if (!readUnsigned(action_object["x"], x) || !readUnsigned(action_object["y"], y) ||
        !readUnsigned(action_object["w"], action_width) ||
        !readUnsigned(action_object["h"], action_height) || x > INT16_MAX ||
        y > INT16_MAX || action_width > UINT16_MAX || action_height > UINT16_MAX) {
      return false;
    }
    RemoteAction& action = descriptor.actions[descriptor.action_count++];
    action.kind = kind;
    action.x = static_cast<std::int16_t>(x);
    action.y = static_cast<std::int16_t>(y);
    action.width = static_cast<std::uint16_t>(action_width);
    action.height = static_cast<std::uint16_t>(action_height);
  }
  DescriptorError descriptor_error = DescriptorError::none;
  if (!validateRemoteFrameDescriptor(descriptor, descriptor_error)) return false;
  output = descriptor;
  return true;
}

bool parseDocument(const char* input, const std::size_t length, JsonDocument& document,
                   DeviceJsonError& error, const std::size_t max_body_bytes,
                   const std::uint8_t max_json_depth) {
  if (input == nullptr || length == 0 || length > max_body_bytes) {
    error = DeviceJsonError::body_too_large;
    return false;
  }
  const DeserializationError result =
      deserializeJson(document, input, length,
                      DeserializationOption::NestingLimit(max_json_depth));
  if (result) {
    error = DeviceJsonError::malformed_json;
    return false;
  }
  if (!document.is<JsonObjectConst>()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  return true;
}

}  // namespace

bool writePairRequest(char* output, const std::size_t capacity, std::size_t& written,
                      const char* request_id, const char* device_id,
                      const char* enrollment_code) {
  written = 0;
  if (output == nullptr || capacity == 0 || !isProtocolIdentifier(request_id) ||
      !isProtocolIdentifier(device_id) || !isProtocolCursor(enrollment_code)) {
    return false;
  }
  JsonDocument document;
  document["protocol_version"] = DeviceProtocol::version;
  document["request_id"] = request_id;
  document["device_id"] = device_id;
  document["enrollment_code"] = enrollment_code;
  document["supported_profiles"].to<JsonArray>().add(DeviceProtocol::portrait_profile);
  document["supported_profiles"].as<JsonArray>().add(DeviceProtocol::landscape_profile);
  JsonObject limits = document["limits"].to<JsonObject>();
  const ProtocolLimits supported{};
  limits["max_pages_per_edition"] = supported.max_pages_per_edition;
  limits["max_pages_response_bytes"] = supported.max_pages_response_bytes;
  limits["max_history_response_bytes"] = supported.max_history_response_bytes;
  limits["max_actions_per_frame"] = supported.max_actions_per_frame;
  limits["max_string_bytes"] = supported.max_string_bytes;
  limits["max_json_depth"] = supported.max_json_depth;
  limits["max_event_body_bytes"] = supported.max_event_body_bytes;
  limits["max_history_items"] = supported.max_history_items;
  limits["request_timeout_ms"] = supported.request_timeout_ms;
  limits["asset_download_timeout_ms"] = supported.asset_download_timeout_ms;
  const std::size_t required = measureJson(document);
  if (required + 1 > capacity) return false;
  written = serializeJson(document, output, capacity);
  return written == required;
}

bool parsePairResponse(const char* input, const std::size_t length,
                       const char* expected_device_id, DeviceBinding& output,
                       DeviceJsonError& error) {
  error = DeviceJsonError::none;
  if (!isProtocolIdentifier(expected_device_id)) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  JsonDocument document;
  if (!parseDocument(input, length, document, error, kMaxObjectBodyBytes, 8)) return false;
  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (!root["protocol_version"].is<std::uint8_t>() ||
      root["protocol_version"].as<std::uint8_t>() != DeviceProtocol::version) {
    error = DeviceJsonError::unsupported_protocol;
    return false;
  }
  DeviceBinding binding{};
  if (!copyText(root["device_id"], binding.device_id) ||
      !copyText(root["binding_id"], binding.binding_id) ||
      !copyText(root["instance_id"], binding.instance_id) ||
      !copyText(root["channel_id"], binding.channel_id) ||
      !copyText(root["epoch"], binding.epoch) ||
      !copyText(root["device_secret"], binding.device_secret) ||
      std::strcmp(binding.device_id.data(), expected_device_id) != 0) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  const JsonArrayConst profiles = root["profiles"].as<JsonArrayConst>();
  bool portrait = false;
  for (const JsonVariantConst profile : profiles) {
    if (profile.is<const char*>() &&
        std::strcmp(profile.as<const char*>(), DeviceProtocol::portrait_profile) == 0) {
      portrait = true;
    }
  }
  if (!portrait) {
    error = DeviceJsonError::unsupported_profile;
    return false;
  }
  if (!parseLimits(root["limits"].as<JsonObjectConst>(), binding.limits) ||
      !binding.valid()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  output = binding;
  return true;
}

bool parseScreenResponse(const char* input, const std::size_t length,
                         const DeviceBinding& binding, ScreenResponse& output,
                         DeviceJsonError& error) {
  error = DeviceJsonError::none;
  if (!binding.valid()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  JsonDocument document;
  if (!parseDocument(input, length, document, error, kMaxObjectBodyBytes, 8)) return false;
  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (!root["protocol_version"].is<std::uint8_t>() ||
      root["protocol_version"].as<std::uint8_t>() != DeviceProtocol::version) {
    error = DeviceJsonError::unsupported_protocol;
    return false;
  }
  if (!scopeMatches(root, binding)) {
    error = DeviceJsonError::scope_mismatch;
    return false;
  }
  std::uint64_t revision = 0;
  if (!readUnsigned(root["revision"], revision)) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  const JsonObjectConst availability = root["availability"].as<JsonObjectConst>();
  if (availability.isNull() || !availability["state"].is<const char*>()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  ScreenResponse response{};
  response.revision = revision;
  if (!root["library"].isNull()) {
    const JsonObjectConst library = root["library"].as<JsonObjectConst>();
    std::uint64_t library_revision = 0;
    std::uint64_t unread_count = 0;
    if (library.isNull() || !readUnsigned(library["revision"], library_revision) ||
        !readUnsigned(library["unread_count"], unread_count) ||
        unread_count > UINT32_MAX) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    response.has_library = true;
    response.library.revision = library_revision;
    response.library.unread_count = static_cast<std::uint32_t>(unread_count);
    if (!library["selected_read_status"].isNull()) {
      const JsonObjectConst selected =
          library["selected_read_status"].as<JsonObjectConst>();
      if (selected.isNull() ||
          !copyText(selected["publication_id"],
                    response.library.selected_publication_id) ||
          !selected["unread"].is<bool>()) {
        error = DeviceJsonError::invalid_schema;
        return false;
      }
      response.library.has_selected_read_status = true;
      response.library.selected_unread = selected["unread"].as<bool>();
    }
  }
  const char* state = availability["state"].as<const char*>();
  if (std::strcmp(state, "empty") == 0) {
    if (!root["offer"].isNull()) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    response.availability = ScreenAvailability::empty;
  } else if (std::strcmp(state, "unsupported_profile") == 0) {
    if (!root["offer"].isNull()) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    response.availability = ScreenAvailability::unsupported_profile;
  } else if (std::strcmp(state, "ready") == 0) {
    const JsonObjectConst offer = root["offer"].as<JsonObjectConst>();
    if (offer.isNull() || !copyText(offer["delivery_id"], response.offer.delivery_id) ||
        !copyText(offer["publication_id"], response.offer.publication_id) ||
        !parseFrame(offer["frame"].as<JsonObjectConst>(), response.offer.frame) ||
        std::strcmp(response.offer.publication_id.data(),
                    response.offer.frame.publication_id.data()) != 0) {
      error = DeviceJsonError::invalid_descriptor;
      return false;
    }
    response.availability = ScreenAvailability::ready;
    response.has_offer = true;
  } else {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  output = response;
  return true;
}

bool parseHistoryResponse(const char* input, const std::size_t length,
                          const DeviceBinding& binding, HistoryResponse& output,
                          DeviceJsonError& error) {
  error = DeviceJsonError::none;
  if (!binding.valid()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  JsonDocument document;
  if (!parseDocument(input, length, document, error,
                     binding.limits.max_history_response_bytes,
                     binding.limits.max_json_depth)) {
    return false;
  }
  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (!root["protocol_version"].is<std::uint8_t>() ||
      root["protocol_version"].as<std::uint8_t>() != DeviceProtocol::version) {
    error = DeviceJsonError::unsupported_protocol;
    return false;
  }
  if (!scopeMatches(root, binding)) {
    error = DeviceJsonError::scope_mismatch;
    return false;
  }
  const JsonArrayConst items = root["items"].as<JsonArrayConst>();
  if (items.isNull() || items.size() > HistoryResponse::item_capacity ||
      items.size() > binding.limits.max_history_items ||
      !root["server_time"].is<const char*>()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }

  output.clear();
  if (!root["library_revision"].isNull() || !root["unread_count"].isNull()) {
    std::uint64_t library_revision = 0;
    std::uint64_t unread_count = 0;
    if (!readUnsigned(root["library_revision"], library_revision) ||
        !readUnsigned(root["unread_count"], unread_count) ||
        unread_count > UINT32_MAX) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    output.has_library = true;
    output.library_revision = library_revision;
    output.unread_count = static_cast<std::uint32_t>(unread_count);
  }
  std::uint64_t previous_seq = UINT64_MAX;
  for (const JsonVariantConst value : items) {
    if (!value.is<JsonObjectConst>()) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    const JsonObjectConst item_object = value.as<JsonObjectConst>();
    HistoryItem& item = output.items[output.item_count];
    std::uint64_t acceptance_seq = 0;
    std::uint64_t page_count = 0;
    const bool dates_ok = item_object["accepted_at"].is<const char*>() &&
                          item_object["committed_at"].is<const char*>() &&
                          (item_object["expires_at"].isNull() ||
                           item_object["expires_at"].is<const char*>()) &&
                          (item_object["withdrawn_at"].isNull() ||
                           item_object["withdrawn_at"].is<const char*>());
    if (!copyText(item_object["publication_id"], item.publication_id) ||
        !copyText(item_object["delivery_id"], item.delivery_id) ||
        !copyText(item_object["edition_id"], item.edition_id) ||
        !copyText(item_object["profile"], item.profile) ||
        !copyOptionalText(item_object["label"], item.label) ||
        !copyOptionalText(item_object["summary"], item.summary) ||
        !copyOptionalText(item_object["genre"], item.genre) ||
        !copyOptionalText(item_object["display_date"], item.display_date) ||
        !readUnsigned(item_object["acceptance_seq"], acceptance_seq) ||
        !readUnsigned(item_object["page_count"], page_count) ||
        page_count > UINT16_MAX || !item_object["presentable"].is<bool>() ||
        !dates_ok) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    item.acceptance_seq = acceptance_seq;
    item.page_count = static_cast<std::uint16_t>(page_count);
    item.unread = item_object["unread"].is<bool>()
                      ? item_object["unread"].as<bool>()
                      : false;
    item.presentable = item_object["presentable"].as<bool>();
    if (!item.valid() || item.acceptance_seq >= previous_seq) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    previous_seq = item.acceptance_seq;
    ++output.item_count;
  }
  if (root["next_cursor"].isNull()) {
    output.has_next_cursor = false;
  } else if (copyText(root["next_cursor"], output.next_cursor) &&
             isProtocolCursor(output.next_cursor.data())) {
    output.has_next_cursor = true;
  } else {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  return true;
}

bool parsePagesResponse(const char* input, const std::size_t length,
                        const DeviceBinding& binding, PagesResponse& output,
                        DeviceJsonError& error) {
  error = DeviceJsonError::none;
  if (!binding.valid()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  JsonDocument document;
  if (!parseDocument(input, length, document, error,
                     binding.limits.max_pages_response_bytes,
                     binding.limits.max_json_depth)) {
    return false;
  }
  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (!root["protocol_version"].is<std::uint8_t>() ||
      root["protocol_version"].as<std::uint8_t>() != DeviceProtocol::version) {
    error = DeviceJsonError::unsupported_protocol;
    return false;
  }
  if (!scopeMatches(root, binding)) {
    error = DeviceJsonError::scope_mismatch;
    return false;
  }
  output.clear();
  std::uint64_t page_count = 0;
  const JsonArrayConst frames = root["frames"].as<JsonArrayConst>();
  if (!copyText(root["publication_id"], output.publication_id) ||
      !copyText(root["edition_id"], output.edition_id) ||
      !copyText(root["profile"], output.profile) ||
      !readUnsigned(root["page_count"], page_count) || page_count > UINT16_MAX ||
      frames.isNull() || frames.size() != page_count ||
      frames.size() > DeviceProtocol::max_pages_per_edition ||
      frames.size() > binding.limits.max_pages_per_edition) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  output.page_count = static_cast<std::uint16_t>(page_count);
  for (const JsonVariantConst value : frames) {
    if (!value.is<JsonObjectConst>() ||
        !parseFrame(value.as<JsonObjectConst>(), output.frames[output.frame_count])) {
      error = DeviceJsonError::invalid_descriptor;
      return false;
    }
    ++output.frame_count;
  }
  if (!output.valid()) {
    error = DeviceJsonError::invalid_descriptor;
    return false;
  }
  return true;
}

bool writeEventRequest(char* output, const std::size_t capacity, std::size_t& written,
                       const DeviceBinding& binding, const DeviceEvent& event,
                       const DevicePowerReport* power,
                       DeviceJsonError& error) {
  written = 0;
  error = DeviceJsonError::none;
  if (output == nullptr || capacity == 0 || !binding.valid() || !event.valid()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  const char* kind = nullptr;
  switch (event.kind) {
    case DeviceEventKind::cached: kind = "cached"; break;
    case DeviceEventKind::presented: kind = "presented"; break;
    case DeviceEventKind::acknowledged: kind = "acknowledged"; break;
    case DeviceEventKind::status: kind = "status"; break;
    case DeviceEventKind::interaction: kind = "interaction"; break;
  }
  if (kind == nullptr) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }

  JsonDocument document;
  document["protocol_version"] = DeviceProtocol::version;
  document["instance_id"] = binding.instance_id.data();
  document["channel_id"] = binding.channel_id.data();
  document["epoch"] = binding.epoch.data();
  document["binding_id"] = binding.binding_id.data();
  document["device_id"] = binding.device_id.data();
  document["event_id"] = event.event_id.data();
  document["seq"] = event.seq;
  document["kind"] = kind;
  document["observed_at"] = nullptr;
  if (event.has_subject) {
    JsonObject subject = document["subject"].to<JsonObject>();
    subject["publication_id"] = event.subject.publication_id.data();
    subject["page_id"] = event.subject.page_id.data();
    subject["frame_id"] = event.subject.frame_id.data();
    if (event.has_delivery_id) {
      subject["delivery_id"] = event.delivery_id.data();
    } else {
      subject["delivery_id"] = nullptr;
    }
  } else {
    document["subject"] = nullptr;
  }
  if (event.has_action) document["action_id"] = remoteActionName(event.action);
  JsonObject state = document["state"].to<JsonObject>();
  state["active_app"] = event.active_app.data();
  state["mode"] = event.history_mode ? "history" : "follow_latest";
  state["pending_count"] = event.pending_count;
  if (event.has_presented_frame) {
    JsonObject presented = state["presented_frame"].to<JsonObject>();
    presented["publication_id"] = event.presented_frame.publication_id.data();
    presented["page_id"] = event.presented_frame.page_id.data();
    presented["frame_id"] = event.presented_frame.frame_id.data();
  } else {
    state["presented_frame"] = nullptr;
  }
  if (power != nullptr) {
    if (!power->valid()) {
      error = DeviceJsonError::invalid_schema;
      return false;
    }
    JsonObject power_state = state["power"].to<JsonObject>();
    switch (power->source) {
      case DevicePowerSource::external: power_state["source"] = "external"; break;
      case DevicePowerSource::battery: power_state["source"] = "battery"; break;
      case DevicePowerSource::unknown: power_state["source"] = "unknown"; break;
    }
    if (power->has_battery) {
      power_state["battery_percent"] = power->battery_percent;
      power_state["battery_mv"] = power->battery_millivolts;
    } else {
      power_state["battery_percent"] = nullptr;
      power_state["battery_mv"] = nullptr;
    }
    switch (power->mode) {
      case DevicePowerMode::external_online: power_state["mode"] = "external_online"; break;
      case DevicePowerMode::active: power_state["mode"] = "active"; break;
      case DevicePowerMode::battery_idle: power_state["mode"] = "battery_idle"; break;
      case DevicePowerMode::retry_backoff: power_state["mode"] = "retry_backoff"; break;
      case DevicePowerMode::low_battery: power_state["mode"] = "low_battery"; break;
    }
    // The device has no trusted wall clock. The Console uses the server's
    // receipt time, so scheduling fields remain explicitly unknown.
    power_state["next_sync_in_seconds"] = nullptr;
    power_state["next_sync_at"] = nullptr;
    if (power->has_gauge_details) {
      power_state["current_ma"] = power->current_ma;
      power_state["average_current_ma"] = power->average_current_ma;
      power_state["remaining_mah"] = power->remaining_mah;
      power_state["full_mah"] = power->full_mah;
    }
    power_state["light_sleep_seconds"] = power->light_sleep_seconds;
    power_state["uptime_seconds"] = power->uptime_seconds;
  }

  const std::size_t required = measureJson(document);
  if (required + 1 > capacity || required > binding.limits.max_event_body_bytes) {
    error = DeviceJsonError::output_too_small;
    return false;
  }
  written = serializeJson(document, output, capacity);
  return written == required;
}

bool parseEventResponse(const char* input, const std::size_t length,
                        const char* expected_event_id, DeviceJsonError& error) {
  error = DeviceJsonError::none;
  if (!isProtocolIdentifier(expected_event_id)) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  JsonDocument document;
  if (!parseDocument(input, length, document, error, kMaxObjectBodyBytes, 8)) return false;
  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (!root["protocol_version"].is<std::uint8_t>() ||
      root["protocol_version"].as<std::uint8_t>() != DeviceProtocol::version) {
    error = DeviceJsonError::unsupported_protocol;
    return false;
  }
  if (!root["event_id"].is<const char*>() ||
      std::strcmp(root["event_id"].as<const char*>(), expected_event_id) != 0 ||
      !root["status"].is<const char*>()) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  const char* status = root["status"].as<const char*>();
  if (std::strcmp(status, "accepted") != 0 && std::strcmp(status, "duplicate") != 0) {
    error = DeviceJsonError::invalid_schema;
    return false;
  }
  return true;
}

bool deviceJsonSelfTest() {
  constexpr char request_id[] = "pair_request_01";
  constexpr char device_id[] = "mooneink_t5_01";
  constexpr char code[] = "0123456789abcdef0123456789abcdef";
  char output[1024]{};
  std::size_t written = 0;
  if (!writePairRequest(output, sizeof(output), written, request_id, device_id, code) ||
      written == 0 || std::strstr(output, DeviceProtocol::portrait_profile) == nullptr) {
    return false;
  }

  DeviceBinding binding{};
  std::strcpy(binding.device_id.data(), device_id);
  std::strcpy(binding.binding_id.data(), "binding_01");
  std::strcpy(binding.instance_id.data(), "instance_01");
  std::strcpy(binding.channel_id.data(), "channel_01");
  std::strcpy(binding.epoch.data(), "epoch_01");
  std::strcpy(binding.device_secret.data(), code);
  DeviceEvent event{};
  std::strcpy(event.event_id.data(), "event_01");
  event.seq = 1;
  event.kind = DeviceEventKind::status;
  std::strcpy(event.active_app.data(), "settings");
  DeviceJsonError error = DeviceJsonError::none;
  DevicePowerReport power{};
  power.source = DevicePowerSource::battery;
  power.mode = DevicePowerMode::battery_idle;
  power.has_battery = true;
  power.battery_percent = 73;
  power.battery_millivolts = 3910;
  return writeEventRequest(output, sizeof(output), written, binding, event, &power, error) &&
         written > 0 && std::strstr(output, "\"kind\":\"status\"") != nullptr &&
         std::strstr(output, "\"battery_percent\":73") != nullptr;
}

}  // namespace mooneink
