// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include "mooneink/app_manager.hpp"
#include "mooneink/display_manager.hpp"
#include "mooneink/local_ui.hpp"
#include "mooneink/lvgl_port.hpp"
#include "mooneink/shell_input.hpp"
#include "mooneink/touch_manager.hpp"
#include "mooneink/warm_light.hpp"

namespace mooneink {

class SystemShell final : public SystemInputHandler {
 public:
  SystemShell(AppManager& apps, DisplayManager& display, TouchManager& touch,
              LvglPort& lvgl, LocalUi& local_ui, WarmLightController& warm_light)
      : apps_(apps), display_(display), touch_(touch), lvgl_(lvgl),
        local_ui_(local_ui), warm_light_(warm_light) {}

  bool toggleWarmLight() override;
  bool toggleSystemPage() override;
  bool handleSystemTouch(std::int16_t x, std::int16_t y) override;
  bool systemPageOpen() const override { return page_open_; }
  bool appInputAllowed() const override;

 private:
  enum class Page : std::uint8_t { launcher, ephemera_controls };

  bool openLauncher();
  bool showLauncher();
  bool showEphemeraControls();
  bool closeSystemPage(bool restore_app);
  bool activate(const char* id);
  bool dispatchEphemeraAction(std::uint16_t action_id);

  static constexpr const char* overlay_owner = "system-overlay";

  AppManager& apps_;
  DisplayManager& display_;
  TouchManager& touch_;
  LvglPort& lvgl_;
  LocalUi& local_ui_;
  WarmLightController& warm_light_;
  bool page_open_ = false;
  Page page_ = Page::launcher;
};

}  // namespace mooneink
