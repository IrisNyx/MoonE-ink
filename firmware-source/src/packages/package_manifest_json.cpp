// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/package_manifest_json.hpp"

#include <array>
#include <cstring>

namespace mooneink {
namespace {

class JsonCursor final {
 public:
  JsonCursor(const PackageSnapshotReader& source, const std::size_t length)
      : source_(source), length_(length) {}

  bool peek(std::uint8_t& output) {
    if (offset_ >= length_) return false;
    if (offset_ < window_offset_ || offset_ >= window_offset_ + window_length_) {
      window_offset_ = offset_;
      window_length_ = 0;
      if (!source_.readFile("manifest.json", window_offset_, window_.data(), window_.size(),
                            window_length_) ||
          window_length_ == 0 || window_length_ > window_.size()) {
        io_failed_ = true;
        return false;
      }
    }
    output = window_[offset_ - window_offset_];
    return true;
  }

  bool take(std::uint8_t& output) {
    if (!peek(output)) return false;
    ++offset_;
    return true;
  }

  bool expect(const std::uint8_t expected) {
    std::uint8_t actual = 0;
    return take(actual) && actual == expected;
  }

  void whitespace() {
    std::uint8_t value = 0;
    while (peek(value) && (value == ' ' || value == '\t' || value == '\r' || value == '\n')) {
      ++offset_;
    }
  }

  std::size_t offset() const { return offset_; }
  std::size_t length() const { return length_; }
  bool ioFailed() const { return io_failed_; }

