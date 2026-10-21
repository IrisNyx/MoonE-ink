// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/m4_provisioning.hpp"

#include <ArduinoJson.h>

#include <cstring>

namespace mooneink {
namespace {

template <std::size_t Size>
bool copyJsonText(const JsonVariantConst value, std::array<char, Size>& output,
                  const bool allow_empty = false) {
  if (!value.is<const char*>()) return false;
  const char* text = value.as<const char*>();
  if (text == nullptr) return false;
  const std::size_t length = std::strlen(text);
  if ((!allow_empty && length == 0) || length >= output.size()) return false;
  output.fill('\0');
  std::memcpy(output.data(), text, length);
  return true;
}

bool terminated(const char* value, const std::size_t capacity, std::size_t& length) {
  const void* end = std::memchr(value, '\0', capacity);
  if (end == nullptr) return false;
  length = static_cast<const char*>(end) - value;
  return true;
}

}  // namespace

bool M4ProvisioningConfig::valid() const {
  std::size_t ssid_length = 0;
  std::size_t password_length = 0;
  std::size_t endpoint_length = 0;
  return terminated(wifi_ssid.data(), wifi_ssid.size(), ssid_length) && ssid_length > 0 &&
         terminated(wifi_password.data(), wifi_password.size(), password_length) &&
         password_length <= 63 &&
         terminated(endpoint.data(), endpoint.size(), endpoint_length) && endpoint_length > 0 &&
         isProtocolCursor(enrollment_code.data()) && isProtocolIdentifier(device_id.data()) &&
         unix_time >= 1704067200ULL && unix_time <= 4102444800ULL;
}

void M4ProvisioningConfig::clearSecrets() {
  wifi_password.fill('\0');
  enrollment_code.fill('\0');
}

void M4SerialReceiver::reset() {
  line_.fill('\0');
  length_ = 0;
  overflow_ = false;
}

bool M4SerialReceiver::parse(M4SerialCommand& output) {
  JsonDocument document;
  const DeserializationError parsed =
      deserializeJson(document, line_.data(), length_, DeserializationOption::NestingLimit(3));
  if (parsed || !document.is<JsonObjectConst>()) return false;
  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (!root["type"].is<const char*>()) return false;
  const char* type = root["type"].as<const char*>();
  if (std::strcmp(type, "m4_factory_reset") == 0) {
    if (root.size() != 1) return false;
    output.kind = M4SerialCommandKind::factory_reset;
    return true;
  }
  if (std::strcmp(type, "m4_show") == 0) {
    if (root.size() != 2 || !root["app"].is<const char*>()) return false;
    const char* app = root["app"].as<const char*>();
    if (std::strcmp(app, "settings") == 0) {
      output.kind = M4SerialCommandKind::show_settings;
      return true;
    }
    if (std::strcmp(app, "ephemera") == 0) {
      output.kind = M4SerialCommandKind::show_ephemera;
      return true;
    }
    return false;
  }
  if (std::strcmp(type, "m5_action") == 0) {
    if (root.size() != 2 || !root["action"].is<const char*>()) return false;
    RemoteActionKind action = RemoteActionKind::previous_page;
    if (!parseRemoteActionKind(root["action"].as<const char*>(), action)) return false;
    output.kind = M4SerialCommandKind::m5_action;
    output.action = action;
    return true;
  }
  if (std::strcmp(type, "m5_touch") == 0) {
    if (root.size() != 3 || !root["x"].is<std::int16_t>() ||
        !root["y"].is<std::int16_t>()) {
      return false;
    }
    const Point touch{root["x"].as<std::int16_t>(), root["y"].as<std::int16_t>()};
    if (touch.x < 0 || touch.x >= BoardProfile::portrait_width ||
        touch.y < 0 || touch.y >= BoardProfile::portrait_height) {
      return false;
    }
    output.kind = M4SerialCommandKind::m5_touch;
    output.touch = touch;
    return true;
  }
  if (std::strcmp(type, "m4_provision") != 0 || root.size() != 7 ||
      !root["unix_time"].is<std::uint64_t>()) return false;
  M4ProvisioningConfig config{};
  if (!copyJsonText(root["wifi_ssid"], config.wifi_ssid) ||
      !copyJsonText(root["wifi_password"], config.wifi_password, true) ||
      !copyJsonText(root["endpoint"], config.endpoint) ||
      !copyJsonText(root["enrollment_code"], config.enrollment_code) ||
      !copyJsonText(root["device_id"], config.device_id)) {
    config.clearSecrets();
    return false;
  }
  config.unix_time = root["unix_time"].as<std::uint64_t>();
  if (!config.valid()) {
    config.clearSecrets();
    return false;
  }
  output.kind = M4SerialCommandKind::provision;
  output.provisioning = config;
  config.clearSecrets();
  return true;
}

bool M4SerialReceiver::feed(const char byte, M4SerialCommand& output, bool& rejected) {
  rejected = false;
  if (byte == '\r') return false;
  if (byte != '\n') {
    if (length_ < max_line_bytes) {
      line_[length_++] = byte;
      line_[length_] = '\0';
    } else {
      overflow_ = true;
    }
    return false;
  }
  if (length_ == 0 && !overflow_) {
    reset();
    return false;
  }
  const bool accepted = !overflow_ && parse(output);
  rejected = !accepted;
  reset();
  return accepted;
}

bool m4ProvisioningSelfTest() {
  constexpr char line[] =
      "{\"type\":\"m4_provision\",\"wifi_ssid\":\"test\","
      "\"wifi_password\":\"secret\",\"endpoint\":\"http://192.0.2.1:8765\","
      "\"enrollment_code\":\"0123456789abcdef0123456789abcdef\","
      "\"device_id\":\"mooneink_test_01\",\"unix_time\":1791676800}\n";
  M4SerialReceiver receiver;
  M4SerialCommand command{};
  bool rejected = false;
  bool accepted = false;
  for (const char byte : line) {
    if (byte == '\0') break;
    if (receiver.feed(byte, command, rejected)) accepted = true;
  }
  if (!accepted || rejected || command.kind != M4SerialCommandKind::provision ||
      !command.provisioning.valid()) {
    command.provisioning.clearSecrets();
    return false;
  }
  command.provisioning.clearSecrets();
  constexpr char show[] = "{\"type\":\"m4_show\",\"app\":\"settings\"}\n";
  accepted = false;
  rejected = false;
  for (const char byte : show) {
    if (byte == '\0') break;
    if (receiver.feed(byte, command, rejected)) accepted = true;
  }
  if (!accepted || rejected || command.kind != M4SerialCommandKind::show_settings) {
    return false;
  }
  constexpr char action[] = "{\"type\":\"m5_action\",\"action\":\"next_page\"}\n";
  accepted = false;
  rejected = false;
  for (const char byte : action) {
    if (byte == '\0') break;
    if (receiver.feed(byte, command, rejected)) accepted = true;
  }
  if (!accepted || rejected || command.kind != M4SerialCommandKind::m5_action ||
      command.action != RemoteActionKind::next_page) {
    return false;
  }
  constexpr char touch[] = "{\"type\":\"m5_touch\",\"x\":147,\"y\":468}\n";
  accepted = false;
  rejected = false;
  for (const char byte : touch) {
    if (byte == '\0') break;
    if (receiver.feed(byte, command, rejected)) accepted = true;
  }
  return accepted && !rejected && command.kind == M4SerialCommandKind::m5_touch &&
         command.touch.x == 147 && command.touch.y == 468;
}

}  // namespace mooneink

