// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/package_policy.hpp"

#include <cctype>
#include <cstring>

namespace mooneink {
namespace {

struct SemVer final {
  std::uint16_t major = 0;
  std::uint16_t minor = 0;
  std::uint16_t patch = 0;
};

template <std::size_t Size>
bool terminatedNonEmpty(const std::array<char, Size>& value) {
  return value[0] != '\0' && std::memchr(value.data(), '\0', value.size()) != nullptr;
}

bool parseComponent(const char*& cursor, std::uint16_t& output,
                    const bool final) {
  if (cursor == nullptr || !std::isdigit(static_cast<unsigned char>(*cursor))) return false;
  if (*cursor == '0' && std::isdigit(static_cast<unsigned char>(cursor[1]))) return false;
  std::uint32_t value = 0;
  do {
    value = value * 10U + static_cast<std::uint32_t>(*cursor - '0');
    if (value > 65535U) return false;
    ++cursor;
  } while (std::isdigit(static_cast<unsigned char>(*cursor)));
  if (final ? *cursor != '\0' : *cursor != '.') return false;
  if (!final) ++cursor;
  output = static_cast<std::uint16_t>(value);
  return true;
}

bool parseSemVer(const char* text, SemVer& output) {
  if (text == nullptr || *text == '\0') return false;
  const char* cursor = text;
  return parseComponent(cursor, output.major, false) &&
         parseComponent(cursor, output.minor, false) &&
         parseComponent(cursor, output.patch, true);
}

int compare(const SemVer& lhs, const SemVer& rhs) {
  if (lhs.major != rhs.major) return lhs.major < rhs.major ? -1 : 1;
  if (lhs.minor != rhs.minor) return lhs.minor < rhs.minor ? -1 : 1;
  if (lhs.patch != rhs.patch) return lhs.patch < rhs.patch ? -1 : 1;
  return 0;
}

bool validId(const char* id) {
  if (id == nullptr || id[0] < 'a' || id[0] > 'z') return false;
  bool prior_hyphen = false;
  for (std::size_t index = 1; id[index] != '\0'; ++index) {
    const char value = id[index];
    const bool hyphen = value == '-';
    if (!((value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') ||
          hyphen) || (hyphen && prior_hyphen)) {
      return false;
    }
    prior_hyphen = hyphen;
  }
  const std::size_t length = std::strlen(id);
  return length >= 1 && length < PackageManifest::id_capacity && id[length - 1] != '-';
}

bool reservedId(const char* id) {
  constexpr const char* reserved[] = {
      "ephemera", "reader", "settings", "diagnostics", "launcher", "system"};
  for (const char* candidate : reserved) {
    if (std::strcmp(id, candidate) == 0) return true;
  }
  return false;
}

bool safeEntry(const char* path) {
  if (path == nullptr || *path == '\0' || *path == '/' || *path == '\\') return false;
  std::size_t segment_length = 0;
  std::array<char, 3> segment{};
  for (std::size_t index = 0;; ++index) {
    const unsigned char value = static_cast<unsigned char>(path[index]);
    if (value == '\\' || value == ':') return false;
    if (value == '/' || value == '\0') {
      if (segment_length == 0 ||
          (segment_length == 1 && segment[0] == '.') ||
          (segment_length == 2 && segment[0] == '.' && segment[1] == '.')) {
        return false;
      }
      segment.fill('\0');
      segment_length = 0;
      if (value == '\0') break;
      continue;
    }
    if (value < 0x20U || value == 0x7fU) return false;
    if (segment_length < segment.size()) segment[segment_length] = static_cast<char>(value);
    ++segment_length;
  }
  const std::size_t length = std::strlen(path);
  return length >= 6 && std::strcmp(path + length - 5, ".json") == 0;
}

bool resourcesFit(const PackageResourceFacts& resources) {
  return resources.manifest_bytes > 0 &&
         resources.manifest_bytes <= PackageResourceLimits::max_manifest_bytes &&
         resources.layout_bytes > 0 &&
         resources.layout_bytes <= PackageResourceLimits::max_layout_bytes &&
         resources.file_count > 0 && resources.file_count <= PackageResourceLimits::max_files &&
         resources.asset_count <= PackageResourceLimits::max_assets &&
         resources.largest_asset_bytes <= PackageResourceLimits::max_single_asset_bytes &&
         resources.total_asset_bytes <= PackageResourceLimits::max_total_asset_bytes &&
         resources.largest_decoded_image_pixels <= PackageResourceLimits::max_decoded_image_pixels &&
         resources.ui_nodes > 0 && resources.ui_nodes <= PackageResourceLimits::max_ui_nodes &&
         resources.ui_depth > 0 && resources.ui_depth <= PackageResourceLimits::max_ui_depth &&
         resources.largest_string_bytes <= PackageResourceLimits::max_string_bytes;
}

bool nonzeroDigest(const std::array<std::uint8_t, 32>& digest) {
  for (const std::uint8_t byte : digest) {
    if (byte != 0) return true;
  }
  return false;
}

template <std::size_t Destination, std::size_t Source>
bool copyText(const std::array<char, Source>& source,
              std::array<char, Destination>& destination) {
  const void* terminator = std::memchr(source.data(), '\0', source.size());
  if (terminator == nullptr) return false;
  const std::size_t length = static_cast<const char*>(terminator) - source.data();
  if (length == 0 || length >= destination.size()) return false;
  destination.fill('\0');
  std::memcpy(destination.data(), source.data(), length);
  return true;
}

}  // namespace

PackageValidation validatePackage(const PackageManifest& manifest,
                                  const PackageResourceFacts& resources,
                                  const char* shell_version) {
  PackageValidation result{};
  if (manifest.schema != 1) {
    result.code = PackageValidationCode::unsupported_schema;
    return result;
  }
  if (!terminatedNonEmpty(manifest.id) || !validId(manifest.id.data())) {
    result.code = PackageValidationCode::invalid_id;
    return result;
  }
  if (reservedId(manifest.id.data())) {
    result.code = PackageValidationCode::reserved_id;
    return result;
  }
  if (!terminatedNonEmpty(manifest.name)) {
    result.code = PackageValidationCode::invalid_name;
    return result;
  }
  SemVer version{};
  SemVer minimum{};
  SemVer shell{};
  if (!terminatedNonEmpty(manifest.version) || !terminatedNonEmpty(manifest.min_shell) ||
      !parseSemVer(manifest.version.data(), version) ||
      !parseSemVer(manifest.min_shell.data(), minimum) ||
      !parseSemVer(shell_version, shell)) {
    result.code = PackageValidationCode::invalid_version;
    return result;
  }
  if (compare(shell, minimum) < 0) {
    result.code = PackageValidationCode::shell_too_old;
    return result;
  }
  // SD packages never replace the built-in trusted remote-framebuffer adapter
  // and v1 has no native-binary or script runtime.
  if (manifest.runtime != PackageRuntime::lvgl_layout) {
    result.code = PackageValidationCode::unsupported_runtime;
    return result;
  }
  if (!terminatedNonEmpty(manifest.entry) || !safeEntry(manifest.entry.data())) {
    result.code = PackageValidationCode::unsafe_entry_path;
    return result;
  }
  if (manifest.permission_count > manifest.permissions.size()) {
    result.code = PackageValidationCode::invalid_permission;
    return result;
  }
  for (std::size_t index = 0; index < manifest.permission_count; ++index) {
    const std::uint8_t raw = static_cast<std::uint8_t>(manifest.permissions[index]);
    if (raw > static_cast<std::uint8_t>(AppPermission::background_poll)) {
      result.code = PackageValidationCode::invalid_permission;
      return result;
    }
    const std::uint16_t bit = permissionBit(manifest.permissions[index]);
    if ((result.requested_permissions & bit) != 0) {
      result.code = PackageValidationCode::duplicate_permission;
      return result;
    }
    result.requested_permissions =
        static_cast<std::uint16_t>(result.requested_permissions | bit);
  }
  if (!resourcesFit(resources)) {
    result.code = PackageValidationCode::resource_limit;
    return result;
  }
  return result;
}

PackageInstallPlan planPackageInstall(const PackageCandidate& candidate,
                                      const InstalledPackageRecord* current,
                                      const char* shell_version) {
  PackageInstallPlan plan{};
  const PackageValidation validation =
      validatePackage(candidate.manifest, candidate.resources, shell_version);
  plan.code = validation.code;
  plan.requested_permissions = validation.requested_permissions;
  if (!validation.ok()) return plan;
  if (!nonzeroDigest(candidate.content_sha256)) {
    plan.code = PackageValidationCode::invalid_digest;
    return plan;
  }
  if (current != nullptr && current->occupied &&
      std::strcmp(current->app_id.data(), candidate.manifest.id.data()) != 0) {
    plan.code = PackageValidationCode::identity_conflict;
    return plan;
  }
  if (current == nullptr || !current->occupied) {
    plan.action = PackageInstallAction::confirmation_required;
    plan.content_changed = true;
    plan.new_permissions = plan.requested_permissions;
    return plan;
  }
  plan.content_changed = current->content_sha256 != candidate.content_sha256;
  plan.new_permissions = static_cast<std::uint16_t>(
      plan.requested_permissions & static_cast<std::uint16_t>(~current->granted_permissions));
  if (!plan.content_changed && plan.new_permissions == 0 &&
      std::strcmp(current->version.data(), candidate.manifest.version.data()) == 0) {
    plan.action = PackageInstallAction::unchanged;
    return plan;
  }
  plan.action = PackageInstallAction::confirmation_required;
  return plan;
}

PackageValidationCode commitPackageInstall(
    const PackageCandidate& candidate, const InstalledPackageRecord* current,
    const char* shell_version,
    const std::uint16_t explicitly_granted_permissions,
    const bool reuse_private_namespace, const char* new_install_identity,
    InstalledPackageRecord& output) {
  const PackageInstallPlan plan = planPackageInstall(candidate, current, shell_version);
  if (plan.action == PackageInstallAction::rejected) return plan.code;
  if (explicitly_granted_permissions != plan.requested_permissions) {
    return PackageValidationCode::grant_mismatch;
  }
  InstalledPackageRecord record{};
  if (!copyText(candidate.manifest.id, record.app_id) ||
      !copyText(candidate.manifest.version, record.version)) {
    return PackageValidationCode::invalid_id;
  }
  if (reuse_private_namespace && current != nullptr && current->occupied) {
    record.install_identity = current->install_identity;
  } else {
    if (new_install_identity == nullptr || *new_install_identity == '\0' ||
        std::strlen(new_install_identity) >= record.install_identity.size()) {
      return PackageValidationCode::invalid_install_identity;
    }
    if (current != nullptr && current->occupied &&
        std::strcmp(new_install_identity, current->install_identity.data()) == 0) {
      return PackageValidationCode::invalid_install_identity;
    }
    std::memcpy(record.install_identity.data(), new_install_identity,
                std::strlen(new_install_identity));
  }
  record.occupied = true;
  record.content_sha256 = candidate.content_sha256;
  record.granted_permissions = explicitly_granted_permissions;
  output = record;
  return PackageValidationCode::ok;
}

void uninstallPackage(InstalledPackageRecord& record) {
  record = InstalledPackageRecord{};
}

}  // namespace mooneink
