// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/package_policy.hpp"
#include "mooneink/persistent_storage.hpp"

namespace mooneink {

enum class PackageRegistryLoad : std::uint8_t {
  ready,
  corrupt,
  storage_failure,
};

struct PackageRegistryState final {
  static constexpr std::size_t capacity = 4;
  std::uint64_t generation = 0;
  std::array<InstalledPackageRecord, capacity> records{};
};

// The registry is separate from package bytes. A caller first seals and verifies
// a staging snapshot, then atomically commits this record, then registers the
// declarative App. A failed write/sync leaves the in-memory registry unchanged.
class PackageRegistryRepository final {
 public:
  static constexpr std::uint32_t storage_key = 0x45415031U;  // EAP1
  static constexpr std::size_t wire_bytes = 624;

  PackageRegistryLoad begin(PersistentStore& store);
  const InstalledPackageRecord* find(const char* app_id) const;
  bool upsert(const InstalledPackageRecord& record);
  bool remove(const char* app_id);
  const PackageRegistryState& state() const { return state_; }

 private:
  bool persist(const PackageRegistryState& next);

  PersistentStore* store_ = nullptr;
  PackageRegistryState state_{};
};

}  // namespace mooneink
