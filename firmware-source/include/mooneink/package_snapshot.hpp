// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "mooneink/package_policy.hpp"

namespace mooneink {

struct PackageFileInfo final {
  std::array<char, PackageManifest::entry_capacity> path{};
  std::uint32_t byte_length = 0;
  // Set only by the bounded image decoder that inspected this exact file.
  // Zero means that the file is not a decoded image.
  std::uint32_t decoded_image_pixels = 0;
};

class PackageSnapshotReader {
 public:
  virtual ~PackageSnapshotReader() = default;
  virtual bool fileCount(std::size_t& output) const = 0;
  virtual bool fileInfo(std::size_t index, PackageFileInfo& output) const = 0;
  virtual bool readFile(const char* path, std::size_t offset, std::uint8_t* output,
                        std::size_t capacity, std::size_t& bytes_read) const = 0;
  // Source directories return zero. A sealed staging store returns a stable,
  // nonzero identity which changes whenever its bytes are replaced.
  virtual std::uint64_t sealedSnapshotIdentity() const { return 0; }
};

class PackageStagingStore : public PackageSnapshotReader {
 public:
  virtual bool beginStaging() = 0;
  virtual bool beginFile(const PackageFileInfo& file) = 0;
  virtual bool appendFile(const std::uint8_t* data, std::size_t length) = 0;
  virtual bool finishFile() = 0;
  // seal must atomically publish the staged set as a read-only snapshot and
  // return its new nonzero identity. Runtime code reads only this snapshot.
  virtual bool seal(const std::array<std::uint8_t, 32>& digest,
                    std::uint64_t& snapshot_identity) = 0;
  virtual void abortStaging() = 0;
};

enum class PackageSnapshotCode : std::uint8_t {
  ok,
  invalid_file_count,
  invalid_path,
  duplicate_path,
  missing_manifest,
  resource_limit,
  source_read_failed,
  staging_write_failed,
  staging_seal_failed,
  unsealed_snapshot,
  snapshot_identity_changed,
  digest_mismatch,
};

struct PackageSnapshot final {
  PackageSnapshotCode code = PackageSnapshotCode::ok;
  std::uint64_t snapshot_identity = 0;
  std::array<std::uint8_t, 32> content_sha256{};
  PackageResourceFacts resources{};
  std::size_t total_bytes = 0;

  bool ok() const { return code == PackageSnapshotCode::ok; }
};

bool isSafePackageRelativePath(const char* path);

PackageSnapshot capturePackageSnapshot(const PackageSnapshotReader& source,
                                       PackageStagingStore& staging);

PackageSnapshot verifyPackageSnapshot(const PackageSnapshotReader& staging,
                                      const PackageSnapshot& expected);

bool packageSnapshotContains(const PackageSnapshotReader& snapshot, const char* path,
                             PackageFileInfo& output);

PackageValidationCode commitVerifiedPackageInstall(
    const PackageCandidate& candidate, const PackageSnapshot& approved_snapshot,
    const PackageSnapshotReader& staging, const InstalledPackageRecord* current,
    const char* shell_version, std::uint16_t explicitly_granted_permissions,
    bool reuse_private_namespace, const char* new_install_identity,
    InstalledPackageRecord& output);

}  // namespace mooneink
