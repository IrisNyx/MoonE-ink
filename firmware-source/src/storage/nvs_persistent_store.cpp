// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/nvs_persistent_store.hpp"

#include <memory>
#include <cstdio>
#include <cstring>

#include <esp_heap_caps.h>

#include "mooneink/sha256.hpp"

namespace mooneink {
namespace {

struct HeapCapsDeleter final {
  void operator()(std::uint8_t* pointer) const {
    if (pointer != nullptr) heap_caps_free(pointer);
  }
};

using PersistentBuffer = std::unique_ptr<std::uint8_t, HeapCapsDeleter>;

PersistentBuffer allocatePersistentBuffer(const std::size_t size) {
  auto* memory = static_cast<std::uint8_t*>(
      heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (memory == nullptr) {
    memory = static_cast<std::uint8_t*>(heap_caps_malloc(size, MALLOC_CAP_8BIT));
  }
  return PersistentBuffer(memory);
}

constexpr std::uint32_t envelope_magic = 0x4d4e5653U;  // MNVS
constexpr std::uint16_t envelope_schema = 1;
constexpr std::uint32_t journal_key = 1;

struct EnvelopeHeader final {
  std::uint32_t magic = envelope_magic;
  std::uint16_t schema = envelope_schema;
  std::uint8_t area = 0;
  std::uint8_t reserved = 0;
  std::uint32_t key = 0;
  std::uint64_t generation = 0;
  std::uint32_t payload_size = 0;
  std::array<std::uint8_t, 32> digest{};
};

bool calculateDigest(const EnvelopeHeader& header, const std::uint8_t* payload,
                     const std::size_t payload_size,
                     std::array<std::uint8_t, 32>& output) {
  EnvelopeHeader unsigned_header = header;
  unsigned_header.digest.fill(0);
  Sha256 hash;
  return hash.update(reinterpret_cast<const std::uint8_t*>(&unsigned_header),
                     sizeof(unsigned_header)) &&
         hash.update(payload, payload_size) && hash.finish(output);
}

bool validHeader(const EnvelopeHeader& header, const PersistentArea area,
                 const std::uint32_t key, const std::size_t blob_size) {
  return header.magic == envelope_magic && header.schema == envelope_schema &&
         header.area == static_cast<std::uint8_t>(area) && header.reserved == 0 &&
         header.key == key && header.generation > 0 && header.payload_size > 0 &&
         blob_size == sizeof(EnvelopeHeader) + header.payload_size;
}

}  // namespace

bool NvsPersistentStore::begin() {
  if (ready_) return true;
  ready_ = preferences_.begin("mooneink", false);
  return ready_;
}

void NvsPersistentStore::end() {
  if (ready_) preferences_.end();
  ready_ = false;
}

bool NvsPersistentStore::makeKey(const PersistentArea area, const std::uint32_t key,
                                 char output[15]) const {
  if (area >= PersistentArea::count || output == nullptr) return false;
  const int written = std::snprintf(output, 15, "r%02x%08lx",
                                    static_cast<unsigned>(area),
                                    static_cast<unsigned long>(key));
  return written > 0 && written < 15;
}

PersistentReadResult NvsPersistentStore::readLatest(
    const PersistentArea area, const std::uint32_t key, std::uint8_t* output,
    const std::size_t capacity, std::size_t& actual_size) {
  actual_size = 0;
  char record_key[15]{};
  if (!ready_ || !makeKey(area, key, record_key)) return PersistentReadResult::failure;
  const std::size_t blob_size = preferences_.getBytesLength(record_key);
  if (blob_size == 0) return PersistentReadResult::not_found;
  if (blob_size < sizeof(EnvelopeHeader)) return PersistentReadResult::failure;
  PersistentBuffer blob = allocatePersistentBuffer(blob_size);
  if (!blob || preferences_.getBytes(record_key, blob.get(), blob_size) != blob_size) {
    return PersistentReadResult::failure;
  }
  EnvelopeHeader header{};
  std::memcpy(&header, blob.get(), sizeof(header));
  if (!validHeader(header, area, key, blob_size)) return PersistentReadResult::failure;
  std::array<std::uint8_t, 32> digest{};
  const std::uint8_t* payload = blob.get() + sizeof(header);
  if (!calculateDigest(header, payload, header.payload_size, digest) ||
      digest != header.digest) {
    return PersistentReadResult::failure;
  }
  actual_size = header.payload_size;
  if (output == nullptr || capacity < actual_size) return PersistentReadResult::failure;
  std::memcpy(output, payload, actual_size);
  return PersistentReadResult::found;
}

bool NvsPersistentStore::writeAtomic(const PersistentArea area,
                                     const std::uint32_t key,
                                     const std::uint8_t* data,
                                     const std::size_t size) {
  char record_key[15]{};
  if (!ready_ || !makeKey(area, key, record_key) || data == nullptr || size == 0 ||
      size > UINT32_MAX || size > 16U * 1024U) {
    return false;
  }
  std::uint64_t generation = 1;
  const std::size_t previous_size = preferences_.getBytesLength(record_key);
  if (previous_size >= sizeof(EnvelopeHeader)) {
    PersistentBuffer previous_blob = allocatePersistentBuffer(previous_size);
    if (!previous_blob) return false;
    if (preferences_.getBytes(record_key, previous_blob.get(), previous_size) == previous_size) {
      EnvelopeHeader previous{};
      std::memcpy(&previous, previous_blob.get(), sizeof(previous));
      if (validHeader(previous, area, key, previous_size) &&
          previous.generation < UINT64_MAX) {
        generation = previous.generation + 1;
      }
    }
  }
  EnvelopeHeader header{};
  header.area = static_cast<std::uint8_t>(area);
  header.key = key;
  header.generation = generation;
  header.payload_size = static_cast<std::uint32_t>(size);
  if (!calculateDigest(header, data, size, header.digest)) return false;
  const std::size_t blob_size = sizeof(header) + size;
  PersistentBuffer blob = allocatePersistentBuffer(blob_size);
  if (!blob) return false;
  std::memcpy(blob.get(), &header, sizeof(header));
  std::memcpy(blob.get() + sizeof(header), data, size);
  return preferences_.putBytes(record_key, blob.get(), blob_size) == blob_size;
}

bool NvsPersistentStore::appendJournal(const std::uint8_t* data,
                                       const std::size_t size) {
  return writeAtomic(PersistentArea::event_journal, journal_key, data, size);
}

bool NvsPersistentStore::sync() {
  // Preferences commits each putBytes transaction before it returns.
  return ready_;
}

}  // namespace mooneink
