// SPDX-License-Identifier: AGPL-3.0-only
#include "mooneink/package_snapshot.hpp"

#include <algorithm>
#include <cstring>

#include "mooneink/sha256.hpp"

namespace mooneink {
namespace {

constexpr std::size_t kReadWindow = 256;
constexpr std::uint8_t kDigestPrefix[] = {'e', 'a', 'p', 'p', '-', 's', 'n', 'a',
                                          'p', 's', 'h', 'o', 't', '-', 'v', '1', 0};
constexpr std::size_t kMaxSnapshotBytes =
    PackageResourceLimits::max_manifest_bytes + PackageResourceLimits::max_layout_bytes +
    PackageResourceLimits::max_total_asset_bytes;

bool terminatedPath(const PackageFileInfo& file) {
  return file.path[0] != '\0' &&
         std::memchr(file.path.data(), '\0', file.path.size()) != nullptr;
}

bool isAssetPath(const char* path) {
  return path != nullptr && std::strncmp(path, "assets/", 7) == 0 && path[7] != '\0';
}

bool updateU16(Sha256& digest, const std::uint16_t value) {
  const std::uint8_t bytes[] = {static_cast<std::uint8_t>(value >> 8U),
                                static_cast<std::uint8_t>(value)};
  return digest.update(bytes, sizeof(bytes));
}

bool updateU32(Sha256& digest, const std::uint32_t value) {
  const std::uint8_t bytes[] = {static_cast<std::uint8_t>(value >> 24U),
                                static_cast<std::uint8_t>(value >> 16U),
                                static_cast<std::uint8_t>(value >> 8U),
                                static_cast<std::uint8_t>(value)};
  return digest.update(bytes, sizeof(bytes));
}

PackageSnapshotCode inventory(const PackageSnapshotReader& source,
                              std::array<PackageFileInfo, PackageResourceLimits::max_files>& files,
                              std::size_t& count, PackageResourceFacts& resources,
                              std::size_t& total_bytes) {
  if (!source.fileCount(count) || count < 2 || count > files.size()) {
    return PackageSnapshotCode::invalid_file_count;
  }
  for (std::size_t index = 0; index < count; ++index) {
    if (!source.fileInfo(index, files[index]) || !terminatedPath(files[index]) ||
        !isSafePackageRelativePath(files[index].path.data()) || files[index].byte_length == 0) {
      return PackageSnapshotCode::invalid_path;
    }
  }
  std::sort(files.begin(), files.begin() + count,
            [](const PackageFileInfo& lhs, const PackageFileInfo& rhs) {
              return std::strcmp(lhs.path.data(), rhs.path.data()) < 0;
            });

  bool found_manifest = false;
  resources = PackageResourceFacts{};
  resources.file_count = count;
  total_bytes = 0;
  for (std::size_t index = 0; index < count; ++index) {
    if (index > 0 && std::strcmp(files[index - 1].path.data(), files[index].path.data()) == 0) {
      return PackageSnapshotCode::duplicate_path;
    }
    const std::size_t size = files[index].byte_length;
    if (size > kMaxSnapshotBytes || total_bytes > kMaxSnapshotBytes - size) {
      return PackageSnapshotCode::resource_limit;
    }
    total_bytes += size;
    if (std::strcmp(files[index].path.data(), "manifest.json") == 0) {
      found_manifest = true;
      resources.manifest_bytes = size;
      if (size > PackageResourceLimits::max_manifest_bytes) {
        return PackageSnapshotCode::resource_limit;
      }
    }
    if (isAssetPath(files[index].path.data())) {
      ++resources.asset_count;
      resources.total_asset_bytes += size;
      resources.largest_asset_bytes =
          std::max(resources.largest_asset_bytes, size);
      resources.largest_decoded_image_pixels =
          std::max(resources.largest_decoded_image_pixels,
                   files[index].decoded_image_pixels);
    }
  }
  if (!found_manifest) return PackageSnapshotCode::missing_manifest;
  if (resources.asset_count > PackageResourceLimits::max_assets ||
      resources.total_asset_bytes > PackageResourceLimits::max_total_asset_bytes ||
      resources.largest_asset_bytes > PackageResourceLimits::max_single_asset_bytes ||
      resources.largest_decoded_image_pixels >
          PackageResourceLimits::max_decoded_image_pixels) {
    return PackageSnapshotCode::resource_limit;
  }
  return PackageSnapshotCode::ok;
}

PackageSnapshot hashSnapshot(const PackageSnapshotReader& source,
                             PackageStagingStore* writer) {
  PackageSnapshot result{};
  std::array<PackageFileInfo, PackageResourceLimits::max_files> files{};
  std::size_t count = 0;
  result.code = inventory(source, files, count, result.resources, result.total_bytes);
  if (!result.ok()) return result;

  Sha256 digest;
  if (!digest.update(kDigestPrefix, sizeof(kDigestPrefix)) ||
      !updateU16(digest, static_cast<std::uint16_t>(count))) {
    result.code = PackageSnapshotCode::source_read_failed;
    return result;
  }
  std::array<std::uint8_t, kReadWindow> buffer{};
  for (std::size_t index = 0; index < count; ++index) {
    const PackageFileInfo& file = files[index];
    const std::size_t path_length = std::strlen(file.path.data());
    if (!updateU16(digest, static_cast<std::uint16_t>(path_length)) ||
        !digest.update(reinterpret_cast<const std::uint8_t*>(file.path.data()), path_length) ||
        !updateU32(digest, file.byte_length)) {
      result.code = PackageSnapshotCode::source_read_failed;
      return result;
    }
    if (writer != nullptr && !writer->beginFile(file)) {
      result.code = PackageSnapshotCode::staging_write_failed;
      return result;
    }
    std::size_t offset = 0;
    while (offset < file.byte_length) {
      const std::size_t requested =
          std::min(buffer.size(), static_cast<std::size_t>(file.byte_length) - offset);
      std::size_t bytes_read = 0;
      if (!source.readFile(file.path.data(), offset, buffer.data(), requested, bytes_read) ||
          bytes_read == 0 || bytes_read > requested ||
          !digest.update(buffer.data(), bytes_read)) {
        result.code = PackageSnapshotCode::source_read_failed;
        return result;
      }
      if (writer != nullptr && !writer->appendFile(buffer.data(), bytes_read)) {
        result.code = PackageSnapshotCode::staging_write_failed;
        return result;
      }
      offset += bytes_read;
    }
    std::size_t trailing = 0;
    if (!source.readFile(file.path.data(), file.byte_length, buffer.data(), 1, trailing) ||
        trailing != 0) {
      result.code = PackageSnapshotCode::source_read_failed;
      return result;
    }
    if (writer != nullptr && !writer->finishFile()) {
      result.code = PackageSnapshotCode::staging_write_failed;
      return result;
    }
  }
  if (!digest.finish(result.content_sha256)) {
    result.code = PackageSnapshotCode::source_read_failed;
  }
  return result;
}

}  // namespace

bool isSafePackageRelativePath(const char* path) {
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
    } else {
      if (value < 0x20U || value == 0x7fU) return false;
      if (segment_length < segment.size()) segment[segment_length] = static_cast<char>(value);
      ++segment_length;
    }
  }
  return std::strlen(path) < PackageManifest::entry_capacity;
}

