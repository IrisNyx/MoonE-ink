// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/system_shell.hpp"

#include <cstring>

#include "mooneink/device_protocol.hpp"

namespace mooneink {

bool SystemShell::toggleWarmLight() { return warm_light_.toggle(); }

bool SystemShell::appInputAllowed() const {
  const DisplayPolicySnapshot state = display_.snapshot();
  return !page_open_ && apps_.active() != nullptr && state.state == DisplayState::idle &&
         state.physical_known && state.visible_surface == SurfaceKind::app_frame;
}

bool SystemShell::showLauncher() {
  const char* const active_id = apps_.activeApp();
  const bool ephemera_active =
      active_id != nullptr && std::strcmp(active_id, "ephemera") == 0;
  const bool reader_active =
      active_id != nullptr && std::strcmp(active_id, "reader") == 0;
  if (!local_ui_.buildLauncher(apps_.isAvailable("ephemera"), ephemera_active,
                               reader_active) ||
      !lvgl_.composeNow() || !display_.presentOverlayComposedFrame(overlay_owner)) {
    return false;
  }

  std::array<HitRegion, TouchManager::max_overlay_regions> regions{};
  std::size_t count = 0;
  regions[count++] = HitRegion{40, 176, 215, 132,
                               static_cast<std::uint16_t>(LauncherAction::settings)};
  if (apps_.isAvailable("ephemera")) {
    regions[count++] = HitRegion{285, 176, 215, 132,
                                 static_cast<std::uint16_t>(LauncherAction::ephemera)};
  }
  regions[count++] = HitRegion{40, 332, 215, 132,
                               static_cast<std::uint16_t>(LauncherAction::reader)};
  regions[count++] = HitRegion{285, 332, 215, 132,
                               static_cast<std::uint16_t>(LauncherAction::diagnostics)};
  if (ephemera_active) {
    regions[count++] = HitRegion{
        40, 488, 215, 132,
        static_cast<std::uint16_t>(LauncherAction::ephemera_controls)};
    regions[count++] = HitRegion{285, 488, 215, 132,
                                 static_cast<std::uint16_t>(LauncherAction::back)};
  } else {
    regions[count++] = HitRegion{40, 488, 215, 132,
                                 static_cast<std::uint16_t>(LauncherAction::back)};
  }
  page_ = Page::launcher;
  return touch_.bindOverlay(overlay_owner, Orientation::portrait, regions.data(), count);
}

bool SystemShell::showEphemeraControls() {
  if (!local_ui_.buildEphemeraSystemMenu() || !lvgl_.composeNow() ||
      !display_.presentOverlayComposedFrame(overlay_owner)) {
    return false;
  }
  const HitRegion regions[] = {
      {40, 246, 215, 132, remoteActionId(RemoteActionKind::previous_page)},
      {285, 246, 215, 132, remoteActionId(RemoteActionKind::next_page)},
      {40, 402, 215, 132, remoteActionId(RemoteActionKind::previous_publication)},
      {285, 402, 215, 132, remoteActionId(RemoteActionKind::next_publication)},
      {40, 558, 215, 132, remoteActionId(RemoteActionKind::return_latest)},
      {285, 558, 215, 132, remoteActionId(RemoteActionKind::acknowledge)},
  };
  page_ = Page::ephemera_controls;
  return touch_.bindOverlay(overlay_owner, Orientation::portrait, regions,
                            sizeof(regions) / sizeof(regions[0]));
}

bool SystemShell::openLauncher() {
  const char* const active_id = apps_.activeApp();
  if (active_id == nullptr || !display_.openModalOverlay(active_id, overlay_owner)) {
    return false;
  }
  touch_.clearOverlay();
  page_open_ = true;
  if (showLauncher()) return true;
  closeSystemPage(true);
  return false;
}

bool SystemShell::closeSystemPage(const bool restore_app) {
  if (!page_open_) return false;
  touch_.clearOverlay();
  touch_.clearApp();
  if (!display_.closeModalOverlay(overlay_owner)) return false;
  page_open_ = false;
  page_ = Page::launcher;
  if (!restore_app) return true;
  App* const app = apps_.active();
  return app != nullptr && app->render();
}

bool SystemShell::toggleSystemPage() {
  return page_open_ ? closeSystemPage(true) : openLauncher();
}

bool SystemShell::activate(const char* id) {
  if (!closeSystemPage(false)) return false;
  return apps_.activateHome(id);
}

bool SystemShell::dispatchEphemeraAction(const std::uint16_t action_id) {
  if (!closeSystemPage(true)) return false;
  AppInputEvent input{};
  input.kind = AppInputKind::action;
  input.action_id = action_id;
  const AppInputResult result = apps_.dispatchInput(input);
  return result == AppInputResult::handled || result == AppInputResult::blocked;
}

bool SystemShell::handleSystemTouch(const std::int16_t x, const std::int16_t y) {
  if (!page_open_) return false;
  const DispatchResult result = touch_.dispatch(Point{x, y});
  if (!result.matched || result.layer != InputLayer::overlay) return false;

  if (page_ == Page::ephemera_controls) {
    return dispatchEphemeraAction(result.action_id);
  }

  const LauncherAction action = static_cast<LauncherAction>(result.action_id);
  switch (action) {
    case LauncherAction::back:
      return closeSystemPage(true);
    case LauncherAction::ephemera:
      return activate("ephemera");
    case LauncherAction::settings:
      return activate("settings");
    case LauncherAction::reader:
      return activate("reader");
    case LauncherAction::diagnostics:
      return activate("diagnostics");
    case LauncherAction::ephemera_controls:
      return showEphemeraControls();
  }
  return false;
}

}  // namespace mooneink
