// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include "mooneink/app_manager.hpp"
#include "mooneink/display_manager.hpp"
#include "mooneink/local_ui.hpp"
#include "mooneink/lvgl_port.hpp"
#include "mooneink/touch_manager.hpp"

namespace mooneink {

class DiagnosticsApp final : public App {
 public:
  DiagnosticsApp(DisplayManager& display, TouchManager& touch)
      : display_(display), touch_(touch) {}

  void setSnapshot(const DiagnosticsSnapshot& snapshot) { snapshot_ = snapshot; }
  const char* id() const override { return "diagnostics"; }
  bool onEnter() override;
  bool onExit() override;
  bool render() override;
  AppInputResult onInput(const AppInputEvent& input) override;
  bool saveState(AppStateRecord& output) const override;
  bool restoreState(const AppStateRecord& input) override;

 private:
  DisplayManager& display_;
  TouchManager& touch_;
  DiagnosticsSnapshot snapshot_{};
  FrameIdentity frame_{};
};

class SettingsApp final : public App {
 public:
  SettingsApp(DisplayManager& display, TouchManager& touch, LvglPort& lvgl,
              LocalUi& local_ui)
      : display_(display), touch_(touch), lvgl_(lvgl), local_ui_(local_ui) {}

  void setSnapshot(const LocalUiSnapshot& snapshot) { snapshot_ = snapshot; }
  const char* id() const override { return "settings"; }
  bool onEnter() override;
  bool onExit() override;
  bool render() override;
  AppInputResult onInput(const AppInputEvent& input) override;
  bool saveState(AppStateRecord& output) const override;
  bool restoreState(const AppStateRecord& input) override;

 private:
  DisplayManager& display_;
  TouchManager& touch_;
  LvglPort& lvgl_;
  LocalUi& local_ui_;
  LocalUiSnapshot snapshot_{};
  FrameIdentity frame_{};
};

}  // namespace mooneink