PackageSnapshot capturePackageSnapshot(const PackageSnapshotReader& source,
                                       PackageStagingStore& staging) {
  PackageSnapshot failed{};
  if (!staging.beginStaging()) {
    failed.code = PackageSnapshotCode::staging_write_failed;
    return failed;
  }
  PackageSnapshot captured = hashSnapshot(source, &staging);
  if (!captured.ok()) {
    staging.abortStaging();
    return captured;
  }
  if (!staging.seal(captured.content_sha256, captured.snapshot_identity) ||
      captured.snapshot_identity == 0) {
    staging.abortStaging();
    captured.code = PackageSnapshotCode::staging_seal_failed;
    captured.snapshot_identity = 0;
    return captured;
  }
  const PackageSnapshot verified = verifyPackageSnapshot(staging, captured);
  if (!verified.ok()) {
    staging.abortStaging();
    return verified;
  }
  return captured;
}

PackageSnapshot verifyPackageSnapshot(const PackageSnapshotReader& staging,
                                      const PackageSnapshot& expected) {
  PackageSnapshot result{};
  const std::uint64_t identity = staging.sealedSnapshotIdentity();
  if (identity == 0) {
    result.code = PackageSnapshotCode::unsealed_snapshot;
    return result;
  }
  if (identity != expected.snapshot_identity) {
    result.code = PackageSnapshotCode::snapshot_identity_changed;
    return result;
  }
  result = hashSnapshot(staging, nullptr);
  result.snapshot_identity = identity;
  if (!result.ok()) return result;
  if (result.content_sha256 != expected.content_sha256 ||
      result.total_bytes != expected.total_bytes ||
      result.resources.file_count != expected.resources.file_count) {
    result.code = PackageSnapshotCode::digest_mismatch;
  }
  return result;
}

