// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <Preferences.h>

#include "mooneink/persistent_storage.hpp"

namespace mooneink {

// Power-loss-safe persistent records backed by the board's NVS partition.
// NVS provides atomic blob replacement; the envelope below adds an explicit
// generation and SHA-256 checksum before a record is exposed to callers.
class NvsPersistentStore final : public PersistentStore {
 public:
  bool begin();
  void end();

  PersistentReadResult readLatest(PersistentArea area, std::uint32_t key,
                                  std::uint8_t* output, std::size_t capacity,
                                  std::size_t& actual_size) override;
  bool writeAtomic(PersistentArea area, std::uint32_t key,
                   const std::uint8_t* data, std::size_t size) override;
  bool appendJournal(const std::uint8_t* data, std::size_t size) override;
  bool sync() override;

 private:
  bool makeKey(PersistentArea area, std::uint32_t key, char output[15]) const;

  Preferences preferences_{};
  bool ready_ = false;
};

}  // namespace mooneink
