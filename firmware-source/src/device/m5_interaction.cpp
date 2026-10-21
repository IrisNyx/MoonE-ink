// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/m5_interaction.hpp"

#include <cstdio>
#include <cstring>
#include <memory>
#include <new>

namespace mooneink {
namespace {

template <std::size_t Size>
bool copyText(const char* source, std::array<char, Size>& target) {
  if (source == nullptr) return false;
  const std::size_t length = std::strlen(source);
  if (length == 0 || length >= target.size()) return false;
  target.fill('\0');
  std::memcpy(target.data(), source, length);
  return true;
}

bool sameText(const char* lhs, const char* rhs) {
  return lhs != nullptr && rhs != nullptr && std::strcmp(lhs, rhs) == 0;
}

}  // namespace

bool M5Intent::valid() const {
  if (kind == M5IntentKind::none) return false;
  if (has_delivery_id && !isProtocolIdentifier(delivery_id.data())) return false;
  switch (kind) {
    case M5IntentKind::show_frame: {
      DescriptorError error = DescriptorError::none;
      const bool show_action = action == RemoteActionKind::previous_page ||
                               action == RemoteActionKind::next_page ||
                               action == RemoteActionKind::previous_publication ||
                               action == RemoteActionKind::next_publication ||
                               action == RemoteActionKind::return_latest;
      return show_action && validateRemoteFrameDescriptor(frame, error) &&
             isProtocolIdentifier(publication_id.data()) &&
             sameText(publication_id.data(), frame.publication_id.data()) &&
             sameText(edition_id.data(), frame.edition_id.data()) &&
             sameText(profile.data(), frame.profile.data());
    }
    case M5IntentKind::fetch_publication:
      return (action == RemoteActionKind::previous_publication ||
              action == RemoteActionKind::next_publication ||
              action == RemoteActionKind::return_latest) &&
             isProtocolIdentifier(publication_id.data()) &&
             isProtocolIdentifier(edition_id.data()) &&
             isSupportedProfile(profile.data()) &&
             has_delivery_id;
    case M5IntentKind::acknowledge:
      return action == RemoteActionKind::acknowledge &&
             isProtocolIdentifier(publication_id.data()) &&
             isProtocolIdentifier(edition_id.data()) &&
             isSupportedProfile(profile.data());
    case M5IntentKind::none:
      break;
  }
  return false;
}

bool M5InteractionState::validOffer(const ScreenOffer& offer) {
  DescriptorError error = DescriptorError::none;
  return isProtocolIdentifier(offer.delivery_id.data()) &&
         isProtocolIdentifier(offer.publication_id.data()) &&
         sameText(offer.publication_id.data(), offer.frame.publication_id.data()) &&
         validateRemoteFrameDescriptor(offer.frame, error);
}

bool M5InteractionState::samePublication(const RemoteFrameDescriptor& frame,
                                         const char* publication_id) {
  return sameText(frame.publication_id.data(), publication_id);
}

bool M5InteractionState::copyReference(const RemoteFrameDescriptor& frame,
                                       DeviceFrameReference& output) {
  DeviceFrameReference reference{};
  if (!copyText(frame.publication_id.data(), reference.publication_id) ||
      !copyText(frame.page_id.data(), reference.page_id) ||
      !copyText(frame.frame_id.data(), reference.frame_id) || !reference.valid()) {
    return false;
  }
  output = reference;
  return true;
}

bool M5InteractionState::begin(const ScreenOffer& offer) {
  if (!validOffer(offer)) return false;
  latest_ = offer;
  current_frame_ = offer.frame;
  current_delivery_id_ = offer.delivery_id;
  mode_ = EphemeraBrowseMode::follow_latest;
  pending_count_ = 0;
  history_.clear();
  history_loaded_ = false;
  pages_.clear();
  pages_loaded_ = false;
  current_acknowledged_ = false;
  ready_ = true;
  return true;
}

bool M5InteractionState::observeLatest(const ScreenOffer& offer) {
  if (!ready_ || !validOffer(offer)) return false;
  latest_ = offer;
  pending_count_ = samePublication(current_frame_, offer.publication_id.data()) ? 0 : 1;
  return true;
}

bool M5InteractionState::installHistory(const HistoryResponse& history) {
  if (!ready_ || history.item_count > HistoryResponse::item_capacity) return false;
  std::uint64_t previous_sequence = UINT64_MAX;
  for (std::size_t i = 0; i < history.item_count; ++i) {
    if (!history.items[i].valid() ||
        history.items[i].acceptance_seq >= previous_sequence) {
      return false;
    }
    previous_sequence = history.items[i].acceptance_seq;
  }
  if (history.has_next_cursor && !isProtocolCursor(history.next_cursor.data())) return false;
  history_ = history;
  history_loaded_ = true;
  return true;
}

HistoryResponse& M5InteractionState::historyLoadBuffer() {
  history_loaded_ = false;
  history_.clear();
  return history_;
}

PagesResponse& M5InteractionState::pagesLoadBuffer() {
  pages_loaded_ = false;
  pages_.clear();
  return pages_;
}

bool M5InteractionState::installPages(const PagesResponse& pages) {
  if (!ready_ || !pages.valid() ||
      !samePublication(current_frame_, pages.publication_id.data()) ||
      !sameText(current_frame_.edition_id.data(), pages.edition_id.data())) {
    return false;
  }
  pages_ = pages;
  pages_loaded_ = true;
  return true;
}

bool M5InteractionState::actionBoundToCurrent(const std::uint16_t action_id,
                                              RemoteActionKind& action) const {
  if (!ready_) return false;
  for (std::size_t i = 0; i < current_frame_.action_count; ++i) {
    if (remoteActionId(current_frame_.actions[i].kind) == action_id) {
      action = current_frame_.actions[i].kind;
      return true;
    }
  }
  return false;
}

std::size_t M5InteractionState::findCurrentHistoryIndex() const {
  if (!history_loaded_) return history_.item_count;
  for (std::size_t i = 0; i < history_.item_count; ++i) {
    if (samePublication(current_frame_, history_.items[i].publication_id.data())) return i;
  }
  return history_.item_count;
}

bool M5InteractionState::requestAction(const std::uint16_t action_id,
                                       M5Intent& output) const {
  RemoteActionKind action = RemoteActionKind::previous_page;
  if (!actionBoundToCurrent(action_id, action)) return false;
  return makeIntent(action, output);
}

bool M5InteractionState::requestSystemAction(const RemoteActionKind action,
                                             M5Intent& output) const {
  if (remoteActionName(action) == nullptr) return false;
  return makeIntent(action, output);
}

bool M5InteractionState::requestPublication(const HistoryItem& item,
                                             M5Intent& output) const {
  if (!ready_ || !item.valid() || !item.presentable) return false;
  M5Intent intent{};
  intent.kind = M5IntentKind::fetch_publication;
  intent.action = RemoteActionKind::return_latest;
  intent.mode_after_success =
      samePublication(latest_.frame, item.publication_id.data())
          ? EphemeraBrowseMode::follow_latest
          : EphemeraBrowseMode::history;
  if (!copyText(item.publication_id.data(), intent.publication_id) ||
      !copyText(item.edition_id.data(), intent.edition_id) ||
      !copyText(item.profile.data(), intent.profile) ||
      !copyText(item.delivery_id.data(), intent.delivery_id)) {
    return false;
  }
  intent.has_delivery_id = true;
  if (!intent.valid()) return false;
  output = intent;
  return true;
}

bool M5InteractionState::makeIntent(const RemoteActionKind action,
                                    M5Intent& output) const {
  if (!ready_) return false;
  M5Intent intent{};
  intent.action = action;
  intent.mode_after_success = mode_;
  switch (action) {
    case RemoteActionKind::previous_page:
    case RemoteActionKind::next_page: {
      if (!pages_loaded_ ||
          !samePublication(current_frame_, pages_.publication_id.data()) ||
          !sameText(current_frame_.edition_id.data(), pages_.edition_id.data())) {
        return false;
      }
      const std::int32_t delta = action == RemoteActionKind::previous_page ? -1 : 1;
      const std::int32_t target = static_cast<std::int32_t>(current_frame_.page_index) + delta;
      if (target < 0 || target >= static_cast<std::int32_t>(pages_.frame_count)) return false;
      intent.kind = M5IntentKind::show_frame;
      intent.frame = pages_.frames[static_cast<std::size_t>(target)];
      if (!copyText(intent.frame.publication_id.data(), intent.publication_id) ||
          !copyText(intent.frame.edition_id.data(), intent.edition_id) ||
          !copyText(intent.frame.profile.data(), intent.profile) ||
          !copyText(current_delivery_id_.data(), intent.delivery_id)) {
        return false;
      }
      intent.has_delivery_id = true;
      break;
    }
    case RemoteActionKind::previous_publication:
    case RemoteActionKind::next_publication: {
      const std::size_t current = findCurrentHistoryIndex();
      if (current >= history_.item_count) return false;
      const std::int32_t delta =
          action == RemoteActionKind::previous_publication ? 1 : -1;
      const std::int32_t target = static_cast<std::int32_t>(current) + delta;
      if (target < 0 || target >= static_cast<std::int32_t>(history_.item_count)) return false;
      const HistoryItem& item = history_.items[static_cast<std::size_t>(target)];
      if (!item.presentable) return false;
      intent.kind = M5IntentKind::fetch_publication;
      intent.mode_after_success = EphemeraBrowseMode::history;
      if (!copyText(item.publication_id.data(), intent.publication_id) ||
          !copyText(item.edition_id.data(), intent.edition_id) ||
          !copyText(item.profile.data(), intent.profile) ||
          !copyText(item.delivery_id.data(), intent.delivery_id)) {
        return false;
      }
      intent.has_delivery_id = true;
      break;
    }
    case RemoteActionKind::acknowledge:
      intent.kind = M5IntentKind::acknowledge;
      if (!copyText(current_frame_.publication_id.data(), intent.publication_id) ||
          !copyText(current_frame_.edition_id.data(), intent.edition_id) ||
          !copyText(current_frame_.profile.data(), intent.profile) ||
          !copyText(current_delivery_id_.data(), intent.delivery_id)) {
        return false;
      }
      intent.has_delivery_id = true;
      break;
    case RemoteActionKind::return_latest:
      if (!validOffer(latest_)) return false;
      intent.kind = M5IntentKind::show_frame;
      intent.mode_after_success = EphemeraBrowseMode::follow_latest;
      intent.frame = latest_.frame;
      if (!copyText(latest_.publication_id.data(), intent.publication_id) ||
          !copyText(latest_.frame.edition_id.data(), intent.edition_id) ||
          !copyText(latest_.frame.profile.data(), intent.profile) ||
          !copyText(latest_.delivery_id.data(), intent.delivery_id)) {
        return false;
      }
      intent.has_delivery_id = true;
      break;
  }
  if (!intent.valid()) return false;
  output = intent;
  return true;
}

bool M5InteractionState::resolvePublication(const M5Intent& fetch_intent,
                                            const PagesResponse& pages,
                                            M5Intent& show_intent) const {
  if (!ready_ || fetch_intent.kind != M5IntentKind::fetch_publication ||
      !fetch_intent.valid() || !pages.valid() ||
      !sameText(fetch_intent.publication_id.data(), pages.publication_id.data()) ||
      !sameText(fetch_intent.edition_id.data(), pages.edition_id.data()) ||
      !sameText(fetch_intent.profile.data(), pages.profile.data())) {
    return false;
  }
  M5Intent resolved = fetch_intent;
  resolved.kind = M5IntentKind::show_frame;
  resolved.frame = pages.frames[0];
  if (!resolved.valid()) return false;
  show_intent = resolved;
  return true;
}

bool M5InteractionState::commitPresented(const M5Intent& show_intent) {
  if (!ready_ || show_intent.kind != M5IntentKind::show_frame ||
      !show_intent.valid() || !show_intent.has_delivery_id) {
    return false;
  }
  const bool same_publication =
      samePublication(current_frame_, show_intent.publication_id.data());
  current_frame_ = show_intent.frame;
  current_delivery_id_ = show_intent.delivery_id;
  mode_ = show_intent.mode_after_success;
  if (!same_publication) current_acknowledged_ = false;
  pending_count_ = samePublication(current_frame_, latest_.publication_id.data()) ? 0 : 1;
  if (pages_loaded_ &&
      (!sameText(pages_.publication_id.data(), current_frame_.publication_id.data()) ||
       !sameText(pages_.edition_id.data(), current_frame_.edition_id.data()))) {
    pages_.clear();
    pages_loaded_ = false;
  }
  return true;
}

bool M5InteractionState::shouldAcknowledgeOnEngagement() const {
  return ready_ && !current_acknowledged_ && current_frame_.page_count == 1;
}

bool M5InteractionState::shouldAcknowledgeAfterPresentation(
    const M5Intent& show_intent) const {
  return ready_ && !current_acknowledged_ && show_intent.valid() &&
         show_intent.kind == M5IntentKind::show_frame &&
         show_intent.action == RemoteActionKind::next_page &&
         show_intent.frame.page_count > 1 &&
         show_intent.frame.page_index + 1U == show_intent.frame.page_count;
}

bool M5InteractionState::markCurrentAcknowledged() {
  if (!ready_) return false;
  current_acknowledged_ = true;
  return true;
}

bool M5InteractionState::reportState(const char* active_app, const bool overlay_open,
                                     M5ReportedState& output) const {
  if (!ready_) return false;
  M5ReportedState state{};
  if (!copyText(active_app, state.active_app)) return false;
  state.history_mode = mode_ == EphemeraBrowseMode::history;
  state.pending_count = pending_count_;
  state.has_presented_frame = !overlay_open;
  if (state.has_presented_frame && !copyReference(current_frame_, state.presented_frame)) {
    return false;
  }
  output = state;
  return true;
}

bool M5EventOutbox::begin(const std::uint64_t next_sequence) {
  if (next_sequence == 0) return false;
  events_.fill(DeviceEvent{});
  head_ = 0;
  size_ = 0;
  next_sequence_ = next_sequence;
  initialized_ = true;
  store_ = nullptr;
  binding_id_.fill('\0');
  storage_faulted_ = false;
  return true;
}

namespace {

constexpr std::uint32_t outbox_magic = 0x4d4f4258U;  // MOBX
constexpr std::uint16_t outbox_schema = 2;
constexpr std::uint32_t outbox_storage_key = 1;

struct PersistentOutboxHeader final {
  std::uint32_t magic = outbox_magic;
  std::uint16_t schema = outbox_schema;
  std::uint16_t count = 0;
  std::uint64_t next_sequence = 0;
  std::array<char, DeviceProtocol::identifier_capacity> binding_id{};
};

// Schema 1 always stored all eight event slots, even when the queue was empty.
// Keep its shape only so installed devices can migrate it once.
struct PersistentOutboxV1 final {
  std::uint32_t magic = outbox_magic;
  std::uint16_t schema = 1;
  std::uint16_t count = 0;
  std::uint64_t next_sequence = 0;
  std::array<char, DeviceProtocol::identifier_capacity> binding_id{};
  std::array<DeviceEvent, M5EventOutbox::capacity> events{};
};

bool validPersistentEvents(const PersistentOutboxHeader& header,
                           const DeviceEvent* events) {
  if (header.magic != outbox_magic || header.schema != outbox_schema ||
      header.count > M5EventOutbox::capacity || header.next_sequence == 0 ||
      !isProtocolIdentifier(header.binding_id.data()) ||
      (header.count > 0 && events == nullptr)) {
    return false;
  }
  if (header.next_sequence <= header.count) return false;
  std::uint64_t expected = header.next_sequence - header.count;
  for (std::size_t index = 0; index < header.count; ++index) {
    if (!events[index].valid() || events[index].seq != expected++) return false;
  }
  return expected == header.next_sequence;
}

bool validPersistentOutboxV1(const PersistentOutboxV1& record) {
  PersistentOutboxHeader header{};
  header.count = record.count;
  header.next_sequence = record.next_sequence;
  header.binding_id = record.binding_id;
  return validPersistentEvents(header, record.events.data());
}

}  // namespace

bool M5EventOutbox::beginPersistent(PersistentStore& store,
                                    const std::uint64_t new_binding_sequence,
                                    const char* binding_id) {
  if (new_binding_sequence == 0 || !isProtocolIdentifier(binding_id)) return false;
  constexpr std::size_t max_record_size = sizeof(PersistentOutboxV1);
  std::unique_ptr<std::uint8_t[]> record(new (std::nothrow) std::uint8_t[max_record_size]{});
  if (!record) return false;
  std::size_t actual_size = 0;
  const PersistentReadResult read = store.readLatest(
      PersistentArea::event_journal, outbox_storage_key,
      record.get(), max_record_size, actual_size);
  if (read == PersistentReadResult::found) {
    std::array<DeviceEvent, capacity> restored_events{};
    PersistentOutboxHeader restored_header{};
    bool migrate_v1 = false;
    if (actual_size >= sizeof(PersistentOutboxHeader)) {
      std::memcpy(&restored_header, record.get(), sizeof(restored_header));
      if (restored_header.schema == outbox_schema &&
          actual_size == sizeof(PersistentOutboxHeader) +
                             restored_header.count * sizeof(DeviceEvent)) {
        const auto* stored_events = reinterpret_cast<const DeviceEvent*>(
            record.get() + sizeof(PersistentOutboxHeader));
        if (!validPersistentEvents(restored_header, stored_events)) return false;
        for (std::size_t index = 0; index < restored_header.count; ++index) {
          restored_events[index] = stored_events[index];
        }
      } else if (actual_size == sizeof(PersistentOutboxV1)) {
        const auto* legacy = reinterpret_cast<const PersistentOutboxV1*>(record.get());
        if (!validPersistentOutboxV1(*legacy)) return false;
        restored_header.count = legacy->count;
        restored_header.next_sequence = legacy->next_sequence;
        restored_header.binding_id = legacy->binding_id;
        restored_events = legacy->events;
        migrate_v1 = true;
      } else {
        return false;
      }
    } else {
      return false;
    }
    if (std::strcmp(restored_header.binding_id.data(), binding_id) == 0) {
      events_ = restored_events;
      head_ = 0;
      size_ = restored_header.count;
      next_sequence_ = restored_header.next_sequence;
      initialized_ = true;
      store_ = &store;
      binding_id_ = restored_header.binding_id;
      storage_faulted_ = false;
      record.reset();
      if (migrate_v1 && !persist(events_, head_, size_, next_sequence_)) {
        storage_faulted_ = true;
        initialized_ = false;
        return false;
      }
      return true;
    }
  }

  // An event journal is expendable delivery telemetry. If an older firmware
  // left an unreadable record, replace it instead of blocking Wi-Fi, pairing
  // and the user's last-good screen forever.
  record.reset();
  if (!begin(new_binding_sequence)) return false;
  store_ = &store;
  binding_id_.fill('\0');
  std::memcpy(binding_id_.data(), binding_id, std::strlen(binding_id));
  if (!persist(events_, head_, size_, next_sequence_)) {
    storage_faulted_ = true;
    initialized_ = false;
    return false;
  }
  return true;
}

bool M5EventOutbox::persist(const std::array<DeviceEvent, capacity>& events,
                            const std::size_t head, const std::size_t size,
                            const std::uint64_t next_sequence) {
  if (store_ == nullptr) return true;
  if (size > capacity || next_sequence == 0 || !isProtocolIdentifier(binding_id_.data())) {
    return false;
  }
  const std::size_t record_size =
      sizeof(PersistentOutboxHeader) + size * sizeof(DeviceEvent);
  std::unique_ptr<std::uint8_t[]> record(new (std::nothrow) std::uint8_t[record_size]{});
  if (!record) return false;
  PersistentOutboxHeader header{};
  header.count = static_cast<std::uint16_t>(size);
  header.next_sequence = next_sequence;
  header.binding_id = binding_id_;
  std::memcpy(record.get(), &header, sizeof(header));
  for (std::size_t index = 0; index < size; ++index) {
    std::memcpy(record.get() + sizeof(header) + index * sizeof(DeviceEvent),
                &events[(head + index) % capacity], sizeof(DeviceEvent));
  }
  return store_->appendJournal(record.get(), record_size);
}

bool M5EventOutbox::enqueue(const DeviceEventKind kind,
                            const DeviceFrameReference* subject,
                            const char* delivery_id,
                            const RemoteActionKind* action,
                            const M5ReportedState& state) {
  if (!initialized_ || storage_faulted_ || full() || next_sequence_ == UINT64_MAX ||
      state.active_app[0] == '\0' || state.pending_count > 1 ||
      (state.has_presented_frame && !state.presented_frame.valid())) {
    return false;
  }
  DeviceEvent event{};
  char event_id[DeviceProtocol::identifier_capacity]{};
  const int event_id_length = std::snprintf(
      event_id, sizeof(event_id), "event_%020llu",
      static_cast<unsigned long long>(next_sequence_));
  if (event_id_length <= 0 ||
      static_cast<std::size_t>(event_id_length) >= sizeof(event_id) ||
      !copyText(event_id, event.event_id)) {
    return false;
  }
  event.seq = next_sequence_;
  event.kind = kind;
  event.has_subject = subject != nullptr;
  if (subject != nullptr) event.subject = *subject;
  event.has_delivery_id = delivery_id != nullptr && delivery_id[0] != '\0';
  if (event.has_delivery_id && !copyText(delivery_id, event.delivery_id)) return false;
  event.has_action = action != nullptr;
  if (action != nullptr) event.action = *action;
  event.active_app = state.active_app;
  event.history_mode = state.history_mode;
  event.pending_count = state.pending_count;
  event.has_presented_frame = state.has_presented_frame;
  event.presented_frame = state.presented_frame;
  if (!event.valid()) return false;

  std::unique_ptr<std::array<DeviceEvent, capacity>> next_events(
      new (std::nothrow) std::array<DeviceEvent, capacity>(events_));
  if (!next_events) return false;
  const std::size_t tail = (head_ + size_) % capacity;
  (*next_events)[tail] = event;
  if (!persist(*next_events, head_, size_ + 1, next_sequence_ + 1)) {
    storage_faulted_ = true;
    return false;
  }
  events_ = *next_events;
  ++size_;
  ++next_sequence_;
  return true;
}

const DeviceEvent* M5EventOutbox::front() const {
  return empty() ? nullptr : &events_[head_];
}

bool M5EventOutbox::markDelivered(const char* event_id) {
  if (storage_faulted_ || empty() || event_id == nullptr ||
      !sameText(events_[head_].event_id.data(), event_id)) {
    return false;
  }
  std::unique_ptr<std::array<DeviceEvent, capacity>> next_events(
      new (std::nothrow) std::array<DeviceEvent, capacity>(events_));
  if (!next_events) return false;
  (*next_events)[head_] = DeviceEvent{};
  const std::size_t next_head = (head_ + 1) % capacity;
  if (!persist(*next_events, next_head, size_ - 1, next_sequence_)) {
    storage_faulted_ = true;
    return false;
  }
  events_ = *next_events;
  head_ = next_head;
  --size_;
  return true;
}

}  // namespace mooneink
