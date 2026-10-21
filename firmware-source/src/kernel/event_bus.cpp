// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/event_bus.hpp"

namespace mooneink {

bool EventBus::publish(EventKind kind, std::int32_t value_a, std::int32_t value_b) {
  if (size_ == capacity) {
    ++dropped_;
    return false;
  }
  queue_[tail_] = Event{kind, next_sequence_++, value_a, value_b};
  tail_ = (tail_ + 1) % capacity;
  ++size_;
  return true;
}

bool EventBus::pop(Event& event) {
  if (size_ == 0) return false;
  event = queue_[head_];
  head_ = (head_ + 1) % capacity;
  --size_;
  return true;
}

}  // namespace mooneink

