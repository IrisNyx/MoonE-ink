// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstdint>

#include "mooneink/persistent_storage.hpp"
#include "mooneink/reader_core.hpp"

namespace mooneink {

enum class ReaderEncoding : std::uint16_t { utf8 = 1 };

struct ReaderProgress final {
  static constexpr std::uint16_t schema_version = 1;

  std::uint16_t schema = schema_version;
  ReaderEncoding encoding = ReaderEncoding::utf8;
  ReaderBookIdentity identity{};
  std::uint64_t presented_page_start = 0;
  std::uint32_t layout_revision = 0;
  std::uint32_t font_revision = 0;

  bool valid() const {
    return schema == schema_version && encoding == ReaderEncoding::utf8 &&
           identity.valid() && presented_page_start <= identity.file_size &&
           layout_revision != 0 && font_revision != 0;
  }
};

enum class ReaderProgressLoad : std::uint8_t {
  found,
  not_found,
  corrupt,
  storage_failure,
};

// Progress is one small versioned checksummed record, separate from the
// disposable page index. writeAtomic must provide replace-or-old semantics;
// sync is required before the caller reports a persisted checkpoint.
class ReaderProgressRepository final {
 public:
  static constexpr std::uint32_t storage_key = 0x52315031U;  // "R1P1"
  static constexpr std::size_t wire_bytes = 48;

  explicit ReaderProgressRepository(PersistentStore& store) : store_(store) {}

  ReaderProgressLoad load(ReaderProgress& output);
  bool save(const ReaderProgress& progress);

 private:
  PersistentStore& store_;
};

}  // namespace mooneink
