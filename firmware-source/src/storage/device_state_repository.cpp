// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/device_state_repository.hpp"

#include <cstring>

namespace mooneink {
namespace {

constexpr std::uint32_t record_magic = 0x4d445354U;  // MDST
constexpr std::uint16_t record_schema = 2;
constexpr std::uint32_t storage_key = 0x44535431U;

struct DeviceStateRecord final {
  std::uint32_t magic = record_magic;
  std::uint16_t schema = record_schema;
  std::uint16_t reserved = 0;
  DeviceRecoveryState state{};
};

template <std::size_t Size>
bool terminatedLength(const std::array<char, Size>& value, std::size_t& length) {
  const void* end = std::memchr(value.data(), '\0', value.size());
  if (end == nullptr) return false;
  length = static_cast<const char*>(end) - value.data();
  return true;
}

bool validEndpoint(const std::array<char, 256>& value) {
  std::size_t length = 0;
  if (!terminatedLength(value, length) || length < 9) return false;
  const char* text = value.data();
  const bool https = std::strncmp(text, "https://", 8) == 0;
  const bool http = std::strncmp(text, "http://", 7) == 0;
  if (!https && !http) return false;
  const char* authority = text + (https ? 8 : 7);
  if (*authority == '\0' || std::strchr(authority, '/') != nullptr ||
      std::strchr(authority, '\\') != nullptr || std::strchr(authority, '@') != nullptr ||
      std::strchr(authority, '?') != nullptr || std::strchr(authority, '#') != nullptr) {
    return false;
  }
  for (const char* cursor = authority; *cursor != '\0'; ++cursor) {
    if (static_cast<unsigned char>(*cursor) <= 0x20U) return false;
  }
  return true;
}

bool validCandidate(const ProvisioningCandidate& candidate, const bool require_enrollment) {
  std::size_t ssid_length = 0;
  std::size_t password_length = 0;
  std::size_t endpoint_length = 0;
  if (!terminatedLength(candidate.wifi_ssid, ssid_length) || ssid_length == 0 ||
      !terminatedLength(candidate.wifi_password, password_length) || password_length > 63 ||
      !terminatedLength(candidate.endpoint, endpoint_length) || endpoint_length <= 8 ||
      !validEndpoint(candidate.endpoint) ||
      !isProtocolIdentifier(candidate.device_id.data()) ||
      !isProtocolIdentifier(candidate.pairing_request_id.data())) {
    return false;
  }
  return require_enrollment ? isProtocolCursor(candidate.enrollment_code.data())
                            : candidate.enrollment_code[0] == '\0';
}

bool validState(const DeviceRecoveryState& state) {
  if (state.generation == 0) return false;
  switch (state.phase) {
    case ProvisioningPhase::empty:
      return true;
    case ProvisioningPhase::network_staged:
      return validCandidate(state.candidate, true) && !state.binding.valid();
    case ProvisioningPhase::active_binding:
      return validCandidate(state.candidate, false) && state.binding.valid() &&
             std::strcmp(state.candidate.device_id.data(), state.binding.device_id.data()) == 0 &&
             state.candidate.enrollment_code[0] == '\0';
  }
  return false;
}

}  // namespace

bool ProvisioningCandidate::valid() const {
  return validCandidate(*this, true);
}

void ProvisioningCandidate::clearSecrets() {
  wifi_password.fill('\0');
  enrollment_code.fill('\0');
}

bool DeviceStateRepository::begin(PersistentStore& store) {
  DeviceStateRecord record{};
  std::size_t actual_size = 0;
  const PersistentReadResult result = store.readLatest(
      PersistentArea::system_config, storage_key,
      reinterpret_cast<std::uint8_t*>(&record), sizeof(record), actual_size);
  if (result == PersistentReadResult::failure) return false;
  if (result == PersistentReadResult::not_found) {
    store_ = &store;
    state_ = DeviceRecoveryState{};
    return true;
  }
  if (actual_size != sizeof(record) || record.magic != record_magic ||
      record.schema != record_schema || record.reserved != 0 || !validState(record.state)) {
    return false;
  }
  store_ = &store;
  state_ = record.state;
  return true;
}

bool DeviceStateRepository::persist(const DeviceRecoveryState& state) {
  if (store_ == nullptr || !validState(state)) return false;
  DeviceStateRecord record{};
  record.state = state;
  return store_->writeAtomic(PersistentArea::system_config, storage_key,
                             reinterpret_cast<const std::uint8_t*>(&record), sizeof(record));
}

bool DeviceStateRepository::stageNetwork(const ProvisioningCandidate& candidate) {
  if (store_ == nullptr || !candidate.valid() || state_.generation == UINT64_MAX) return false;
  DeviceRecoveryState next{};
  next.phase = ProvisioningPhase::network_staged;
  next.generation = state_.generation + 1;
  next.candidate = candidate;
  if (!persist(next)) return false;
  state_ = next;
  return true;
}

bool DeviceStateRepository::commitBinding(const DeviceBinding& binding) {
  if (store_ == nullptr || state_.phase != ProvisioningPhase::network_staged ||
      !binding.valid() ||
      std::strcmp(state_.candidate.device_id.data(), binding.device_id.data()) != 0 ||
      state_.generation == UINT64_MAX) {
    return false;
  }
  DeviceRecoveryState next = state_;
  next.phase = ProvisioningPhase::active_binding;
  ++next.generation;
  next.binding = binding;
  next.candidate.enrollment_code.fill('\0');
  if (!persist(next)) return false;
  state_ = next;
  return true;
}

bool DeviceStateRepository::retireBinding() {
  if (store_ == nullptr || state_.generation == UINT64_MAX) return false;
  DeviceRecoveryState next{};
  next.phase = ProvisioningPhase::empty;
  next.generation = state_.generation + 1;
  if (!persist(next)) return false;
  state_.candidate.clearSecrets();
  state_ = next;
  return true;
}

}  // namespace mooneink
