// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace mooneink {

class Sha256 final {
 public:
  Sha256() { reset(); }

  void reset();
  bool update(const std::uint8_t* data, std::size_t length);
  bool finish(std::array<std::uint8_t, 32>& digest);

 private:
  void transform(const std::uint8_t block[64]);

  std::array<std::uint32_t, 8> state_{};
  std::array<std::uint8_t, 64> block_{};
  std::size_t block_length_ = 0;
  std::uint64_t total_bytes_ = 0;
  bool finished_ = false;
};

bool sha256(const std::uint8_t* data, std::size_t length,
            std::array<std::uint8_t, 32>& digest);

}  // namespace mooneink
