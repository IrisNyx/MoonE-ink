// SPDX-License-Identifier: AGPL-3.0-only
#include <Arduino.h>
#include <WiFi.h>
#include <driver/gpio.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_sleep.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include <cstring>

#include "mooneink/app_manager.hpp"
#include "mooneink/battery_sleep.hpp"
#include "mooneink/board_profile.hpp"
#include "mooneink/built_in_apps.hpp"
#include "mooneink/display_manager.hpp"
#include "mooneink/device_json.hpp"
#include "mooneink/event_bus.hpp"
#include "mooneink/h752_01_input.hpp"
#include "mooneink/local_ui.hpp"
#include "mooneink/lvgl_port.hpp"
#include "mooneink/m5gfx_h752_01_backend.hpp"
#include "mooneink/m4_first_light.hpp"
#include "mooneink/m4_provisioning.hpp"
#include "mooneink/nvs_persistent_store.hpp"
#include "mooneink/power_monitor.hpp"
#include "mooneink/remote_frame_cache.hpp"
#include "mooneink/reader_app.hpp"
#include "mooneink/shell_input.hpp"
#include "mooneink/storage_manager.hpp"
#include "mooneink/system_shell.hpp"
#include "mooneink/touch_manager.hpp"
#include "mooneink/touch_transform.hpp"
#include "mooneink/warm_light.hpp"

// M4 performs TLS-capable HTTP calls and bounded JSON parsing from loop().  The
// ESP32 Arduino default (8 KiB) is too small for that call chain, including the
// transport error path.  Keep the official Arduino loop task and give it the
// stack budget used by the framework's own stack-size example.
SET_LOOP_TASK_STACK_SIZE(16 * 1024);

