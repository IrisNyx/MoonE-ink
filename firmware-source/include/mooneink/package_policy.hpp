// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace mooneink {

enum class PackageRuntime : std::uint8_t {
  lvgl_layout = 1,
  remote_framebuffer = 2,
};

enum class AppPermission : std::uint8_t {
  rtc_read = 0,
  battery_read = 1,
  network = 2,
  storage_app = 3,
  storage_shared = 4,
  storage_cache = 5,
  touch = 6,
  background_poll = 7,
};

constexpr std::uint16_t permissionBit(const AppPermission permission) {
  return static_cast<std::uint16_t>(1U << static_cast<std::uint8_t>(permission));
}

struct PackageManifest final {
  static constexpr std::size_t id_capacity = 33;
  static constexpr std::size_t name_capacity = 65;
  static constexpr std::size_t version_capacity = 17;
  static constexpr std::size_t entry_capacity = 129;
  static constexpr std::size_t max_permissions = 8;

  std::uint16_t schema = 1;
  std::array<char, id_capacity> id{};
  std::array<char, name_capacity> name{};
  std::array<char, version_capacity> version{};
  std::array<char, version_capacity> min_shell{};
  PackageRuntime runtime = PackageRuntime::lvgl_layout;
  std::array<char, entry_capacity> entry{};
  std::array<AppPermission, max_permissions> permissions{};
  std::uint8_t permission_count = 0;
};

struct PackageResourceLimits final {
  static constexpr std::size_t max_manifest_bytes = 4096;
  static constexpr std::size_t max_layout_bytes = 64U * 1024U;
  static constexpr std::size_t max_files = 64;
  static constexpr std::size_t max_assets = 32;
  static constexpr std::size_t max_single_asset_bytes = 1024U * 1024U;
  static constexpr std::size_t max_total_asset_bytes = 4U * 1024U * 1024U;
  static constexpr std::uint32_t max_decoded_image_pixels = 540U * 960U;
  static constexpr std::uint16_t max_ui_nodes = 128;
  static constexpr std::uint8_t max_ui_depth = 12;
  static constexpr std::uint16_t max_string_bytes = 512;
};

struct PackageResourceFacts final {
  std::size_t manifest_bytes = 0;
  std::size_t layout_bytes = 0;
  std::size_t file_count = 0;
  std::size_t asset_count = 0;
  std::size_t largest_asset_bytes = 0;
  std::size_t total_asset_bytes = 0;
  std::uint32_t largest_decoded_image_pixels = 0;
  std::uint16_t ui_nodes = 0;
  std::uint8_t ui_depth = 0;
  std::uint16_t largest_string_bytes = 0;
};

enum class PackageValidationCode : std::uint8_t {
  ok,
  unsupported_schema,
  invalid_id,
  reserved_id,
  invalid_name,
  invalid_version,
  shell_too_old,
  unsupported_runtime,
  unsafe_entry_path,
  invalid_permission,
  duplicate_permission,
  resource_limit,
  invalid_digest,
  identity_conflict,
  grant_mismatch,
  invalid_install_identity,
  snapshot_mismatch,
};

struct PackageValidation final {
  PackageValidationCode code = PackageValidationCode::ok;
  std::uint16_t requested_permissions = 0;
  bool ok() const { return code == PackageValidationCode::ok; }
};

PackageValidation validatePackage(const PackageManifest& manifest,
                                  const PackageResourceFacts& resources,
                                  const char* shell_version);

struct PackageCandidate final {
  PackageManifest manifest{};
  PackageResourceFacts resources{};
  std::array<std::uint8_t, 32> content_sha256{};
};

struct InstalledPackageRecord final {
  bool occupied = false;
  std::array<char, PackageManifest::id_capacity> app_id{};
  std::array<char, PackageManifest::version_capacity> version{};
  std::array<char, 65> install_identity{};
  std::array<std::uint8_t, 32> content_sha256{};
  std::uint16_t granted_permissions = 0;
};

enum class PackageInstallAction : std::uint8_t {
  rejected,
  confirmation_required,
  unchanged,
};

struct PackageInstallPlan final {
  PackageInstallAction action = PackageInstallAction::rejected;
  PackageValidationCode code = PackageValidationCode::ok;
  std::uint16_t requested_permissions = 0;
  std::uint16_t new_permissions = 0;
  bool content_changed = false;
};

PackageInstallPlan planPackageInstall(const PackageCandidate& candidate,
                                      const InstalledPackageRecord* current,
                                      const char* shell_version);

PackageValidationCode commitPackageInstall(
    const PackageCandidate& candidate, const InstalledPackageRecord* current,
    const char* shell_version,
    std::uint16_t explicitly_granted_permissions, bool reuse_private_namespace,
    const char* new_install_identity, InstalledPackageRecord& output);

void uninstallPackage(InstalledPackageRecord& record);

}  // namespace mooneink