bool packageSnapshotContains(const PackageSnapshotReader& snapshot, const char* path,
                             PackageFileInfo& output) {
  if (!isSafePackageRelativePath(path)) return false;
  std::size_t count = 0;
  if (!snapshot.fileCount(count) || count > PackageResourceLimits::max_files) return false;
  for (std::size_t index = 0; index < count; ++index) {
    PackageFileInfo candidate{};
    if (!snapshot.fileInfo(index, candidate) || !terminatedPath(candidate)) return false;
    if (std::strcmp(candidate.path.data(), path) == 0) {
      output = candidate;
      return true;
    }
  }
  return false;
}

PackageValidationCode commitVerifiedPackageInstall(
    const PackageCandidate& candidate, const PackageSnapshot& approved_snapshot,
    const PackageSnapshotReader& staging, const InstalledPackageRecord* current,
    const char* shell_version, const std::uint16_t explicitly_granted_permissions,
    const bool reuse_private_namespace, const char* new_install_identity,
    InstalledPackageRecord& output) {
  if (!approved_snapshot.ok() || approved_snapshot.snapshot_identity == 0 ||
      candidate.content_sha256 != approved_snapshot.content_sha256) {
    return PackageValidationCode::snapshot_mismatch;
  }
  const PackageResourceFacts& approved = approved_snapshot.resources;
  const PackageResourceFacts& candidate_facts = candidate.resources;
  if (approved.manifest_bytes != candidate_facts.manifest_bytes ||
      approved.file_count != candidate_facts.file_count ||
      approved.asset_count != candidate_facts.asset_count ||
      approved.largest_asset_bytes != candidate_facts.largest_asset_bytes ||
      approved.total_asset_bytes != candidate_facts.total_asset_bytes ||
      approved.largest_decoded_image_pixels !=
          candidate_facts.largest_decoded_image_pixels) {
    return PackageValidationCode::snapshot_mismatch;
  }
  PackageFileInfo entry{};
  if (!packageSnapshotContains(staging, candidate.manifest.entry.data(), entry) ||
      entry.byte_length != candidate.resources.layout_bytes) {
    return PackageValidationCode::snapshot_mismatch;
  }
  const PackageSnapshot verified = verifyPackageSnapshot(staging, approved_snapshot);
  if (!verified.ok()) return PackageValidationCode::snapshot_mismatch;
  return commitPackageInstall(candidate, current, shell_version,
                              explicitly_granted_permissions,
                              reuse_private_namespace, new_install_identity, output);
}

}  // namespace mooneink
