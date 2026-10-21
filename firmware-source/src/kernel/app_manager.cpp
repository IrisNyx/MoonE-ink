// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/app_manager.hpp"

#include <cstring>

namespace mooneink {
namespace {

bool copyId(const char* source,
            std::array<char, AppManager::id_capacity>& destination) {
  if (source == nullptr || *source == '\0') return false;
  const std::size_t length = std::strlen(source);
  if (length >= destination.size()) return false;
  destination.fill('\0');
  std::memcpy(destination.data(), source, length);
  return true;
}

}  // namespace

AppManager::Slot* AppManager::find(const char* id) {
  if (id == nullptr) return nullptr;
  for (std::size_t i = 0; i < count_; ++i) {
    if (std::strcmp(apps_[i].id.data(), id) == 0) return &apps_[i];
  }
  return nullptr;
}

const AppManager::Slot* AppManager::find(const char* id) const {
  if (id == nullptr) return nullptr;
  for (std::size_t i = 0; i < count_; ++i) {
    if (std::strcmp(apps_[i].id.data(), id) == 0) return &apps_[i];
  }
  return nullptr;
}

bool AppManager::registerApp(App& app) {
  const char* const id = app.id();
  if (count_ == max_apps || find(id) != nullptr) return false;
  Slot candidate{};
  if (!copyId(id, candidate.id)) return false;
  candidate.app = &app;
  apps_[count_++] = candidate;
  return true;
}

bool AppManager::capture(Slot& slot) {
  AppStateRecord candidate{};
  if (slot.app == nullptr || !slot.app->saveState(candidate) || !candidate.valid()) {
    return false;
  }
  slot.state = candidate;
  slot.has_state = true;
  return true;
}

bool AppManager::restorePrevious(Slot& previous) {
  if (previous.has_state && !previous.app->restoreState(previous.state)) return false;
  if (!previous.app->onEnter()) return false;
  active_ = &previous;
  ++activation_generation_;
  return true;
}

bool AppManager::activate(const char* id) {
  Slot* const target = find(id);
  if (target == nullptr || target->app == nullptr || !target->app->available()) return false;
  if (target == active_) return true;

  Slot* const previous = active_;
  if (previous != nullptr) {
    if (!capture(*previous) || !previous->app->onExit()) {
      events_.publish(EventKind::app_activation_failed);
      return false;
    }
    active_ = nullptr;
    ++activation_generation_;
    events_.publish(EventKind::app_deactivated);
  }

  if (target->restore_pending) {
    target->restore_pending = false;
    if (!target->app->restoreState(target->state)) {
      target->has_state = false;
      target->state.clear();
      if (previous != nullptr) restorePrevious(*previous);
      events_.publish(EventKind::app_activation_failed);
      return false;
    }
  }

  if (!target->app->onEnter()) {
    if (previous != nullptr) restorePrevious(*previous);
    events_.publish(EventKind::app_activation_failed);
    return false;
  }

  active_ = target;
  ++activation_generation_;
  const std::size_t index = static_cast<std::size_t>(target - apps_.data());
  events_.publish(EventKind::app_activated, static_cast<std::int32_t>(index));
  return true;
}

bool AppManager::activateHome(const char* id) {
  Slot* const target = find(id);
  if (target == nullptr || target->app == nullptr || !target->app->available()) {
    return false;
  }
  target->app->prepareHome();
  if (target == active_) return target->app->showHome();
  return activate(id);
}

AppInputResult AppManager::dispatchInput(const AppInputEvent& input) {
  if (active_ == nullptr || active_->app == nullptr) return AppInputResult::blocked;
  return active_->app->onInput(input);
}

bool AppManager::deliverEvent(const char* id, const AppEvent& event) {
  Slot* const target = find(id);
  if (target == nullptr || target->app == nullptr) return false;
  target->app->onEvent(event);
  return true;
}

bool AppManager::saveActiveState() {
  return active_ != nullptr && capture(*active_);
}

bool AppManager::captureState(const char* id, AppStateRecord& output) {
  Slot* const target = find(id);
  if (target == nullptr || !capture(*target)) return false;
  output = target->state;
  return true;
}

bool AppManager::stageState(const char* id, const AppStateRecord& input) {
  Slot* const target = find(id);
  if (target == nullptr || !input.valid() || target == active_) return false;
  target->state = input;
  target->has_state = true;
  target->restore_pending = true;
  return true;
}

void AppManager::onWake() {
  for (std::size_t i = 0; i < count_; ++i) apps_[i].app->onWake();
}

bool AppManager::onSleep() {
  if (active_ != nullptr && !capture(*active_)) return false;
  for (std::size_t i = 0; i < count_; ++i) apps_[i].app->onSleep();
  return true;
}

const char* AppManager::activeApp() const {
  return active_ == nullptr ? nullptr : active_->id.data();
}

App* AppManager::active() const { return active_ == nullptr ? nullptr : active_->app; }

AppActivationToken AppManager::activeToken() const {
  return AppActivationToken{active(), activation_generation_};
}

bool AppManager::isActive(const AppActivationToken& token) const {
  return token.app != nullptr && token.app == active() &&
         token.generation == activation_generation_;
}

bool AppManager::isAvailable(const char* id) const {
  const Slot* const slot = find(id);
  return slot != nullptr && slot->app != nullptr && slot->app->available();
}

}  // namespace mooneink
