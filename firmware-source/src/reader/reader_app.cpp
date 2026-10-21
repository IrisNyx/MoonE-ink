// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/reader_app.hpp"

#include <cstdio>
#include <cstring>

namespace mooneink {
namespace {

void put64(std::uint8_t* output, const std::uint64_t value) {
  for (std::size_t index = 0; index < 8; ++index) {
    output[index] = static_cast<std::uint8_t>((value >> (index * 8U)) & 0xffU);
  }
}

std::uint64_t get64(const std::uint8_t* input) {
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < 8; ++index) {
    value |= static_cast<std::uint64_t>(input[index]) << (index * 8U);
  }
  return value;
}

const char* readerError(const ReaderStatus status) {
  switch (status) {
    case ReaderStatus::unsupported_encoding:
      return "UTF-8 TXT REQUIRED";
    case ReaderStatus::invalid_utf8:
      return "INVALID UTF-8";
    case ReaderStatus::io_error:
      return "TF READ FAILED";
    case ReaderStatus::cancelled:
      return "READ CANCELLED";
    case ReaderStatus::page_buffer_full:
      return "PAGE LIMIT REACHED";
    case ReaderStatus::end_of_book:
      return "EMPTY TXT";
    default:
      return "BOOK UNAVAILABLE";
  }
}

}  // namespace

bool ReaderApp::attachSource(ReaderByteSource& source,
                             const ReaderBookIdentity& confirmed_identity) {
  if (!source.present() || !confirmed_identity.valid() ||
      confirmed_identity.file_size != source.size() ||
      !index_.bind(confirmed_identity, layout_)) {
    return false;
  }
  source_ = &source;
  identity_ = confirmed_identity;
  presented_offset_ = 0;
  page_valid_ = false;
  if (restore_pending_) {
    if (pending_identity_ == identity_ && pending_offset_ <= identity_.file_size) {
      presented_offset_ = pending_offset_;
    }
    restore_pending_ = false;
    pending_identity_ = ReaderBookIdentity{};
    pending_offset_ = 0;
  }
  return true;
}

void ReaderApp::detachSource() {
  source_ = nullptr;
  identity_ = ReaderBookIdentity{};
  index_.invalidate();
  page_.clear();
  page_valid_ = false;
  presented_offset_ = 0;
}

bool ReaderApp::onEnter() {
  if (!display_.acquire(id())) return false;
  if (render()) return true;
  touch_.clearApp();
  display_.release(id());
  return false;
}

bool ReaderApp::onExit() {
  touch_.clearApp();
  return display_.release(id());
}

bool ReaderApp::showUnavailable(const char* reason) {
  touch_.clearApp();
  if (!local_ui_.buildReaderUnavailable(reason) || !lvgl_.composeNow() ||
      !FrameIdentity::create("local-reader", "reader-unavailable-v1", 0,
                             Orientation::portrait, frame_) ||
      !display_.selectDesired(id(), frame_) ||
      !display_.commitCached(id(), frame_) ||
      !display_.presentComposedFrame(id(), frame_)) {
    return false;
  }
  return touch_.bindApp(id(), frame_, nullptr, 0);
}

bool ReaderApp::showPage(const std::uint64_t offset) {
  if (source_ == nullptr || !identity_.valid()) return showUnavailable("INSERT TF CARD");
  ReaderPage candidate{};
  const ReaderStatus status = paginator_.buildPage(*source_, offset, layout_, candidate);
  if (status != ReaderStatus::ok) return showUnavailable(readerError(status));

  char frame_id[64]{};
  std::snprintf(frame_id, sizeof(frame_id), "reader-%016llx-%016llx",
                static_cast<unsigned long long>(identity_.content_hash),
                static_cast<unsigned long long>(candidate.source_begin));
  FrameIdentity candidate_frame{};
  if (!local_ui_.buildReaderPage(candidate.text.data(), candidate.source_begin,
                                 identity_.file_size, candidate.has_more) ||
      !lvgl_.composeNow() ||
      !FrameIdentity::create("local-reader", frame_id,
                             static_cast<std::uint16_t>(index_.size()),
                             Orientation::portrait, candidate_frame) ||
      !display_.selectDesired(id(), candidate_frame) ||
      !display_.commitCached(id(), candidate_frame) ||
      !display_.presentComposedFrame(id(), candidate_frame)) {
    return false;
  }

  const HitRegion regions[] = {
      {0, 0, 120, 960, previous_action},
      {420, 0, 120, 960, next_action},
  };
  if (!touch_.bindApp(id(), candidate_frame, regions,
                      sizeof(regions) / sizeof(regions[0]))) {
    return false;
  }
  // The source offset advances only after physical presentation and input
  // binding both succeed. A failed flip therefore retains the previous state.
  page_ = candidate;
  frame_ = candidate_frame;
  presented_offset_ = candidate.source_begin;
  page_valid_ = true;
  index_.remember(candidate.source_begin);
  return true;
}

