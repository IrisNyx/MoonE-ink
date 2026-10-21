// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>
#include <cstdint>

namespace mooneink {

enum class LauncherAction : std::uint16_t {
  back = 100,
  ephemera = 101,
  settings = 102,
  diagnostics = 103,
  ephemera_controls = 104,
  reader = 105,
};

struct LocalUiSnapshot final {
  const char* profile_id;
  std::size_t psram_free;
  std::uint16_t app_count;
  std::uint16_t event_count;
  bool storage_ok;
  bool touch_ok;
};

class LocalUi final {
 public:
  bool build(const LocalUiSnapshot& snapshot);
  bool buildLauncher(bool ephemera_available, bool ephemera_active,
                     bool reader_active);
  bool buildEphemeraSystemMenu();
  bool buildReaderUnavailable(const char* reason);
  bool buildReaderPage(const char* text, std::uint64_t source_offset,
                       std::uint64_t file_size, bool has_more);
};

}  // namespace mooneink
