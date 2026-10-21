// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/m4_first_light.hpp"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_system.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <cstdio>
#include <cstring>
#include <ctime>
#include <algorithm>
#include <sys/time.h>

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

void logLoopStackHeadroom(const char* stage) {
  Serial.printf("[M5] stack_headroom stage=%s bytes=%u\n", stage,
                static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
}

bool actionFromId(const std::uint16_t action_id, RemoteActionKind& action) {
  for (const RemoteActionKind candidate : {
           RemoteActionKind::previous_page,
           RemoteActionKind::next_page,
           RemoteActionKind::previous_publication,
           RemoteActionKind::next_publication,
           RemoteActionKind::acknowledge,
           RemoteActionKind::return_latest,
       }) {
    if (remoteActionId(candidate) == action_id) {
      action = candidate;
      return true;
    }
  }
  return false;
}

bool setWallClock(const std::uint64_t unix_time) {
  if (unix_time < 1704067200ULL || unix_time > 4102444800ULL) return false;
  timeval value{};
  value.tv_sec = static_cast<time_t>(unix_time);
  return settimeofday(&value, nullptr) == 0;
}

bool clockReady() {
  return std::time(nullptr) >= static_cast<time_t>(1704067200ULL);
}

}  // namespace

const char* m4FirstLightErrorName(const M4FirstLightError error) {
  switch (error) {
    case M4FirstLightError::none: return "none";
    case M4FirstLightError::already_paired: return "already_paired";
    case M4FirstLightError::invalid_configuration: return "invalid_configuration";
    case M4FirstLightError::wifi_failed: return "wifi_failed";
    case M4FirstLightError::pair_failed: return "pair_failed";
    case M4FirstLightError::screen_failed: return "screen_failed";
    case M4FirstLightError::no_ready_offer: return "no_ready_offer";
    case M4FirstLightError::download_failed: return "download_failed";
    case M4FirstLightError::cache_event_failed: return "cache_event_failed";
    case M4FirstLightError::display_transition_failed: return "display_transition_failed";
    case M4FirstLightError::display_failed: return "display_failed";
    case M4FirstLightError::input_bind_failed: return "input_bind_failed";
    case M4FirstLightError::manifest_failed: return "manifest_failed";
    case M4FirstLightError::action_unavailable: return "action_unavailable";
    case M4FirstLightError::event_backpressure: return "event_backpressure";
  }
  return "unknown";
}

bool M4FirstLight::onEnter() {
  if (!configured() || !display_.acquire(id())) return false;
  if ((!ready_ || !cache_.hasActive()) && view_ == EphemeraAppView::reading) {
    view_ = EphemeraAppView::home;
  }
  if (view_ == EphemeraAppView::home) refreshLibrarySummary();
  if (!render()) {
    touch_.clearApp();
    display_.release(id());
    return false;
  }
  showing_ephemera_ = true;
  return true;
}

bool M4FirstLight::onExit() {
  touch_.clearApp();
  if (!display_.release(id())) return false;
  showing_ephemera_ = false;
  return true;
}

bool M4FirstLight::render() {
  switch (view_) {
    case EphemeraAppView::home: return renderHome();
    case EphemeraAppView::inbox: return renderInbox();
    case EphemeraAppView::reading: return renderReading();
  }
  return false;
}

bool M4FirstLight::showHome() {
  view_ = EphemeraAppView::home;
  reading_return_view_ = EphemeraAppView::home;
  refreshLibrarySummary();
  // The home card should name the work a person will actually resume. Loading
  // recent text also primes the paper drawer instead of leaving it as a count-
  // only shell until the next screen.
  loadLibrary(false);
  return renderHome();
}

bool M4FirstLight::renderReading() {
  touch_.clearApp();
  if (!ready_ || !cache_.hasActive() ||
      !display_.selectDesired(id(), frame_) ||
      !display_.commitCached(id(), frame_) ||
      !display_.presentGray4FrameWithUnreadBadge(
          id(), frame_, cache_.activePixels(), cache_.activeBytes(),
          offer_.frame.width, offer_.frame.height, offer_.frame.stride_bytes,
          otherUnreadCount())) {
    return false;
  }
  return bindActiveActions();
}

bool M4FirstLight::bindHomeActions(const FrameIdentity& frame) {
  const HitRegion regions[] = {
      {42, 156, 456, 166, action_home_continue},
      {42, 372, 456, 166, action_home_inbox},
  };
  return touch_.bindApp(id(), frame, regions,
                        sizeof(regions) / sizeof(regions[0]));
}

bool M4FirstLight::bindInboxActions(const FrameIdentity& frame,
                                    const std::size_t visible_count) {
  std::array<HitRegion, TouchManager::max_app_regions> regions{};
  std::size_t count = 0;
  regions[count++] = HitRegion{42, 104, 110, 58, action_inbox_unread};
  regions[count++] = HitRegion{170, 104, 150, 58, action_inbox_recent};
  for (std::size_t i = 0; i < visible_count; ++i) {
    regions[count++] = HitRegion{42, static_cast<std::int16_t>(170 + i * 94),
                                 456, 82,
                                 static_cast<std::uint16_t>(action_inbox_row_base + i)};
  }
  regions[count++] = HitRegion{42, 842, 130, 90, action_inbox_home};
  return touch_.bindApp(id(), frame, regions.data(), count);
}

