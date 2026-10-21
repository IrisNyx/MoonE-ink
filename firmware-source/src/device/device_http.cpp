// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/device_http.hpp"

#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>

#include <cstdio>
#include <cstring>

namespace mooneink {
namespace {

constexpr std::size_t kMaxJsonResponse = 32768;
extern const std::uint8_t system_ca_bundle[] asm("_binary_x509_crt_bundle_start");

class BoundedBodyStream final : public Stream {
 public:
  BoundedBodyStream(String& output, const std::size_t capacity)
      : output_(output), capacity_(capacity) {}

  std::size_t write(const std::uint8_t value) override { return write(&value, 1); }
  std::size_t write(const std::uint8_t* data, const std::size_t length) override {
    if (data == nullptr || length > capacity_ - output_.length()) {
      overflow_ = true;
      return 0;
    }
    return output_.concat(reinterpret_cast<const char*>(data), length) ? length : 0;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
  bool overflowed() const { return overflow_; }

 private:
  String& output_;
  std::size_t capacity_ = 0;
  bool overflow_ = false;
};

bool startsWith(const char* value, const char* prefix) {
  return value != nullptr && prefix != nullptr &&
         std::strncmp(value, prefix, std::strlen(prefix)) == 0;
}

bool isPrivatePlaintextAuthority(const char* authority) {
  if (authority == nullptr || authority[0] == '\0') return false;
  char host[128]{};
  const char* end = std::strchr(authority, ':');
  const std::size_t length = end == nullptr ? std::strlen(authority)
                                            : static_cast<std::size_t>(end - authority);
  if (length == 0 || length >= sizeof(host)) return false;
  std::memcpy(host, authority, length);
  if (std::strcmp(host, "localhost") == 0) return true;
  if (length > 6 && std::strcmp(host + length - 6, ".local") == 0) return true;
  unsigned a = 0;
  unsigned b = 0;
  unsigned c = 0;
  unsigned d = 0;
  char tail = '\0';
  if (std::sscanf(host, "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) != 4 ||
      a > 255 || b > 255 || c > 255 || d > 255) {
    return false;
  }
  return a == 10 || (a == 172 && b >= 16 && b <= 31) ||
         (a == 192 && b == 168) || (a == 169 && b == 254) || a == 127;
}

bool configureHttp(HTTPClient& http, const DeviceEndpoint& endpoint, const char* url,
                   WiFiClient& plain, WiFiClientSecure& secure) {
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.setConnectTimeout(15000);
  http.setTimeout(15000);
  if (endpoint.secure()) {
    if (endpoint.root_ca_pem != nullptr) {
      secure.setCACert(endpoint.root_ca_pem);
    } else if (endpoint.use_system_ca_bundle) {
      secure.setCACertBundle(system_ca_bundle);
    } else {
      return false;
    }
    return http.begin(secure, url);
  }
  return http.begin(plain, url);
}

bool readBoundedJson(HTTPClient& http, String& body, const std::size_t capacity,
                     DeviceHttpError& error) {
  const int length = http.getSize();
  if (capacity == 0 ||
      (length > 0 && static_cast<std::size_t>(length) > capacity)) {
    error = DeviceHttpError::response_too_large;
    return false;
  }
  body = "";
  const std::size_t reserve = length > 0 ? static_cast<std::size_t>(length) :
                                          (capacity < 1024 ? capacity : 1024);
  if (!body.reserve(reserve + 1)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  BoundedBodyStream sink(body, capacity);
  const int received = http.writeToStream(&sink);
  if (sink.overflowed()) {
    error = DeviceHttpError::response_too_large;
    return false;
  }
  if (received < 0 || static_cast<std::size_t>(received) != body.length() ||
      (length >= 0 && received != length)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  return true;
}

bool setBearer(HTTPClient& http, const DeviceBinding& binding) {
  if (!binding.valid()) return false;
  String value("Bearer ");
  value += binding.device_secret.data();
  http.addHeader("Authorization", value, false, true);
  return true;
}

}  // namespace

bool DeviceEndpoint::set(const char* url, const char* root_ca, const bool allow_plaintext) {
  base_url.fill('\0');
  root_ca_pem = root_ca;
  use_system_ca_bundle = false;
  allow_plaintext_private = allow_plaintext;
  if (url == nullptr) return false;
  std::size_t length = std::strlen(url);
  while (length > 0 && url[length - 1] == '/') --length;
  if (length == 0 || length >= base_url.size()) return false;
  std::memcpy(base_url.data(), url, length);
  use_system_ca_bundle = secure() && (root_ca_pem == nullptr || root_ca_pem[0] == '\0');
  if (!valid()) {
    base_url.fill('\0');
    return false;
  }
  return true;
}

bool DeviceEndpoint::secure() const { return startsWith(base_url.data(), "https://"); }

bool DeviceEndpoint::valid() const {
  if (base_url[0] == '\0' || std::strchr(base_url.data(), '@') != nullptr ||
      std::strchr(base_url.data(), '#') != nullptr ||
      std::strchr(base_url.data(), '?') != nullptr) {
    return false;
  }
  const char* authority = nullptr;
  if (secure()) {
    authority = base_url.data() + std::strlen("https://");
  } else if (allow_plaintext_private && startsWith(base_url.data(), "http://")) {
    authority = base_url.data() + std::strlen("http://");
  } else {
    return false;
  }
  if (authority[0] == '\0' || std::strchr(authority, '/') != nullptr ||
      std::strchr(authority, '\\') != nullptr) {
    return false;
  }
  for (const char* cursor = authority; *cursor != '\0'; ++cursor) {
    if (static_cast<unsigned char>(*cursor) <= 0x20U) return false;
  }
  return secure() || isPrivatePlaintextAuthority(authority);
}

bool DeviceHttpClient::buildUrl(const char* path, char* output,
                                const std::size_t capacity) const {
  if (!endpoint_.valid() || path == nullptr || path[0] != '/' || output == nullptr ||
      capacity == 0) {
    return false;
  }
  const int length = std::snprintf(output, capacity, "%s%s", endpoint_.base_url.data(), path);
  return length > 0 && static_cast<std::size_t>(length) < capacity;
}

bool DeviceHttpClient::pair(const char* request_id, const char* device_id,
                            const char* enrollment_code, DeviceBinding& binding,
                            DeviceHttpError& error) {
  error = DeviceHttpError::none;
  char url[DeviceEndpoint::url_capacity + 32]{};
  char request[1024]{};
  std::size_t request_length = 0;
  if (!buildUrl("/device/v1/pair", url, sizeof(url)) ||
      !writePairRequest(request, sizeof(request), request_length, request_id, device_id,
                        enrollment_code)) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  http.addHeader("Content-Type", "application/json", false, true);
  const int status = http.POST(reinterpret_cast<std::uint8_t*>(request), request_length);
  if (status != 200) {
    error = status > 0 ? DeviceHttpError::http_rejected : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  String body;
  if (!readBoundedJson(http, body, kMaxJsonResponse, error)) {
    http.end();
    return false;
  }
  http.end();
  DeviceJsonError json_error = DeviceJsonError::none;
  if (!parsePairResponse(body.c_str(), body.length(), device_id, binding, json_error)) {
    error = DeviceHttpError::invalid_response;
    return false;
  }
  return true;
}

bool DeviceHttpClient::fetchScreen(const DeviceBinding& binding, ScreenResponse& response,
                                   DeviceHttpError& error) {
  bool changed = false;
  return waitForScreen(binding, 0, 0, response, changed, error) && changed;
}

bool DeviceHttpClient::fetchScreenState(const DeviceBinding& binding,
                                        const char* read_status_for,
                                        ScreenResponse& response,
                                        DeviceHttpError& error) {
  bool changed = false;
  return waitForScreenState(binding, 0, 0, 0, read_status_for, response,
                            changed, error) && changed;
}

bool DeviceHttpClient::waitForScreen(const DeviceBinding& binding,
                                     const std::uint64_t after_revision,
                                     const std::uint32_t wait_ms,
                                     ScreenResponse& response, bool& changed,
                                     DeviceHttpError& error) {
  error = DeviceHttpError::none;
  changed = false;
  char path[96]{};
  char url[DeviceEndpoint::url_capacity + sizeof(path)]{};
  const int path_length = wait_ms == 0
      ? std::snprintf(path, sizeof(path), "/device/v1/screen")
      : std::snprintf(path, sizeof(path),
                      "/device/v1/screen?after_revision=%llu&wait_ms=%lu",
                      static_cast<unsigned long long>(after_revision),
                      static_cast<unsigned long>(wait_ms));
  if (path_length <= 0 || static_cast<std::size_t>(path_length) >= sizeof(path) ||
      wait_ms > 30000U || !buildUrl(path, url, sizeof(url)) || !binding.valid()) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure) || !setBearer(http, binding)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  const std::uint32_t timeout = wait_ms == 0 ? binding.limits.request_timeout_ms
                                             : wait_ms + 5000U;
  http.setTimeout(static_cast<std::uint16_t>(timeout > UINT16_MAX ? UINT16_MAX : timeout));
  const int status = http.GET();
  if (status == 304 || status == 204) {
    http.end();
    return true;
  }
  if (status != 200) {
    error = status > 0 ? DeviceHttpError::http_rejected : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  String body;
  if (!readBoundedJson(http, body, kMaxJsonResponse, error)) {
    http.end();
    return false;
  }
  http.end();
  DeviceJsonError json_error = DeviceJsonError::none;
  if (!parseScreenResponse(body.c_str(), body.length(), binding, response, json_error)) {
    error = DeviceHttpError::invalid_response;
    return false;
  }
  changed = true;
  return true;
}

bool DeviceHttpClient::waitForScreenState(
    const DeviceBinding& binding, const std::uint64_t after_revision,
    const std::uint64_t after_library_revision, const std::uint32_t wait_ms,
    const char* read_status_for, ScreenResponse& response, bool& changed,
    DeviceHttpError& error) {
  error = DeviceHttpError::none;
  changed = false;
  const bool has_read_status =
      read_status_for != nullptr && read_status_for[0] != '\0';
  char path[384]{};
  char url[DeviceEndpoint::url_capacity + sizeof(path)]{};
  const int path_length = std::snprintf(
      path, sizeof(path),
      has_read_status
          ? "/device/v1/screen?include_library=1&after_revision=%llu&after_library_revision=%llu&wait_ms=%lu&read_status_for=%s"
          : "/device/v1/screen?include_library=1&after_revision=%llu&after_library_revision=%llu&wait_ms=%lu",
      static_cast<unsigned long long>(after_revision),
      static_cast<unsigned long long>(after_library_revision),
      static_cast<unsigned long>(wait_ms),
      has_read_status ? read_status_for : "");
  if (path_length <= 0 || static_cast<std::size_t>(path_length) >= sizeof(path) ||
      wait_ms > 30000U || !binding.valid() ||
      (has_read_status && !isProtocolIdentifier(read_status_for)) ||
      !buildUrl(path, url, sizeof(url))) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure) ||
      !setBearer(http, binding)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  const std::uint32_t timeout = wait_ms == 0 ? binding.limits.request_timeout_ms
                                             : wait_ms + 5000U;
  http.setTimeout(static_cast<std::uint16_t>(timeout > UINT16_MAX ? UINT16_MAX
                                                                  : timeout));
  const int status = http.GET();
  if (status == 304 || status == 204) {
    http.end();
    return true;
  }
  if (status != 200) {
    error = status > 0 ? DeviceHttpError::http_rejected
                       : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  String body;
  if (!readBoundedJson(http, body, kMaxJsonResponse, error)) {
    http.end();
    return false;
  }
  http.end();
  DeviceJsonError json_error = DeviceJsonError::none;
  if (!parseScreenResponse(body.c_str(), body.length(), binding, response,
                           json_error) ||
      !response.has_library) {
    error = DeviceHttpError::invalid_response;
    return false;
  }
  changed = true;
  return true;
}

bool DeviceHttpClient::fetchHistory(const DeviceBinding& binding, const char* cursor,
                                    const std::uint8_t limit, HistoryResponse& response,
                                    DeviceHttpError& error) {
  error = DeviceHttpError::none;
  char path[256]{};
  char url[DeviceEndpoint::url_capacity + sizeof(path)]{};
  const bool has_cursor = cursor != nullptr && cursor[0] != '\0';
  const int path_length = has_cursor
      ? std::snprintf(path, sizeof(path), "/device/v1/history?cursor=%s&limit=%u",
                      cursor, static_cast<unsigned>(limit))
      : std::snprintf(path, sizeof(path), "/device/v1/history?limit=%u",
                      static_cast<unsigned>(limit));
  if (!binding.valid() || limit == 0 || limit > HistoryResponse::item_capacity ||
      limit > binding.limits.max_history_items ||
      (has_cursor && !isProtocolCursor(cursor)) || path_length <= 0 ||
      static_cast<std::size_t>(path_length) >= sizeof(path) ||
      !buildUrl(path, url, sizeof(url))) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure) || !setBearer(http, binding)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  http.setTimeout(static_cast<std::uint16_t>(
      binding.limits.request_timeout_ms > UINT16_MAX
          ? UINT16_MAX
          : binding.limits.request_timeout_ms));
  const int status = http.GET();
  if (status != 200) {
    error = status > 0 ? DeviceHttpError::http_rejected : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  String body;
  if (!readBoundedJson(http, body, binding.limits.max_history_response_bytes, error)) {
    http.end();
    return false;
  }
  http.end();
  DeviceJsonError json_error = DeviceJsonError::none;
  if (!parseHistoryResponse(body.c_str(), body.length(), binding, response, json_error)) {
    error = DeviceHttpError::invalid_response;
    return false;
  }
  return true;
}

bool DeviceHttpClient::fetchLibraryHistory(
    const DeviceBinding& binding, const char* cursor, const std::uint8_t limit,
    const char* filter, HistoryResponse& response, DeviceHttpError& error) {
  error = DeviceHttpError::none;
  char path[320]{};
  char url[DeviceEndpoint::url_capacity + sizeof(path)]{};
  const bool has_cursor = cursor != nullptr && cursor[0] != '\0';
  const bool filter_ok = filter != nullptr &&
                         (std::strcmp(filter, "recent") == 0 ||
                          std::strcmp(filter, "unread") == 0);
  const int path_length = has_cursor
      ? std::snprintf(path, sizeof(path),
                      "/device/v1/history?include_library=1&filter=%s&cursor=%s&limit=%u",
                      filter == nullptr ? "" : filter, cursor,
                      static_cast<unsigned>(limit))
      : std::snprintf(path, sizeof(path),
                      "/device/v1/history?include_library=1&filter=%s&limit=%u",
                      filter == nullptr ? "" : filter,
                      static_cast<unsigned>(limit));
  if (!binding.valid() || !filter_ok || limit == 0 ||
      limit > HistoryResponse::item_capacity ||
      limit > binding.limits.max_history_items ||
      (has_cursor && !isProtocolCursor(cursor)) || path_length <= 0 ||
      static_cast<std::size_t>(path_length) >= sizeof(path) ||
      !buildUrl(path, url, sizeof(url))) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure) ||
      !setBearer(http, binding)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  http.setTimeout(static_cast<std::uint16_t>(
      binding.limits.request_timeout_ms > UINT16_MAX
          ? UINT16_MAX
          : binding.limits.request_timeout_ms));
  const int status = http.GET();
  if (status != 200) {
    error = status > 0 ? DeviceHttpError::http_rejected
                       : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  String body;
  if (!readBoundedJson(http, body, binding.limits.max_history_response_bytes,
                       error)) {
    http.end();
    return false;
  }
  http.end();
  DeviceJsonError json_error = DeviceJsonError::none;
  if (!parseHistoryResponse(body.c_str(), body.length(), binding, response,
                            json_error) ||
      !response.has_library) {
    error = DeviceHttpError::invalid_response;
    return false;
  }
  return true;
}

bool DeviceHttpClient::fetchPages(const DeviceBinding& binding,
                                  const char* publication_id, const char* profile,
                                  const char* edition_id, PagesResponse& response,
                                  DeviceHttpError& error) {
  error = DeviceHttpError::none;
  char path[512]{};
  char url[DeviceEndpoint::url_capacity + sizeof(path)]{};
  const int path_length = std::snprintf(
      path, sizeof(path),
      "/device/v1/publications/%s/pages?profile=%s&edition_id=%s",
      publication_id == nullptr ? "" : publication_id,
      profile == nullptr ? "" : profile,
      edition_id == nullptr ? "" : edition_id);
  if (!binding.valid() || !isProtocolIdentifier(publication_id) ||
      !isProtocolIdentifier(edition_id) || profile == nullptr ||
      !isSupportedProfile(profile) ||
      path_length <= 0 || static_cast<std::size_t>(path_length) >= sizeof(path) ||
      !buildUrl(path, url, sizeof(url))) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure) || !setBearer(http, binding)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  http.setTimeout(static_cast<std::uint16_t>(
      binding.limits.request_timeout_ms > UINT16_MAX
          ? UINT16_MAX
          : binding.limits.request_timeout_ms));
  const int status = http.GET();
  if (status != 200) {
    error = status > 0 ? DeviceHttpError::http_rejected : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  String body;
  if (!readBoundedJson(http, body, binding.limits.max_pages_response_bytes, error)) {
    http.end();
    return false;
  }
  http.end();
  DeviceJsonError json_error = DeviceJsonError::none;
  if (!parsePagesResponse(body.c_str(), body.length(), binding, response, json_error) ||
      std::strcmp(response.publication_id.data(), publication_id) != 0 ||
      std::strcmp(response.edition_id.data(), edition_id) != 0 ||
      std::strcmp(response.profile.data(), profile) != 0) {
    error = DeviceHttpError::invalid_response;
    return false;
  }
  return true;
}

bool DeviceHttpClient::downloadFrame(const DeviceBinding& binding,
                                     const RemoteFrameDescriptor& descriptor,
                                     RemoteFrameCache& cache, DeviceHttpError& error) {
  error = DeviceHttpError::none;
  DescriptorError descriptor_error = DescriptorError::none;
  char url[DeviceEndpoint::url_capacity + DeviceProtocol::asset_path_capacity]{};
  if (!binding.valid() || !validateRemoteFrameDescriptor(descriptor, descriptor_error) ||
      !buildUrl(descriptor.asset.data(), url, sizeof(url)) || !cache.beginStage(descriptor)) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure) || !setBearer(http, binding)) {
    cache.discardStage();
    error = DeviceHttpError::transport_failed;
    return false;
  }
  http.setTimeout(static_cast<std::uint16_t>(
      binding.limits.asset_download_timeout_ms > UINT16_MAX
          ? UINT16_MAX
          : binding.limits.asset_download_timeout_ms));
  const int status = http.GET();
  if (status != 200) {
    cache.discardStage();
    error = status > 0 ? DeviceHttpError::http_rejected : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  if (http.getSize() != static_cast<int>(descriptor.byte_length)) {
    cache.discardStage();
    error = DeviceHttpError::asset_length_mismatch;
    http.end();
    return false;
  }
  WiFiClient* stream = http.getStreamPtr();
  std::uint8_t chunk[1024]{};
  std::size_t received = 0;
  const std::uint32_t started = millis();
  while (received < descriptor.byte_length) {
    if (millis() - started > binding.limits.asset_download_timeout_ms) {
      cache.discardStage();
      error = DeviceHttpError::transport_failed;
      http.end();
      return false;
    }
    const int available = stream->available();
    if (available <= 0) {
      if (!stream->connected()) {
        cache.discardStage();
        error = DeviceHttpError::transport_failed;
        http.end();
        return false;
      }
      // Arduino Stream::readBytes() busy-spins inside timedRead() while a TCP
      // packet is outstanding.  A slow 259 KiB EPD frame can therefore starve
      // CPU0's idle task long enough to trip the hardware watchdog.  Wait for
      // the next packet cooperatively instead.
      delay(1);
      continue;
    }
    const std::size_t remaining = descriptor.byte_length - received;
    std::size_t wanted = remaining < sizeof(chunk) ? remaining : sizeof(chunk);
    if (wanted > static_cast<std::size_t>(available)) {
      wanted = static_cast<std::size_t>(available);
    }
    const int count = stream->read(chunk, wanted);
    if (count < 0 ||
        (count > 0 && !cache.append(chunk, static_cast<std::size_t>(count)))) {
      cache.discardStage();
      error = DeviceHttpError::transport_failed;
      http.end();
      return false;
    }
    if (count == 0) {
      delay(1);
      continue;
    }
    received += static_cast<std::size_t>(count);
    delay(1);
  }
  http.end();
  if (!cache.finishStage() || !cache.commitStage()) {
    cache.discardStage();
    error = DeviceHttpError::asset_integrity_failed;
    return false;
  }
  return true;
}

bool DeviceHttpClient::postEvent(const DeviceBinding& binding, const DeviceEvent& event,
                                 const DevicePowerReport* power, DeviceHttpError& error) {
  error = DeviceHttpError::none;
  char url[DeviceEndpoint::url_capacity + 32]{};
  char request[2048]{};
  std::size_t request_length = 0;
  DeviceJsonError json_error = DeviceJsonError::none;
  if (!buildUrl("/device/v1/event", url, sizeof(url)) ||
      !writeEventRequest(request, sizeof(request), request_length, binding, event, power,
                         json_error)) {
    error = DeviceHttpError::invalid_configuration;
    return false;
  }
  WiFiClient plain;
  WiFiClientSecure secure;
  HTTPClient http;
  if (!configureHttp(http, endpoint_, url, plain, secure) || !setBearer(http, binding)) {
    error = DeviceHttpError::transport_failed;
    return false;
  }
  http.addHeader("Content-Type", "application/json", false, true);
  const int status = http.POST(reinterpret_cast<std::uint8_t*>(request), request_length);
  std::memset(request, 0, sizeof(request));
  if (status != 200) {
    error = status > 0 ? DeviceHttpError::http_rejected : DeviceHttpError::transport_failed;
    http.end();
    return false;
  }
  String body;
  if (!readBoundedJson(http, body, kMaxJsonResponse, error)) {
    http.end();
    return false;
  }
  http.end();
  if (!parseEventResponse(body.c_str(), body.length(), event.event_id.data(), json_error)) {
    error = DeviceHttpError::invalid_response;
    return false;
  }
  return true;
}

}  // namespace mooneink
