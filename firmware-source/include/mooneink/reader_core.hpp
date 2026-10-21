// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace mooneink {

enum class ReaderStatus : std::uint8_t {
  ok,
  end_of_book,
  source_missing,
  io_error,
  invalid_offset,
  invalid_utf8,
  unsupported_encoding,
  layout_invalid,
  page_buffer_full,
  cancelled,
};

class ReaderByteSource {
 public:
  virtual ~ReaderByteSource() = default;
  virtual bool present() const = 0;
  virtual std::uint64_t size() const = 0;
  // Reads at most capacity bytes from an absolute raw-file offset. A successful
  // short read is allowed only at EOF; zero bytes before EOF is an I/O error.
  virtual bool readAt(std::uint64_t offset, std::uint8_t* output,
                      std::size_t capacity, std::size_t& actual_size) = 0;
};

struct ReaderLayout final {
  static constexpr std::uint16_t max_cells_limit = 80;
  static constexpr std::uint16_t max_lines_limit = 48;

  std::uint16_t cells_per_line = 36;
  std::uint16_t lines_per_page = 30;
  std::uint32_t revision = 1;
  std::uint32_t font_revision = 1;

  bool valid() const {
    return cells_per_line >= 2 && cells_per_line <= max_cells_limit &&
           lines_per_page >= 1 && lines_per_page <= max_lines_limit &&
           revision != 0 && font_revision != 0;
  }
};

struct ReaderPage final {
  static constexpr std::size_t text_capacity = 8192;

  std::uint64_t source_begin = 0;
  std::uint64_t source_end = 0;
  std::uint16_t line_count = 0;
  std::size_t text_size = 0;
  bool has_more = false;
  std::array<char, text_capacity + 1> text{};

  void clear();
};

using ReaderCancel = bool (*)(void* context);

class ReaderPaginator final {
 public:
  static constexpr std::size_t read_chunk_bytes = 256;

  ReaderStatus buildPage(ReaderByteSource& source, std::uint64_t start_offset,
                         const ReaderLayout& layout, ReaderPage& output,
                         ReaderCancel cancel = nullptr,
                         void* cancel_context = nullptr) const;
};

struct ReaderBookIdentity final {
  static constexpr std::uint16_t algorithm_fnv1a64_v1 = 1;

  std::uint16_t algorithm = 0;
  std::uint64_t file_size = 0;
  std::uint64_t content_hash = 0;

  bool valid() const { return algorithm == algorithm_fnv1a64_v1; }
  bool operator==(const ReaderBookIdentity& other) const {
    return algorithm == other.algorithm && file_size == other.file_size &&
           content_hash == other.content_hash;
  }
  bool operator!=(const ReaderBookIdentity& other) const { return !(*this == other); }
};

ReaderStatus computeReaderBookIdentity(ReaderByteSource& source,
                                       ReaderBookIdentity& output,
                                       ReaderCancel cancel = nullptr,
                                       void* cancel_context = nullptr);

// A bounded acceleration cache only. Reader progress is stored separately and
// remains valid without it. Rebinding to changed content/layout drops every
// cached page start, so same-name card replacement cannot inherit old pages.
class ReaderPageIndex final {
 public:
  static constexpr std::size_t max_entries = 128;

  bool bind(const ReaderBookIdentity& identity, const ReaderLayout& layout);
  bool remember(std::uint64_t page_start);
  bool previous(std::uint64_t current_start, std::uint64_t& page_start) const;
  bool nearestAtOrBefore(std::uint64_t target, std::uint64_t& page_start) const;
  bool compatible(const ReaderBookIdentity& identity,
                  const ReaderLayout& layout) const;
  void invalidate();
  std::size_t size() const { return count_; }

 private:
  ReaderBookIdentity identity_{};
  std::uint32_t layout_revision_ = 0;
  std::uint32_t font_revision_ = 0;
  std::array<std::uint64_t, max_entries> offsets_{};
  std::size_t count_ = 0;
};

}  // namespace mooneink
