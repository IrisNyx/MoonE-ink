// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/built_in_apps.hpp"

namespace mooneink {
namespace {

bool saveEmptyState(AppStateRecord& output) {
  output.clear();
  output.schema = 1;
  output.size = 1;
  output.payload[0] = 0;
  return true;
}

bool restoreEmptyState(const AppStateRecord& input) {
  return input.valid() && input.schema == 1 && input.size == 1 && input.payload[0] == 0;
}

}  // namespace

bool DiagnosticsApp::onEnter() {
  if (!display_.acquire(id())) return false;
  if (render()) return true;
  touch_.clearApp();
  display_.release(id());
  return false;
}

bool DiagnosticsApp::onExit() {
  touch_.clearApp();
  return display_.release(id());
}

bool DiagnosticsApp::render() {
  touch_.clearApp();
  if (!FrameIdentity::create("local-system", "shell-diagnostics-v1", 0,
                             Orientation::portrait, frame_) ||
      !display_.selectDesired(id(), frame_) ||
      !display_.commitCached(id(), frame_) ||
      !display_.presentDiagnostics(id(), frame_, snapshot_)) {
    return false;
  }
  return touch_.bindApp(id(), frame_, nullptr, 0);
}

AppInputResult DiagnosticsApp::onInput(const AppInputEvent& input) {
  if (input.kind != AppInputKind::touch) return AppInputResult::ignored;
  const DispatchResult result = touch_.dispatch(Point{input.x, input.y});
  return result.consumed ? AppInputResult::handled : AppInputResult::ignored;
}

bool DiagnosticsApp::saveState(AppStateRecord& output) const {
  return saveEmptyState(output);
}

bool DiagnosticsApp::restoreState(const AppStateRecord& input) {
  return restoreEmptyState(input);
}

bool SettingsApp::onEnter() {
  if (!display_.acquire(id())) return false;
  if (render()) return true;
  touch_.clearApp();
  display_.release(id());
  return false;
}

bool SettingsApp::onExit() {
  touch_.clearApp();
  return display_.release(id());
}

bool SettingsApp::render() {
  touch_.clearApp();
  if (!local_ui_.build(snapshot_) || !lvgl_.composeNow() ||
      !FrameIdentity::create("local-system", "settings-diagnostics-v2", 0,
                             Orientation::portrait, frame_) ||
      !display_.selectDesired(id(), frame_) ||
      !display_.commitCached(id(), frame_) ||
      !display_.presentComposedFrame(id(), frame_)) {
    return false;
  }
  return touch_.bindApp(id(), frame_, nullptr, 0);
}

AppInputResult SettingsApp::onInput(const AppInputEvent& input) {
  if (input.kind != AppInputKind::touch) return AppInputResult::ignored;
  const DispatchResult result = touch_.dispatch(Point{input.x, input.y});
  return result.consumed ? AppInputResult::handled : AppInputResult::ignored;
}

bool SettingsApp::saveState(AppStateRecord& output) const {
  return saveEmptyState(output);
}

bool SettingsApp::restoreState(const AppStateRecord& input) {
  return restoreEmptyState(input);
}

}  // namespace mooneink
