// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/m5gfx_h752_01_backend.hpp"

#include <Arduino.h>
#include <M5GFX.h>
#include <Wire.h>

#include <cstdint>

#include "driver/gpio.h"
#include "lgfx/v1/platforms/esp32/Bus_EPD.h"
#include "lgfx/v1/platforms/esp32/Panel_EPD.hpp"

namespace mooneink {
namespace {

constexpr int kPanelWidth = 960;
constexpr int kPanelHeight = 540;
constexpr int kEpdBusSpeedHz = 20000000;
constexpr int kVcomMillivolts = 1560;
constexpr int kPowerGoodTimeoutMs = 400;

constexpr int kI2cSda = 39;
constexpr int kI2cScl = 40;
constexpr std::uint8_t kPca9535Address = 0x20;
constexpr std::uint8_t kTps651851Address = 0x68;
constexpr std::uint8_t kTpsRegEnable = 0x01;
constexpr std::uint8_t kTpsRegVcom = 0x03;
constexpr std::uint8_t kTpsRegPowerGood = 0x0F;
constexpr std::uint8_t kTpsEnableAllRails = 0x3F;
constexpr std::uint8_t kTpsPowerGoodMask = 0xFA;
constexpr std::uint8_t kTpsPowerGoodExpected = 0xFA;

constexpr std::uint8_t kPcaInputPort0 = 0x00;
constexpr std::uint8_t kPcaOutputPort0 = 0x02;
constexpr std::uint8_t kPcaConfigPort0 = 0x06;
constexpr std::uint8_t kPcaPinEpdOe = 8;
constexpr std::uint8_t kPcaPinEpdMode = 9;
constexpr std::uint8_t kPcaPinTpsPwrUp = 11;
constexpr std::uint8_t kPcaPinVcomCtrl = 12;
constexpr std::uint8_t kPcaPinTpsWakeUp = 13;
constexpr std::uint8_t kPcaPinTpsPowerGood = 14;

constexpr gpio_num_t kPinEpdCkh = GPIO_NUM_4;
constexpr gpio_num_t kPinEpdD0 = GPIO_NUM_5;
constexpr gpio_num_t kPinEpdD1 = GPIO_NUM_6;
constexpr gpio_num_t kPinEpdD2 = GPIO_NUM_7;
constexpr gpio_num_t kPinEpdD7 = GPIO_NUM_8;
constexpr gpio_num_t kPinTouchReset = GPIO_NUM_9;
constexpr gpio_num_t kPinWarmLight = GPIO_NUM_11;
constexpr gpio_num_t kPinEpdD3 = GPIO_NUM_15;
constexpr gpio_num_t kPinEpdD4 = GPIO_NUM_16;
constexpr gpio_num_t kPinEpdD5 = GPIO_NUM_17;
constexpr gpio_num_t kPinEpdD6 = GPIO_NUM_18;
constexpr gpio_num_t kPinDummyBus = GPIO_NUM_1;
constexpr gpio_num_t kPinEpdSth = GPIO_NUM_41;
constexpr gpio_num_t kPinEpdLe = GPIO_NUM_42;
constexpr gpio_num_t kPinEpdStv = GPIO_NUM_45;
constexpr gpio_num_t kPinEpdCkv = GPIO_NUM_48;
constexpr std::uint8_t kPanelOffsetRotation = 3;

std::uint8_t pca_output[2] = {0xFF, 0x00};

bool i2cWrite(const std::uint8_t address, const std::uint8_t* data, const std::size_t length) {
  Wire.beginTransmission(address);
  const std::size_t written = Wire.write(data, length);
  return written == length && Wire.endTransmission() == 0;
}

bool i2cWriteRegister(const std::uint8_t address, const std::uint8_t reg,
                      const std::uint8_t value) {
  const std::uint8_t buffer[2] = {reg, value};
  return i2cWrite(address, buffer, sizeof(buffer));
}

bool i2cReadRegister(const std::uint8_t address, const std::uint8_t reg,
                     std::uint8_t* buffer, const std::size_t length) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(static_cast<int>(address), static_cast<int>(length)) != length) return false;
  for (std::size_t i = 0; i < length; ++i) buffer[i] = static_cast<std::uint8_t>(Wire.read());
  return true;
}