bool M4FirstLight::renderHome() {
  touch_.clearApp();
  FrameIdentity local_frame{};
  const char* binding_id = binding_.valid() ? binding_.binding_id.data()
                                             : "local-ephemera";
  if (!FrameIdentity::create(binding_id, "ephemera-home-v1", 0,
                             Orientation::portrait, local_frame)) {
    return false;
  }
  const char* current_label = ready_ ? "当前显示稿件" : "暂时没有可继续的稿件";
  if (ready_ && library_items_ != nullptr) {
    const RemoteFrameDescriptor* current = interaction_.currentFrame();
    if (current != nullptr) {
      for (std::size_t i = 0; i < library_count_; ++i) {
        if (std::strcmp(library_items_[i].publication_id.data(),
                        current->publication_id.data()) == 0 &&
            library_items_[i].label[0] != '\0') {
          current_label = library_items_[i].label.data();
          break;
        }
      }
    }
  }
  EphemeraLocalView view{};
  view.kind = EphemeraLocalViewKind::home;
  view.online = WiFi.status() == WL_CONNECTED;
  view.unread_count = unread_count_;
  view.current_label = current_label;
  return display_.selectDesired(id(), local_frame) &&
         display_.commitCached(id(), local_frame) &&
         display_.presentEphemeraLocalView(id(), local_frame, view) &&
         bindHomeActions(local_frame);
}

bool M4FirstLight::renderInbox() {
  touch_.clearApp();
  FrameIdentity local_frame{};
  const char* binding_id = binding_.valid() ? binding_.binding_id.data()
                                             : "local-ephemera";
  if (!FrameIdentity::create(
          binding_id,
          library_filter_unread_ ? "ephemera-inbox-unread-v1"
                                 : "ephemera-inbox-recent-v1",
          library_page_, Orientation::portrait, local_frame)) {
    return false;
  }
  const std::size_t start =
      static_cast<std::size_t>(library_page_) * library_rows_per_page;
  const std::size_t visible = start >= library_count_
      ? 0
      : std::min(library_rows_per_page, library_count_ - start);
  std::array<EphemeraLocalRow, library_rows_per_page> rows{};
  for (std::size_t i = 0; i < visible; ++i) {
    const HistoryItem& item = library_items_[start + i];
    rows[i].label = item.label.data();
    rows[i].summary = item.summary.data();
    rows[i].genre = item.genre.data();
    rows[i].page_count = item.page_count;
    rows[i].unread = item.unread;
  }
  const std::uint16_t page_count = static_cast<std::uint16_t>(
      std::max<std::size_t>(1, (library_count_ + library_rows_per_page - 1) /
                                   library_rows_per_page));
  EphemeraLocalView view{};
  view.kind = EphemeraLocalViewKind::inbox;
  view.online = library_online_;
  view.filter_unread = library_filter_unread_;
  view.unread_count = unread_count_;
  view.rows = rows.data();
  view.row_count = visible;
  view.page_index = library_page_;
  view.page_count = page_count;
  return display_.selectDesired(id(), local_frame) &&
         display_.commitCached(id(), local_frame) &&
         display_.presentEphemeraLocalView(id(), local_frame, view) &&
         bindInboxActions(local_frame, visible);
}

AppInputResult M4FirstLight::onInput(const AppInputEvent& input) {
  M4FirstLightError error = M4FirstLightError::none;
  bool engagement_acknowledged = false;
  if (showing_ephemera_ && view_ == EphemeraAppView::reading &&
      interaction_.shouldAcknowledgeOnEngagement()) {
    if (!acknowledgeCurrent("single_page_engagement", error)) {
      if (error == M4FirstLightError::event_backpressure) return AppInputResult::blocked;
      return AppInputResult::failed;
    }
    engagement_acknowledged = true;
  }
  if (input.kind == AppInputKind::engagement) {
    return engagement_acknowledged ? AppInputResult::handled
                                   : AppInputResult::ignored;
  }

  if (input.kind == AppInputKind::back) {
    if (view_ == EphemeraAppView::reading) {
      view_ = reading_return_view_;
      return render() ? AppInputResult::handled : AppInputResult::failed;
    }
    if (view_ == EphemeraAppView::inbox) {
      view_ = EphemeraAppView::home;
      return renderHome() ? AppInputResult::handled : AppInputResult::failed;
    }
    return AppInputResult::ignored;
  }

  if (view_ == EphemeraAppView::home) {
    if (input.kind != AppInputKind::touch) return AppInputResult::ignored;
    const DispatchResult result = touch_.dispatch(Point{input.x, input.y});
    if (!result.matched || result.layer != InputLayer::app) {
      return AppInputResult::ignored;
    }
    if (result.action_id == action_home_continue) {
      if (!ready_ || !cache_.hasActive()) return AppInputResult::ignored;
      reading_return_view_ = EphemeraAppView::home;
      view_ = EphemeraAppView::reading;
      return renderReading() ? AppInputResult::handled : AppInputResult::failed;
    }
    if (result.action_id == action_home_inbox) {
      loadLibrary(true);
      library_page_ = 0;
      view_ = EphemeraAppView::inbox;
      return renderInbox() ? AppInputResult::handled : AppInputResult::failed;
    }
    return AppInputResult::ignored;
  }

  if (view_ == EphemeraAppView::inbox) {
    if (input.kind == AppInputKind::previous_page) {
      if (library_page_ == 0) return AppInputResult::ignored;
      --library_page_;
      return renderInbox() ? AppInputResult::handled : AppInputResult::failed;
    }
    if (input.kind == AppInputKind::next_page) {
      const std::size_t next_start =
          static_cast<std::size_t>(library_page_ + 1U) * library_rows_per_page;
      if (next_start >= library_count_) return AppInputResult::ignored;
      ++library_page_;
      return renderInbox() ? AppInputResult::handled : AppInputResult::failed;
    }
    if (input.kind != AppInputKind::touch) return AppInputResult::ignored;
    const DispatchResult result = touch_.dispatch(Point{input.x, input.y});
    if (!result.matched || result.layer != InputLayer::app) {
      return AppInputResult::ignored;
    }
    if (result.action_id == action_inbox_home) {
      view_ = EphemeraAppView::home;
      return renderHome() ? AppInputResult::handled : AppInputResult::failed;
    }
    if (result.action_id == action_inbox_unread ||
        result.action_id == action_inbox_recent) {
      const bool unread = result.action_id == action_inbox_unread;
      loadLibrary(unread);
      library_page_ = 0;
      return renderInbox() ? AppInputResult::handled : AppInputResult::failed;
    }
    if (result.action_id >= action_inbox_row_base &&
        result.action_id < action_inbox_row_base + library_rows_per_page) {
      const std::size_t visible_index = result.action_id - action_inbox_row_base;
      if (openLibraryItem(visible_index, error)) return AppInputResult::handled;
      return error == M4FirstLightError::event_backpressure
                 ? AppInputResult::blocked
                 : AppInputResult::failed;
    }
    return AppInputResult::ignored;
  }

  bool ok = false;
  if (input.kind == AppInputKind::touch) {
    ok = handleTouch(Point{input.x, input.y}, error);
  } else {
    RemoteActionKind action = RemoteActionKind::previous_page;
    if (input.kind == AppInputKind::previous_page) {
      action = RemoteActionKind::previous_page;
    } else if (input.kind == AppInputKind::next_page) {
      action = RemoteActionKind::next_page;
    } else if (!actionFromId(input.action_id, action)) {
      return AppInputResult::ignored;
    }
    ok = handleSystemAction(action, error);
  }
  if (ok) return AppInputResult::handled;
  if (error == M4FirstLightError::action_unavailable) {
    return engagement_acknowledged ? AppInputResult::handled
                                   : AppInputResult::ignored;
  }
  if (error == M4FirstLightError::event_backpressure) return AppInputResult::blocked;
  return AppInputResult::failed;
}

