// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/device_json.hpp"
#include "mooneink/persistent_storage.hpp"

namespace mooneink {

enum class EphemeraBrowseMode : std::uint8_t { follow_latest, history };

enum class M5IntentKind : std::uint8_t {
  none,
  show_frame,
  fetch_publication,
  acknowledge,
};

struct M5Intent final {
  M5IntentKind kind = M5IntentKind::none;
  RemoteActionKind action = RemoteActionKind::previous_page;
  EphemeraBrowseMode mode_after_success = EphemeraBrowseMode::follow_latest;
  RemoteFrameDescriptor frame{};
  std::array<char, DeviceProtocol::identifier_capacity> publication_id{};
  std::array<char, DeviceProtocol::identifier_capacity> edition_id{};
  std::array<char, DeviceProtocol::identifier_capacity> profile{};
  bool has_delivery_id = false;
  std::array<char, DeviceProtocol::identifier_capacity> delivery_id{};

  bool valid() const;
};

struct M5ReportedState final {
  std::array<char, 32> active_app{};
  bool history_mode = false;
  std::uint8_t pending_count = 0;
  bool has_presented_frame = false;
  DeviceFrameReference presented_frame{};
};

class M5InteractionState final {
 public:
  bool begin(const ScreenOffer& offer);
  bool observeLatest(const ScreenOffer& offer);
  bool installHistory(const HistoryResponse& history);
  bool installPages(const PagesResponse& pages);
  // Parse HTTP manifests directly into the state-owned bounded storage. This
  // avoids placing a 10+ KiB response object on the ESP32 loop-task stack.
  HistoryResponse& historyLoadBuffer();
  PagesResponse& pagesLoadBuffer();

  // action_id must come from the hitboxes bound to the currently presented frame.
  bool requestAction(std::uint16_t action_id, M5Intent& output) const;
  // Shell-owned overlay actions use the same current-frame state, but do not
  // depend on a publication-provided hitbox being present.
  bool requestSystemAction(RemoteActionKind action, M5Intent& output) const;
  bool requestPublication(const HistoryItem& item, M5Intent& output) const;
  bool resolvePublication(const M5Intent& fetch_intent, const PagesResponse& pages,
                          M5Intent& show_intent) const;
  bool commitPresented(const M5Intent& show_intent);
  // A single-page work becomes read on the first deliberate key/touch while
  // it is visible. A multi-page work becomes read after a forward page turn
  // successfully presents its final page. Merely auto-presenting a work never
  // satisfies either policy.
  bool shouldAcknowledgeOnEngagement() const;
  bool shouldAcknowledgeAfterPresentation(const M5Intent& show_intent) const;
  bool markCurrentAcknowledged();
  bool currentAcknowledged() const { return current_acknowledged_; }
  bool reportState(const char* active_app, bool overlay_open,
                   M5ReportedState& output) const;

  bool ready() const { return ready_; }
  EphemeraBrowseMode mode() const { return mode_; }
  std::uint8_t pendingCount() const { return pending_count_; }
  const RemoteFrameDescriptor* currentFrame() const {
    return ready_ ? &current_frame_ : nullptr;
  }
  const char* currentDeliveryId() const {
    return ready_ ? current_delivery_id_.data() : nullptr;
  }

 private:
  static bool validOffer(const ScreenOffer& offer);
  static bool samePublication(const RemoteFrameDescriptor& frame, const char* publication_id);
  static bool copyReference(const RemoteFrameDescriptor& frame, DeviceFrameReference& output);
  bool actionBoundToCurrent(std::uint16_t action_id, RemoteActionKind& action) const;
  bool makeIntent(RemoteActionKind action, M5Intent& output) const;
  std::size_t findCurrentHistoryIndex() const;

  bool ready_ = false;
  EphemeraBrowseMode mode_ = EphemeraBrowseMode::follow_latest;
  std::uint8_t pending_count_ = 0;
  ScreenOffer latest_{};
  RemoteFrameDescriptor current_frame_{};
  std::array<char, DeviceProtocol::identifier_capacity> current_delivery_id_{};
  HistoryResponse history_{};
  bool history_loaded_ = false;
  PagesResponse pages_{};
  bool pages_loaded_ = false;
  bool current_acknowledged_ = false;
};

class M5EventOutbox final {
 public:
  static constexpr std::size_t capacity = 8;

  bool begin(std::uint64_t next_sequence);
  bool beginPersistent(PersistentStore& store, std::uint64_t new_binding_sequence,
                       const char* binding_id);
  bool enqueue(DeviceEventKind kind, const DeviceFrameReference* subject,
               const char* delivery_id, const RemoteActionKind* action,
               const M5ReportedState& state);
  const DeviceEvent* front() const;
  bool markDelivered(const char* event_id);

  std::size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  bool full() const { return size_ == capacity; }
  std::size_t freeSlots() const { return capacity - size_; }
  std::uint64_t nextSequence() const { return next_sequence_; }
  bool storageFaulted() const { return storage_faulted_; }

 private:
  std::array<DeviceEvent, capacity> events_{};
  std::size_t head_ = 0;
  std::size_t size_ = 0;
  std::uint64_t next_sequence_ = 0;
  bool initialized_ = false;
  PersistentStore* store_ = nullptr;
  std::array<char, DeviceProtocol::identifier_capacity> binding_id_{};
  bool storage_faulted_ = false;

  bool persist(const std::array<DeviceEvent, capacity>& events,
               std::size_t head, std::size_t size,
               std::uint64_t next_sequence);
};

}  // namespace mooneink
