// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include "mooneink/display_backend.hpp"

namespace mooneink {

class M5GfxH75201Backend final : public DisplayBackend {
 public:
  bool begin() override;
  bool presentDiagnostics(const DiagnosticsSnapshot& snapshot) override;
  bool beginComposition() override;
  bool writeRgb565Area(std::int16_t x, std::int16_t y, std::uint16_t width,
                       std::uint16_t height, const std::uint16_t* pixels) override;
  bool endComposition() override;
  bool composeGray4Frame(const std::uint8_t* pixels, std::size_t byte_length,
                         std::uint16_t width, std::uint16_t height,
                         std::uint16_t stride_bytes) override;
  bool composeGray4FrameWithUnreadBadge(
      const std::uint8_t* pixels, std::size_t byte_length,
      std::uint16_t width, std::uint16_t height,
      std::uint16_t stride_bytes, std::uint32_t other_unread) override;
  bool composeEphemeraLocalView(const EphemeraLocalView& view) override;
  bool presentComposedFrame() override;
  std::uint16_t width() const override;
  std::uint16_t height() const override;

 private:
  bool composition_open_ = false;
};

}  // namespace mooneink