bool M4FirstLight::saveState(AppStateRecord& output) const {
  output.clear();
  output.schema = 1;
  output.size = 1;
  output.payload[0] = ready_ ? 1U : 0U;
  return true;
}

bool M4FirstLight::restoreState(const AppStateRecord& input) {
  if (!input.valid() || input.schema != 1 || input.size != 1) return false;
  // A ready session includes credentials and a continuous event sequence. Until
  // M7 persists those atomically, a cold object must not pretend that an opaque
  // App snapshot restored the binding.
  return input.payload[0] == 0U || ready_;
}

bool M4FirstLight::ensureLibraryStorage() {
  if (library_items_ != nullptr) return true;
  library_items_ = static_cast<HistoryItem*>(heap_caps_calloc(
      library_capacity, sizeof(HistoryItem), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  return library_items_ != nullptr;
}

bool M4FirstLight::refreshLibrarySummary() {
  if (!ready_ || WiFi.status() != WL_CONNECTED) {
    library_online_ = false;
    return false;
  }
  const RemoteFrameDescriptor* current = interaction_.currentFrame();
  DeviceHttpClient client(endpoint_);
  DeviceHttpError http_error = DeviceHttpError::none;
  ScreenResponse screen{};
  if (!client.fetchScreenState(binding_,
                               current == nullptr
                                   ? nullptr
                                   : current->publication_id.data(),
                               screen, http_error) ||
      !screen.has_library) {
    library_online_ = false;
    return false;
  }
  library_online_ = true;
  library_revision_ = screen.library.revision;
  unread_count_ = screen.library.unread_count;
  if (screen.library.has_selected_read_status) {
    current_unread_ = screen.library.selected_unread;
  }
  return true;
}

bool M4FirstLight::loadLibrary(const bool unread_only) {
  library_filter_unread_ = unread_only;
  library_page_ = 0;
  if (!ready_ || WiFi.status() != WL_CONNECTED || !ensureLibraryStorage()) {
    library_online_ = false;
    return false;
  }
  DeviceHttpClient client(endpoint_);
  DeviceHttpError http_error = DeviceHttpError::none;
  HistoryResponse& response = interaction_.historyLoadBuffer();
  std::array<char, DeviceProtocol::identifier_capacity> cursor{};
  bool has_cursor = false;
  std::size_t count = 0;
  do {
    if (!client.fetchLibraryHistory(binding_, has_cursor ? cursor.data() : nullptr,
                                    HistoryResponse::item_capacity,
                                    unread_only ? "unread" : "recent", response,
                                    http_error)) {
      library_count_ = count;
      library_online_ = false;
      Serial.printf("[EPH] library=FAIL filter=%s error=%u loaded=%u\n",
                    unread_only ? "unread" : "recent",
                    static_cast<unsigned>(http_error),
                    static_cast<unsigned>(count));
      return false;
    }
    library_revision_ = response.library_revision;
    unread_count_ = response.unread_count;
    for (std::size_t i = 0;
         i < response.item_count && count < library_capacity; ++i) {
      library_items_[count++] = response.items[i];
    }
    has_cursor = response.has_next_cursor && count < library_capacity;
    cursor.fill('\0');
    if (has_cursor) {
      std::memcpy(cursor.data(), response.next_cursor.data(),
                  response.next_cursor.size());
    }
  } while (has_cursor);
  library_count_ = count;
  library_online_ = true;
  Serial.printf("[EPH] library=PASS filter=%s items=%u unread=%lu\n",
                unread_only ? "unread" : "recent",
                static_cast<unsigned>(library_count_),
                static_cast<unsigned long>(unread_count_));
  return true;
}

std::uint32_t M4FirstLight::otherUnreadCount() const {
  if (unread_count_ == 0) return 0;
  return current_unread_ ? unread_count_ - 1U : unread_count_;
}

void M4FirstLight::markCurrentReadLocally() {
  if (!current_unread_) return;
  current_unread_ = false;
  if (unread_count_ > 0) --unread_count_;
  const RemoteFrameDescriptor* current = interaction_.currentFrame();
  if (current == nullptr || library_items_ == nullptr) return;
  for (std::size_t i = 0; i < library_count_; ++i) {
    if (std::strcmp(library_items_[i].publication_id.data(),
                    current->publication_id.data()) == 0) {
      library_items_[i].unread = false;
    }
  }
}

bool M4FirstLight::openLibraryItem(const std::size_t visible_index,
                                   M4FirstLightError& error) {
  const std::size_t index =
      static_cast<std::size_t>(library_page_) * library_rows_per_page +
      visible_index;
  if (!ready_ || library_items_ == nullptr || index >= library_count_) {
    error = M4FirstLightError::action_unavailable;
    return false;
  }
  M5Intent intent{};
  if (!interaction_.requestPublication(library_items_[index], intent)) {
    error = M4FirstLightError::action_unavailable;
    return false;
  }
  const EphemeraAppView previous_view = view_;
  const EphemeraAppView previous_return_view = reading_return_view_;
  const bool previous_unread = current_unread_;
  reading_return_view_ = EphemeraAppView::inbox;
  view_ = EphemeraAppView::reading;
  current_unread_ = library_items_[index].unread;
  if (!executeIntent(intent, error, false)) {
    view_ = previous_view;
    reading_return_view_ = previous_return_view;
    current_unread_ = previous_unread;
    return false;
  }
  refreshInteractionManifests();
  return true;
}

bool M4FirstLight::makeCurrentReference(DeviceFrameReference& output) const {
  return makeReference(offer_.frame, output);
}

bool M4FirstLight::makeReference(const RemoteFrameDescriptor& descriptor,
                                 DeviceFrameReference& output) {
  DeviceFrameReference reference{};
  if (!copyText(descriptor.publication_id.data(), reference.publication_id) ||
      !copyText(descriptor.page_id.data(), reference.page_id) ||
      !copyText(descriptor.frame_id.data(), reference.frame_id) || !reference.valid()) {
    return false;
  }
  output = reference;
  return true;
}

bool M4FirstLight::queueReceipt(const DeviceEventKind kind,
                                const M5ReportedState& state) {
  return queueEvent(kind, &offer_.frame, offer_.delivery_id.data(), nullptr, state);
}

bool M4FirstLight::queueEvent(const DeviceEventKind kind,
                              const RemoteFrameDescriptor* subject,
                              const char* delivery_id,
                              const RemoteActionKind* action,
                              const M5ReportedState& state) {
  DeviceFrameReference reference{};
  if (subject != nullptr && !makeReference(*subject, reference)) return false;
  return outbox_.enqueue(kind, subject == nullptr ? nullptr : &reference,
                         delivery_id, action, state);
}

void M4FirstLight::flushOutbox() {
  if (WiFi.status() != WL_CONNECTED) return;
  DeviceHttpClient client(endpoint_);
  while (const DeviceEvent* event = outbox_.front()) {
    DeviceHttpError http_error = DeviceHttpError::none;
    if (!client.postEvent(binding_, *event,
                          has_power_report_ ? &power_report_ : nullptr,
                          http_error)) return;
    std::array<char, DeviceProtocol::identifier_capacity> delivered_id{};
    if (!copyText(event->event_id.data(), delivered_id) ||
        !outbox_.markDelivered(delivered_id.data())) {
      return;
    }
  }
}

bool M4FirstLight::setPowerReport(const DevicePowerReport& report) {
  if (!report.valid()) return false;
  power_report_ = report;
  has_power_report_ = true;
  return true;
}

bool M4FirstLight::reportPowerStatus() {
  if (!has_power_report_ || WiFi.status() != WL_CONNECTED) return false;
  flushOutbox();
  if (outbox_.full()) return false;
  M5ReportedState state{};
  if (interaction_.ready()) {
    const bool page_visible = showing_ephemera_ && view_ == EphemeraAppView::reading;
    if (!interaction_.reportState(apps_.activeApp(), !page_visible, state)) return false;
  } else if (!copyText(apps_.activeApp(), state.active_app)) {
    return false;
  }
  if (!queueEvent(DeviceEventKind::status, nullptr, nullptr, nullptr, state)) {
    return false;
  }
  flushOutbox();
  return outbox_.empty();
}

bool M4FirstLight::bindActiveActions() {
  return touch_.bindApp("ephemera", frame_, actions_.data(), action_count_);
}

bool M4FirstLight::refreshInteractionManifests() {
  if (!interaction_.ready() || WiFi.status() != WL_CONNECTED) return false;
  const RemoteFrameDescriptor* current = interaction_.currentFrame();
  if (current == nullptr) return false;
  DeviceHttpClient client(endpoint_);
  DeviceHttpError http_error = DeviceHttpError::none;
  PagesResponse& pages = interaction_.pagesLoadBuffer();
  const bool pages_ok = client.fetchPages(binding_, current->publication_id.data(),
                                          current->profile.data(),
                                          current->edition_id.data(), pages, http_error) &&
                        interaction_.installPages(pages);
  HistoryResponse& history = interaction_.historyLoadBuffer();
  const std::uint8_t history_limit =
      binding_.limits.max_history_items < HistoryResponse::item_capacity
          ? binding_.limits.max_history_items
          : static_cast<std::uint8_t>(HistoryResponse::item_capacity);
  const bool history_ok = client.fetchHistory(
                              binding_, nullptr, history_limit, history, http_error) &&
                          interaction_.installHistory(history);
  Serial.printf("[M5] manifests pages=%s history=%s\n",
                pages_ok ? "PASS" : "PENDING", history_ok ? "PASS" : "PENDING");
  return pages_ok && history_ok;
}

bool M4FirstLight::connectNetwork(const ProvisioningCandidate& candidate,
                                  M4FirstLightError& error) {
  if (!endpoint_.set(candidate.endpoint.data(), nullptr, true)) {
    error = M4FirstLightError::invalid_configuration;
    return false;
  }
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(candidate.wifi_ssid.data(), candidate.wifi_password.data());
  const std::uint32_t wifi_started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifi_started < 30000U) delay(100);
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect(true, false);
    error = M4FirstLightError::wifi_failed;
    return false;
  }
  Serial.printf("[M4] wifi=PASS rssi=%d\n", WiFi.RSSI());
  if (endpoint_.secure() && !clockReady()) {
    configTime(0, 0, "time.cloudflare.com", "pool.ntp.org", "time.google.com");
    const std::uint32_t time_started = millis();
    while (!clockReady() && millis() - time_started < 20000U) delay(100);
    if (!clockReady()) {
      error = M4FirstLightError::wifi_failed;
      return false;
    }
  }
  return true;
}

