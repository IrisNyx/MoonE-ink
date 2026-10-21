// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/reader_core.hpp"

#include <algorithm>
#include <cstring>

namespace mooneink {
namespace {

class ByteCursor final {
 public:
  ByteCursor(ReaderByteSource& source, const std::uint64_t start)
      : source_(source), offset_(start), chunk_start_(start) {}

  std::uint64_t position() const { return offset_; }
  bool failed() const { return failed_; }

  void seek(const std::uint64_t offset) {
    offset_ = offset;
    chunk_size_ = 0;
    chunk_pos_ = 0;
    chunk_start_ = offset;
    failed_ = false;
  }

  bool read(std::uint8_t& output) {
    if (offset_ >= source_.size()) return false;
    if (chunk_pos_ >= chunk_size_ ||
        offset_ < chunk_start_ || offset_ >= chunk_start_ + chunk_size_) {
      chunk_start_ = offset_;
      chunk_pos_ = 0;
      chunk_size_ = 0;
      if (!source_.readAt(offset_, chunk_.data(), chunk_.size(), chunk_size_) ||
          chunk_size_ == 0 || chunk_size_ > chunk_.size()) {
        failed_ = true;
        return false;
      }
    } else {
      chunk_pos_ = static_cast<std::size_t>(offset_ - chunk_start_);
    }
    output = chunk_[chunk_pos_++];
    ++offset_;
    return true;
  }

