// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/package_registry.hpp"

#include <cstring>

namespace mooneink {
namespace {

constexpr std::array<std::uint8_t, 4> kMagic{{'E', 'A', 'P', '1'}};
constexpr std::uint16_t kSchema = 1;
constexpr std::size_t kHeaderBytes = 16;
constexpr std::size_t kSlotBytes = 151;

void put16(std::array<std::uint8_t, PackageRegistryRepository::wire_bytes>& bytes,
           const std::size_t offset, const std::uint16_t value) {
  bytes[offset] = static_cast<std::uint8_t>(value);
  bytes[offset + 1] = static_cast<std::uint8_t>(value >> 8U);
}

void put32(std::array<std::uint8_t, PackageRegistryRepository::wire_bytes>& bytes,
           const std::size_t offset, const std::uint32_t value) {
  for (std::size_t index = 0; index < 4; ++index) {
    bytes[offset + index] = static_cast<std::uint8_t>(value >> (index * 8U));
  }
}

void put64(std::array<std::uint8_t, PackageRegistryRepository::wire_bytes>& bytes,
           const std::size_t offset, const std::uint64_t value) {
  for (std::size_t index = 0; index < 8; ++index) {
    bytes[offset + index] = static_cast<std::uint8_t>(value >> (index * 8U));
  }
}

std::uint16_t get16(
    const std::array<std::uint8_t, PackageRegistryRepository::wire_bytes>& bytes,
    const std::size_t offset) {
  return static_cast<std::uint16_t>(bytes[offset]) |
         (static_cast<std::uint16_t>(bytes[offset + 1]) << 8U);
}

std::uint32_t get32(
    const std::array<std::uint8_t, PackageRegistryRepository::wire_bytes>& bytes,
    const std::size_t offset) {
  std::uint32_t value = 0;
  for (std::size_t index = 0; index < 4; ++index) {
    value |= static_cast<std::uint32_t>(bytes[offset + index]) << (index * 8U);
  }
  return value;
}

std::uint64_t get64(
    const std::array<std::uint8_t, PackageRegistryRepository::wire_bytes>& bytes,
    const std::size_t offset) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) {
    value |= static_cast<std::uint64_t>(bytes[offset + index]) << (index * 8U);
  }
  return value;
}

std::uint32_t crc32(const std::uint8_t* data, const std::size_t length) {
  std::uint32_t crc = 0xffffffffU;
  for (std::size_t index = 0; index < length; ++index) {
    crc ^= data[index];
    for (std::uint8_t bit = 0; bit < 8; ++bit) {
      const std::uint32_t mask = 0U - (crc & 1U);
      crc = (crc >> 1U) ^ (0xedb88320U & mask);
    }
  }
  return ~crc;
}

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

bool validRecord(const InstalledPackageRecord& record) {
  return record.occupied && terminatedNonEmpty(record.app_id) &&
         terminatedNonEmpty(record.version) && terminatedNonEmpty(record.install_identity) &&
         nonzeroDigest(record.content_sha256) &&
         (record.granted_permissions & 0xff00U) == 0;
}

bool validState(const PackageRegistryState& state) {
  for (std::size_t index = 0; index < state.records.size(); ++index) {
    const InstalledPackageRecord& record = state.records[index];
    if (!record.occupied) continue;
    if (!validRecord(record)) return false;
    for (std::size_t prior = 0; prior < index; ++prior) {
      if (!state.records[prior].occupied) continue;
      if (std::strcmp(record.app_id.data(), state.records[prior].app_id.data()) == 0 ||
          std::strcmp(record.install_identity.data(),
                      state.records[prior].install_identity.data()) == 0) {
        return false;
      }
    }
  }
  return true;
}

std::array<std::uint8_t, PackageRegistryRepository::wire_bytes> encode(
    const PackageRegistryState& state) {
  std::array<std::uint8_t, PackageRegistryRepository::wire_bytes> bytes{};
  std::memcpy(bytes.data(), kMagic.data(), kMagic.size());
  put16(bytes, 4, kSchema);
  std::uint16_t count = 0;
  for (const InstalledPackageRecord& record : state.records) {
    if (record.occupied) ++count;
  }
  put16(bytes, 6, count);
  put64(bytes, 8, state.generation);
  for (std::size_t index = 0; index < state.records.size(); ++index) {
    const InstalledPackageRecord& record = state.records[index];
    const std::size_t base = kHeaderBytes + index * kSlotBytes;
    bytes[base] = record.occupied ? 1U : 0U;
    put16(bytes, base + 2, record.granted_permissions);
    std::memcpy(bytes.data() + base + 4, record.app_id.data(), record.app_id.size());
    std::memcpy(bytes.data() + base + 37, record.version.data(), record.version.size());
    std::memcpy(bytes.data() + base + 54, record.install_identity.data(),
                record.install_identity.size());
    std::memcpy(bytes.data() + base + 119, record.content_sha256.data(),
                record.content_sha256.size());
  }
  put32(bytes, bytes.size() - 4, crc32(bytes.data(), bytes.size() - 4));
  return bytes;
}