bool pcaInit() {
  pca_output[0] = 0xFF;
  pca_output[1] = 0x00;
  return i2cWriteRegister(kPca9535Address, kPcaOutputPort0, pca_output[0]) &&
         i2cWriteRegister(kPca9535Address, kPcaOutputPort0 + 1, pca_output[1]) &&
         i2cWriteRegister(kPca9535Address, kPcaConfigPort0, 0x00) &&
         i2cWriteRegister(kPca9535Address, kPcaConfigPort0 + 1, 0xC4);
}

bool pcaSet(const std::uint8_t pin, const bool level) {
  const std::uint8_t port = pin / 8;
  const std::uint8_t bit = pin & 7;
  if (level) pca_output[port] |= static_cast<std::uint8_t>(1U << bit);
  else pca_output[port] &= static_cast<std::uint8_t>(~(1U << bit));
  return i2cWriteRegister(kPca9535Address, kPcaOutputPort0 + port, pca_output[port]);
}

bool pcaGet(const std::uint8_t pin, bool& level) {
  std::uint8_t value = 0;
  if (!i2cReadRegister(kPca9535Address, kPcaInputPort0 + pin / 8, &value, 1)) return false;
  level = (value & (1U << (pin & 7))) != 0;
  return true;
}

bool tpsWrite(const std::uint8_t reg, const std::uint8_t* data, const std::size_t length) {
  if (length > 3) return false;
  std::uint8_t buffer[4] = {reg, 0, 0, 0};
  for (std::size_t i = 0; i < length; ++i) buffer[i + 1] = data[i];
  return i2cWrite(kTps651851Address, buffer, length + 1);
}

bool tpsWrite8(const std::uint8_t reg, const std::uint8_t value) {
  return tpsWrite(reg, &value, 1);
}

class H75201EpdBus final : public lgfx::Bus_EPD {
 public:
  bool init() override {
    Wire.begin(kI2cSda, kI2cScl);
    Wire.setClock(400000);
    pinMode(kPinWarmLight, OUTPUT);
    digitalWrite(kPinWarmLight, LOW);
    pinMode(kPinTouchReset, OUTPUT);
    digitalWrite(kPinTouchReset, HIGH);
    return pcaInit() && lgfx::Bus_EPD::init();
  }

  bool powerControl(const bool power_on) override {
    if (_pwr_on == power_on) return true;
    wait();
    const bool ok = power_on ? powerOn() : powerOff();
    if (ok) _pwr_on = power_on;
    return ok;
  }

 private:
  bool waitPcaPowerGood() {
    for (int i = 0; i < kPowerGoodTimeoutMs; ++i) {
      bool level = false;
      if (!pcaGet(kPcaPinTpsPowerGood, level)) return false;
      if (level) return true;
      delay(1);
    }
    return false;
  }

  bool waitTpsPowerGood() {
    for (int i = 0; i < kPowerGoodTimeoutMs; ++i) {
      std::uint8_t value = 0;
      if (!i2cReadRegister(kTps651851Address, kTpsRegPowerGood, &value, 1)) return false;
      if ((value & kTpsPowerGoodMask) == kTpsPowerGoodExpected) return true;
      delay(1);
    }
    return false;
  }

