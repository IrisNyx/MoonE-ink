// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <cstddef>
#include <cstdint>

#include "mooneink/package_policy.hpp"
#include "mooneink/package_snapshot.hpp"

namespace mooneink {

enum class PackageManifestParseCode : std::uint8_t {
  ok,
  manifest_unavailable,
  invalid_json,
  duplicate_field,
  unknown_field,
  missing_field,
  invalid_schema,
  invalid_string,
  string_too_long,
  invalid_runtime,
  invalid_permission,
};

struct PackageManifestParseResult final {
  PackageManifestParseResult() = default;
  PackageManifestParseResult(const PackageManifestParseCode value,
                             const std::size_t offset)
      : code(value), byte_offset(offset) {}
  PackageManifestParseCode code = PackageManifestParseCode::ok;
  std::size_t byte_offset = 0;
  bool ok() const { return code == PackageManifestParseCode::ok; }
};

PackageManifestParseResult parsePackageManifest(
    const PackageSnapshotReader& snapshot, PackageManifest& output);

struct PackageLayoutFacts final {
  std::uint16_t ui_nodes = 0;
  std::uint8_t ui_depth = 0;
  std::uint16_t largest_string_bytes = 0;
};

enum class PackageCandidateBuildCode : std::uint8_t {
  ok,
  snapshot_invalid,
  manifest_invalid,
  entry_missing,
  unexpected_file,
  resource_limit,
};

struct PackageCandidateBuildResult final {
  PackageCandidateBuildResult() = default;
  PackageCandidateBuildResult(const PackageCandidateBuildCode value,
                              const PackageManifestParseResult& parsed)
      : code(value), manifest(parsed) {}
  PackageCandidateBuildCode code = PackageCandidateBuildCode::ok;
  PackageManifestParseResult manifest{};
  bool ok() const { return code == PackageCandidateBuildCode::ok; }
};

PackageCandidateBuildResult buildPackageCandidate(
    const PackageSnapshot& approved_snapshot, const PackageSnapshotReader& staging,
    const PackageLayoutFacts& layout, PackageCandidate& output);

}  // namespace mooneink
