// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>
#include <cstdint>

namespace mooneink {

enum class PersistentArea : std::uint8_t {
  system_config,
  app_state,
  frame_last_good,
  frame_staging,
  event_journal,
  reader_progress,
  reader_index,
  app_registry,
  count,
};

enum class PersistentReadResult : std::uint8_t {
  found,
  not_found,
  failure,
};

// Storage implementations must make a record visible only after its payload,
// schema, monotonic generation and checksum have all been committed. Journal
// append is separate because binding/event sequence continuity must never be
// rolled back with ordinary configuration.
class PersistentStore {
 public:
  virtual ~PersistentStore() = default;
  virtual PersistentReadResult readLatest(PersistentArea area, std::uint32_t key,
                                          std::uint8_t* output, std::size_t capacity,
                                          std::size_t& actual_size) = 0;
  virtual bool writeAtomic(PersistentArea area, std::uint32_t key,
                           const std::uint8_t* data, std::size_t size) = 0;
  // A successful append is durable and becomes the latest event_journal
  // record returned by readLatest. A false result guarantees that the record
  // was not committed, so callers never reuse an ambiguously reserved seq.
  virtual bool appendJournal(const std::uint8_t* data, std::size_t size) = 0;
  virtual bool sync() = 0;
};

// Review budget for the future partition migration. These constants document
// limits and support host checks; the factory-preserve CSV remains unchanged.
struct M7StorageBudget final {
  static constexpr std::size_t kib = 1024U;
  static constexpr std::size_t flash_bytes = 16U * 1024U * kib;
  static constexpr std::size_t boot_and_tables_bytes = 64U * kib;
  static constexpr std::size_t ota_slot_bytes = 4U * 1024U * kib;
  static constexpr std::size_t ota_slots_bytes = 2U * ota_slot_bytes;
  static constexpr std::size_t system_font_bytes = 4U * 1024U * kib;
  static constexpr std::size_t frame_cache_bytes = 1024U * kib;
  static constexpr std::size_t config_bytes = 256U * kib;
  static constexpr std::size_t event_journal_bytes = 512U * kib;
  static constexpr std::size_t local_data_bytes = 512U * kib;
  static constexpr std::size_t coredump_bytes = 128U * kib;
  static constexpr std::size_t crashlog_bytes = 64U * kib;
  static constexpr std::size_t allocated_bytes =
      boot_and_tables_bytes + ota_slots_bytes + system_font_bytes +
      frame_cache_bytes + config_bytes + event_journal_bytes +
      local_data_bytes + coredump_bytes + crashlog_bytes;
  static constexpr std::size_t reserve_bytes = flash_bytes - allocated_bytes;

  static constexpr std::size_t gray4_frame_bytes = 259200U;
  static constexpr std::size_t frame_descriptor_bytes = 8U * kib;
  static constexpr std::size_t minimum_dual_frame_bytes =
      2U * (gray4_frame_bytes + frame_descriptor_bytes);
};

static_assert(M7StorageBudget::allocated_bytes <= M7StorageBudget::flash_bytes,
              "M7 storage budget exceeds verified flash");
static_assert(M7StorageBudget::frame_cache_bytes >=
                  M7StorageBudget::minimum_dual_frame_bytes,
              "frame cache must hold last-good and staging frames");
static_assert(M7StorageBudget::reserve_bytes >= 1024U * M7StorageBudget::kib,
              "M7 storage plan requires at least 1 MiB unassigned reserve");

}  // namespace mooneink