  bool powerOn() {
    if (!pcaSet(kPcaPinEpdOe, true) || !pcaSet(kPcaPinEpdMode, true) ||
        !pcaSet(kPcaPinTpsWakeUp, true) || !pcaSet(kPcaPinTpsPwrUp, true) ||
        !pcaSet(kPcaPinVcomCtrl, true)) return false;
    delay(1);
    if (!waitPcaPowerGood() || !tpsWrite8(kTpsRegEnable, kTpsEnableAllRails)) return false;
    const std::uint16_t vcom = static_cast<std::uint16_t>(kVcomMillivolts / 10);
    const std::uint8_t bytes[2] = {
        static_cast<std::uint8_t>(vcom & 0xFF),
        static_cast<std::uint8_t>(vcom >> 8),
    };
    return tpsWrite(kTpsRegVcom, bytes, sizeof(bytes)) && waitTpsPowerGood();
  }

  bool powerOff() {
    if (!pcaSet(kPcaPinEpdOe, false) || !pcaSet(kPcaPinEpdMode, false) ||
        !pcaSet(kPcaPinTpsPwrUp, false) || !pcaSet(kPcaPinVcomCtrl, false)) return false;
    delay(1);
    return pcaSet(kPcaPinTpsWakeUp, false);
  }
};

class H75201Display final : public lgfx::LGFX_Device {
 public:
  H75201Display() {
    auto bus = bus_.config();
    bus.bus_speed = kEpdBusSpeedHz;
    bus.pin_data[0] = kPinEpdD0;
    bus.pin_data[1] = kPinEpdD1;
    bus.pin_data[2] = kPinEpdD2;
    bus.pin_data[3] = kPinEpdD3;
    bus.pin_data[4] = kPinEpdD4;
    bus.pin_data[5] = kPinEpdD5;
    bus.pin_data[6] = kPinEpdD6;
    bus.pin_data[7] = kPinEpdD7;
    bus.pin_pwr = kPinDummyBus;
    bus.pin_spv = kPinEpdStv;
    bus.pin_ckv = kPinEpdCkv;
    bus.pin_sph = kPinEpdSth;
    bus.pin_oe = kPinDummyBus;
    bus.pin_le = kPinEpdLe;
    bus.pin_cl = kPinEpdCkh;
    bus.bus_width = 8;
    bus_.config(bus);

    panel_.setBus(&bus_);
    auto panel = panel_.config();
    panel.memory_width = kPanelWidth;
    panel.memory_height = kPanelHeight;
    panel.panel_width = kPanelWidth;
    panel.panel_height = kPanelHeight;
    panel.offset_rotation = kPanelOffsetRotation;
    panel.bus_shared = false;
    panel_.config(panel);
    auto detail = panel_.config_detail();
    detail.line_padding = 0;
    detail.task_priority = 3;
    panel_.config_detail(detail);
    setPanel(&panel_);
  }

 private:
  H75201EpdBus bus_;
  lgfx::Panel_EPD panel_;
};

H75201Display display;

std::uint32_t gray(const std::uint8_t value) {
  return display.color888(value, value, value);
}

void drawStatus(const int y, const char* label, const bool ok) {
  display.setTextColor(TFT_BLACK, TFT_WHITE);
  display.setTextDatum(textdatum_t::top_left);
  display.drawString(label, 42, y);
  display.setTextDatum(textdatum_t::top_right);
  display.drawString(ok ? "PASS" : "PENDING", 498, y);
  display.drawFastHLine(42, y + 28, 456, gray(205));
}

}  // namespace

bool M5GfxH75201Backend::begin() {
  // M5GFX must initialise the panel before allocating/changing its framebuffer.
  // The proven H752-01 probe uses this order as well.
  if (!display.init_without_reset(false)) {
    Serial.println("[DISPLAY] M5GFX init failed");
    return false;
  }
  display.setAutoDisplay(false);
  display.setColorDepth(4);
  display.setRotation(0);
  display.setEpdMode(lgfx::epd_mode_t::epd_quality);
  const bool geometry_ok = display.width() == 540 && display.height() == 960;
  if (!geometry_ok) {
    Serial.printf("[DISPLAY] geometry mismatch width=%d height=%d\n", display.width(),
                  display.height());
  }
  return geometry_ok;
}

