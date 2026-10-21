// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/remote_frame_cache.hpp"

#include <cstring>

namespace mooneink {

bool RemoteFrameCache::begin(std::uint8_t* first, std::uint8_t* second,
                             const std::size_t bytes_per_buffer) {
  if (first == nullptr || second == nullptr || first == second ||
      bytes_per_buffer < BoardProfile::gray4_frame_bytes) {
    return false;
  }
  active_ = first;
  staging_ = second;
  bytes_per_buffer_ = bytes_per_buffer;
  active_valid_ = false;
  active_descriptor_ = RemoteFrameDescriptor{};
  transfer_.reset();
  return true;
}

bool RemoteFrameCache::beginStage(const RemoteFrameDescriptor& descriptor) {
  if (active_ == nullptr || staging_ == nullptr ||
      transfer_.state() == FrameTransferState::receiving) {
    return false;
  }
  transfer_.reset();
  return transfer_.begin(descriptor, staging_, bytes_per_buffer_);
}

bool RemoteFrameCache::append(const std::uint8_t* data, const std::size_t length) {
  return transfer_.append(data, length);
}

bool RemoteFrameCache::finishStage() { return transfer_.finish(); }

bool RemoteFrameCache::commitStage() {
  if (transfer_.state() != FrameTransferState::verified || transfer_.data() != staging_) {
    return false;
  }
  std::uint8_t* previous_active = active_;
  active_ = staging_;
  staging_ = previous_active;
  active_descriptor_ = transfer_.descriptor();
  active_valid_ = true;
  transfer_.reset();
  return true;
}

void RemoteFrameCache::discardStage() { transfer_.reset(); }

bool RemoteFrameCache::activeMatches(const RemoteFrameDescriptor& descriptor) const {
  return active_valid_ &&
         std::strcmp(active_descriptor_.frame_id.data(), descriptor.frame_id.data()) == 0 &&
         std::strcmp(active_descriptor_.sha256.data(), descriptor.sha256.data()) == 0 &&
         active_descriptor_.page_index == descriptor.page_index;
}

}  // namespace mooneink