bool M4FirstLight::run(M4ProvisioningConfig& config, M4FirstLightError& error) {
  logLoopStackHeadroom("run_begin");
  error = M4FirstLightError::none;
  if (!config.valid() || !setWallClock(config.unix_time)) {
    config.clearSecrets();
    error = M4FirstLightError::invalid_configuration;
    return false;
  }
  if (ready_) {
    if (!apps_.activate("settings")) {
      config.clearSecrets();
      error = M4FirstLightError::display_transition_failed;
      return false;
    }
    ready_ = false;
    showing_ephemera_ = false;
  }

  char request_id[DeviceProtocol::identifier_capacity]{};
  const int request_length = std::snprintf(
      request_id, sizeof(request_id), "pair_%08lx_%08lx",
      static_cast<unsigned long>(ESP.getEfuseMac() & 0xffffffffULL),
      static_cast<unsigned long>(esp_random()));
  ProvisioningCandidate candidate{};
  candidate.wifi_ssid = config.wifi_ssid;
  candidate.wifi_password = config.wifi_password;
  candidate.endpoint = config.endpoint;
  candidate.enrollment_code = config.enrollment_code;
  candidate.device_id = config.device_id;
  if (request_length <= 0 || static_cast<std::size_t>(request_length) >= sizeof(request_id) ||
      !copyText(request_id, candidate.pairing_request_id) ||
      !device_state_.stageNetwork(candidate)) {
    config.clearSecrets();
    candidate.clearSecrets();
    error = M4FirstLightError::invalid_configuration;
    return false;
  }
  config.clearSecrets();
  const bool result = resume(error);
  candidate.clearSecrets();
  return result;
}

