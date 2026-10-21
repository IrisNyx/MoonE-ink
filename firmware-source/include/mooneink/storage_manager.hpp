// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>

namespace mooneink {

struct StorageProbe final {
  bool nvs;
  bool app0;
  bool font;
  bool coredump;
  bool crashlog;
  bool spiffs;
  std::size_t app0_size;
};

class StorageManager final {
 public:
  StorageProbe inspectReadOnly() const;
};

}  // namespace mooneink

