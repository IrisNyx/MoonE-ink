// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>
#include <cstdint>

namespace mooneink {

struct DiagnosticsSnapshot final {
  const char* profile_id;
  std::uint32_t profile_revision;
  std::size_t psram_total;
  std::size_t psram_free;
  bool storage_layout_ok;
  bool touch_transform_ok;
  bool sd_available;
};

enum class EphemeraLocalViewKind : std::uint8_t { home, inbox };

struct EphemeraLocalRow final {
  const char* label = nullptr;
  const char* summary = nullptr;
  const char* genre = nullptr;
  std::uint16_t page_count = 0;
  bool unread = false;
};

struct EphemeraLocalView final {
  EphemeraLocalViewKind kind = EphemeraLocalViewKind::home;
  bool online = false;
  bool filter_unread = false;
  std::uint32_t unread_count = 0;
  const char* current_label = nullptr;
  const EphemeraLocalRow* rows = nullptr;
  std::size_t row_count = 0;
  std::uint16_t page_index = 0;
  std::uint16_t page_count = 1;
};

class DisplayBackend {
 public:
  virtual ~DisplayBackend() = default;
  virtual bool begin() = 0;
  virtual bool presentDiagnostics(const DiagnosticsSnapshot& snapshot) = 0;
  virtual bool beginComposition() = 0;
  virtual bool writeRgb565Area(std::int16_t x, std::int16_t y, std::uint16_t width,
                               std::uint16_t height, const std::uint16_t* pixels) = 0;
  virtual bool endComposition() = 0;
  virtual bool composeGray4Frame(const std::uint8_t* pixels, std::size_t byte_length,
                                 std::uint16_t width, std::uint16_t height,
                                 std::uint16_t stride_bytes) = 0;
  virtual bool composeGray4FrameWithUnreadBadge(
      const std::uint8_t* pixels, std::size_t byte_length,
      std::uint16_t width, std::uint16_t height,
      std::uint16_t stride_bytes, std::uint32_t other_unread) {
    (void)other_unread;
    return composeGray4Frame(pixels, byte_length, width, height, stride_bytes);
  }
  virtual bool composeEphemeraLocalView(const EphemeraLocalView&) { return false; }
  virtual bool presentComposedFrame() = 0;
  virtual std::uint16_t width() const = 0;
  virtual std::uint16_t height() const = 0;
};

}  // namespace mooneink