bool M4FirstLight::resume(M4FirstLightError& error) {
  error = M4FirstLightError::none;
  const DeviceRecoveryState& recovery = device_state_.state();
  if (recovery.phase == ProvisioningPhase::empty ||
      !connectNetwork(recovery.candidate, error)) {
    return false;
  }
  if (recovery.phase == ProvisioningPhase::network_staged) {
    DeviceHttpClient client(endpoint_);
    DeviceHttpError http_error = DeviceHttpError::none;
    DeviceBinding paired{};
    if (!client.pair(recovery.candidate.pairing_request_id.data(),
                     recovery.candidate.device_id.data(),
                     recovery.candidate.enrollment_code.data(), paired, http_error) ||
        !device_state_.commitBinding(paired)) {
      error = M4FirstLightError::pair_failed;
      return false;
    }
    Serial.println("[M4] pair=PASS persistence=COMMITTED");
  }
  const DeviceBinding* active = device_state_.activeBinding();
  if (active == nullptr || !active->valid()) {
    error = M4FirstLightError::pair_failed;
    return false;
  }
  binding_ = *active;
  if (!outbox_.beginPersistent(persistent_store_, 1, binding_.binding_id.data())) {
    error = M4FirstLightError::cache_event_failed;
    return false;
  }
  Serial.printf("[M4] setup=PASS device_id=%s persistence=NVS\n",
                binding_.device_id.data());
  if (!loadFirstScreen(error)) {
    if (error == M4FirstLightError::screen_failed ||
        error == M4FirstLightError::no_ready_offer ||
        error == M4FirstLightError::download_failed) {
      Serial.printf("[M4] first_light=PENDING reason=%s\n",
                    m4FirstLightErrorName(error));
      error = M4FirstLightError::none;
      return true;
    }
    return false;
  }
  return true;
}

