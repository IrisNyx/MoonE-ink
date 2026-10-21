// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/shell_input.hpp"

namespace mooneink {

ShellInputResult ShellInputRouter::translate(const AppInputResult result) {
  switch (result) {
    case AppInputResult::handled:
      return ShellInputResult::handled_app;
    case AppInputResult::ignored:
      return ShellInputResult::ignored;
    case AppInputResult::blocked:
      return ShellInputResult::blocked;
    case AppInputResult::failed:
      return ShellInputResult::failed;
  }
  return ShellInputResult::failed;
}

ShellInputResult ShellInputRouter::route(const ShellInputEvent& input) {
  if (input.kind == ShellInputKind::home_short) {
    if (!system_.systemPageOpen() && system_.appInputAllowed() &&
        apps_.active() != nullptr) {
      AppInputEvent back{};
      back.kind = AppInputKind::back;
      const AppInputResult result = apps_.dispatchInput(back);
      if (result != AppInputResult::ignored) return translate(result);
    }
    return system_.toggleSystemPage() ? ShellInputResult::handled_global
                                      : ShellInputResult::failed;
  }
  if (input.kind == ShellInputKind::home_long) {
    if (!system_.systemPageOpen() && system_.appInputAllowed()) {
      AppInputEvent engagement{};
      engagement.kind = AppInputKind::engagement;
      apps_.dispatchInput(engagement);
    }
    return system_.toggleSystemPage() ? ShellInputResult::handled_global
                                      : ShellInputResult::failed;
  }
  if (input.kind == ShellInputKind::light_toggle) {
    return system_.toggleWarmLight() ? ShellInputResult::handled_global
                                     : ShellInputResult::failed;
  }
  if (input.kind == ShellInputKind::touch && system_.systemPageOpen()) {
    return system_.handleSystemTouch(input.x, input.y)
               ? ShellInputResult::handled_global
               : ShellInputResult::ignored;
  }
  if (system_.systemPageOpen() || !system_.appInputAllowed()) {
    return ShellInputResult::blocked;
  }

  AppInputEvent app_input{};
  switch (input.kind) {
    case ShellInputKind::previous_page:
      app_input.kind = AppInputKind::previous_page;
      break;
    case ShellInputKind::next_page:
      app_input.kind = AppInputKind::next_page;
      break;
    case ShellInputKind::touch:
      app_input.kind = AppInputKind::touch;
      app_input.x = input.x;
      app_input.y = input.y;
      break;
    case ShellInputKind::home_short:
    case ShellInputKind::home_long:
    case ShellInputKind::light_toggle:
      return ShellInputResult::failed;
  }
  return translate(apps_.dispatchInput(app_input));
}

}  // namespace mooneink
