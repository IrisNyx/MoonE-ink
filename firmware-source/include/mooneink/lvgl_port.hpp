// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>

#include <lvgl.h>

#include "mooneink/display_backend.hpp"

namespace mooneink {

class LvglPort final {
 public:
  explicit LvglPort(DisplayBackend& backend) : backend_(backend) {}

  bool begin();
  bool composeNow();
  std::size_t drawBufferBytes() const { return draw_buffer_bytes_; }

 private:
  static constexpr std::size_t draw_buffer_rows = 40;
  static void flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* colors);

  DisplayBackend& backend_;
  lv_disp_draw_buf_t draw_buffer_{};
  lv_disp_drv_t driver_{};
  lv_disp_t* display_ = nullptr;
  lv_color_t* buffer_a_ = nullptr;
  lv_color_t* buffer_b_ = nullptr;
  std::size_t draw_buffer_bytes_ = 0;
  bool flush_ok_ = true;
  bool started_ = false;
};

}  // namespace mooneink
