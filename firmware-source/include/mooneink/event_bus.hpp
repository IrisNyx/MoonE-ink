// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace mooneink {

enum class EventKind : std::uint8_t {
  boot,
  app_activated,
  app_deactivated,
  app_activation_failed,
  display_started,
  display_presented,
  display_failed,
  display_fault_latched,
  desired_changed,
  cached_committed,
  overlay_opened,
  overlay_closed,
  touch,
  input_dispatched,
  input_blocked,
};

struct Event final {
  EventKind kind;
  std::uint32_t sequence;
  std::int32_t value_a;
  std::int32_t value_b;
};

class EventBus final {
 public:
  static constexpr std::size_t capacity = 32;

  bool publish(EventKind kind, std::int32_t value_a = 0, std::int32_t value_b = 0);
  bool pop(Event& event);
  std::size_t size() const { return size_; }
  std::uint32_t dropped() const { return dropped_; }

 private:
  std::array<Event, capacity> queue_{};
  std::size_t head_ = 0;
  std::size_t tail_ = 0;
  std::size_t size_ = 0;
  std::uint32_t next_sequence_ = 1;
  std::uint32_t dropped_ = 0;
};

}  // namespace mooneink

