/**
 * Content-addressed asset store inside the service data directory (MCP-03b).
 *
 * Layout (relative to the data directory):
 *   assets/sha256/<first-2-hex>/<sha256>.<kind>   — immutable final assets
 *   tmp/render/<operationId>/<leaseId>/          — per-attempt scratch space
 *
 * Final assets are written via a same-directory temporary file + fsync (when
 * the platform allows it) + atomic rename. An existing target is reused only
 * when it is byte-identical (hash AND length) — a same-path/different-bytes
 * situation is an explicit storage failure, never an overwrite. Cleanup only
 * ever touches the tmp tree; final assets referenced by the database (or not)
 * are never deleted here.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { BusinessError } from '../errors.js';

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function storageFailure(): BusinessError {
  return new BusinessError('storage_unavailable', 'asset store is unavailable', true);
}

export type AssetKind = 'png' | 'gray4';

export interface CommittedAsset {
  sha256: string;
  kind: AssetKind;
  mediaType: string;
  byteLength: number;
  /** Content-addressed path relative to the data directory. */
  relativePath: string;
}

export function mediaTypeFor(kind: AssetKind): string {
  return kind === 'png' ? 'image/png' : 'application/octet-stream';
}

/** Content-addressed relative path for a digest (fixed convention). */
export function relativePathFor(sha256: string, kind: AssetKind): string {
  return `assets/sha256/${sha256.slice(0, 2)}/${sha256}.${kind}`;
}

export class AssetStore {
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  publicationArchiveExists(publicationId: string): boolean {
    return SAFE_SEGMENT.test(publicationId) &&
      existsSync(join(this.dataDir, 'publications', publicationId, 'manifest.json'));
  }

  /** Fresh scratch directory for one render attempt. */
  leaseTmpDir(operationId: string, leaseId: string): string {
    if (!SAFE_SEGMENT.test(operationId) || !SAFE_SEGMENT.test(leaseId)) {
      throw storageFailure();
    }
    const dir = join(this.dataDir, 'tmp', 'render', operationId, leaseId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  finalPath(relativePath: string): string {
    if (!/^(assets\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|gray4))$/.test(relativePath)) {
      throw storageFailure();
    }
    return join(this.dataDir, relativePath);
  }

  readFinal(relativePath: string): Buffer {
    try {
      return readFileSync(this.finalPath(relativePath));
    } catch {
      throw storageFailure();
    }
  }

  /**
   * Move a fully verified scratch artifact to its immutable content-addressed
   * path. Recomputes the digest from the actual bytes — never trusts the
   * renderer's self-report alone.
   */
  commitTmpFile(tmpFile: string, kind: AssetKind, expectedSha256: string, expectedBytes: number): CommittedAsset {
    let data: Buffer;
    try {
      data = readFileSync(tmpFile);
    } catch {
      throw storageFailure();
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== expectedSha256 || data.length !== expectedBytes) {
      throw storageFailure();
    }
    const relativePath = relativePathFor(sha256, kind);
    const finalPath = this.finalPath(relativePath);
    if (existsSync(finalPath)) {
      // Reuse only when byte-identical; a differing file at the same digest
      // path is corruption, never something to overwrite.
      const existing = readFileSync(finalPath);
      if (existing.length !== data.length || createHash('sha256').update(existing).digest('hex') !== sha256) {
        throw storageFailure();
      }
      return { sha256, kind, mediaType: mediaTypeFor(kind), byteLength: data.length, relativePath };
    }
    const dir = join(this.dataDir, 'assets', 'sha256', sha256.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const incoming = join(dir, `.${sha256}.${kind}.incoming-${randomBytes(6).toString('hex')}`);
    const fd = openSync(incoming, 'wx');
    try {
      writeSync(fd, data);
      try {
        // fsync is best-effort: some platforms/filesystems refuse it.
        fsyncSync(fd);
      } catch {
        // platform does not allow fsync here; the rename below is still atomic
      }
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(incoming, finalPath);
    } catch {
      try {
        rmSync(incoming, { force: true });
      } catch {
        // best effort; the incoming name is unique per attempt
      }
      throw storageFailure();
    }
    return { sha256, kind, mediaType: mediaTypeFor(kind), byteLength: data.length, relativePath };
  }

  /**
   * Keep a human-readable copy of each finished publication alongside the
   * content-addressed asset store. This is the data authors and operators can
   * browse directly without decoding database rows or SHA paths.
   */
  archivePublication(input: {
    publicationId: string;
    manuscript: unknown;
    body: string;
    pages: ReadonlyArray<{ index: number; partRole?: string; png: CommittedAsset }>;
  }): string {
    if (!SAFE_SEGMENT.test(input.publicationId)) throw storageFailure();
    const root = join(this.dataDir, 'publications', input.publicationId);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'original.txt'), input.body, 'utf8');
    writeFileSync(join(root, 'manuscript.json'), `${JSON.stringify(input.manuscript, null, 2)}\n`, 'utf8');
    const manifest = input.pages.map((page) => {
      const file = `page-${String(page.index + 1).padStart(3, '0')}.png`;
      copyFileSync(this.finalPath(page.png.relativePath), join(root, file));
      return {
        page_index: page.index,
        page_number: page.index + 1,
        role: page.partRole ?? 'main',
        file,
        sha256: page.png.sha256,
        bytes: page.png.byteLength,
      };
    });
    writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({
      publication_id: input.publicationId,
      page_count: manifest.length,
      pages: manifest,
    }, null, 2)}\n`, 'utf8');
    return root;
  }

  /**
   * Remove scratch lease directories that do not belong to an active lease.
   * Only the tmp tree is ever touched; final assets are never deleted. The
   * data-directory lock guarantees no other live process owns a lease.
   */
  cleanupStaleTmp(activeLeaseIds: ReadonlySet<string>): { removedLeaseDirs: number } {
    const renderRoot = join(this.dataDir, 'tmp', 'render');
    if (!existsSync(renderRoot)) {
      return { removedLeaseDirs: 0 };
    }
    let removed = 0;
    for (const operationId of readdirSync(renderRoot)) {
      const operationDir = join(renderRoot, operationId);
      if (!statSync(operationDir).isDirectory()) {
        continue;
      }
      for (const leaseId of readdirSync(operationDir)) {
        if (activeLeaseIds.has(leaseId)) {
          continue;
        }
        rmSync(join(operationDir, leaseId), { recursive: true, force: true });
        removed += 1;
      }
      if (readdirSync(operationDir).length === 0) {
        rmSync(operationDir, { recursive: true, force: true });
      }
    }
    return { removedLeaseDirs: removed };
  }

  /** Remove one attempt's scratch directory after it finished. */
  removeLeaseTmp(operationId: string, leaseId: string): void {
    if (!SAFE_SEGMENT.test(operationId) || !SAFE_SEGMENT.test(leaseId)) {
      throw storageFailure();
    }
    rmSync(join(this.dataDir, 'tmp', 'render', operationId, leaseId), { recursive: true, force: true });
    // Prune the operation directory once its last lease directory is gone.
    const operationDir = join(this.dataDir, 'tmp', 'render', operationId);
    try {
      if (readdirSync(operationDir).length === 0) {
        rmSync(operationDir, { recursive: true, force: true });
      }
    } catch {
      // already gone or not a directory; nothing to prune
    }
  }
}
