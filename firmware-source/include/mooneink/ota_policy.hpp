// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace mooneink {

enum class OtaSlot : std::uint8_t { slot_a = 0, slot_b = 1 };
enum class OtaPhase : std::uint8_t {
  idle,
  staged,
  trial_boot,
  rollback_pending,
  recovery_required,
};

enum class OtaPolicyCode : std::uint8_t {
  ok,
  busy,
  invalid_manifest,
  untrusted_signature,
  image_not_verified,
  wrong_board,
  wrong_board_revision,
  wrong_partition_layout,
  image_too_large,
  active_slot_targeted,
  journal_incompatible,
  config_rollback_unsafe,
  invalid_state,
  local_health_failed,
};

struct OtaImageManifest final {
  static constexpr std::size_t text_capacity = 33;

  std::array<char, text_capacity> board_profile{};
  std::uint32_t board_revision = 0;
  std::uint32_t partition_layout_version = 0;
  std::array<char, text_capacity> firmware_version{};
  std::size_t image_bytes = 0;
  std::array<std::uint8_t, 32> image_sha256{};
  std::uint16_t journal_schema_min = 0;
  std::uint16_t journal_schema_max = 0;
  std::uint16_t config_schema_written = 0;
};

struct OtaPlatformContract final {
  const char* board_profile = nullptr;
  std::uint32_t board_revision = 0;
  std::uint32_t partition_layout_version = 0;
  std::size_t slot_bytes = 0;
  std::uint16_t current_journal_schema = 0;
  // The currently confirmed firmware must still be able to read the config
  // format after a trial rolls back. A candidate writing beyond this bound is
  // refused until a shadow-copy migration design is supplied.
  std::uint16_t confirmed_config_read_max = 0;
};

struct OtaTrialHealth final {
  bool display_ready = false;
  bool input_ready = false;
  bool storage_ready = false;
  bool config_readable = false;
  bool journal_continuity_ready = false;
  bool service_reachable = false;  // Diagnostic only; never a confirmation gate.
};

struct OtaCoordinatorState final {
  static constexpr std::uint16_t schema_version = 1;

  std::uint16_t schema = schema_version;
  OtaPhase phase = OtaPhase::idle;
  OtaSlot confirmed_slot = OtaSlot::slot_a;
  OtaSlot boot_slot = OtaSlot::slot_a;
  OtaSlot candidate_slot = OtaSlot::slot_b;
  std::uint8_t trial_attempts = 0;
  std::array<char, OtaImageManifest::text_capacity> candidate_version{};
  std::array<std::uint8_t, 32> candidate_sha256{};
  // Monotonic protocol facts are deliberately outside config rollback. The
  // coordinator carries the observed watermark through every phase unchanged.
  std::uint64_t continuity_watermark = 0;

  bool valid() const;
};

class OtaCoordinator final {
 public:
  explicit OtaCoordinator(OtaCoordinatorState initial = {}) : state_(initial) {}

  OtaPolicyCode stage(const OtaImageManifest& image,
                      const OtaPlatformContract& platform,
                      OtaSlot target, bool signature_trusted,
                      bool image_verified);
  OtaPolicyCode beginTrialBoot();
  OtaPolicyCode assessTrial(const OtaTrialHealth& health);
  OtaPolicyCode recordUnconfirmedReset();
  OtaPolicyCode finishRollback();
  void observeContinuityWatermark(std::uint64_t watermark);

  bool deepSleepAllowed() const { return state_.phase == OtaPhase::idle; }
  const OtaCoordinatorState& state() const { return state_; }

 private:
  void clearCandidate();

  OtaCoordinatorState state_{};
};

}  // namespace mooneink
