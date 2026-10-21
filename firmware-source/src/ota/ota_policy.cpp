// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/ota_policy.hpp"

#include <cstring>

namespace mooneink {
namespace {

template <std::size_t Size>
bool terminatedNonEmpty(const std::array<char, Size>& value) {
  return value[0] != '\0' && std::memchr(value.data(), '\0', value.size()) != nullptr;
}

bool nonzeroDigest(const std::array<std::uint8_t, 32>& digest) {
  for (const std::uint8_t byte : digest) {
    if (byte != 0) return true;
  }
  return false;
}

bool localHealthPassed(const OtaTrialHealth& health) {
  return health.display_ready && health.input_ready && health.storage_ready &&
         health.config_readable && health.journal_continuity_ready;
}

}  // namespace

bool OtaCoordinatorState::valid() const {
  if (schema != schema_version) return false;
  if (phase == OtaPhase::idle) {
    return boot_slot == confirmed_slot && trial_attempts == 0;
  }
  if (phase == OtaPhase::staged) {
    return candidate_slot != confirmed_slot && boot_slot == confirmed_slot &&
           trial_attempts == 0 && terminatedNonEmpty(candidate_version) &&
           nonzeroDigest(candidate_sha256);
  }
  if (phase == OtaPhase::trial_boot) {
    return candidate_slot != confirmed_slot && boot_slot == candidate_slot &&
           trial_attempts == 1 && terminatedNonEmpty(candidate_version) &&
           nonzeroDigest(candidate_sha256);
  }
  if (phase == OtaPhase::rollback_pending) {
    return boot_slot == confirmed_slot && trial_attempts == 1 &&
           terminatedNonEmpty(candidate_version) && nonzeroDigest(candidate_sha256);
  }
  return phase == OtaPhase::recovery_required;
}

OtaPolicyCode OtaCoordinator::stage(const OtaImageManifest& image,
                                    const OtaPlatformContract& platform,
                                    const OtaSlot target,
                                    const bool signature_trusted,
                                    const bool image_verified) {
  if (!state_.valid() || platform.board_profile == nullptr) {
    return OtaPolicyCode::invalid_state;
  }
  if (state_.phase != OtaPhase::idle) return OtaPolicyCode::busy;
  if (!terminatedNonEmpty(image.board_profile) ||
      !terminatedNonEmpty(image.firmware_version) || image.image_bytes == 0 ||
      !nonzeroDigest(image.image_sha256) || image.journal_schema_min == 0 ||
      image.journal_schema_max < image.journal_schema_min ||
      image.config_schema_written == 0) {
    return OtaPolicyCode::invalid_manifest;
  }
  if (!signature_trusted) return OtaPolicyCode::untrusted_signature;
  if (!image_verified) return OtaPolicyCode::image_not_verified;
  if (std::strcmp(image.board_profile.data(), platform.board_profile) != 0) {
    return OtaPolicyCode::wrong_board;
  }
  if (image.board_revision != platform.board_revision) {
    return OtaPolicyCode::wrong_board_revision;
  }
  if (image.partition_layout_version != platform.partition_layout_version) {
    return OtaPolicyCode::wrong_partition_layout;
  }
  if (platform.slot_bytes == 0 || image.image_bytes > platform.slot_bytes) {
    return OtaPolicyCode::image_too_large;
  }
  if (target == state_.confirmed_slot) return OtaPolicyCode::active_slot_targeted;
  if (platform.current_journal_schema < image.journal_schema_min ||
      platform.current_journal_schema > image.journal_schema_max) {
    return OtaPolicyCode::journal_incompatible;
  }
  if (image.config_schema_written > platform.confirmed_config_read_max) {
    return OtaPolicyCode::config_rollback_unsafe;
  }

  state_.phase = OtaPhase::staged;
  state_.candidate_slot = target;
  state_.candidate_version = image.firmware_version;
  state_.candidate_sha256 = image.image_sha256;
  state_.trial_attempts = 0;
  return OtaPolicyCode::ok;
}

OtaPolicyCode OtaCoordinator::beginTrialBoot() {
  if (!state_.valid() || state_.phase != OtaPhase::staged) {
    return OtaPolicyCode::invalid_state;
  }
  state_.phase = OtaPhase::trial_boot;
  state_.boot_slot = state_.candidate_slot;
  state_.trial_attempts = 1;
  return OtaPolicyCode::ok;
}

OtaPolicyCode OtaCoordinator::assessTrial(const OtaTrialHealth& health) {
  if (!state_.valid() || state_.phase != OtaPhase::trial_boot) {
    return OtaPolicyCode::invalid_state;
  }
  if (!localHealthPassed(health)) {
    state_.phase = OtaPhase::rollback_pending;
    state_.boot_slot = state_.confirmed_slot;
    return OtaPolicyCode::local_health_failed;
  }
  state_.confirmed_slot = state_.candidate_slot;
  state_.boot_slot = state_.confirmed_slot;
  clearCandidate();
  state_.phase = OtaPhase::idle;
  state_.trial_attempts = 0;
  return OtaPolicyCode::ok;
}

OtaPolicyCode OtaCoordinator::recordUnconfirmedReset() {
  if (!state_.valid() || state_.phase != OtaPhase::trial_boot) {
    return OtaPolicyCode::invalid_state;
  }
  state_.phase = OtaPhase::rollback_pending;
  state_.boot_slot = state_.confirmed_slot;
  return OtaPolicyCode::ok;
}

OtaPolicyCode OtaCoordinator::finishRollback() {
  if (!state_.valid() || state_.phase != OtaPhase::rollback_pending) {
    return OtaPolicyCode::invalid_state;
  }
  state_.boot_slot = state_.confirmed_slot;
  clearCandidate();
  state_.phase = OtaPhase::idle;
  state_.trial_attempts = 0;
  return OtaPolicyCode::ok;
}

void OtaCoordinator::observeContinuityWatermark(const std::uint64_t watermark) {
  if (watermark > state_.continuity_watermark) {
    state_.continuity_watermark = watermark;
  }
}

void OtaCoordinator::clearCandidate() {
  state_.candidate_version.fill('\0');
  state_.candidate_sha256.fill(0);
  state_.candidate_slot = state_.confirmed_slot == OtaSlot::slot_a
                              ? OtaSlot::slot_b
                              : OtaSlot::slot_a;
}

}  // namespace mooneink
