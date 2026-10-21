// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/local_ui.hpp"

#include <lvgl.h>

namespace mooneink {
namespace {

lv_color_t white() { return lv_color_make(255, 255, 255); }
lv_color_t black() { return lv_color_make(0, 0, 0); }
lv_color_t lightGray() { return lv_color_make(232, 232, 232); }
lv_color_t midGray() { return lv_color_make(112, 112, 112); }

void styleRoot(lv_obj_t* object) {
  lv_obj_set_style_bg_color(object, white(), 0);
  lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(object, 0, 0);
  lv_obj_set_style_pad_all(object, 0, 0);
  lv_obj_clear_flag(object, LV_OBJ_FLAG_SCROLLABLE);
}

void styleCard(lv_obj_t* object) {
  lv_obj_set_style_bg_color(object, white(), 0);
  lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
  lv_obj_set_style_border_color(object, black(), 0);
  lv_obj_set_style_border_width(object, 2, 0);
  lv_obj_set_style_radius(object, 0, 0);
  lv_obj_set_style_pad_all(object, 18, 0);
  lv_obj_clear_flag(object, LV_OBJ_FLAG_SCROLLABLE);
}

lv_obj_t* label(lv_obj_t* parent, const char* text, const lv_font_t* font, const lv_color_t color,
                const lv_coord_t x, const lv_coord_t y) {
  lv_obj_t* object = lv_label_create(parent);
  lv_label_set_text(object, text);
  lv_obj_set_style_text_font(object, font, 0);
  lv_obj_set_style_text_color(object, color, 0);
  lv_obj_set_pos(object, x, y);
  return object;
}

void statusRow(lv_obj_t* parent, const char* name, const bool ok, const lv_coord_t y) {
  label(parent, name, &lv_font_montserrat_22, black(), 0, y);
  lv_obj_t* value = label(parent, ok ? "PASS" : "PENDING", &lv_font_montserrat_22,
                          ok ? black() : midGray(), 0, y);
  lv_obj_align(value, LV_ALIGN_TOP_RIGHT, 0, y);
  lv_obj_t* rule = lv_obj_create(parent);
  lv_obj_set_size(rule, 410, 1);
  lv_obj_set_pos(rule, 0, y + 32);
  lv_obj_set_style_bg_color(rule, lightGray(), 0);
  lv_obj_set_style_bg_opa(rule, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(rule, 0, 0);
}

void menuButton(lv_obj_t* parent, const char* title, const char* subtitle,
                const lv_coord_t x, const lv_coord_t y) {
  lv_obj_t* button = lv_obj_create(parent);
  lv_obj_set_size(button, 215, 132);
  lv_obj_set_pos(button, x, y);
  styleCard(button);
  label(button, title, &lv_font_montserrat_28, black(), 0, 8);
  label(button, subtitle, &lv_font_montserrat_22, midGray(), 0, 54);
}

}  // namespace

bool LocalUi::build(const LocalUiSnapshot& snapshot) {
  if (snapshot.profile_id == nullptr) return false;
  lv_obj_t* root = lv_scr_act();
  if (root == nullptr) return false;
  lv_obj_clean(root);
  styleRoot(root);

  label(root, "MoonE-ink", &lv_font_montserrat_32, black(), 38, 42);
  label(root, "M3 LOCAL UI / LVGL 8.4", &lv_font_montserrat_22, midGray(), 40, 88);

  lv_obj_t* top_rule = lv_obj_create(root);
  lv_obj_set_size(top_rule, 460, 2);
  lv_obj_set_pos(top_rule, 40, 128);
  lv_obj_set_style_bg_color(top_rule, black(), 0);
  lv_obj_set_style_bg_opa(top_rule, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(top_rule, 0, 0);

  lv_obj_t* settings = lv_obj_create(root);
  lv_obj_set_size(settings, 460, 250);
  lv_obj_set_pos(settings, 40, 158);
  styleCard(settings);
  label(settings, "SETTINGS", &lv_font_montserrat_28, black(), 0, 0);
  label(settings, "Network", &lv_font_montserrat_22, black(), 0, 54);
  label(settings, "Provisioning required", &lv_font_montserrat_22, midGray(), 0, 86);
  label(settings, "Publication service", &lv_font_montserrat_22, black(), 0, 132);
  label(settings, "Not paired", &lv_font_montserrat_22, midGray(), 0, 164);

  lv_obj_t* diagnostics = lv_obj_create(root);
  lv_obj_set_size(diagnostics, 460, 370);
  lv_obj_set_pos(diagnostics, 40, 438);
  styleCard(diagnostics);
  label(diagnostics, "DIAGNOSTICS", &lv_font_montserrat_28, black(), 0, 0);
  statusRow(diagnostics, "Partition map", snapshot.storage_ok, 54);
  statusRow(diagnostics, "Touch transform", snapshot.touch_ok, 96);
  statusRow(diagnostics, "Display owner", true, 138);
  statusRow(diagnostics, "Input binding", true, 180);
  statusRow(diagnostics, "GPIO0 wake", true, 222);

  char resources[96]{};
  lv_snprintf(resources, sizeof(resources), "%u KiB PSRAM / %u apps / %u events",
              static_cast<unsigned>(snapshot.psram_free / 1024),
              static_cast<unsigned>(snapshot.app_count),
              static_cast<unsigned>(snapshot.event_count));
  label(diagnostics, resources, &lv_font_montserrat_22, black(), 0, 278);

  label(root, "PURE WHITE / 540 x 960", &lv_font_montserrat_22, midGray(), 40, 852);
  label(root, "LOCAL UI / EPD OWNER: SHELL", &lv_font_montserrat_22, black(), 40, 892);
  return true;
}

bool LocalUi::buildLauncher(const bool ephemera_available,
                            const bool ephemera_active,
                            const bool reader_active) {
  lv_obj_t* root = lv_scr_act();
  if (root == nullptr) return false;
  lv_obj_clean(root);
  styleRoot(root);

  label(root, "MoonE-ink", &lv_font_montserrat_32, black(), 38, 42);
  label(root, "APP LAUNCHER", &lv_font_montserrat_22, midGray(), 40, 88);

  lv_obj_t* top_rule = lv_obj_create(root);
  lv_obj_set_size(top_rule, 460, 2);
  lv_obj_set_pos(top_rule, 40, 128);
  lv_obj_set_style_bg_color(top_rule, black(), 0);
  lv_obj_set_style_bg_opa(top_rule, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(top_rule, 0, 0);

  menuButton(root, "SETTINGS", "local system", 40, 176);
  menuButton(root, "EPHEMERA",
             ephemera_available ? (ephemera_active ? "current app" : "publication")
                                 : "pairing required",
             285, 176);
  menuButton(root, "READER", reader_active ? "current app" : "local TF / TXT", 40, 332);
  menuButton(root, "DIAGNOSTICS", "device status", 285, 332);
  if (ephemera_active) {
    menuButton(root, "CONTROLS", "reading actions", 40, 488);
    menuButton(root, "BACK", "return to app", 285, 488);
  } else {
    menuButton(root, "BACK", "return to app", 40, 488);
  }

  label(root, "LOCAL APPS WORK OFFLINE", &lv_font_montserrat_22, midGray(), 40, 692);
  label(root, "HOME: RETURN", &lv_font_montserrat_22, black(), 40, 786);
  label(root, "HOLD S3: LIGHT", &lv_font_montserrat_22, black(), 40, 828);
  label(root, "BOOT / S3 PAUSED IN SYSTEM UI", &lv_font_montserrat_22, midGray(), 40, 882);
  return true;
}

bool LocalUi::buildReaderUnavailable(const char* reason) {
  if (reason == nullptr) return false;
  lv_obj_t* root = lv_scr_act();
  if (root == nullptr) return false;
  lv_obj_clean(root);
  styleRoot(root);
  label(root, "READER", &lv_font_montserrat_32, black(), 40, 48);
  label(root, "LOCAL TXT / OFFLINE", &lv_font_montserrat_22, midGray(), 40, 96);
  lv_obj_t* card = lv_obj_create(root);
  lv_obj_set_size(card, 460, 300);
  lv_obj_set_pos(card, 40, 220);
  styleCard(card);
  label(card, reason, &lv_font_montserrat_28, black(), 0, 42);
  label(card, "Use UTF-8 TXT in /books/", &lv_font_montserrat_22, midGray(), 0, 112);
  label(card, "No network or pairing required", &lv_font_montserrat_22, midGray(), 0, 156);
  label(root, "HOME: APP LAUNCHER  /  HOLD S3: LIGHT",
        &lv_font_montserrat_22, black(), 40, 856);
  return true;
}

bool LocalUi::buildReaderPage(const char* text, const std::uint64_t source_offset,
                              const std::uint64_t file_size, const bool has_more) {
  if (text == nullptr) return false;
  lv_obj_t* root = lv_scr_act();
  if (root == nullptr) return false;
  lv_obj_clean(root);
  styleRoot(root);

  lv_obj_t* body = label(root, text, &lv_font_montserrat_26, black(), 46, 42);
  lv_obj_set_width(body, 448);
  lv_label_set_long_mode(body, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_line_space(body, 8, 0);

  char progress[96]{};
  lv_snprintf(progress, sizeof(progress), "BYTE %llu / %llu%s",
              static_cast<unsigned long long>(source_offset),
              static_cast<unsigned long long>(file_size), has_more ? "  >" : "  END");
  label(root, progress, &lv_font_montserrat_22, midGray(), 40, 902);
  return true;
}

bool LocalUi::buildEphemeraSystemMenu() {
  lv_obj_t* root = lv_scr_act();
  if (root == nullptr) return false;
  lv_obj_clean(root);
  styleRoot(root);

  label(root, "MoonE-ink", &lv_font_montserrat_32, black(), 38, 42);
  label(root, "SYSTEM / READING", &lv_font_montserrat_22, midGray(), 40, 88);

  lv_obj_t* top_rule = lv_obj_create(root);
  lv_obj_set_size(top_rule, 460, 2);
  lv_obj_set_pos(top_rule, 40, 128);
  lv_obj_set_style_bg_color(top_rule, black(), 0);
  lv_obj_set_style_bg_opa(top_rule, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(top_rule, 0, 0);

  label(root, "EPHEMERA CONTROLS", &lv_font_montserrat_28, black(), 40, 158);
  label(root, "Actions stay bound to the opened page.",
        &lv_font_montserrat_22, midGray(), 40, 198);

  menuButton(root, "PREV PAGE", "same issue", 40, 246);
  menuButton(root, "NEXT PAGE", "same issue", 285, 246);
  menuButton(root, "OLDER", "previous issue", 40, 402);
  menuButton(root, "NEWER", "next issue", 285, 402);
  menuButton(root, "LATEST", "latest issue", 40, 558);
  menuButton(root, "MARK READ", "acknowledge", 285, 558);

  lv_obj_t* footer_rule = lv_obj_create(root);
  lv_obj_set_size(footer_rule, 460, 1);
  lv_obj_set_pos(footer_rule, 40, 744);
  lv_obj_set_style_bg_color(footer_rule, lightGray(), 0);
  lv_obj_set_style_bg_opa(footer_rule, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(footer_rule, 0, 0);
  label(root, "HOME: RETURN", &lv_font_montserrat_22, black(), 40, 786);
  label(root, "HOLD S3: LIGHT", &lv_font_montserrat_22, black(), 40, 828);
  label(root, "BOOT / S3: PREV / NEXT", &lv_font_montserrat_22, midGray(), 40, 882);
  return true;
}

}  // namespace mooneink
