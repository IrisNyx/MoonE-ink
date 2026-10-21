// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/lvgl_port.hpp"

#include <Arduino.h>
#include <esp_heap_caps.h>

#include <cstdint>

namespace mooneink {

bool LvglPort::begin() {
  if (started_ || backend_.width() == 0 || backend_.height() == 0 || sizeof(lv_color_t) != 2) {
    return false;
  }

  lv_init();
  const std::size_t pixel_count = static_cast<std::size_t>(backend_.width()) * draw_buffer_rows;
  draw_buffer_bytes_ = pixel_count * sizeof(lv_color_t) * 2;
  buffer_a_ = static_cast<lv_color_t*>(
      heap_caps_malloc(pixel_count * sizeof(lv_color_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  buffer_b_ = static_cast<lv_color_t*>(
      heap_caps_malloc(pixel_count * sizeof(lv_color_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (buffer_a_ == nullptr || buffer_b_ == nullptr) {
    if (buffer_a_ != nullptr) heap_caps_free(buffer_a_);
    if (buffer_b_ != nullptr) heap_caps_free(buffer_b_);
    buffer_a_ = nullptr;
    buffer_b_ = nullptr;
    return false;
  }

  lv_disp_draw_buf_init(&draw_buffer_, buffer_a_, buffer_b_, pixel_count);
  lv_disp_drv_init(&driver_);
  driver_.hor_res = backend_.width();
  driver_.ver_res = backend_.height();
  driver_.draw_buf = &draw_buffer_;
  driver_.flush_cb = flush;
  driver_.user_data = this;
  display_ = lv_disp_drv_register(&driver_);
  started_ = display_ != nullptr;
  return started_;
}

bool LvglPort::composeNow() {
  if (!started_ || display_ == nullptr || !backend_.beginComposition()) return false;
  flush_ok_ = true;
  lv_obj_invalidate(lv_scr_act());
  lv_refr_now(display_);
  const bool ended = backend_.endComposition();
  return flush_ok_ && ended;
}

void LvglPort::flush(lv_disp_drv_t* driver, const lv_area_t* area, lv_color_t* colors) {
  LvglPort* self = driver == nullptr ? nullptr : static_cast<LvglPort*>(driver->user_data);
  if (self == nullptr || area == nullptr || colors == nullptr) {
    if (driver != nullptr) lv_disp_flush_ready(driver);
    return;
  }

  const std::int32_t width = area->x2 - area->x1 + 1;
  const std::int32_t height = area->y2 - area->y1 + 1;
  if (width <= 0 || height <= 0 ||
      !self->backend_.writeRgb565Area(area->x1, area->y1, static_cast<std::uint16_t>(width),
                                      static_cast<std::uint16_t>(height),
                                      reinterpret_cast<const std::uint16_t*>(colors))) {
    self->flush_ok_ = false;
  }
  lv_disp_flush_ready(driver);
}

}  // namespace mooneink
