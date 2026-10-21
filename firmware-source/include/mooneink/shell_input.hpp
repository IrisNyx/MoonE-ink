// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstdint>

#include "mooneink/app_manager.hpp"

namespace mooneink {

enum class ShellInputKind : std::uint8_t {
  home_short,
  home_long,
  light_toggle,
  previous_page,
  next_page,
  touch,
};

struct ShellInputEvent final {
  ShellInputKind kind = ShellInputKind::touch;
  std::int16_t x = 0;
  std::int16_t y = 0;
};

enum class ShellInputResult : std::uint8_t {
  handled_global,
  handled_app,
  ignored,
  blocked,
  failed,
};

class SystemInputHandler {
 public:
  virtual ~SystemInputHandler() = default;
  virtual bool toggleWarmLight() = 0;
  virtual bool toggleSystemPage() = 0;
  virtual bool handleSystemTouch(std::int16_t x, std::int16_t y) = 0;
  virtual bool systemPageOpen() const = 0;
  virtual bool appInputAllowed() const = 0;
};

// A short Home press first offers the foreground App a local back action and
// opens the system home when the App is already at its root. Long Home always
// owns the system-home action. The warm light has its own Shell action. Page
// and touch input is delivered only to the foreground App and is blocked by a
// modal system page or an in-progress display commit.
class ShellInputRouter final {
 public:
  ShellInputRouter(AppManager& apps, SystemInputHandler& system)
      : apps_(apps), system_(system) {}

  ShellInputResult route(const ShellInputEvent& input);

 private:
  static ShellInputResult translate(AppInputResult result);

  AppManager& apps_;
  SystemInputHandler& system_;
};

}  // namespace mooneink