bool ReaderApp::render() {
  if (source_ == nullptr || !source_->present()) return showUnavailable("INSERT TF CARD");
  return showPage(presented_offset_);
}

AppInputResult ReaderApp::navigate(const bool next) {
  if (!page_valid_ || source_ == nullptr) return AppInputResult::blocked;
  std::uint64_t target = 0;
  if (next) {
    if (!page_.has_more || page_.source_end <= page_.source_begin) {
      return AppInputResult::blocked;
    }
    target = page_.source_end;
  } else if (!findPreviousPage(page_.source_begin, target)) {
    return AppInputResult::blocked;
  }
  return showPage(target) ? AppInputResult::handled : AppInputResult::failed;
}

bool ReaderApp::findPreviousPage(const std::uint64_t current,
                                 std::uint64_t& previous) {
  if (source_ == nullptr || current == 0) return false;
  std::uint64_t candidate = 0;
  if (!index_.previous(current, candidate)) candidate = 0;
  for (;;) {
    ReaderPage rebuilt{};
    if (paginator_.buildPage(*source_, candidate, layout_, rebuilt) !=
            ReaderStatus::ok ||
        rebuilt.source_end <= candidate || rebuilt.source_end > current) {
      return false;
    }
    index_.remember(rebuilt.source_begin);
    if (rebuilt.source_end == current) {
      previous = rebuilt.source_begin;
      return true;
    }
    candidate = rebuilt.source_end;
  }
}

AppInputResult ReaderApp::onInput(const AppInputEvent& input) {
  if (input.kind == AppInputKind::previous_page) return navigate(false);
  if (input.kind == AppInputKind::next_page) return navigate(true);
  if (input.kind == AppInputKind::touch) {
    const DispatchResult result = touch_.dispatch(Point{input.x, input.y});
    if (!result.consumed) return AppInputResult::ignored;
    if (result.action_id == previous_action) return navigate(false);
    if (result.action_id == next_action) return navigate(true);
  }
  return AppInputResult::ignored;
}

void ReaderApp::onEvent(const AppEvent& event) {
  if (event.kind == AppEventKind::storage_changed && event.value == 0) detachSource();
}

bool ReaderApp::saveState(AppStateRecord& output) const {
  output.clear();
  if (!identity_.valid()) {
    output.schema = 1;
    output.size = 1;
    output.payload[0] = 0;
    return true;
  }
  output.schema = 2;
  output.size = 27;
  output.payload[0] = 1;
  output.payload[1] = static_cast<std::uint8_t>(identity_.algorithm & 0xffU);
  output.payload[2] = static_cast<std::uint8_t>((identity_.algorithm >> 8U) & 0xffU);
  put64(output.payload.data() + 3, identity_.file_size);
  put64(output.payload.data() + 11, identity_.content_hash);
  put64(output.payload.data() + 19, presented_offset_);
  return true;
}

bool ReaderApp::restoreState(const AppStateRecord& input) {
  if (!input.valid()) return false;
  if (input.schema == 1 && input.size == 1 && input.payload[0] == 0) return true;
  if (input.schema != 2 || input.size != 27 || input.payload[0] != 1) return false;
  ReaderBookIdentity restored{};
  restored.algorithm = static_cast<std::uint16_t>(input.payload[1]) |
                       (static_cast<std::uint16_t>(input.payload[2]) << 8U);
  restored.file_size = get64(input.payload.data() + 3);
  restored.content_hash = get64(input.payload.data() + 11);
  const std::uint64_t offset = get64(input.payload.data() + 19);
  if (!restored.valid() || offset > restored.file_size) return false;
  if (identity_.valid()) {
    if (restored != identity_) return true;
    presented_offset_ = offset;
    page_valid_ = false;
    return true;
  }
  pending_identity_ = restored;
  pending_offset_ = offset;
  restore_pending_ = true;
  return true;
}

}  // namespace mooneink