bool M4FirstLight::loadFirstScreen(M4FirstLightError& error) {
  DeviceHttpClient client(endpoint_);
  DeviceHttpError http_error = DeviceHttpError::none;

  ScreenResponse screen{};
  if (!client.fetchScreenState(binding_, nullptr, screen, http_error)) {
    error = M4FirstLightError::screen_failed;
    return false;
  }
  return installFirstScreen(screen, error);
}

bool M4FirstLight::installFirstScreen(const ScreenResponse& screen,
                                      M4FirstLightError& error) {
  error = M4FirstLightError::none;
  if (screen.has_library) {
    library_revision_ = screen.library.revision;
    unread_count_ = screen.library.unread_count;
    library_online_ = true;
  }
  if (screen.availability != ScreenAvailability::ready || !screen.has_offer) {
    screen_revision_ = screen.revision;
    error = M4FirstLightError::no_ready_offer;
    return false;
  }
  offer_ = screen.offer;
  current_unread_ = unread_count_ > 0;
  DeviceHttpClient client(endpoint_);
  DeviceHttpError http_error = DeviceHttpError::none;
  if (!client.downloadFrame(binding_, offer_.frame, cache_, http_error)) {
    error = M4FirstLightError::download_failed;
    return false;
  }
  Serial.printf("[M4] asset=PASS bytes=%u\n", static_cast<unsigned>(cache_.activeBytes()));

  if (!makeFrameIdentity(binding_.binding_id.data(), offer_.frame, frame_) ||
      !makeHitRegions(offer_.frame, actions_, action_count_)) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  M5ReportedState cached_state{};
  if (!copyText("ephemera", cached_state.active_app)) {
    error = M4FirstLightError::cache_event_failed;
    return false;
  }
  cached_state.pending_count = 1;
  if (!queueReceipt(DeviceEventKind::cached, cached_state)) {
    error = M4FirstLightError::cache_event_failed;
    return false;
  }
  flushOutbox();
  Serial.printf("[M4] cached_receipt=%s\n", outbox_.empty() ? "PASS" : "PENDING");

  logLoopStackHeadroom("before_interaction_begin");
  if (!interaction_.begin(offer_)) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  logLoopStackHeadroom("after_interaction_begin");
  screen_revision_ = screen.revision;
  ready_ = true;
  reading_return_view_ = EphemeraAppView::home;
  view_ = EphemeraAppView::reading;
  if (!apps_.activate("ephemera")) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  M5ReportedState presented_state{};
  if (!interaction_.reportState("ephemera", false, presented_state)) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  if (!queueReceipt(DeviceEventKind::presented, presented_state)) {
    error = M4FirstLightError::cache_event_failed;
    return false;
  }
  flushOutbox();
  Serial.printf("[M4] first_light=PASS receipt=%s actions=%u\n",
                outbox_.empty() ? "PASS" : "PENDING",
                static_cast<unsigned>(action_count_));
  refreshInteractionManifests();
  logLoopStackHeadroom("after_manifests");
  return true;
}

bool M4FirstLight::showSettings(M4FirstLightError& error) {
  error = M4FirstLightError::none;
  if (!apps_.activate("settings")) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  Serial.println("[M4] show=settings PASS");
  return true;
}

bool M4FirstLight::showEphemera(M4FirstLightError& error) {
  error = M4FirstLightError::none;
  reading_return_view_ = EphemeraAppView::home;
  view_ = EphemeraAppView::reading;
  const bool already_active = apps_.active() == this;
  if (!ready_ || !apps_.activate("ephemera") ||
      (already_active && !renderReading())) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  Serial.println("[M4] show=ephemera restore=PASS");
  return true;
}

