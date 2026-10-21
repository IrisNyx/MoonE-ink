// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/event_bus.hpp"

namespace mooneink {

enum class AppInputKind : std::uint8_t {
  // Ask the foreground App to leave its current nested view. Apps that do not
  // expose a nested view ignore this so the Shell can open the system home.
  back,
  previous_page,
  next_page,
  touch,
  action,
  // A Shell-owned key was used while this App's physical page was visible.
  // The App may observe the engagement without taking over the key's global
  // behavior (for example long Home still opens the system home).
  engagement,
};

struct AppInputEvent final {
  AppInputKind kind = AppInputKind::touch;
  std::int16_t x = 0;
  std::int16_t y = 0;
  std::uint16_t action_id = 0;
};

enum class AppInputResult : std::uint8_t {
  ignored,
  handled,
  blocked,
  failed,
};

enum class AppEventKind : std::uint8_t {
  background_offer,
  connectivity_changed,
  storage_changed,
};

struct AppEvent final {
  AppEventKind kind = AppEventKind::connectivity_changed;
  std::int32_t value = 0;
};

// A bounded, versioned record that can later be persisted by M7. AppManager
// never allocates per-App state and never interprets an App's payload.
struct AppStateRecord final {
  static constexpr std::size_t payload_capacity = 192;

  std::uint16_t schema = 0;
  std::uint16_t size = 0;
  std::array<std::uint8_t, payload_capacity> payload{};

  bool valid() const { return schema != 0 && size <= payload.size(); }
  void clear() {
    schema = 0;
    size = 0;
    payload.fill(0);
  }
};

class App {
 public:
  virtual ~App() = default;

  virtual const char* id() const = 0;
  virtual bool available() const { return true; }
  virtual bool onEnter() = 0;
  virtual bool onExit() = 0;
  virtual bool render() = 0;
  // The launcher may ask an App for its own landing page before activation.
  // Apps without a separate home keep their normal render behavior.
  virtual void prepareHome() {}
  virtual bool showHome() { return render(); }
  virtual AppInputResult onInput(const AppInputEvent& input) = 0;
  virtual void onEvent(const AppEvent&) {}
  virtual void onWake() {}
  virtual void onSleep() {}
  virtual bool saveState(AppStateRecord& output) const = 0;
  virtual bool restoreState(const AppStateRecord& input) = 0;
};

struct AppActivationToken final {
  constexpr AppActivationToken(const App* target = nullptr,
                               std::uint32_t value = 0)
      : app(target), generation(value) {}

  const App* app;
  std::uint32_t generation;
};

class AppManager final {
 public:
  static constexpr std::size_t max_apps = 8;
  static constexpr std::size_t id_capacity = 33;

  explicit AppManager(EventBus& events) : events_(events) {}

  bool registerApp(App& app);
  bool activate(const char* id);
  bool activateHome(const char* id);
  AppInputResult dispatchInput(const AppInputEvent& input);
  bool deliverEvent(const char* id, const AppEvent& event);
  bool saveActiveState();
  bool captureState(const char* id, AppStateRecord& output);
  bool stageState(const char* id, const AppStateRecord& input);
  void onWake();
  bool onSleep();

  const char* activeApp() const;
  App* active() const;
  AppActivationToken activeToken() const;
  bool isActive(const AppActivationToken& token) const;
  bool isAvailable(const char* id) const;
  std::size_t appCount() const { return count_; }

 private:
  struct Slot final {
    std::array<char, id_capacity> id{};
    App* app = nullptr;
    AppStateRecord state{};
    bool has_state = false;
    bool restore_pending = false;
  };

  Slot* find(const char* id);
  const Slot* find(const char* id) const;
  bool capture(Slot& slot);
  bool restorePrevious(Slot& previous);

  EventBus& events_;
  std::array<Slot, max_apps> apps_{};
  std::size_t count_ = 0;
  Slot* active_ = nullptr;
  std::uint32_t activation_generation_ = 0;
};

}  // namespace mooneink
