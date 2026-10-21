// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>
#include <cstdint>

namespace mooneink {

struct BoardProfile final {
  static constexpr const char* id = "lilygo-t5-47-s3-pro-lite-h752-01";
  static constexpr std::uint32_t revision = 1;
  static constexpr std::uint16_t portrait_width = 540;
  static constexpr std::uint16_t portrait_height = 960;
  static constexpr std::size_t gray4_frame_bytes = 259200;
  static constexpr std::size_t flash_bytes = 16U * 1024U * 1024U;
  static constexpr std::size_t psram_bytes = 8U * 1024U * 1024U;
  // ESP.getPsramSize() reports allocator-visible capacity. Arduino/IDF reserves a
  // small implementation-dependent prefix, so validate the detected 8 MiB part
  // with bounded headroom instead of requiring every nominal byte to be allocatable.
  static constexpr std::size_t psram_min_usable_bytes = psram_bytes - (64U * 1024U);
  static constexpr std::size_t app0_bytes = 5U * 1024U * 1024U;

  static constexpr int i2c_sda = 39;
  static constexpr int i2c_scl = 40;
  static constexpr int touch_irq = 3;
  static constexpr int touch_reset = 9;
  static constexpr int boot_button = 0;
  static constexpr int warm_light = 11;
  static constexpr int pca9535_interrupt = 38;
  static constexpr std::uint8_t pca9535_address = 0x20;
  static constexpr std::uint8_t pca9535_input_port_1 = 0x01;
  static constexpr std::uint8_t pca9535_function_button_bit = 2;

  static constexpr bool timer_wake_verified = true;
  static constexpr bool button_wake_verified = true;
  static constexpr bool touch_wake_verified = false;
  static constexpr bool sd_card_verified = false;
};

static_assert(BoardProfile::portrait_width * BoardProfile::portrait_height / 2 ==
              BoardProfile::gray4_frame_bytes);

}  // namespace mooneink

