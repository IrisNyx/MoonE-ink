// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/reader_progress.hpp"

#include <array>

namespace mooneink {
namespace {

constexpr std::array<std::uint8_t, 4> magic{{'R', 'P', 'R', '1'}};

void put16(std::array<std::uint8_t, ReaderProgressRepository::wire_bytes>& bytes,
           const std::size_t offset, const std::uint16_t value) {
  bytes[offset] = static_cast<std::uint8_t>(value & 0xffU);
  bytes[offset + 1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void put32(std::array<std::uint8_t, ReaderProgressRepository::wire_bytes>& bytes,
           const std::size_t offset, const std::uint32_t value) {
  for (std::size_t index = 0; index < 4; ++index) {
    bytes[offset + index] =
        static_cast<std::uint8_t>((value >> (index * 8U)) & 0xffU);
  }
}

void put64(std::array<std::uint8_t, ReaderProgressRepository::wire_bytes>& bytes,
           const std::size_t offset, const std::uint64_t value) {
  for (std::size_t index = 0; index < 8; ++index) {
    bytes[offset + index] =
        static_cast<std::uint8_t>((value >> (index * 8U)) & 0xffU);
  }
}

std::uint16_t get16(const std::array<std::uint8_t, ReaderProgressRepository::wire_bytes>& bytes,
                    const std::size_t offset) {
  return static_cast<std::uint16_t>(bytes[offset]) |
         (static_cast<std::uint16_t>(bytes[offset + 1]) << 8U);
}

std::uint32_t get32(const std::array<std::uint8_t, ReaderProgressRepository::wire_bytes>& bytes,
                    const std::size_t offset) {
  std::uint32_t value = 0;
  for (std::size_t index = 0; index < 4; ++index) {
    value |= static_cast<std::uint32_t>(bytes[offset + index]) << (index * 8U);
  }
  return value;
}

std::uint64_t get64(const std::array<std::uint8_t, ReaderProgressRepository::wire_bytes>& bytes,
                    const std::size_t offset) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) {
    value |= static_cast<std::uint64_t>(bytes[offset + index]) << (index * 8U);
  }
  return value;
}

std::uint32_t crc32(const std::uint8_t* data, const std::size_t size) {
  std::uint32_t crc = 0xffffffffU;
  for (std::size_t index = 0; index < size; ++index) {
    crc ^= data[index];
    for (std::uint8_t bit = 0; bit < 8; ++bit) {
      const std::uint32_t mask = 0U - (crc & 1U);
      crc = (crc >> 1U) ^ (0xedb88320U & mask);
    }
  }
  return ~crc;
}

std::array<std::uint8_t, ReaderProgressRepository::wire_bytes> encode(
    const ReaderProgress& progress) {
  std::array<std::uint8_t, ReaderProgressRepository::wire_bytes> bytes{};
  for (std::size_t index = 0; index < magic.size(); ++index) bytes[index] = magic[index];
  put16(bytes, 4, progress.schema);
  put16(bytes, 6, static_cast<std::uint16_t>(progress.encoding));
  put16(bytes, 8, progress.identity.algorithm);
  put16(bytes, 10, 0);
  put64(bytes, 12, progress.identity.file_size);
  put64(bytes, 20, progress.identity.content_hash);
  put64(bytes, 28, progress.presented_page_start);
  put32(bytes, 36, progress.layout_revision);
  put32(bytes, 40, progress.font_revision);
  put32(bytes, 44, crc32(bytes.data(), 44));
  return bytes;
}

bool decode(const std::array<std::uint8_t, ReaderProgressRepository::wire_bytes>& bytes,
            ReaderProgress& output) {
  for (std::size_t index = 0; index < magic.size(); ++index) {
    if (bytes[index] != magic[index]) return false;
  }
  if (get16(bytes, 10) != 0 || get32(bytes, 44) != crc32(bytes.data(), 44)) return false;
  ReaderProgress candidate{};
  candidate.schema = get16(bytes, 4);
  candidate.encoding = static_cast<ReaderEncoding>(get16(bytes, 6));
  candidate.identity.algorithm = get16(bytes, 8);
  candidate.identity.file_size = get64(bytes, 12);
  candidate.identity.content_hash = get64(bytes, 20);
  candidate.presented_page_start = get64(bytes, 28);
  candidate.layout_revision = get32(bytes, 36);
  candidate.font_revision = get32(bytes, 40);
  if (!candidate.valid()) return false;
  output = candidate;
  return true;
}

}  // namespace

ReaderProgressLoad ReaderProgressRepository::load(ReaderProgress& output) {
  output = ReaderProgress{};
  std::array<std::uint8_t, wire_bytes> bytes{};
  std::size_t actual = 0;
  const PersistentReadResult result = store_.readLatest(
      PersistentArea::reader_progress, storage_key, bytes.data(), bytes.size(), actual);
  if (result == PersistentReadResult::not_found) return ReaderProgressLoad::not_found;
  if (result != PersistentReadResult::found) return ReaderProgressLoad::storage_failure;
  if (actual != bytes.size() || !decode(bytes, output)) {
    output = ReaderProgress{};
    return ReaderProgressLoad::corrupt;
  }
  return ReaderProgressLoad::found;
}

bool ReaderProgressRepository::save(const ReaderProgress& progress) {
  if (!progress.valid()) return false;
  const auto bytes = encode(progress);
  return store_.writeAtomic(PersistentArea::reader_progress, storage_key,
                            bytes.data(), bytes.size()) &&
         store_.sync();
}

}  // namespace mooneink