 private:
  const PackageSnapshotReader& source_;
  std::size_t length_ = 0;
  std::size_t offset_ = 0;
  std::array<std::uint8_t, 128> window_{};
  std::size_t window_offset_ = 0;
  std::size_t window_length_ = 0;
  bool io_failed_ = false;
};

bool hexValue(const std::uint8_t value, std::uint16_t& output) {
  if (value >= '0' && value <= '9') {
    output = static_cast<std::uint16_t>(value - '0');
    return true;
  }
  if (value >= 'a' && value <= 'f') {
    output = static_cast<std::uint16_t>(value - 'a' + 10U);
    return true;
  }
  if (value >= 'A' && value <= 'F') {
    output = static_cast<std::uint16_t>(value - 'A' + 10U);
    return true;
  }
  return false;
}

bool readHex4(JsonCursor& cursor, std::uint16_t& output) {
  output = 0;
  for (std::size_t index = 0; index < 4; ++index) {
    std::uint8_t value = 0;
    std::uint16_t digit = 0;
    if (!cursor.take(value) || !hexValue(value, digit)) return false;
    output = static_cast<std::uint16_t>((output << 4U) | digit);
  }
  return true;
}

template <std::size_t Capacity>
bool appendByte(std::array<char, Capacity>& output, std::size_t& length,
                const std::uint8_t value) {
  if (length + 1 >= output.size()) return false;
  output[length++] = static_cast<char>(value);
  return true;
}

template <std::size_t Capacity>
bool appendCodepoint(std::array<char, Capacity>& output, std::size_t& length,
                     const std::uint32_t codepoint) {
  if (codepoint == 0 || codepoint > 0x10ffffU ||
      (codepoint >= 0xd800U && codepoint <= 0xdfffU) || codepoint < 0x20U) {
    return false;
  }
  if (codepoint <= 0x7fU) return appendByte(output, length, static_cast<std::uint8_t>(codepoint));
  if (codepoint <= 0x7ffU) {
    return appendByte(output, length, static_cast<std::uint8_t>(0xc0U | (codepoint >> 6U))) &&
           appendByte(output, length, static_cast<std::uint8_t>(0x80U | (codepoint & 0x3fU)));
  }
  if (codepoint <= 0xffffU) {
    return appendByte(output, length, static_cast<std::uint8_t>(0xe0U | (codepoint >> 12U))) &&
           appendByte(output, length,
                      static_cast<std::uint8_t>(0x80U | ((codepoint >> 6U) & 0x3fU))) &&
           appendByte(output, length, static_cast<std::uint8_t>(0x80U | (codepoint & 0x3fU)));
  }
  return appendByte(output, length, static_cast<std::uint8_t>(0xf0U | (codepoint >> 18U))) &&
         appendByte(output, length,
                    static_cast<std::uint8_t>(0x80U | ((codepoint >> 12U) & 0x3fU))) &&
         appendByte(output, length,
                    static_cast<std::uint8_t>(0x80U | ((codepoint >> 6U) & 0x3fU))) &&
         appendByte(output, length, static_cast<std::uint8_t>(0x80U | (codepoint & 0x3fU)));
}

template <std::size_t Capacity>
bool validUtf8(const std::array<char, Capacity>& value, const std::size_t length) {
  std::size_t index = 0;
  while (index < length) {
    const std::uint8_t first = static_cast<std::uint8_t>(value[index++]);
    if (first <= 0x7fU) continue;
    std::size_t continuation = 0;
    std::uint32_t codepoint = 0;
    std::uint32_t minimum = 0;
    if (first >= 0xc2U && first <= 0xdfU) {
      continuation = 1;
      codepoint = first & 0x1fU;
      minimum = 0x80U;
    } else if (first >= 0xe0U && first <= 0xefU) {
      continuation = 2;
      codepoint = first & 0x0fU;
      minimum = 0x800U;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      continuation = 3;
      codepoint = first & 0x07U;
      minimum = 0x10000U;
    } else {
      return false;
    }
    if (index + continuation > length) return false;
    for (std::size_t count = 0; count < continuation; ++count) {
      const std::uint8_t next = static_cast<std::uint8_t>(value[index++]);
      if ((next & 0xc0U) != 0x80U) return false;
      codepoint = (codepoint << 6U) | (next & 0x3fU);
    }
    if (codepoint < minimum || codepoint > 0x10ffffU ||
        (codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
      return false;
    }
  }
  return true;
}

template <std::size_t Capacity>
PackageManifestParseCode parseString(JsonCursor& cursor,
                                     std::array<char, Capacity>& output) {
  output.fill('\0');
  if (!cursor.expect('"')) return PackageManifestParseCode::invalid_json;
  std::size_t length = 0;
  for (;;) {
    std::uint8_t value = 0;
    if (!cursor.take(value)) return PackageManifestParseCode::invalid_json;
    if (value == '"') break;
    if (value < 0x20U) return PackageManifestParseCode::invalid_string;
    if (value != '\\') {
      if (!appendByte(output, length, value)) return PackageManifestParseCode::string_too_long;
      continue;
    }
    std::uint8_t escape = 0;
    if (!cursor.take(escape)) return PackageManifestParseCode::invalid_json;
    std::uint32_t codepoint = 0;
    switch (escape) {
      case '"': codepoint = '"'; break;
      case '\\': codepoint = '\\'; break;
      case '/': codepoint = '/'; break;
      case 'b': codepoint = 0x08U; break;
      case 'f': codepoint = 0x0cU; break;
      case 'n': codepoint = 0x0aU; break;
      case 'r': codepoint = 0x0dU; break;
      case 't': codepoint = 0x09U; break;
      case 'u': {
        std::uint16_t first = 0;
        if (!readHex4(cursor, first)) return PackageManifestParseCode::invalid_json;
        codepoint = first;
        if (first >= 0xd800U && first <= 0xdbffU) {
          if (!cursor.expect('\\') || !cursor.expect('u')) {
            return PackageManifestParseCode::invalid_string;
          }
          std::uint16_t second = 0;
          if (!readHex4(cursor, second) || second < 0xdc00U || second > 0xdfffU) {
            return PackageManifestParseCode::invalid_string;
          }
          codepoint = 0x10000U +
                      ((static_cast<std::uint32_t>(first) - 0xd800U) << 10U) +
                      (static_cast<std::uint32_t>(second) - 0xdc00U);
        }
        break;
      }
      default: return PackageManifestParseCode::invalid_json;
    }
    if (!appendCodepoint(output, length, codepoint)) {
      return codepoint < 0x20U ? PackageManifestParseCode::invalid_string
                               : PackageManifestParseCode::string_too_long;
    }
  }
  if (length == 0 || !validUtf8(output, length)) return PackageManifestParseCode::invalid_string;
  output[length] = '\0';
  return PackageManifestParseCode::ok;
}

bool parseUnsigned(JsonCursor& cursor, std::uint16_t& output) {
  std::uint8_t value = 0;
  if (!cursor.peek(value) || value < '0' || value > '9') return false;
  if (value == '0') {
    cursor.take(value);
    std::uint8_t next = 0;
    if (cursor.peek(next) && next >= '0' && next <= '9') return false;
    output = 0;
    return true;
  }
  std::uint32_t parsed = 0;
  do {
    cursor.take(value);
    parsed = parsed * 10U + static_cast<std::uint32_t>(value - '0');
    if (parsed > 65535U) return false;
  } while (cursor.peek(value) && value >= '0' && value <= '9');
  output = static_cast<std::uint16_t>(parsed);
  return true;
}

bool permissionFor(const char* name, AppPermission& output) {
  struct Entry final { const char* name; AppPermission permission; };
  constexpr Entry entries[] = {
      {"rtc.read", AppPermission::rtc_read},
      {"battery.read", AppPermission::battery_read},
      {"network", AppPermission::network},
      {"storage.app", AppPermission::storage_app},
      {"storage.shared", AppPermission::storage_shared},
      {"storage.cache", AppPermission::storage_cache},
      {"touch", AppPermission::touch},
      {"background.poll", AppPermission::background_poll},
  };
  for (const Entry& entry : entries) {
    if (std::strcmp(name, entry.name) == 0) {
      output = entry.permission;
      return true;
    }
  }
  return false;
}

PackageManifestParseCode parsePermissions(JsonCursor& cursor, PackageManifest& manifest) {
  if (!cursor.expect('[')) return PackageManifestParseCode::invalid_json;
  cursor.whitespace();
  std::uint8_t value = 0;
  if (cursor.peek(value) && value == ']') {
    cursor.take(value);
    return PackageManifestParseCode::ok;
  }
  for (;;) {
    if (manifest.permission_count >= manifest.permissions.size()) {
      return PackageManifestParseCode::invalid_permission;
    }
    std::array<char, 32> name{};
    const PackageManifestParseCode code = parseString(cursor, name);
    if (code != PackageManifestParseCode::ok) return code;
    AppPermission permission{};
    if (!permissionFor(name.data(), permission)) {
      return PackageManifestParseCode::invalid_permission;
    }
    manifest.permissions[manifest.permission_count++] = permission;
    cursor.whitespace();
    if (!cursor.take(value)) return PackageManifestParseCode::invalid_json;
    if (value == ']') return PackageManifestParseCode::ok;
    if (value != ',') return PackageManifestParseCode::invalid_json;
    cursor.whitespace();
  }
}

enum Field : std::uint8_t {
  schema_field = 0,
  id_field,
  name_field,
  version_field,
  minimum_field,
  runtime_field,
  entry_field,
  permissions_field,
  field_count,
};

int fieldFor(const char* name) {
  constexpr const char* fields[] = {"schema", "id", "name", "version", "min_shell",
                                    "runtime", "entry", "permissions"};
  for (std::size_t index = 0; index < field_count; ++index) {
    if (std::strcmp(name, fields[index]) == 0) return static_cast<int>(index);
  }
  return -1;
}

PackageManifestParseResult fail(JsonCursor& cursor, const PackageManifestParseCode code) {
  return {cursor.ioFailed() ? PackageManifestParseCode::manifest_unavailable : code,
          cursor.offset()};
}

}  // namespace

PackageManifestParseResult parsePackageManifest(const PackageSnapshotReader& snapshot,
                                                PackageManifest& output) {
  output = PackageManifest{};
  PackageFileInfo manifest_file{};
  if (!packageSnapshotContains(snapshot, "manifest.json", manifest_file) ||
      manifest_file.byte_length == 0 ||
      manifest_file.byte_length > PackageResourceLimits::max_manifest_bytes) {
    return {PackageManifestParseCode::manifest_unavailable, 0};
  }
  JsonCursor cursor(snapshot, manifest_file.byte_length);
  cursor.whitespace();
  if (!cursor.expect('{')) return fail(cursor, PackageManifestParseCode::invalid_json);
  cursor.whitespace();
  std::uint16_t seen = 0;
  std::uint8_t value = 0;
  if (cursor.peek(value) && value == '}') return fail(cursor, PackageManifestParseCode::missing_field);
  for (;;) {
    std::array<char, 24> key{};
    PackageManifestParseCode code = parseString(cursor, key);
    if (code != PackageManifestParseCode::ok) return fail(cursor, code);
    const int raw_field = fieldFor(key.data());
    if (raw_field < 0) return fail(cursor, PackageManifestParseCode::unknown_field);
    const std::uint8_t field = static_cast<std::uint8_t>(raw_field);
    const std::uint16_t bit = static_cast<std::uint16_t>(1U << field);
    if ((seen & bit) != 0) return fail(cursor, PackageManifestParseCode::duplicate_field);
    seen = static_cast<std::uint16_t>(seen | bit);
    cursor.whitespace();
    if (!cursor.expect(':')) return fail(cursor, PackageManifestParseCode::invalid_json);
    cursor.whitespace();
    switch (field) {
      case schema_field:
        if (!parseUnsigned(cursor, output.schema) || output.schema != 1) {
          return fail(cursor, PackageManifestParseCode::invalid_schema);
        }
        break;
      case id_field: code = parseString(cursor, output.id); break;
      case name_field: code = parseString(cursor, output.name); break;
      case version_field: code = parseString(cursor, output.version); break;
      case minimum_field: code = parseString(cursor, output.min_shell); break;
      case entry_field: code = parseString(cursor, output.entry); break;
      case runtime_field: {
        std::array<char, 32> runtime{};
        code = parseString(cursor, runtime);
        if (code == PackageManifestParseCode::ok) {
          if (std::strcmp(runtime.data(), "lvgl-layout") == 0) {
            output.runtime = PackageRuntime::lvgl_layout;
          } else if (std::strcmp(runtime.data(), "remote-framebuffer") == 0) {
            output.runtime = PackageRuntime::remote_framebuffer;
          } else {
            code = PackageManifestParseCode::invalid_runtime;
          }
        }
        break;
      }
      case permissions_field: code = parsePermissions(cursor, output); break;
      default: code = PackageManifestParseCode::unknown_field; break;
    }
    if (code != PackageManifestParseCode::ok) return fail(cursor, code);
    cursor.whitespace();
    if (!cursor.take(value)) return fail(cursor, PackageManifestParseCode::invalid_json);
    if (value == '}') break;
    if (value != ',') return fail(cursor, PackageManifestParseCode::invalid_json);
    cursor.whitespace();
  }
  constexpr std::uint16_t all_fields = static_cast<std::uint16_t>((1U << field_count) - 1U);
  if (seen != all_fields) return fail(cursor, PackageManifestParseCode::missing_field);
  cursor.whitespace();
  if (cursor.offset() != cursor.length()) {
    return fail(cursor, PackageManifestParseCode::invalid_json);
  }
  return {PackageManifestParseCode::ok, cursor.offset()};
}

PackageCandidateBuildResult buildPackageCandidate(
    const PackageSnapshot& approved_snapshot, const PackageSnapshotReader& staging,
    const PackageLayoutFacts& layout, PackageCandidate& output) {
  output = PackageCandidate{};
  if (!approved_snapshot.ok() ||
      !verifyPackageSnapshot(staging, approved_snapshot).ok()) {
    return {PackageCandidateBuildCode::snapshot_invalid, {}};
  }
  const PackageManifestParseResult parsed =
      parsePackageManifest(staging, output.manifest);
  if (!parsed.ok()) {
    return {PackageCandidateBuildCode::manifest_invalid, parsed};
  }
  PackageFileInfo entry{};
  if (std::strncmp(output.manifest.entry.data(), "assets/", 7) == 0 ||
      !packageSnapshotContains(staging, output.manifest.entry.data(), entry)) {
    return {PackageCandidateBuildCode::entry_missing, parsed};
  }
  std::size_t count = 0;
  if (!staging.fileCount(count) || count != approved_snapshot.resources.file_count) {
    return {PackageCandidateBuildCode::snapshot_invalid, parsed};
  }
  for (std::size_t index = 0; index < count; ++index) {
    PackageFileInfo file{};
    if (!staging.fileInfo(index, file)) {
      return {PackageCandidateBuildCode::snapshot_invalid, parsed};
    }
    const bool known = std::strcmp(file.path.data(), "manifest.json") == 0 ||
                       std::strcmp(file.path.data(), output.manifest.entry.data()) == 0 ||
                       (std::strncmp(file.path.data(), "assets/", 7) == 0 &&
                        file.path[7] != '\0');
    if (!known) return {PackageCandidateBuildCode::unexpected_file, parsed};
  }
  output.resources = approved_snapshot.resources;
  output.resources.layout_bytes = entry.byte_length;
  output.resources.ui_nodes = layout.ui_nodes;
  output.resources.ui_depth = layout.ui_depth;
  output.resources.largest_string_bytes = layout.largest_string_bytes;
  output.content_sha256 = approved_snapshot.content_sha256;
  if (output.resources.layout_bytes == 0 ||
      output.resources.layout_bytes > PackageResourceLimits::max_layout_bytes ||
      output.resources.ui_nodes == 0 ||
      output.resources.ui_nodes > PackageResourceLimits::max_ui_nodes ||
      output.resources.ui_depth == 0 ||
      output.resources.ui_depth > PackageResourceLimits::max_ui_depth ||
      output.resources.largest_string_bytes > PackageResourceLimits::max_string_bytes) {
    return {PackageCandidateBuildCode::resource_limit, parsed};
  }
  return {PackageCandidateBuildCode::ok, parsed};
}

}  // namespace mooneink
