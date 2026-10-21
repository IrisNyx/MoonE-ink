// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/storage_manager.hpp"

#include <cstring>
#include <esp_partition.h>

namespace mooneink {
namespace {

const esp_partition_t* findLabel(const char* label) {
  esp_partition_iterator_t iterator = esp_partition_find(
      ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, nullptr);
  while (iterator != nullptr) {
    const esp_partition_t* partition = esp_partition_get(iterator);
    if (partition != nullptr && std::strcmp(partition->label, label) == 0) {
      esp_partition_iterator_release(iterator);
      return partition;
    }
    iterator = esp_partition_next(iterator);
  }
  return nullptr;
}

}  // namespace

StorageProbe StorageManager::inspectReadOnly() const {
  const esp_partition_t* app0 = findLabel("app0");
  return StorageProbe{
      findLabel("nvs") != nullptr,
      app0 != nullptr,
      findLabel("font") != nullptr,
      findLabel("coredump") != nullptr,
      findLabel("crashlog") != nullptr,
      findLabel("spiffs") != nullptr,
      app0 == nullptr ? 0U : app0->size,
  };
}

}  // namespace mooneink

