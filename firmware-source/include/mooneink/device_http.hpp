// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/device_json.hpp"
#include "mooneink/remote_frame_cache.hpp"

namespace mooneink {

enum class DeviceHttpError : std::uint8_t {
  none,
  invalid_configuration,
  transport_failed,
  http_rejected,
  response_too_large,
  invalid_response,
  asset_length_mismatch,
  asset_integrity_failed,
};

struct DeviceEndpoint final {
  static constexpr std::size_t url_capacity = 256;
  std::array<char, url_capacity> base_url{};
  const char* root_ca_pem = nullptr;
  bool use_system_ca_bundle = false;
  bool allow_plaintext_private = false;

  bool set(const char* url, const char* root_ca, bool allow_plaintext);
  bool valid() const;
  bool secure() const;
};

class DeviceHttpClient final {
 public:
  explicit DeviceHttpClient(const DeviceEndpoint& endpoint) : endpoint_(endpoint) {}

  bool pair(const char* request_id, const char* device_id, const char* enrollment_code,
            DeviceBinding& binding, DeviceHttpError& error);
  bool fetchScreen(const DeviceBinding& binding, ScreenResponse& response,
                   DeviceHttpError& error);
  bool waitForScreen(const DeviceBinding& binding, std::uint64_t after_revision,
                     std::uint32_t wait_ms, ScreenResponse& response,
                     bool& changed, DeviceHttpError& error);
  bool fetchScreenState(const DeviceBinding& binding, const char* read_status_for,
                        ScreenResponse& response, DeviceHttpError& error);
  bool waitForScreenState(const DeviceBinding& binding,
                          std::uint64_t after_revision,
                          std::uint64_t after_library_revision,
                          std::uint32_t wait_ms, const char* read_status_for,
                          ScreenResponse& response, bool& changed,
                          DeviceHttpError& error);
  bool fetchHistory(const DeviceBinding& binding, const char* cursor,
                    std::uint8_t limit, HistoryResponse& response,
                    DeviceHttpError& error);
  bool fetchLibraryHistory(const DeviceBinding& binding, const char* cursor,
                           std::uint8_t limit, const char* filter,
                           HistoryResponse& response, DeviceHttpError& error);
  bool fetchPages(const DeviceBinding& binding, const char* publication_id,
                  const char* profile, const char* edition_id,
                  PagesResponse& response, DeviceHttpError& error);
  bool downloadFrame(const DeviceBinding& binding, const RemoteFrameDescriptor& descriptor,
                     RemoteFrameCache& cache, DeviceHttpError& error);
  bool postEvent(const DeviceBinding& binding, const DeviceEvent& event,
                 const DevicePowerReport* power, DeviceHttpError& error);

 private:
  bool buildUrl(const char* path, char* output, std::size_t capacity) const;

  DeviceEndpoint endpoint_{};
};

}  // namespace mooneink
