// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/sha256.hpp"

namespace mooneink {
namespace {

constexpr std::uint32_t kConstants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U,
    0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U,
    0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
    0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
    0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU,
    0x5b9cca4fU, 0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

std::uint32_t rotateRight(const std::uint32_t value, const std::uint8_t count) {
  return (value >> count) | (value << (32U - count));
}

}  // namespace

void Sha256::reset() {
  state_ = {0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
            0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};
  block_.fill(0);
  block_length_ = 0;
  total_bytes_ = 0;
  finished_ = false;
}

void Sha256::transform(const std::uint8_t block[64]) {
  std::uint32_t words[64]{};
  for (std::size_t index = 0; index < 16; ++index) {
    const std::size_t offset = index * 4;
    words[index] = (static_cast<std::uint32_t>(block[offset]) << 24U) |
                   (static_cast<std::uint32_t>(block[offset + 1]) << 16U) |
                   (static_cast<std::uint32_t>(block[offset + 2]) << 8U) |
                   static_cast<std::uint32_t>(block[offset + 3]);
  }
  for (std::size_t index = 16; index < 64; ++index) {
    const std::uint32_t low = rotateRight(words[index - 15], 7) ^
                              rotateRight(words[index - 15], 18) ^
                              (words[index - 15] >> 3U);
    const std::uint32_t high = rotateRight(words[index - 2], 17) ^
                               rotateRight(words[index - 2], 19) ^
                               (words[index - 2] >> 10U);
    words[index] = words[index - 16] + low + words[index - 7] + high;
  }
  std::uint32_t a = state_[0];
  std::uint32_t b = state_[1];
  std::uint32_t c = state_[2];
  std::uint32_t d = state_[3];
  std::uint32_t e = state_[4];
  std::uint32_t f = state_[5];
  std::uint32_t g = state_[6];
  std::uint32_t h = state_[7];
  for (std::size_t index = 0; index < 64; ++index) {
    const std::uint32_t upper = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const std::uint32_t choice = (e & f) ^ ((~e) & g);
    const std::uint32_t first = h + upper + choice + kConstants[index] + words[index];
    const std::uint32_t lower = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const std::uint32_t second = lower + majority;
    h = g;
    g = f;
    f = e;
    e = d + first;
    d = c;
    c = b;
    b = a;
    a = first + second;
  }
  state_[0] += a;
  state_[1] += b;
  state_[2] += c;
  state_[3] += d;
  state_[4] += e;
  state_[5] += f;
  state_[6] += g;
  state_[7] += h;
}

bool Sha256::update(const std::uint8_t* data, const std::size_t length) {
  if (finished_ || (length > 0 && data == nullptr) ||
      total_bytes_ > UINT64_MAX - length) {
    return false;
  }
  total_bytes_ += length;
  for (std::size_t index = 0; index < length; ++index) {
    block_[block_length_++] = data[index];
    if (block_length_ == block_.size()) {
      transform(block_.data());
      block_length_ = 0;
    }
  }
  return true;
}

bool Sha256::finish(std::array<std::uint8_t, 32>& digest) {
  if (finished_ || total_bytes_ > UINT64_MAX / 8U) return false;
  const std::uint64_t bit_length = total_bytes_ * 8U;
  block_[block_length_++] = 0x80;
  if (block_length_ > 56) {
    while (block_length_ < 64) block_[block_length_++] = 0;
    transform(block_.data());
    block_length_ = 0;
  }
  while (block_length_ < 56) block_[block_length_++] = 0;
  for (std::size_t index = 0; index < 8; ++index) {
    block_[63 - index] = static_cast<std::uint8_t>(bit_length >> (index * 8U));
  }
  transform(block_.data());
  for (std::size_t index = 0; index < state_.size(); ++index) {
    digest[index * 4] = static_cast<std::uint8_t>(state_[index] >> 24U);
    digest[index * 4 + 1] = static_cast<std::uint8_t>(state_[index] >> 16U);
    digest[index * 4 + 2] = static_cast<std::uint8_t>(state_[index] >> 8U);
    digest[index * 4 + 3] = static_cast<std::uint8_t>(state_[index]);
  }
  finished_ = true;
  return true;
}

bool sha256(const std::uint8_t* data, const std::size_t length,
            std::array<std::uint8_t, 32>& digest) {
  Sha256 engine;
  return engine.update(data, length) && engine.finish(digest);
}

}  // namespace mooneink