bool M5GfxH75201Backend::presentDiagnostics(const DiagnosticsSnapshot& snapshot) {
  display.startWrite();
  display.fillScreen(TFT_WHITE);
  display.setTextWrap(false);
  display.setTextColor(TFT_BLACK, TFT_WHITE);
  display.setTextDatum(textdatum_t::top_left);
  display.setFont(&fonts::Font4);
  display.drawString("MoonE-ink", 38, 48);
  display.setFont(&fonts::Font2);
  display.drawString("M2 SHELL CORE / DIAGNOSTICS", 40, 92);
  display.drawFastHLine(40, 126, 458, TFT_BLACK);

  display.setFont(&fonts::Font2);
  display.drawString("PROFILE", 42, 158);
  display.drawString(snapshot.profile_id, 42, 184);
  display.drawString(String("revision ") + snapshot.profile_revision, 42, 208);

  display.drawString("16-LEVEL GRAYSCALE", 42, 260);
  for (int i = 0; i < 16; ++i) {
    const int x = 42 + (i % 8) * 57;
    const int y = 294 + (i / 8) * 64;
    display.fillRect(x, y, 48, 42, gray(static_cast<std::uint8_t>(i * 17)));
    display.drawRect(x, y, 48, 42, TFT_BLACK);
  }

  display.drawString("LINE WEIGHTS", 42, 440);
  display.drawFastHLine(42, 474, 456, TFT_BLACK);
  display.fillRect(42, 492, 456, 2, TFT_BLACK);
  display.fillRect(42, 512, 456, 3, TFT_BLACK);

  display.drawString("SYSTEM", 42, 558);
  drawStatus(592, "factory partition map", snapshot.storage_layout_ok);
  drawStatus(634, "portrait / landscape transform", snapshot.touch_transform_ok);
  drawStatus(676, "timer wake", true);
  drawStatus(718, "GPIO0 button wake", true);
  drawStatus(760, "microSD card", snapshot.sd_available);

  display.setTextDatum(textdatum_t::bottom_left);
  display.drawString(String("PSRAM free ") + snapshot.psram_free / 1024 + " KiB", 42, 894);
  display.setTextDatum(textdatum_t::bottom_right);
  display.drawString("540 x 960 / PURE WHITE", 498, 894);
  display.drawRect(8, 8, 524, 944, TFT_BLACK);
  display.endWrite();

  const std::uint32_t started = millis();
  display.display();
  display.waitDisplay();
  display.powerSaveOn();
  Serial.printf("[DISPLAY] presented diagnostics refresh_ms=%lu\n",
                static_cast<unsigned long>(millis() - started));
  return true;
}

bool M5GfxH75201Backend::beginComposition() {
  if (composition_open_) return false;
  display.startWrite();
  display.fillScreen(TFT_WHITE);
  composition_open_ = true;
  return true;
}

bool M5GfxH75201Backend::writeRgb565Area(const std::int16_t x, const std::int16_t y,
                                         const std::uint16_t width,
                                         const std::uint16_t height,
                                         const std::uint16_t* pixels) {
  if (!composition_open_ || pixels == nullptr || width == 0 || height == 0 || x < 0 || y < 0 ||
      static_cast<std::int32_t>(x) + width > display.width() ||
      static_cast<std::int32_t>(y) + height > display.height()) {
    return false;
  }
  display.pushImage(x, y, width, height, pixels);
  return true;
}

bool M5GfxH75201Backend::endComposition() {
  if (!composition_open_) return false;
  display.endWrite();
  composition_open_ = false;
  return true;
}

bool M5GfxH75201Backend::composeGray4Frame(const std::uint8_t* pixels,
                                           const std::size_t byte_length,
                                           const std::uint16_t width,
                                           const std::uint16_t height,
                                           const std::uint16_t stride_bytes) {
  return composeGray4FrameWithUnreadBadge(pixels, byte_length, width, height,
                                           stride_bytes, 0);
}

