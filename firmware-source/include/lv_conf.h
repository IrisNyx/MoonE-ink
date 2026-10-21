// SPDX-License-Identifier: AGPL-3.0-only
#ifndef LV_CONF_H
#define LV_CONF_H

#define LV_COLOR_DEPTH 16
#define LV_COLOR_16_SWAP 0

#define LV_MEM_CUSTOM 1
#define LV_MEM_CUSTOM_INCLUDE <esp_heap_caps.h>
#define LV_MEM_CUSTOM_ALLOC(size) \
  heap_caps_malloc((size), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
#define LV_MEM_CUSTOM_FREE(pointer) heap_caps_free(pointer)
#define LV_MEM_CUSTOM_REALLOC(pointer, size) \
  heap_caps_realloc((pointer), (size), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)

#define LV_TICK_CUSTOM 1
#define LV_TICK_CUSTOM_INCLUDE "Arduino.h"
#define LV_TICK_CUSTOM_SYS_TIME_EXPR (millis())

#define LV_USE_LOG 0
#define LV_USE_ASSERT_NULL 1
#define LV_USE_ASSERT_MALLOC 1
#define LV_USE_USER_DATA 1

#define LV_FONT_MONTSERRAT_22 1
#define LV_FONT_MONTSERRAT_26 1
#define LV_FONT_MONTSERRAT_28 1
#define LV_FONT_MONTSERRAT_32 1
#define LV_FONT_DEFAULT &lv_font_montserrat_22

#define LV_USE_THEME_DEFAULT 1
#define LV_USE_LABEL 1
#define LV_USE_BTN 1
#define LV_USE_LINE 1

#endif  // LV_CONF_H
