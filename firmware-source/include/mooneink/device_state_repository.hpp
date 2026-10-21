// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/device_json.hpp"
#include "mooneink/persistent_storage.hpp"

namespace mooneink {

enum class ProvisioningPhase : std::uint8_t {
  empty,
  network_staged,
  active_binding,
};

// The browser USB setup writes this record before changing networks. HTTPS
// uses the firmware's system CA bundle; plain HTTP is accepted only for a
// private/local endpoint by DeviceEndpoint.
struct ProvisioningCandidate final {
  std::array<char, 33> wifi_ssid{};
  std::array<char, 65> wifi_password{};
  std::array<char, 256> endpoint{};
  std::array<char, DeviceProtocol::identifier_capacity> enrollment_code{};
  std::array<char, DeviceProtocol::identifier_capacity> device_id{};
  std::array<char, DeviceProtocol::identifier_capacity> pairing_request_id{};

  bool valid() const;
  void clearSecrets();
};

struct DeviceRecoveryState final {
  ProvisioningPhase phase = ProvisioningPhase::empty;
  std::uint64_t generation = 0;
  ProvisioningCandidate candidate{};
  DeviceBinding binding{};
};

class DeviceStateRepository final {
 public:
  bool begin(PersistentStore& store);
  bool stageNetwork(const ProvisioningCandidate& candidate);
  bool commitBinding(const DeviceBinding& binding);
  bool retireBinding();

  const DeviceRecoveryState& state() const { return state_; }
  const DeviceBinding* activeBinding() const {
    return state_.phase == ProvisioningPhase::active_binding ? &state_.binding : nullptr;
  }

 private:
  bool persist(const DeviceRecoveryState& state);

  PersistentStore* store_ = nullptr;
  DeviceRecoveryState state_{};
};

}  // namespace mooneink
