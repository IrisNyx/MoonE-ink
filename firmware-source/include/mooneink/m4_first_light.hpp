// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstdint>

#include "mooneink/app_manager.hpp"
#include "mooneink/device_http.hpp"
#include "mooneink/device_state_repository.hpp"
#include "mooneink/display_manager.hpp"
#include "mooneink/local_ui.hpp"
#include "mooneink/lvgl_port.hpp"
#include "mooneink/m4_provisioning.hpp"
#include "mooneink/m5_interaction.hpp"
#include "mooneink/remote_frame_cache.hpp"
#include "mooneink/persistent_storage.hpp"
#include "mooneink/touch_manager.hpp"

namespace mooneink {

enum class M4FirstLightError : std::uint8_t {
  none,
  already_paired,
  invalid_configuration,
  wifi_failed,
  pair_failed,
  screen_failed,
  no_ready_offer,
  download_failed,
  cache_event_failed,
  display_transition_failed,
  display_failed,
  input_bind_failed,
  manifest_failed,
  action_unavailable,
  event_backpressure,
};

enum class EphemeraAppView : std::uint8_t { home, inbox, reading };

class M4FirstLight final : public App {
 public:
  M4FirstLight(AppManager& apps, DisplayManager& display, TouchManager& touch,
               LvglPort& lvgl, LocalUi& local_ui, RemoteFrameCache& cache,
               PersistentStore& persistent_store,
               DeviceStateRepository& device_state)
      : apps_(apps), display_(display), touch_(touch), lvgl_(lvgl),
        local_ui_(local_ui), cache_(cache), persistent_store_(persistent_store),
        device_state_(device_state) {}

  bool run(M4ProvisioningConfig& config, M4FirstLightError& error);
  bool resume(M4FirstLightError& error);
  bool showSettings(M4FirstLightError& error);
  bool showEphemera(M4FirstLightError& error);
  bool handleTouch(Point portrait_hardware, M4FirstLightError& error);
  bool handleSystemAction(RemoteActionKind action, M4FirstLightError& error);
  bool backgroundScreenRequest(DeviceEndpoint& endpoint, DeviceBinding& binding,
                               std::uint64_t& after_revision,
                               std::uint64_t& after_library_revision,
                               std::array<char, DeviceProtocol::identifier_capacity>&
                                   read_status_for) const;
  bool applyScreenUpdate(const ScreenResponse& screen, M4FirstLightError& error);
  bool ensureNetworkConnection(M4FirstLightError& error);
  void retryPendingReceipt();
  bool setPowerReport(const DevicePowerReport& report);
  bool reportPowerStatus();
  bool ready() const { return ready_; }
  bool showingEphemera() const { return showing_ephemera_; }
  bool configured() const { return device_state_.activeBinding() != nullptr; }
  bool hasStoredSetup() const {
    return device_state_.state().phase != ProvisioningPhase::empty;
  }
  bool networkConnected() const;

  const char* id() const override { return "ephemera"; }
  bool available() const override { return configured(); }
  bool onEnter() override;
  bool onExit() override;
  bool render() override;
  void prepareHome() override { view_ = EphemeraAppView::home; }
  bool showHome() override;
  AppInputResult onInput(const AppInputEvent& input) override;
  bool saveState(AppStateRecord& output) const override;
  bool restoreState(const AppStateRecord& input) override;

 private:
  bool makeCurrentReference(DeviceFrameReference& output) const;
  static bool makeReference(const RemoteFrameDescriptor& descriptor,
                            DeviceFrameReference& output);
  bool queueReceipt(DeviceEventKind kind, const M5ReportedState& state);
  bool queueEvent(DeviceEventKind kind, const RemoteFrameDescriptor* subject,
                  const char* delivery_id, const RemoteActionKind* action,
                  const M5ReportedState& state);
  void flushOutbox();
  bool bindActiveActions();
  bool bindHomeActions(const FrameIdentity& frame);
  bool bindInboxActions(const FrameIdentity& frame, std::size_t visible_count);
  bool renderHome();
  bool renderInbox();
  bool renderReading();
  bool refreshLibrarySummary();
  bool loadLibrary(bool unread_only);
  bool openLibraryItem(std::size_t visible_index, M4FirstLightError& error);
  bool ensureLibraryStorage();
  std::uint32_t otherUnreadCount() const;
  void markCurrentReadLocally();
  bool refreshInteractionManifests();
  bool acknowledgeCurrent(const char* source, M4FirstLightError& error);
  bool executeIntent(const M5Intent& intent, M4FirstLightError& error,
                     bool report_interaction = true);
  bool presentIntent(const M5Intent& intent, M4FirstLightError& error);
  bool connectNetwork(const ProvisioningCandidate& candidate,
                      M4FirstLightError& error);
  bool loadFirstScreen(M4FirstLightError& error);
  bool installFirstScreen(const ScreenResponse& screen,
                          M4FirstLightError& error);

  AppManager& apps_;
  DisplayManager& display_;
  TouchManager& touch_;
  LvglPort& lvgl_;
  LocalUi& local_ui_;
  RemoteFrameCache& cache_;
  PersistentStore& persistent_store_;
  DeviceStateRepository& device_state_;
  DeviceBinding binding_{};
  DeviceEndpoint endpoint_{};
  ScreenOffer offer_{};
  FrameIdentity frame_{};
  std::array<HitRegion, DeviceProtocol::max_actions_per_frame> actions_{};
  std::size_t action_count_ = 0;
  M5EventOutbox outbox_{};
  M5InteractionState interaction_{};
  DevicePowerReport power_report_{};
  bool has_power_report_ = false;
  static constexpr std::size_t library_capacity = 128;
  static constexpr std::size_t library_rows_per_page = 7;
  static constexpr std::uint16_t action_home_continue = 1001;
  static constexpr std::uint16_t action_home_inbox = 1002;
  static constexpr std::uint16_t action_inbox_unread = 1010;
  static constexpr std::uint16_t action_inbox_recent = 1011;
  static constexpr std::uint16_t action_inbox_home = 1012;
  static constexpr std::uint16_t action_inbox_row_base = 1100;
  HistoryItem* library_items_ = nullptr;
  std::size_t library_count_ = 0;
  std::uint16_t library_page_ = 0;
  bool library_filter_unread_ = true;
  bool library_online_ = false;
  std::uint64_t library_revision_ = 0;
  std::uint32_t unread_count_ = 0;
  bool current_unread_ = false;
  EphemeraAppView view_ = EphemeraAppView::reading;
  EphemeraAppView reading_return_view_ = EphemeraAppView::home;
  bool ready_ = false;
  bool showing_ephemera_ = false;
  std::uint64_t screen_revision_ = 0;
};

const char* m4FirstLightErrorName(M4FirstLightError error);

}  // namespace mooneink

