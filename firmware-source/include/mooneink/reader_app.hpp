// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include "mooneink/app_manager.hpp"
#include "mooneink/display_manager.hpp"
#include "mooneink/local_ui.hpp"
#include "mooneink/lvgl_port.hpp"
#include "mooneink/reader_core.hpp"
#include "mooneink/touch_manager.hpp"

namespace mooneink {

// Native local-TXT App. The board-specific TF adapter supplies a random-access
// source only after it has stream-confirmed the content identity. With no card
// or no confirmed book, the App remains launchable and shows a safe local hint.
class ReaderApp final : public App {
 public:
  ReaderApp(DisplayManager& display, TouchManager& touch, LvglPort& lvgl,
            LocalUi& local_ui)
      : display_(display), touch_(touch), lvgl_(lvgl), local_ui_(local_ui) {}

  const char* id() const override { return "reader"; }
  bool onEnter() override;
  bool onExit() override;
  bool render() override;
  AppInputResult onInput(const AppInputEvent& input) override;
  void onEvent(const AppEvent& event) override;
  bool saveState(AppStateRecord& output) const override;
  bool restoreState(const AppStateRecord& input) override;

  bool attachSource(ReaderByteSource& source,
                    const ReaderBookIdentity& confirmed_identity);
  void detachSource();
  std::uint64_t presentedOffset() const { return presented_offset_; }

 private:
  static constexpr std::uint16_t previous_action = 201;
  static constexpr std::uint16_t next_action = 202;

  bool showUnavailable(const char* reason);
  bool showPage(std::uint64_t offset);
  bool findPreviousPage(std::uint64_t current, std::uint64_t& previous);
  AppInputResult navigate(bool next);

  DisplayManager& display_;
  TouchManager& touch_;
  LvglPort& lvgl_;
  LocalUi& local_ui_;
  ReaderByteSource* source_ = nullptr;
  ReaderBookIdentity identity_{};
  ReaderLayout layout_{};
  ReaderPaginator paginator_{};
  ReaderPageIndex index_{};
  ReaderPage page_{};
  FrameIdentity frame_{};
  std::uint64_t presented_offset_ = 0;
  bool page_valid_ = false;
  ReaderBookIdentity pending_identity_{};
  std::uint64_t pending_offset_ = 0;
  bool restore_pending_ = false;
};

}  // namespace mooneink