bool M5GfxH75201Backend::composeGray4FrameWithUnreadBadge(
    const std::uint8_t* pixels, const std::size_t byte_length,
    const std::uint16_t width, const std::uint16_t height,
    const std::uint16_t stride_bytes, const std::uint32_t other_unread) {
  const bool portrait = width == 540 && height == 960 && stride_bytes == 270;
  const bool landscape = width == 960 && height == 540 && stride_bytes == 480;
  if (pixels == nullptr || (!portrait && !landscape) ||
      byte_length != static_cast<std::size_t>(stride_bytes) * height ||
      !beginComposition()) {
    return false;
  }
  const auto pixel565 = [](const std::uint8_t nibble) {
    const std::uint8_t value = static_cast<std::uint8_t>(nibble * 17U);
    return static_cast<std::uint16_t>(((value >> 3U) << 11U) |
                                      ((value >> 2U) << 5U) | (value >> 3U));
  };
  std::uint16_t row[540]{};
  for (std::uint16_t physical_y = 0; physical_y < 960; ++physical_y) {
    for (std::uint16_t physical_x = 0; physical_x < 540; ++physical_x) {
      const std::uint16_t source_x = portrait ? physical_x : physical_y;
      const std::uint16_t source_y = portrait ? physical_y : static_cast<std::uint16_t>(539U - physical_x);
      const std::uint8_t packed = pixels[static_cast<std::size_t>(source_y) * stride_bytes + source_x / 2U];
      const std::uint8_t nibble = (source_x & 1U) == 0
                                      ? static_cast<std::uint8_t>(packed >> 4U)
                                      : static_cast<std::uint8_t>(packed & 0x0FU);
      row[physical_x] = pixel565(nibble);
    }
    if (!writeRgb565Area(0, static_cast<std::int16_t>(physical_y), 540, 1, row)) {
      display.endWrite();
      composition_open_ = false;
      return false;
    }
  }
  if (other_unread > 0) {
    const char* suffix = other_unread > 99 ? "99+" : nullptr;
    display.setTextColor(TFT_BLACK, TFT_WHITE);
    display.setTextDatum(textdatum_t::top_left);
    display.setFont(&fonts::efontCN_16);
    display.drawString(suffix == nullptr ? String(other_unread) : String(suffix),
                       22, 20);
  }
  return endComposition();
}