namespace {

mooneink::EventBus events;
mooneink::AppManager apps(events);
mooneink::M5GfxH75201Backend display_backend;
mooneink::DisplayManager display(display_backend, events);
mooneink::TouchManager touch(display, events);
mooneink::LvglPort lvgl(display_backend);
mooneink::LocalUi local_ui;
mooneink::StorageManager storage;
mooneink::RemoteFrameCache remote_frames;
mooneink::NvsPersistentStore persistent_store;
mooneink::DeviceStateRepository device_state;
std::uint8_t* remote_frame_a = nullptr;
std::uint8_t* remote_frame_b = nullptr;
mooneink::M4SerialReceiver m4_serial;
mooneink::M4FirstLight m4_first_light(apps, display, touch, lvgl, local_ui,
                                     remote_frames, persistent_store, device_state);
mooneink::DiagnosticsApp diagnostics_app(display, touch);
mooneink::SettingsApp settings_app(display, touch, lvgl, local_ui);
mooneink::ReaderApp reader_app(display, touch, lvgl, local_ui);
mooneink::H75201Input board_input;
mooneink::WarmLightController warm_light;
mooneink::SystemShell system_shell(apps, display, touch, lvgl, local_ui, warm_light);
mooneink::ShellInputRouter input_router(apps, system_shell);
mooneink::PowerMonitor power_monitor;
mooneink::PowerSnapshot power_snapshot{};
std::uint32_t last_setup_retry_ms = 0;
QueueHandle_t shell_input_queue = nullptr;
QueueHandle_t screen_update_queue = nullptr;
SemaphoreHandle_t m4_mutex = nullptr;
TaskHandle_t screen_watch_task = nullptr;
volatile bool screen_watch_allowed = true;
volatile bool screen_watch_busy = false;
volatile bool battery_sync_mode = false;
volatile bool battery_sync_complete = false;
volatile bool battery_sync_succeeded = false;
volatile bool power_report_due = false;
volatile bool power_reported = false;
volatile std::uint32_t last_user_activity_ms = 0;
bool battery_idle = false;
bool battery_components_suspended = false;
bool external_power_known = false;
bool external_power = true;
std::uint32_t next_power_check_ms = 0;
std::uint32_t next_battery_sync_ms = 0;
std::uint8_t battery_sync_failures = 0;
std::uint32_t last_power_report_ms = 0;
std::uint8_t last_reported_battery_percent = 0;
bool last_reported_battery_known = false;
bool last_reported_external_known = false;
bool last_reported_external_power = true;
std::uint8_t staged_battery_percent = 0;
bool staged_battery_known = false;
bool staged_external_known = false;
bool staged_external_power = true;
bool wakeable_power_path = false;
bool sleep_wakeup_ready = false;
std::uint64_t total_light_sleep_us = 0;
std::uint32_t sleep_retry_at_ms = 0;

struct BatterySleepTrace final {
  std::uint32_t magic = 0;
  std::uint32_t sleep_entries = 0;
  std::uint32_t wake_returns = 0;
  std::uint32_t timed_sync_starts = 0;
  std::uint32_t timed_sync_passes = 0;
  std::uint32_t timed_sync_failures = 0;
  std::int32_t last_sleep_result = 0;
  std::uint32_t last_wakeup_cause = 0;
};

constexpr std::uint32_t kBatterySleepTraceMagic = 0x4d425354U;  // MBST
RTC_DATA_ATTR BatterySleepTrace battery_sleep_trace{};

constexpr std::uint32_t kBatteryActiveMs = 120000U;
constexpr std::uint32_t kPowerCheckMs = 30000U;
constexpr std::uint32_t kBatterySyncMs = 300000U;
constexpr std::uint32_t kLowBatterySyncMs = 900000U;
constexpr std::uint32_t kPowerReportMaxMs = 1800000U;

bool deadlineReached(const std::uint32_t now, const std::uint32_t deadline) {
  return static_cast<std::int32_t>(now - deadline) >= 0;
}

const char* physicalButtonName(const mooneink::PhysicalButton button) {
  switch (button) {
    case mooneink::PhysicalButton::boot:
      return "boot";
    case mooneink::PhysicalButton::function:
      return "s3_io48_label";
    case mooneink::PhysicalButton::home:
      return "home";
  }
  return "unknown";
}

const char* buttonGestureName(const mooneink::ButtonGesture gesture) {
  return gesture == mooneink::ButtonGesture::long_press ? "long" : "short";
}

bool storageLayoutOk(const mooneink::StorageProbe& probe) {
  return probe.nvs && probe.app0 && probe.font && probe.coredump && probe.crashlog &&
         probe.spiffs && probe.app0_size == mooneink::BoardProfile::app0_bytes;
}

mooneink::DevicePowerReport currentPowerReport() {
  mooneink::DevicePowerReport report{};
  if (external_power_known) {
    report.source = external_power ? mooneink::DevicePowerSource::external
                                   : mooneink::DevicePowerSource::battery;
  }
  report.has_battery = power_snapshot.battery_reachable;
  report.battery_percent = power_snapshot.battery_percent;
  report.battery_millivolts = power_snapshot.battery_millivolts;
  report.has_gauge_details = power_snapshot.gauge_details_reachable;
  report.current_ma = power_snapshot.current_ma;
  report.average_current_ma = power_snapshot.average_current_ma;
  report.remaining_mah = power_snapshot.remaining_mah;
  report.full_mah = power_snapshot.full_mah;
  report.light_sleep_seconds = total_light_sleep_us / 1000000ULL;
  report.uptime_seconds = esp_timer_get_time() / 1000000ULL;
  if (external_power_known && external_power) {
    report.mode = mooneink::DevicePowerMode::external_online;
  } else if (power_snapshot.lowBattery()) {
    report.mode = mooneink::DevicePowerMode::low_battery;
  } else if (battery_idle) {
    report.mode = battery_sync_failures >= 2
                      ? mooneink::DevicePowerMode::retry_backoff
                      : mooneink::DevicePowerMode::battery_idle;
  } else {
    report.mode = mooneink::DevicePowerMode::active;
  }
  return report;
}

void stagePowerReport(const std::uint32_t now, const bool force) {
  if (m4_mutex == nullptr ||
      (!power_snapshot.charger_reachable && !power_snapshot.battery_reachable)) {
    return;
  }
  const bool source_changed = power_reported &&
      (last_reported_external_known != external_power_known ||
       (external_power_known &&
        last_reported_external_power != external_power));
  const unsigned percent_delta =
      power_snapshot.battery_percent > last_reported_battery_percent
          ? power_snapshot.battery_percent - last_reported_battery_percent
          : last_reported_battery_percent - power_snapshot.battery_percent;
  const bool battery_changed = power_reported &&
      (last_reported_battery_known != power_snapshot.battery_reachable ||
       (power_snapshot.battery_reachable && percent_delta >= 2U));
  const bool interval_due = power_reported && now - last_power_report_ms >= kPowerReportMaxMs;
  const bool should_report = force || !power_reported || source_changed ||
                             battery_changed || interval_due;
  if (xSemaphoreTake(m4_mutex, portMAX_DELAY) != pdTRUE) return;
  const bool staged = m4_first_light.setPowerReport(currentPowerReport());
  if (staged) {
    staged_battery_known = power_snapshot.battery_reachable;
    staged_battery_percent = power_snapshot.battery_percent;
    staged_external_known = external_power_known;
    staged_external_power = external_power;
    if (should_report) power_report_due = true;
  }
  xSemaphoreGive(m4_mutex);
}

void halt(const char* reason) {
  Serial.printf("[M2] state=FAULT reason=%s\n", reason);
  while (true) delay(1000);
}

void processShellInput(const mooneink::ShellInputEvent& shell_input) {
  last_user_activity_ms = millis();
  if (xSemaphoreTake(m4_mutex, portMAX_DELAY) != pdTRUE) return;
  const mooneink::ShellInputResult result = input_router.route(shell_input);
  if (shell_input.kind == mooneink::ShellInputKind::light_toggle &&
      result == mooneink::ShellInputResult::handled_global) {
    Serial.printf("[M5] warm_light=%s brightness=%u\n",
                  warm_light.enabled() ? "ON" : "OFF",
                  static_cast<unsigned>(warm_light.brightness()));
  }
  if (result == mooneink::ShellInputResult::failed) {
    Serial.println("[SHELL] input=FAIL");
  }
  xSemaphoreGive(m4_mutex);
}

void m4WorkerTask(void*) {
  std::uint32_t last_receipt_retry = millis();
  for (;;) {
    mooneink::ShellInputEvent input{};
    if (xQueueReceive(shell_input_queue, &input, pdMS_TO_TICKS(40)) == pdTRUE) {
      processShellInput(input);
    }
    mooneink::ScreenResponse screen{};
    if (xQueueReceive(screen_update_queue, &screen, 0) == pdTRUE) {
      if (xSemaphoreTake(m4_mutex, portMAX_DELAY) == pdTRUE) {
        mooneink::M4FirstLightError error = mooneink::M4FirstLightError::none;
        if (!m4_first_light.applyScreenUpdate(screen, error)) {
          Serial.printf("[M4] latest=RETRY reason=%s\n",
                        mooneink::m4FirstLightErrorName(error));
        }
        xSemaphoreGive(m4_mutex);
      }
    }
    if (millis() - last_receipt_retry >= 15000U) {
      last_receipt_retry = millis();
      if (xSemaphoreTake(m4_mutex, portMAX_DELAY) == pdTRUE) {
        m4_first_light.retryPendingReceipt();
        xSemaphoreGive(m4_mutex);
      }
    }
    // A full EPD navigation is deliberately synchronous so the visible frame,
    // input hitboxes and delivery receipts commit as one unit.  When several
    // taps are already queued, xQueueReceive() otherwise returns immediately
    // for every item and this higher-priority task can starve CPU0's idle task
    // across consecutive refreshes.  Give the idle task a real blocked window
    // after each pass; taskYIELD() alone cannot run a lower-priority task.
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void screenWatchTask(void*) {
  for (;;) {
    if (!screen_watch_allowed) {
      screen_watch_busy = false;
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
      continue;
    }
    screen_watch_busy = true;
    mooneink::DeviceEndpoint endpoint{};
    mooneink::DeviceBinding binding{};
    std::uint64_t after_revision = 0;
    std::uint64_t after_library_revision = 0;
    std::array<char, mooneink::DeviceProtocol::identifier_capacity>
        read_status_for{};
    bool ready = false;
    if (xSemaphoreTake(m4_mutex, portMAX_DELAY) == pdTRUE) {
      mooneink::M4FirstLightError reconnect_error =
          mooneink::M4FirstLightError::none;
      ready = m4_first_light.ensureNetworkConnection(reconnect_error) &&
              m4_first_light.backgroundScreenRequest(
                  endpoint, binding, after_revision, after_library_revision,
                  read_status_for);
      xSemaphoreGive(m4_mutex);
    }
    if (!ready) {
      if (battery_sync_mode) {
        battery_sync_succeeded = false;
        battery_sync_complete = true;
        screen_watch_allowed = false;
      }
      screen_watch_busy = false;
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    mooneink::DeviceHttpClient client(endpoint);
    mooneink::ScreenResponse response{};
    mooneink::DeviceHttpError error = mooneink::DeviceHttpError::none;
    bool changed = false;
    const std::uint32_t wait_ms = battery_sync_mode ? 0U : 25000U;
    const bool request_ok = client.waitForScreenState(
            binding, after_revision, after_library_revision, wait_ms,
            read_status_for[0] == '\0' ? nullptr : read_status_for.data(),
            response, changed, error);
    if (request_ok && power_report_due &&
        xSemaphoreTake(m4_mutex, portMAX_DELAY) == pdTRUE) {
      if (m4_first_light.reportPowerStatus()) {
        power_report_due = false;
        power_reported = true;
        last_power_report_ms = millis();
        last_reported_battery_known = staged_battery_known;
        last_reported_battery_percent = staged_battery_percent;
        last_reported_external_known = staged_external_known;
        last_reported_external_power = staged_external_power;
      }
      xSemaphoreGive(m4_mutex);
    }
    if (request_ok && changed) {
      xQueueOverwrite(screen_update_queue, &response);
    } else if (!request_ok && error != mooneink::DeviceHttpError::none &&
               !battery_sync_mode) {
      vTaskDelay(pdMS_TO_TICKS(2000));
    }
    if (battery_sync_mode) {
      battery_sync_succeeded = request_ok;
      battery_sync_complete = true;
      screen_watch_allowed = false;
    }
    screen_watch_busy = false;
  }
}

std::uint32_t batterySyncIntervalMs() {
  if (power_snapshot.lowBattery()) return kLowBatterySyncMs;
  switch (battery_sync_failures) {
    case 0:
    case 1: return kBatterySyncMs;
    case 2: return 600000U;
    case 3: return 1200000U;
    default: return 1800000U;
  }
}

void refreshPowerState(const std::uint32_t now) {
  if (!deadlineReached(now, next_power_check_ms) ||
      xSemaphoreTake(m4_mutex, 0) != pdTRUE) {
    return;
  }
  mooneink::PowerSnapshot snapshot{};
  const bool readable = power_monitor.read(snapshot);
  mooneink::PowerSafetyState safety{};
  const bool safety_ready = power_monitor.prepareWakeableSleep(safety);
  xSemaphoreGive(m4_mutex);
  next_power_check_ms = now + kPowerCheckMs;
  if (!readable) {
    Serial.println("[POWER] sensors=UNKNOWN retaining_previous_mode");
    return;
  }
  power_snapshot = snapshot;
  const bool safety_changed = wakeable_power_path != safety_ready;
  wakeable_power_path = safety_ready;
  if (safety_changed || !safety_ready) {
    Serial.printf("[POWER] wakeable_path=%s reg00=%02x reg03=%02x reg07=%02x reg09=%02x\n",
                  safety_ready ? "PASS" : "FAIL",
                  static_cast<unsigned>(safety.reg00),
                  static_cast<unsigned>(safety.reg03),
                  static_cast<unsigned>(safety.reg07),
                  static_cast<unsigned>(safety.reg09));
  }
  if (snapshot.charger_reachable) {
    const bool changed = !external_power_known ||
                         external_power != snapshot.external_power;
    external_power_known = true;
    external_power = snapshot.external_power;
    if (changed) {
      Serial.printf("[POWER] source=%s battery=%s percent=%u voltage_mv=%u\n",
                    external_power ? "EXTERNAL" : "BATTERY",
                    snapshot.battery_reachable ? "KNOWN" : "UNKNOWN",
                    static_cast<unsigned>(snapshot.battery_percent),
                    static_cast<unsigned>(snapshot.battery_millivolts));
    }
  }
  stagePowerReport(now, false);
}

bool inputsReleased() {
  return digitalRead(mooneink::BoardProfile::boot_button) == HIGH &&
         digitalRead(mooneink::BoardProfile::touch_irq) == HIGH &&
         digitalRead(mooneink::BoardProfile::pca9535_interrupt) == HIGH;
}

void allowScreenWatch() {
  if (screen_watch_allowed) return;
  screen_watch_allowed = true;
  xTaskNotifyGive(screen_watch_task);
}

void resumeBatteryComponents() {
  if (!battery_components_suspended) return;
  if (xSemaphoreTake(m4_mutex, portMAX_DELAY) == pdTRUE) {
    apps.onWake();
    xSemaphoreGive(m4_mutex);
  }
  battery_components_suspended = false;
}

void enterBatteryIdleWait() {
  if (screen_watch_busy || screen_watch_allowed ||
      uxQueueMessagesWaiting(shell_input_queue) != 0 ||
      uxQueueMessagesWaiting(screen_update_queue) != 0 ||
      board_input.pendingGesture() || !inputsReleased() ||
      !sleep_wakeup_ready || !wakeable_power_path ||
      !deadlineReached(millis(), sleep_retry_at_ms) ||
      xSemaphoreTake(m4_mutex, 0) != pdTRUE) {
    return;
  }
  warm_light.setEnabled(false);
  if (!battery_components_suspended) {
    if (!apps.onSleep()) {
      xSemaphoreGive(m4_mutex);
      return;
    }
    WiFi.setAutoReconnect(false);
    WiFi.disconnect(false, false);
    if (!WiFi.mode(WIFI_OFF)) {
      apps.onWake();
      xSemaphoreGive(m4_mutex);
      sleep_retry_at_ms = millis() + 1000U;
      return;
    }
    battery_components_suspended = true;
    Serial.println("[POWER] idle_wait=LIGHT_SLEEP slice_ms=2000");
  }
  const std::uint32_t duration = mooneink::batterySleepSliceMs(
      millis(), next_battery_sync_ms, next_power_check_ms);
  // Keep the display worker out until the CPU has returned. Check again after
  // shutting down Wi-Fi: an input/update may have arrived during that handoff.
  if (duration == 0 || screen_watch_busy || screen_watch_allowed ||
      uxQueueMessagesWaiting(shell_input_queue) != 0 ||
      uxQueueMessagesWaiting(screen_update_queue) != 0 || !inputsReleased()) {
    xSemaphoreGive(m4_mutex);
    return;
  }
  esp_err_t result = esp_sleep_enable_timer_wakeup(duration * 1000ULL);
  if (result == ESP_OK) {
    ++battery_sleep_trace.sleep_entries;
    const std::int64_t started = esp_timer_get_time();
    // Never flush USB here: there may be no USB host. IDF restores esp_timer
    // from the RTC on return; delivery deadlines use that clock, not RTOS ticks.
    result = esp_light_sleep_start();
    if (result == ESP_OK) {
      total_light_sleep_us += esp_timer_get_time() - started;
      ++battery_sleep_trace.wake_returns;
      battery_sleep_trace.last_wakeup_cause = esp_sleep_get_wakeup_cause();
      if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_GPIO) {
        // Keep sampling through press AND debounced release. Do not reset the
        // touch controller or discard its latched first report.
        last_user_activity_ms = millis();
      }
    }
  }
  battery_sleep_trace.last_sleep_result = result;
  xSemaphoreGive(m4_mutex);
  if (result != ESP_OK) {
    sleep_retry_at_ms = millis() + 1000U;
    Serial.printf("[POWER] light_sleep=FAIL error=%ld\n", static_cast<long>(result));
  }
}

void servicePowerScheduler() {
  const std::uint32_t now = millis();
  refreshPowerState(now);

  if (!external_power_known || external_power) {
    if (battery_idle) Serial.println("[POWER] mode=EXTERNAL_REALTIME");
    resumeBatteryComponents();
    battery_idle = false;
    battery_sync_mode = false;
    battery_sync_complete = false;
    allowScreenWatch();
    return;
  }

  if (now - last_user_activity_ms < kBatteryActiveMs) {
    if (battery_idle) Serial.println("[POWER] mode=BATTERY_ACTIVE");
    resumeBatteryComponents();
    battery_idle = false;
    battery_sync_mode = false;
    battery_sync_complete = false;
    allowScreenWatch();
    return;
  }

  if (!battery_idle) {
    battery_idle = true;
    battery_sync_mode = false;
    battery_sync_complete = false;
    screen_watch_allowed = false;
    next_battery_sync_ms = now + batterySyncIntervalMs();
    warm_light.setEnabled(false);
    Serial.printf("[POWER] mode=BATTERY_IDLE next_sync_ms=%lu\n",
                  static_cast<unsigned long>(batterySyncIntervalMs()));
    stagePowerReport(now, true);
  }

  if (battery_sync_complete) {
    if (battery_sync_succeeded) {
      battery_sync_failures = 0;
      ++battery_sleep_trace.timed_sync_passes;
    } else if (battery_sync_failures < 4) {
      ++battery_sync_failures;
      ++battery_sleep_trace.timed_sync_failures;
    }
    battery_sync_complete = false;
    battery_sync_mode = false;
    next_battery_sync_ms = now + batterySyncIntervalMs();
    Serial.printf("[POWER] timed_sync=%s next_ms=%lu\n",
                  battery_sync_succeeded ? "PASS" : "BACKOFF",
                  static_cast<unsigned long>(batterySyncIntervalMs()));
  }

  if (!battery_sync_mode && deadlineReached(now, next_battery_sync_ms)) {
    resumeBatteryComponents();
    battery_sync_succeeded = false;
    battery_sync_complete = false;
    battery_sync_mode = true;
    allowScreenWatch();
    ++battery_sleep_trace.timed_sync_starts;
    // The existing timed screen request carries this status report, so every
    // successful battery wake becomes visible to the backend without another
    // radio wake or any EPD refresh.
    stagePowerReport(now, true);
    Serial.printf("[POWER] timed_sync=START sleep_returns=%lu slept_s=%llu\n",
                  static_cast<unsigned long>(battery_sleep_trace.wake_returns),
                  static_cast<unsigned long long>(total_light_sleep_us / 1000000ULL));
    return;
  }

  if (battery_sync_mode || screen_watch_allowed || screen_watch_busy) return;
  enterBatteryIdleWait();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);  // Logging must never wait for an unplugged USB host.
  delay(500);
  Serial.println("[M2] boot");
  if (battery_sleep_trace.magic != kBatterySleepTraceMagic) {
    battery_sleep_trace = BatterySleepTrace{};
    battery_sleep_trace.magic = kBatterySleepTraceMagic;
  }
  Serial.printf("[POWER] reset_reason=%u sleep_entries=%lu wake_returns=%lu sync_start=%lu sync_pass=%lu sync_fail=%lu last_sleep=%ld last_cause=%lu\n",
                static_cast<unsigned>(esp_reset_reason()),
                static_cast<unsigned long>(battery_sleep_trace.sleep_entries),
                static_cast<unsigned long>(battery_sleep_trace.wake_returns),
                static_cast<unsigned long>(battery_sleep_trace.timed_sync_starts),
                static_cast<unsigned long>(battery_sleep_trace.timed_sync_passes),
                static_cast<unsigned long>(battery_sleep_trace.timed_sync_failures),
                static_cast<long>(battery_sleep_trace.last_sleep_result),
                static_cast<unsigned long>(battery_sleep_trace.last_wakeup_cause));
  Serial.printf("[M2] profile=%s revision=%lu\n", mooneink::BoardProfile::id,
                static_cast<unsigned long>(mooneink::BoardProfile::revision));

  if (!events.publish(mooneink::EventKind::boot)) halt("event_bus");

  const mooneink::StorageProbe probe = storage.inspectReadOnly();
  const bool storage_ok = storageLayoutOk(probe);
  const bool transform_ok = mooneink::TouchTransform::selfTest();
  const bool device_json_ok = mooneink::deviceJsonSelfTest();
  const bool provisioning_ok = mooneink::m4ProvisioningSelfTest();
  const bool persistent_store_ok = persistent_store.begin() &&
                                   device_state.begin(persistent_store);
  Serial.printf("[M2] storage_layout=%s app0_size=%u touch_transform=%s\n",
                storage_ok ? "PASS" : "FAIL", static_cast<unsigned>(probe.app0_size),
                transform_ok ? "PASS" : "FAIL");
  Serial.printf("[M4] protocol_json=%s usb_parser=%s\n", device_json_ok ? "PASS" : "FAIL",
                provisioning_ok ? "PASS" : "FAIL");
  if (!device_json_ok || !provisioning_ok) halt("m4_protocol_json");
  if (!persistent_store_ok) halt("persistent_store");

  const std::size_t psram_total = ESP.getPsramSize();
  const std::size_t psram_before = ESP.getFreePsram();
  Serial.printf("[M2] psram_total=%u psram_before=%u\n", static_cast<unsigned>(psram_total),
                static_cast<unsigned>(psram_before));
  if (psram_total < mooneink::BoardProfile::psram_min_usable_bytes) halt("psram_size");
  if (!display.begin()) halt("display_init");
  if (!board_input.begin()) halt("input_init");
  sleep_wakeup_ready =
      gpio_wakeup_enable(static_cast<gpio_num_t>(mooneink::BoardProfile::boot_button), GPIO_INTR_LOW_LEVEL) == ESP_OK &&
      gpio_wakeup_enable(static_cast<gpio_num_t>(mooneink::BoardProfile::touch_irq), GPIO_INTR_LOW_LEVEL) == ESP_OK &&
      gpio_wakeup_enable(static_cast<gpio_num_t>(mooneink::BoardProfile::pca9535_interrupt), GPIO_INTR_LOW_LEVEL) == ESP_OK &&
      esp_sleep_enable_gpio_wakeup() == ESP_OK;
  Serial.printf("[POWER] light_sleep_wakeup=%s firmware=battery-light-sleep-20261021\n",
                sleep_wakeup_ready ? "READY" : "FAIL");
  if (!warm_light.begin()) halt("warm_light_init");
  Serial.printf("[M5] input boot=PASS function=%s touch_home=%s\n",
                board_input.functionButtonReady() ? "PASS" : "UNAVAILABLE",
                board_input.touchReady() ? "PASS" : "UNAVAILABLE");
  const std::size_t psram_after = ESP.getFreePsram();
  Serial.printf("[M2] display=%ux%u psram_total=%u psram_before=%u psram_after=%u\n",
                display_backend.width(), display_backend.height(),
                static_cast<unsigned>(psram_total), static_cast<unsigned>(psram_before),
                static_cast<unsigned>(psram_after));

  const mooneink::DiagnosticsSnapshot snapshot{
      mooneink::BoardProfile::id,
      mooneink::BoardProfile::revision,
      psram_total,
      psram_after,
      storage_ok,
      transform_ok,
      mooneink::BoardProfile::sd_card_verified,
  };
  diagnostics_app.setSnapshot(snapshot);
  if (!apps.registerApp(diagnostics_app) || !apps.registerApp(settings_app) ||
      !apps.registerApp(reader_app) || !apps.registerApp(m4_first_light) ||
      !apps.activate("diagnostics")) {
    halt("app_manager");
  }
  const mooneink::DisplayPolicySnapshot diagnostics_state = display.snapshot();
  const bool input_ok = diagnostics_state.physical_known;
  const bool identity_ok = display.owner() != nullptr &&
                           std::strcmp(display.owner(), "diagnostics") == 0 &&
                           diagnostics_state.visible_surface == mooneink::SurfaceKind::app_frame;
  Serial.printf("[M2] identity_state=%s input_bind=%s\n", identity_ok ? "PASS" : "FAIL",
                input_ok ? "PASS" : "FAIL");
  if (!identity_ok || !input_ok) halt("display_input_commit");
  Serial.printf("[M2] state=RUNNING apps=%u events=%u dropped=%lu\n",
                static_cast<unsigned>(apps.appCount()), static_cast<unsigned>(events.size()),
                static_cast<unsigned long>(events.dropped()));

  if (!lvgl.begin()) halt("m3_lvgl_init");
  const std::size_t m4_psram_before = ESP.getFreePsram();
  remote_frame_a = static_cast<std::uint8_t*>(heap_caps_malloc(
      mooneink::BoardProfile::gray4_frame_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  remote_frame_b = static_cast<std::uint8_t*>(heap_caps_malloc(
      mooneink::BoardProfile::gray4_frame_bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (remote_frame_a == nullptr || remote_frame_b == nullptr ||
      !remote_frames.begin(remote_frame_a, remote_frame_b,
                           mooneink::BoardProfile::gray4_frame_bytes)) {
    halt("m4_remote_cache");
  }
  Serial.printf("[M4] remote_cache=PASS buffers=%u psram_before=%u psram_after=%u\n",
                static_cast<unsigned>(mooneink::BoardProfile::gray4_frame_bytes * 2U),
                static_cast<unsigned>(m4_psram_before),
                static_cast<unsigned>(ESP.getFreePsram()));
  const mooneink::LocalUiSnapshot local_snapshot{
      mooneink::BoardProfile::id,
      ESP.getFreePsram(),
      static_cast<std::uint16_t>(apps.appCount()),
      static_cast<std::uint16_t>(events.size()),
      storage_ok,
      transform_ok,
  };
  settings_app.setSnapshot(local_snapshot);
  if (!apps.activate("settings")) halt("m3_app_switch");
  const mooneink::DisplayPolicySnapshot local_state = display.snapshot();
  const bool local_identity_ok = display.owner() != nullptr &&
                                 std::strcmp(display.owner(), "settings") == 0 &&
                                 local_state.physical_known &&
                                 local_state.visible_surface == mooneink::SurfaceKind::app_frame;
  const bool local_input_ok = local_identity_ok;
  Serial.printf("[M3] lvgl=%d.%d.%d draw_buffers=%u bytes psram_free=%u\n",
                LVGL_VERSION_MAJOR, LVGL_VERSION_MINOR, LVGL_VERSION_PATCH,
                static_cast<unsigned>(lvgl.drawBufferBytes()),
                static_cast<unsigned>(ESP.getFreePsram()));
  Serial.printf("[M3] composition=PASS identity_state=%s input_bind=%s\n",
                local_identity_ok ? "PASS" : "FAIL", local_input_ok ? "PASS" : "FAIL");
  if (!local_identity_ok || !local_input_ok) halt("m3_input_commit");
  Serial.printf("[M3] state=RUNNING active_app=%s events=%u dropped=%lu\n", apps.activeApp(),
                static_cast<unsigned>(events.size()),
                static_cast<unsigned long>(events.dropped()));
  Serial.println("[M4] usb_provisioning=READY persistence=NVS");
  if (m4_first_light.hasStoredSetup()) {
    mooneink::M4FirstLightError restore_error = mooneink::M4FirstLightError::none;
    if (!m4_first_light.resume(restore_error)) {
      Serial.printf("[M4] auto_restore=PENDING reason=%s\n",
                    mooneink::m4FirstLightErrorName(restore_error));
    } else {
      Serial.println("[M4] auto_restore=PASS");
    }
  }
  m4_mutex = xSemaphoreCreateMutex();
  shell_input_queue = xQueueCreate(8, sizeof(mooneink::ShellInputEvent));
  screen_update_queue = xQueueCreate(1, sizeof(mooneink::ScreenResponse));
  if (m4_mutex == nullptr || shell_input_queue == nullptr || screen_update_queue == nullptr ||
      xTaskCreate(m4WorkerTask, "m4-worker", 16 * 1024, nullptr, 2, nullptr) != pdPASS ||
      xTaskCreate(screenWatchTask, "screen-watch", 12 * 1024, nullptr, 1, &screen_watch_task) != pdPASS) {
    halt("m4_tasks");
  }
  last_user_activity_ms = millis();
  next_power_check_ms = 0;
  refreshPowerState(millis());
  Serial.println("[M4] live_updates=READY input_queue=READY");
}

void loop() {
  while (Serial.available() > 0) {
    mooneink::M4SerialCommand command{};
    bool rejected = false;
    if (!m4_serial.feed(static_cast<char>(Serial.read()), command, rejected)) {
      if (rejected) Serial.println("[M4] serial_command=REJECTED");
      continue;
    }
    mooneink::M4FirstLightError error = mooneink::M4FirstLightError::none;
    bool ok = false;
    if (xSemaphoreTake(m4_mutex, portMAX_DELAY) != pdTRUE) continue;
    switch (command.kind) {
      case mooneink::M4SerialCommandKind::provision:
        Serial.println("[M4] provisioning=ACCEPTED");
        ok = m4_first_light.run(command.provisioning, error);
        command.provisioning.clearSecrets();
        break;
      case mooneink::M4SerialCommandKind::show_settings:
        ok = m4_first_light.showSettings(error);
        break;
      case mooneink::M4SerialCommandKind::show_ephemera:
        ok = m4_first_light.showEphemera(error);
        break;
      case mooneink::M4SerialCommandKind::m5_action:
        if (system_shell.appInputAllowed()) {
          mooneink::AppInputEvent app_input{};
          app_input.kind = mooneink::AppInputKind::action;
          app_input.action_id = mooneink::remoteActionId(command.action);
          const mooneink::AppInputResult result = apps.dispatchInput(app_input);
          ok = result == mooneink::AppInputResult::handled;
          if (result == mooneink::AppInputResult::blocked) {
            error = mooneink::M4FirstLightError::event_backpressure;
          } else if (!ok) {
            error = mooneink::M4FirstLightError::action_unavailable;
          }
        } else {
          error = mooneink::M4FirstLightError::action_unavailable;
        }
        break;
      case mooneink::M4SerialCommandKind::m5_touch:
        {
          mooneink::ShellInputEvent shell_input{};
          shell_input.kind = mooneink::ShellInputKind::touch;
          shell_input.x = command.touch.x;
          shell_input.y = command.touch.y;
          ok = xQueueSend(shell_input_queue, &shell_input, 0) == pdTRUE;
          if (!ok) error = mooneink::M4FirstLightError::action_unavailable;
        }
        break;
      case mooneink::M4SerialCommandKind::factory_reset:
        ok = device_state.retireBinding();
        if (ok) {
          Serial.println("[M4] factory_reset=PASS");
          delay(100);
          ESP.restart();
        } else {
          error = mooneink::M4FirstLightError::invalid_configuration;
        }
        break;
      case mooneink::M4SerialCommandKind::none:
        break;
    }
    xSemaphoreGive(m4_mutex);
    if (!ok) {
      Serial.printf("[M4] command=FAIL reason=%s\n", mooneink::m4FirstLightErrorName(error));
    }
  }
  mooneink::H75201InputEvent input{};
  if (!inputsReleased() || board_input.pendingGesture()) {
    last_user_activity_ms = millis();
  }
  if (board_input.poll(input)) {
    last_user_activity_ms = millis();
    if (input.kind == mooneink::H75201InputKind::button) {
      // Input identity must remain observable before provisioning.  Otherwise
      // a valid key press is indistinguishable from a hardware fault when the
      // RAM-only M4 session has been lost after reset.
      unsigned ready = 0;
      if (xSemaphoreTake(m4_mutex, 0) == pdTRUE) {
        ready = m4_first_light.ready() ? 1U : 0U;
        xSemaphoreGive(m4_mutex);
      }
      Serial.printf("[M5] button=%s gesture=%s ready=%u\n",
                    physicalButtonName(input.button.button),
                    buttonGestureName(input.button.gesture),
                    ready);
    }
    bool reserved = false;
    mooneink::ShellInputEvent shell_input{};
    if (input.kind == mooneink::H75201InputKind::button &&
        input.button.button == mooneink::PhysicalButton::home &&
        input.button.gesture == mooneink::ButtonGesture::short_press) {
      shell_input.kind = mooneink::ShellInputKind::home_short;
    } else if (input.kind == mooneink::H75201InputKind::button &&
               input.button.button == mooneink::PhysicalButton::home &&
               input.button.gesture == mooneink::ButtonGesture::long_press) {
      shell_input.kind = mooneink::ShellInputKind::home_long;
    } else if (input.kind == mooneink::H75201InputKind::button &&
               input.button.button == mooneink::PhysicalButton::function &&
               input.button.gesture == mooneink::ButtonGesture::long_press) {
      // S3 is software-readable and distinct from the hardware QON/S4 key.
      // Its decoder suppresses the short page turn when this hold is emitted.
      shell_input.kind = mooneink::ShellInputKind::light_toggle;
    } else if (input.kind == mooneink::H75201InputKind::button &&
               input.button.button == mooneink::PhysicalButton::boot &&
               input.button.gesture == mooneink::ButtonGesture::long_press) {
      reserved = true;
    } else if (input.kind == mooneink::H75201InputKind::touch) {
      shell_input.kind = mooneink::ShellInputKind::touch;
      shell_input.x = input.touch.x;
      shell_input.y = input.touch.y;
    } else if (input.kind == mooneink::H75201InputKind::button &&
               input.button.button == mooneink::PhysicalButton::function) {
      // PCA9535 S3 short press is the dedicated next-page key.
      shell_input.kind = mooneink::ShellInputKind::next_page;
    } else if (input.kind == mooneink::H75201InputKind::button &&
               input.button.button == mooneink::PhysicalButton::boot) {
      // The opposite side key is a dedicated previous-page key.
      shell_input.kind = mooneink::ShellInputKind::previous_page;
    }
    if (!reserved) {
      if (xQueueSend(shell_input_queue, &shell_input, 0) != pdTRUE) {
        Serial.println("[SHELL] input_queue=FULL");
      }
    }
  }
  bool needs_setup_retry = false;
  // Never wait behind a slow display/network operation here: the loop task's
  // primary job is to keep sampling physical keys and queue every press.
  if (xSemaphoreTake(m4_mutex, 0) == pdTRUE) {
    needs_setup_retry = !m4_first_light.ready() && m4_first_light.hasStoredSetup();
    xSemaphoreGive(m4_mutex);
  }
  if (needs_setup_retry && millis() - last_setup_retry_ms >= 60000U) {
    last_setup_retry_ms = millis();
    mooneink::M4FirstLightError retry_error = mooneink::M4FirstLightError::none;
    bool resumed = false;
    if (xSemaphoreTake(m4_mutex, portMAX_DELAY) == pdTRUE) {
      resumed = m4_first_light.resume(retry_error);
      xSemaphoreGive(m4_mutex);
    }
    if (!resumed) {
      Serial.printf("[M4] auto_retry=PENDING reason=%s\n",
                    mooneink::m4FirstLightErrorName(retry_error));
    }
  }
  servicePowerScheduler();
  delay(10);
}

