// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>
#include <cstdint>

#include "mooneink/device_protocol.hpp"

namespace mooneink {

class RemoteFrameCache final {
 public:
  bool begin(std::uint8_t* first, std::uint8_t* second, std::size_t bytes_per_buffer);
  bool beginStage(const RemoteFrameDescriptor& descriptor);
  bool append(const std::uint8_t* data, std::size_t length);
  bool finishStage();
  bool commitStage();
  void discardStage();

  bool hasActive() const { return active_valid_; }
  bool hasVerifiedStage() const {
    return transfer_.state() == FrameTransferState::verified;
  }
  bool activeMatches(const RemoteFrameDescriptor& descriptor) const;
  const RemoteFrameDescriptor* activeDescriptor() const {
    return active_valid_ ? &active_descriptor_ : nullptr;
  }
  const std::uint8_t* activePixels() const { return active_valid_ ? active_ : nullptr; }
  std::size_t activeBytes() const {
    return active_valid_ ? active_descriptor_.byte_length : 0;
  }

 private:
  std::uint8_t* active_ = nullptr;
  std::uint8_t* staging_ = nullptr;
  std::size_t bytes_per_buffer_ = 0;
  bool active_valid_ = false;
  RemoteFrameDescriptor active_descriptor_{};
  FrameTransfer transfer_{};
};

}  // namespace mooneink
