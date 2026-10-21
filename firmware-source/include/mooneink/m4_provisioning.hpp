// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/device_protocol.hpp"

namespace mooneink {

struct M4ProvisioningConfig final {
  std::array<char, 33> wifi_ssid{};
  std::array<char, 65> wifi_password{};
  std::array<char, 256> endpoint{};
  std::array<char, DeviceProtocol::identifier_capacity> enrollment_code{};
  std::array<char, DeviceProtocol::identifier_capacity> device_id{};
  std::uint64_t unix_time = 0;

  bool valid() const;
  void clearSecrets();
};

enum class M4SerialCommandKind : std::uint8_t {
  none,
  provision,
  show_settings,
  show_ephemera,
  m5_action,
  m5_touch,
  factory_reset,
};

struct M4SerialCommand final {
  M4SerialCommandKind kind = M4SerialCommandKind::none;
  M4ProvisioningConfig provisioning{};
  RemoteActionKind action = RemoteActionKind::previous_page;
  Point touch{};
};

class M4SerialReceiver final {
 public:
  static constexpr std::size_t max_line_bytes = 767;

  bool feed(char byte, M4SerialCommand& output, bool& rejected);
  void reset();

 private:
  bool parse(M4SerialCommand& output);

  std::array<char, max_line_bytes + 1> line_{};
  std::size_t length_ = 0;
  bool overflow_ = false;
};

bool m4ProvisioningSelfTest();

}  // namespace mooneink