 private:
  ReaderByteSource& source_;
  std::uint64_t offset_ = 0;
  std::uint64_t chunk_start_ = 0;
  std::array<std::uint8_t, ReaderPaginator::read_chunk_bytes> chunk_{};
  std::size_t chunk_size_ = 0;
  std::size_t chunk_pos_ = 0;
  bool failed_ = false;
};

struct Decoded final {
  std::uint32_t codepoint = 0;
  std::array<std::uint8_t, 4> bytes{};
  std::uint8_t size = 0;
};

bool continuation(const std::uint8_t value) { return (value & 0xc0U) == 0x80U; }

ReaderStatus decodeUtf8(ByteCursor& cursor, Decoded& output) {
  output = Decoded{};
  std::uint8_t first = 0;
  if (!cursor.read(first)) return cursor.failed() ? ReaderStatus::io_error
                                                  : ReaderStatus::end_of_book;
  output.bytes[0] = first;
  output.size = 1;
  if (first <= 0x7fU) {
    output.codepoint = first;
    return ReaderStatus::ok;
  }

  std::uint8_t expected = 0;
  std::uint32_t value = 0;
  std::uint32_t minimum = 0;
  if (first >= 0xc2U && first <= 0xdfU) {
    expected = 2;
    value = first & 0x1fU;
    minimum = 0x80U;
  } else if (first >= 0xe0U && first <= 0xefU) {
    expected = 3;
    value = first & 0x0fU;
    minimum = 0x800U;
  } else if (first >= 0xf0U && first <= 0xf4U) {
    expected = 4;
    value = first & 0x07U;
    minimum = 0x10000U;
  } else {
    return ReaderStatus::invalid_utf8;
  }

  for (std::uint8_t index = 1; index < expected; ++index) {
    std::uint8_t next = 0;
    if (!cursor.read(next)) {
      return cursor.failed() ? ReaderStatus::io_error : ReaderStatus::invalid_utf8;
    }
    if (!continuation(next)) return ReaderStatus::invalid_utf8;
    output.bytes[index] = next;
    output.size = static_cast<std::uint8_t>(index + 1);
    value = (value << 6U) | (next & 0x3fU);
  }
  if (value < minimum || value > 0x10ffffU ||
      (value >= 0xd800U && value <= 0xdfffU)) {
    return ReaderStatus::invalid_utf8;
  }
  output.codepoint = value;
  return ReaderStatus::ok;
}

bool append(ReaderPage& page, const std::uint8_t* bytes, const std::size_t size) {
  if (bytes == nullptr || page.text_size + size > ReaderPage::text_capacity) return false;
  std::memcpy(page.text.data() + page.text_size, bytes, size);
  page.text_size += size;
  page.text[page.text_size] = '\0';
  return true;
}

bool appendNewline(ReaderPage& page) {
  const std::uint8_t newline = '\n';
  return append(page, &newline, 1);
}

bool isCombining(const std::uint32_t cp) {
  return (cp >= 0x0300U && cp <= 0x036fU) ||
         (cp >= 0x1ab0U && cp <= 0x1affU) ||
         (cp >= 0x1dc0U && cp <= 0x1dffU) ||
         (cp >= 0x20d0U && cp <= 0x20ffU) ||
         (cp >= 0xfe20U && cp <= 0xfe2fU) || cp == 0x200dU ||
         (cp >= 0xfe00U && cp <= 0xfe0fU);
}

std::uint16_t displayCells(const std::uint32_t cp, const std::uint16_t column) {
  if (isCombining(cp)) return 0;
  if (cp == '\t') return static_cast<std::uint16_t>(4U - (column % 4U));
  if ((cp >= 0x1100U && cp <= 0x115fU) || cp == 0x2329U || cp == 0x232aU ||
      (cp >= 0x2e80U && cp <= 0xa4cfU) ||
      (cp >= 0xac00U && cp <= 0xd7a3U) ||
      (cp >= 0xf900U && cp <= 0xfaffU) ||
      (cp >= 0xfe10U && cp <= 0xfe19U) ||
      (cp >= 0xfe30U && cp <= 0xfe6fU) ||
      (cp >= 0xff00U && cp <= 0xff60U) ||
      (cp >= 0xffe0U && cp <= 0xffe6U) ||
      (cp >= 0x20000U && cp <= 0x3fffdU)) {
    return 2;
  }
  return 1;
}

ReaderStatus skipLeadingBom(ByteCursor& cursor, const std::uint64_t size,
                            std::uint64_t& visible_start) {
  visible_start = 0;
  if (size == 0) return ReaderStatus::end_of_book;
  std::uint8_t first = 0;
  if (!cursor.read(first)) return cursor.failed() ? ReaderStatus::io_error
                                                  : ReaderStatus::end_of_book;
  if (first == 0xffU || first == 0xfeU) return ReaderStatus::unsupported_encoding;
  if (first != 0xefU || size < 3) {
    cursor.seek(0);
    return ReaderStatus::ok;
  }
  std::uint8_t second = 0;
  std::uint8_t third = 0;
  if (!cursor.read(second) || !cursor.read(third)) {
    return cursor.failed() ? ReaderStatus::io_error : ReaderStatus::invalid_utf8;
  }
  if (second == 0xbbU && third == 0xbfU) {
    visible_start = 3;
    return size == 3 ? ReaderStatus::end_of_book : ReaderStatus::ok;
  }
  cursor.seek(0);
  return ReaderStatus::ok;
}

}  // namespace

void ReaderPage::clear() {
  source_begin = 0;
  source_end = 0;
  line_count = 0;
  text_size = 0;
  has_more = false;
  text.fill('\0');
}

ReaderStatus ReaderPaginator::buildPage(ReaderByteSource& source,
                                        const std::uint64_t start_offset,
                                        const ReaderLayout& layout,
                                        ReaderPage& output,
                                        ReaderCancel cancel,
                                        void* cancel_context) const {
  output.clear();
  if (!source.present()) return ReaderStatus::source_missing;
  if (!layout.valid()) return ReaderStatus::layout_invalid;
  const std::uint64_t file_size = source.size();
  if (start_offset > file_size) return ReaderStatus::invalid_offset;
  if (start_offset == file_size && start_offset != 0) return ReaderStatus::end_of_book;

  ByteCursor cursor(source, start_offset);
  std::uint64_t visible_start = start_offset;
  if (start_offset == 0) {
    const ReaderStatus bom = skipLeadingBom(cursor, file_size, visible_start);
    if (bom != ReaderStatus::ok) return bom;
  }
  output.source_begin = visible_start;
  output.source_end = visible_start;
  output.line_count = 1;

  std::uint16_t cells = 0;
  std::size_t codepoints = 0;
  while (cursor.position() < file_size) {
    if ((codepoints++ % 128U) == 0U && cancel != nullptr && cancel(cancel_context)) {
      output.clear();
      return ReaderStatus::cancelled;
    }
    const std::uint64_t codepoint_start = cursor.position();
    Decoded decoded{};
    const ReaderStatus status = decodeUtf8(cursor, decoded);
    if (status != ReaderStatus::ok) {
      output.clear();
      return status;
    }

    if (decoded.codepoint == '\r' || decoded.codepoint == '\n') {
      if (decoded.codepoint == '\r' && cursor.position() < file_size) {
        const std::uint64_t after_cr = cursor.position();
        std::uint8_t next = 0;
        if (!cursor.read(next)) {
          if (cursor.failed()) {
            output.clear();
            return ReaderStatus::io_error;
          }
        } else if (next != '\n') {
          cursor.seek(after_cr);
        }
      }
      if (!appendNewline(output)) {
        output.clear();
        return ReaderStatus::page_buffer_full;
      }
      output.source_end = cursor.position();
      if (output.line_count >= layout.lines_per_page) {
        output.has_more = cursor.position() < file_size;
        return ReaderStatus::ok;
      }
      ++output.line_count;
      cells = 0;
      continue;
    }

    if (decoded.codepoint < 0x20U && decoded.codepoint != '\t') {
      output.clear();
      return ReaderStatus::invalid_utf8;
    }
    const std::uint16_t width = displayCells(decoded.codepoint, cells);
    if (cells != 0 && static_cast<std::uint32_t>(cells) + width > layout.cells_per_line) {
      cursor.seek(codepoint_start);
      if (output.line_count >= layout.lines_per_page) {
        output.source_end = codepoint_start;
        output.has_more = true;
        return ReaderStatus::ok;
      }
      if (!appendNewline(output)) {
        output.clear();
        return ReaderStatus::page_buffer_full;
      }
      ++output.line_count;
      cells = 0;
      continue;
    }
    if (!append(output, decoded.bytes.data(), decoded.size)) {
      output.clear();
      return ReaderStatus::page_buffer_full;
    }
    cells = static_cast<std::uint16_t>(cells + width);
    output.source_end = cursor.position();
  }
  output.has_more = false;
  return ReaderStatus::ok;
}

ReaderStatus computeReaderBookIdentity(ReaderByteSource& source,
                                       ReaderBookIdentity& output,
                                       ReaderCancel cancel,
                                       void* cancel_context) {
  output = ReaderBookIdentity{};
  if (!source.present()) return ReaderStatus::source_missing;
  constexpr std::uint64_t offset_basis = 14695981039346656037ULL;
  constexpr std::uint64_t prime = 1099511628211ULL;
  std::array<std::uint8_t, 512> chunk{};
  std::uint64_t hash = offset_basis;
  std::uint64_t offset = 0;
  const std::uint64_t size = source.size();
  while (offset < size) {
    if (cancel != nullptr && cancel(cancel_context)) return ReaderStatus::cancelled;
    std::size_t actual = 0;
    if (!source.readAt(offset, chunk.data(), chunk.size(), actual) || actual == 0 ||
        actual > chunk.size() || offset + actual > size) {
      return ReaderStatus::io_error;
    }
    for (std::size_t index = 0; index < actual; ++index) {
      hash ^= chunk[index];
      hash *= prime;
    }
    offset += actual;
  }
  output.algorithm = ReaderBookIdentity::algorithm_fnv1a64_v1;
  output.file_size = size;
  output.content_hash = hash;
  return ReaderStatus::ok;
}

bool ReaderPageIndex::compatible(const ReaderBookIdentity& identity,
                                 const ReaderLayout& layout) const {
  return identity.valid() && layout.valid() && identity_ == identity &&
         layout_revision_ == layout.revision &&
         font_revision_ == layout.font_revision;
}

bool ReaderPageIndex::bind(const ReaderBookIdentity& identity,
                           const ReaderLayout& layout) {
  if (!identity.valid() || !layout.valid()) return false;
  if (compatible(identity, layout)) return true;
  invalidate();
  identity_ = identity;
  layout_revision_ = layout.revision;
  font_revision_ = layout.font_revision;
  return true;
}

bool ReaderPageIndex::remember(const std::uint64_t page_start) {
  if (!identity_.valid()) return false;
  if (count_ != 0) {
    if (offsets_[count_ - 1] == page_start) return true;
    if (offsets_[count_ - 1] > page_start) return false;
  }
  if (count_ == offsets_.size()) {
    // Keep the recent navigation window bounded. Page zero can always be
    // reconstructed and the caller can scan forward from its nearest retained
    // checkpoint when navigating beyond this window.
    for (std::size_t index = 1; index < count_; ++index) {
      offsets_[index - 1] = offsets_[index];
    }
    --count_;
  }
  offsets_[count_++] = page_start;
  return true;
}

bool ReaderPageIndex::previous(const std::uint64_t current_start,
                               std::uint64_t& page_start) const {
  if (!identity_.valid() || count_ == 0) return false;
  for (std::size_t index = count_; index > 0; --index) {
    if (offsets_[index - 1] < current_start) {
      page_start = offsets_[index - 1];
      return true;
    }
  }
  return false;
}

bool ReaderPageIndex::nearestAtOrBefore(const std::uint64_t target,
                                        std::uint64_t& page_start) const {
  if (!identity_.valid() || count_ == 0) return false;
  for (std::size_t index = count_; index > 0; --index) {
    if (offsets_[index - 1] <= target) {
      page_start = offsets_[index - 1];
      return true;
    }
  }
  return false;
}

void ReaderPageIndex::invalidate() {
  identity_ = ReaderBookIdentity{};
  layout_revision_ = 0;
  font_revision_ = 0;
  offsets_.fill(0);
  count_ = 0;
}

}  // namespace mooneink