bool M4FirstLight::presentIntent(const M5Intent& intent,
                                 M4FirstLightError& error) {
  if (intent.kind != M5IntentKind::show_frame || !intent.valid()) {
    error = M4FirstLightError::action_unavailable;
    return false;
  }
  // The intent may describe the same latest offer that is updated below. Keep
  // the tiny log fields independent of all subsequent descriptor copies.
  const RemoteActionKind presented_action = intent.action;
  const std::uint16_t presented_page = intent.frame.page_index + 1U;
  const std::uint16_t presented_page_count = intent.frame.page_count;
  DeviceHttpClient client(endpoint_);
  DeviceHttpError http_error = DeviceHttpError::none;
  if (!client.downloadFrame(binding_, intent.frame, cache_, http_error)) {
    error = M4FirstLightError::download_failed;
    return false;
  }
  Serial.printf("[M5] present_stage=downloaded action=%s\n",
                remoteActionName(intent.action));

  M5ReportedState cached_state{};
  if (!interaction_.reportState("ephemera", false, cached_state) ||
      !queueEvent(DeviceEventKind::cached, &intent.frame,
                  intent.delivery_id.data(), nullptr, cached_state)) {
    error = M4FirstLightError::cache_event_failed;
    return false;
  }
  flushOutbox();
  Serial.printf("[M5] present_stage=cached_event_flushed pending=%u\n",
                static_cast<unsigned>(outbox_.size()));

  FrameIdentity target_frame{};
  std::array<HitRegion, DeviceProtocol::max_actions_per_frame> target_actions{};
  std::size_t target_action_count = 0;
  if (!makeFrameIdentity(binding_.binding_id.data(), intent.frame, target_frame) ||
      !makeHitRegions(intent.frame, target_actions, target_action_count) ||
      !display_.selectDesired("ephemera", target_frame) ||
      !display_.commitCached("ephemera", target_frame)) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  if (!display_.presentGray4FrameWithUnreadBadge(
          "ephemera", target_frame, cache_.activePixels(), cache_.activeBytes(),
          intent.frame.width, intent.frame.height, intent.frame.stride_bytes,
          otherUnreadCount())) {
    error = M4FirstLightError::display_failed;
    return false;
  }
  Serial.println("[M5] present_stage=displayed");
  if (!interaction_.commitPresented(intent)) {
    display_.invalidatePhysicalState();
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  Serial.println("[M5] present_stage=state_committed");

  offer_.frame = intent.frame;
  offer_.publication_id = intent.publication_id;
  offer_.delivery_id = intent.delivery_id;
  frame_ = target_frame;
  actions_ = target_actions;
  action_count_ = target_action_count;
  if (!bindActiveActions()) {
    error = M4FirstLightError::input_bind_failed;
    return false;
  }
  Serial.println("[M5] present_stage=input_bound");

  M5ReportedState presented_state{};
  if (!interaction_.reportState("ephemera", false, presented_state) ||
      !queueEvent(DeviceEventKind::presented, &intent.frame,
                  intent.delivery_id.data(), nullptr, presented_state)) {
    error = M4FirstLightError::cache_event_failed;
    return false;
  }
  Serial.println("[M5] present_stage=presented_event_queued");
  flushOutbox();
  Serial.printf("[M5] present_stage=presented_event_flushed pending=%u\n",
                static_cast<unsigned>(outbox_.size()));
  const char* presented_action_name = remoteActionName(presented_action);
  Serial.print("[M5] present=PASS action=");
  Serial.print(presented_action_name == nullptr ? "unknown" : presented_action_name);
  Serial.print(" page=");
  Serial.print(static_cast<unsigned>(presented_page));
  Serial.print('/');
  Serial.print(static_cast<unsigned>(presented_page_count));
  Serial.print(" receipt=");
  Serial.println(outbox_.empty() ? "PASS" : "PENDING");
  if (interaction_.shouldAcknowledgeAfterPresentation(intent) &&
      !acknowledgeCurrent("completed_last_page", error)) {
    return false;
  }
  return true;
}

bool M4FirstLight::acknowledgeCurrent(const char* source,
                                      M4FirstLightError& error) {
  error = M4FirstLightError::none;
  if (interaction_.currentAcknowledged()) return true;
  if (outbox_.freeSlots() < 1U) {
    error = M4FirstLightError::event_backpressure;
    return false;
  }
  const RemoteFrameDescriptor* current = interaction_.currentFrame();
  M5ReportedState state{};
  if (current == nullptr || !interaction_.reportState("ephemera", false, state) ||
      !queueEvent(DeviceEventKind::acknowledged, current,
                  interaction_.currentDeliveryId(), nullptr, state) ||
      !interaction_.markCurrentAcknowledged()) {
    error = M4FirstLightError::cache_event_failed;
    return false;
  }
  markCurrentReadLocally();
  flushOutbox();
  Serial.printf("[M5] acknowledge=PASS source=%s receipt=%s\n",
                source == nullptr ? "unknown" : source,
                outbox_.empty() ? "PASS" : "PENDING");
  return true;
}

bool M4FirstLight::executeIntent(const M5Intent& intent,
                                 M4FirstLightError& error,
                                 const bool report_interaction) {
  error = M4FirstLightError::none;
  if (!ready_ || !showing_ephemera_ || !intent.valid()) {
    error = M4FirstLightError::action_unavailable;
    return false;
  }
  if (intent.kind == M5IntentKind::acknowledge &&
      interaction_.currentAcknowledged()) {
    return true;
  }
  const bool completes_publication =
      interaction_.shouldAcknowledgeAfterPresentation(intent);
  const std::size_t needed = (intent.kind == M5IntentKind::acknowledge
                                  ? 1U
                                  : (completes_publication ? 3U : 2U)) +
                             (report_interaction ? 1U : 0U);
  if (outbox_.freeSlots() < needed) {
    error = M4FirstLightError::event_backpressure;
    return false;
  }

  if (report_interaction) {
    M5ReportedState before{};
    const RemoteFrameDescriptor* current = interaction_.currentFrame();
    if (current == nullptr ||
        !interaction_.reportState("ephemera", false, before) ||
        !queueEvent(DeviceEventKind::interaction, current,
                    interaction_.currentDeliveryId(), &intent.action, before)) {
      error = M4FirstLightError::cache_event_failed;
      return false;
    }
    flushOutbox();
  }

  if (intent.kind == M5IntentKind::acknowledge) {
    return acknowledgeCurrent("manual", error);
  }

  if (intent.kind == M5IntentKind::fetch_publication) {
    DeviceHttpClient client(endpoint_);
    DeviceHttpError http_error = DeviceHttpError::none;
    PagesResponse& pages = interaction_.pagesLoadBuffer();
    if (!client.fetchPages(binding_, intent.publication_id.data(),
                           intent.profile.data(), intent.edition_id.data(),
                           pages, http_error)) {
      error = M4FirstLightError::manifest_failed;
      return false;
    }
    M5Intent resolved{};
    if (!interaction_.resolvePublication(intent, pages, resolved) ||
        !presentIntent(resolved, error)) {
      if (error == M4FirstLightError::none) error = M4FirstLightError::manifest_failed;
      return false;
    }
    if (!interaction_.installPages(pages)) {
      error = M4FirstLightError::manifest_failed;
      return false;
    }
    return true;
  }

  if (!presentIntent(intent, error)) return false;
  if (intent.action == RemoteActionKind::return_latest) refreshInteractionManifests();
  return true;
}

bool M4FirstLight::handleTouch(const Point portrait_hardware,
                               M4FirstLightError& error) {
  error = M4FirstLightError::none;
  if (!ready_) {
    error = M4FirstLightError::action_unavailable;
    return false;
  }
  const DispatchResult result = touch_.dispatch(portrait_hardware);
  if (!showing_ephemera_) {
    RemoteActionKind action = RemoteActionKind::previous_page;
    M5Intent intent{};
    if (!result.matched || result.layer != InputLayer::app ||
        !actionFromId(result.action_id, action) ||
        !interaction_.requestSystemAction(action, intent)) {
      error = M4FirstLightError::action_unavailable;
      return false;
    }
    // Restore last-good content before executing the menu action. If a network
    // navigation then fails, the physical display remains a readable page.
    if (!showEphemera(error)) return false;
    return executeIntent(intent, error);
  }
  M5Intent intent{};
  if (!result.matched || result.layer != InputLayer::app ||
      !interaction_.requestAction(result.action_id, intent)) {
    error = M4FirstLightError::action_unavailable;
    return false;
  }
  return executeIntent(intent, error);
}

bool M4FirstLight::handleSystemAction(const RemoteActionKind action,
                                      M4FirstLightError& error) {
  error = M4FirstLightError::none;
  M5Intent intent{};
  if (!ready_ || !showing_ephemera_ ||
      !interaction_.requestSystemAction(action, intent)) {
    error = M4FirstLightError::action_unavailable;
    return false;
  }
  return executeIntent(intent, error);
}

bool M4FirstLight::backgroundScreenRequest(DeviceEndpoint& endpoint,
                                           DeviceBinding& binding,
                                           std::uint64_t& after_revision,
                                           std::uint64_t& after_library_revision,
                                           std::array<char, DeviceProtocol::identifier_capacity>&
                                               read_status_for) const {
  if (!endpoint_.valid() || !binding_.valid() || WiFi.status() != WL_CONNECTED) {
    return false;
  }
  endpoint = endpoint_;
  binding = binding_;
  after_revision = screen_revision_;
  after_library_revision = library_revision_;
  read_status_for.fill('\0');
  const RemoteFrameDescriptor* current = interaction_.ready()
                                             ? interaction_.currentFrame()
                                             : nullptr;
  if (current != nullptr) {
    std::memcpy(read_status_for.data(), current->publication_id.data(),
                current->publication_id.size());
  }
  return true;
}

bool M4FirstLight::applyScreenUpdate(const ScreenResponse& screen,
                                     M4FirstLightError& error) {
  error = M4FirstLightError::none;
  if (!ready_) return installFirstScreen(screen, error);
  const bool library_changed =
      screen.has_library && screen.library.revision > library_revision_;
  if (screen.has_library) {
    library_revision_ = screen.library.revision;
    unread_count_ = screen.library.unread_count;
    if (screen.library.has_selected_read_status) {
      current_unread_ = screen.library.selected_unread;
    }
    library_online_ = true;
  }
  if (screen.revision <= screen_revision_) {
    if (!library_changed || !showing_ephemera_) return true;
    if (view_ == EphemeraAppView::home) return renderHome();
    if (view_ == EphemeraAppView::inbox) {
      loadLibrary(library_filter_unread_);
      return renderInbox();
    }
    return renderReading();
  }
  if (screen.availability != ScreenAvailability::ready || !screen.has_offer) {
    screen_revision_ = screen.revision;
    return true;
  }
  const RemoteFrameDescriptor* current = interaction_.currentFrame();
  const bool same_publication = current != nullptr &&
      std::strcmp(current->publication_id.data(), screen.offer.publication_id.data()) == 0;
  if (!interaction_.observeLatest(screen.offer)) {
    error = M4FirstLightError::display_transition_failed;
    return false;
  }
  if (!same_publication) current_unread_ = true;
  if (same_publication || interaction_.mode() == EphemeraBrowseMode::history ||
      !showing_ephemera_ || view_ != EphemeraAppView::reading) {
    screen_revision_ = screen.revision;
    Serial.printf("[M4] latest=READY auto_present=%s pending=%u\n",
                  same_publication ? "SAME_PUBLICATION" : "DEFERRED",
                  static_cast<unsigned>(interaction_.pendingCount()));
    return true;
  }
  M5Intent intent{};
  if (!interaction_.requestSystemAction(RemoteActionKind::return_latest, intent) ||
      !executeIntent(intent, error)) {
    return false;
  }
  screen_revision_ = screen.revision;
  Serial.printf("[M4] latest=PRESENTED revision=%llu\n",
                static_cast<unsigned long long>(screen_revision_));
  return true;
}

void M4FirstLight::retryPendingReceipt() {
  if (WiFi.status() != WL_CONNECTED) return;
  const std::size_t pending_before = outbox_.size();
  flushOutbox();
  if (pending_before > 0 && outbox_.empty()) Serial.println("[M4] pending_receipt=SYNCED");
}

bool M4FirstLight::networkConnected() const {
  return WiFi.status() == WL_CONNECTED;
}

bool M4FirstLight::ensureNetworkConnection(M4FirstLightError& error) {
  error = M4FirstLightError::none;
  if (WiFi.status() == WL_CONNECTED) return true;
  const DeviceRecoveryState& recovery = device_state_.state();
  if (recovery.phase == ProvisioningPhase::empty ||
      !connectNetwork(recovery.candidate, error)) {
    if (error == M4FirstLightError::none) error = M4FirstLightError::wifi_failed;
    return false;
  }
  return true;
}

}  // namespace mooneink