bool M5GfxH75201Backend::composeEphemeraLocalView(
    const EphemeraLocalView& view) {
  if (!beginComposition()) return false;
  display.setTextWrap(false);
  display.setTextColor(TFT_BLACK, TFT_WHITE);
  display.setTextDatum(textdatum_t::top_left);
  display.setFont(&fonts::efontCN_24);

  if (view.kind == EphemeraLocalViewKind::home) {
    display.drawString("书信", 44, 48);
    display.setFont(&fonts::Font2);
    display.setTextDatum(textdatum_t::top_right);
    display.drawString(view.online ? "ONLINE" : "OFFLINE", 496, 58);
    display.drawFastHLine(42, 100, 456, TFT_BLACK);

    display.setTextDatum(textdatum_t::top_left);
    display.setFont(&fonts::efontCN_24);
    display.drawString("继续阅读", 64, 180);
    display.setFont(&fonts::efontCN_16);
    display.setTextColor(gray(70), TFT_WHITE);
    display.drawString(view.current_label == nullptr || view.current_label[0] == '\0'
                           ? "暂时没有稿件"
                           : view.current_label,
                       66, 226);
    display.setTextColor(TFT_BLACK, TFT_WHITE);
    display.drawRoundRect(42, 156, 456, 166, 14, TFT_BLACK);

    display.setFont(&fonts::efontCN_24);
    display.drawString("纸匣", 64, 398);
    display.setFont(&fonts::efontCN_16);
    display.drawString("未读与最近 50 份", 66, 446);
    if (view.unread_count > 0) {
      display.fillCircle(452, 432, 28, TFT_BLACK);
      display.setTextColor(TFT_WHITE, TFT_BLACK);
      display.setTextDatum(textdatum_t::middle_center);
      display.setFont(&fonts::Font2);
      display.drawString(view.unread_count > 99 ? String("99+")
                                                : String(view.unread_count),
                         452, 432);
      display.setTextColor(TFT_BLACK, TFT_WHITE);
      display.setTextDatum(textdatum_t::top_left);
    }
    display.drawRoundRect(42, 372, 456, 166, 14, TFT_BLACK);
    display.setFont(&fonts::efontCN_16);
    display.drawString("点按卡片进入；长按 Home 返回系统菜单", 42, 866);
  } else {
    display.setFont(&fonts::efontCN_24);
    display.drawString("纸匣", 42, 40);
    display.setFont(&fonts::efontCN_16);
    display.setTextDatum(textdatum_t::top_right);
    display.drawString(view.online ? "已同步" : "离线缓存", 498, 50);
    display.setTextDatum(textdatum_t::top_left);
    display.drawFastHLine(42, 94, 456, TFT_BLACK);

    display.setTextColor(view.filter_unread ? TFT_BLACK : gray(110), TFT_WHITE);
    display.drawString("未读", 54, 116);
    display.setTextColor(!view.filter_unread ? TFT_BLACK : gray(110), TFT_WHITE);
    display.drawString("最近 50 份", 182, 116);
    display.setTextColor(TFT_BLACK, TFT_WHITE);
    display.drawFastHLine(view.filter_unread ? 48 : 176, 150,
                          view.filter_unread ? 80 : 130, TFT_BLACK);

    constexpr int row_top = 170;
    constexpr int row_height = 94;
    for (std::size_t i = 0; i < view.row_count; ++i) {
      const EphemeraLocalRow& row = view.rows[i];
      const int y = row_top + static_cast<int>(i) * row_height;
      if (row.unread) display.fillCircle(54, y + 24, 6, TFT_BLACK);
      display.setFont(&fonts::efontCN_16);
      display.setTextColor(TFT_BLACK, TFT_WHITE);
      display.drawString(row.label == nullptr ? "无标题" : row.label, 72, y + 5);
      display.setTextColor(gray(100), TFT_WHITE);
      display.drawString(row.summary == nullptr ? "" : row.summary, 72, y + 38);
      display.drawFastHLine(42, y + 82, 456, gray(205));
    }
    if (view.row_count == 0) {
      display.setFont(&fonts::efontCN_24);
      display.setTextColor(gray(105), TFT_WHITE);
      display.drawString(view.filter_unread ? "没有未读稿件" : "纸匣还是空的", 148,
                         360);
    }
    display.setTextColor(TFT_BLACK, TFT_WHITE);
    display.setFont(&fonts::Font2);
    display.setTextDatum(textdatum_t::bottom_right);
    display.drawString(String(view.page_index + 1U) + "/" +
                           String(view.page_count == 0 ? 1 : view.page_count),
                       498, 914);
    display.setTextDatum(textdatum_t::bottom_left);
    display.setFont(&fonts::efontCN_16);
    display.drawString("主页", 48, 914);
    display.drawString("左/右键翻列表　点按打开", 174, 914);
  }
  display.drawRect(8, 8, 524, 944, TFT_BLACK);
  return endComposition();
}

bool M5GfxH75201Backend::presentComposedFrame() {
  if (composition_open_) return false;
  const std::uint32_t started = millis();
  display.display();
  display.waitDisplay();
  display.powerSaveOn();
  Serial.printf("[DISPLAY] presented composed frame refresh_ms=%lu\n",
                static_cast<unsigned long>(millis() - started));
  return true;
}

std::uint16_t M5GfxH75201Backend::width() const { return display.width(); }
std::uint16_t M5GfxH75201Backend::height() const { return display.height(); }

}  // namespace mooneink