bool decode(const std::array<std::uint8_t, PackageRegistryRepository::wire_bytes>& bytes,
            PackageRegistryState& output) {
  if (std::memcmp(bytes.data(), kMagic.data(), kMagic.size()) != 0 ||
      get16(bytes, 4) != kSchema || get32(bytes, bytes.size() - 4) !=
                                      crc32(bytes.data(), bytes.size() - 4)) {
    return false;
  }
  PackageRegistryState candidate{};
  candidate.generation = get64(bytes, 8);
  std::uint16_t actual_count = 0;
  for (std::size_t index = 0; index < candidate.records.size(); ++index) {
    const std::size_t base = kHeaderBytes + index * kSlotBytes;
    if (bytes[base] > 1U || bytes[base + 1] != 0) return false;
    if (bytes[base] == 0) {
      for (std::size_t offset = 1; offset < kSlotBytes; ++offset) {
        if (bytes[base + offset] != 0) return false;
      }
      continue;
    }
    InstalledPackageRecord& record = candidate.records[index];
    record.occupied = true;
    record.granted_permissions = get16(bytes, base + 2);
    std::memcpy(record.app_id.data(), bytes.data() + base + 4, record.app_id.size());
    std::memcpy(record.version.data(), bytes.data() + base + 37, record.version.size());
    std::memcpy(record.install_identity.data(), bytes.data() + base + 54,
                record.install_identity.size());
    std::memcpy(record.content_sha256.data(), bytes.data() + base + 119,
                record.content_sha256.size());
    ++actual_count;
  }
  if (actual_count != get16(bytes, 6) || !validState(candidate)) return false;
  output = candidate;
  return true;
}

}  // namespace

PackageRegistryLoad PackageRegistryRepository::begin(PersistentStore& store) {
  std::array<std::uint8_t, wire_bytes> bytes{};
  std::size_t actual = 0;
  const PersistentReadResult read = store.readLatest(
      PersistentArea::app_registry, storage_key, bytes.data(), bytes.size(), actual);
  if (read == PersistentReadResult::failure) return PackageRegistryLoad::storage_failure;
  if (read == PersistentReadResult::not_found) {
    store_ = &store;
    state_ = PackageRegistryState{};
    return PackageRegistryLoad::ready;
  }
  PackageRegistryState restored{};
  if (actual != bytes.size() || !decode(bytes, restored)) {
    return PackageRegistryLoad::corrupt;
  }
  store_ = &store;
  state_ = restored;
  return PackageRegistryLoad::ready;
}

const InstalledPackageRecord* PackageRegistryRepository::find(const char* app_id) const {
  if (app_id == nullptr || *app_id == '\0') return nullptr;
  for (const InstalledPackageRecord& record : state_.records) {
    if (record.occupied && std::strcmp(record.app_id.data(), app_id) == 0) return &record;
  }
  return nullptr;
}

bool PackageRegistryRepository::persist(const PackageRegistryState& next) {
  if (store_ == nullptr || !validState(next)) return false;
  const auto bytes = encode(next);
  return store_->writeAtomic(PersistentArea::app_registry, storage_key,
                             bytes.data(), bytes.size()) &&
         store_->sync();
}

bool PackageRegistryRepository::upsert(const InstalledPackageRecord& record) {
  if (store_ == nullptr || !validRecord(record) || state_.generation == UINT64_MAX) return false;
  PackageRegistryState next = state_;
  std::size_t target = next.records.size();
  for (std::size_t index = 0; index < next.records.size(); ++index) {
    if (next.records[index].occupied &&
        std::strcmp(next.records[index].app_id.data(), record.app_id.data()) == 0) {
      target = index;
      break;
    }
    if (target == next.records.size() && !next.records[index].occupied) target = index;
  }
  if (target == next.records.size()) return false;
  next.records[target] = record;
  ++next.generation;
  if (!validState(next) || !persist(next)) return false;
  state_ = next;
  return true;
}

bool PackageRegistryRepository::remove(const char* app_id) {
  if (store_ == nullptr || app_id == nullptr || *app_id == '\0' ||
      state_.generation == UINT64_MAX) {
    return false;
  }
  PackageRegistryState next = state_;
  bool found = false;
  for (InstalledPackageRecord& record : next.records) {
    if (record.occupied && std::strcmp(record.app_id.data(), app_id) == 0) {
      record = InstalledPackageRecord{};
      found = true;
      break;
    }
  }
  if (!found) return false;
  ++next.generation;
  if (!persist(next)) return false;
  state_ = next;
  return true;
}

}  // namespace mooneink
