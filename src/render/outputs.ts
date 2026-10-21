/**
 * Output directory safety + artifact writing.
 *
 * A render always writes into a directory that either does not exist yet or
 * exists and is empty; existing files are never overwritten (writes use the
 * exclusive 'wx' flag), and the output path must not traverse a symlink —
 * neither the target itself nor any existing ancestor component.
 */

import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { RenderError } from './errors.js';

/** Resolve and validate the output directory (must be absent or empty, no symlinks). */
export async function prepareOutputDir(outputPath: string): Promise<string> {
  const target = resolve(outputPath);
  // Refuse when any existing path component (target included) is a symlink,
  // so an output argument cannot escape through a planted link.
  let current = target;
  const components: string[] = [];
  while (true) {
    components.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of components) {
    let stats;
    try {
      stats = await lstat(component);
    } catch {
      continue; // absent components are created below
    }
    if (stats.isSymbolicLink()) {
      throw new RenderError('output_unavailable', 'output path traverses a symbolic link');
    }
    if (!stats.isDirectory()) {
      throw new RenderError('output_unavailable', 'output path is not a directory');
    }
  }
  try {
    const entries = await readdir(target);
    if (entries.length > 0) {
      throw new RenderError('output_unavailable', 'output directory is not empty');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(target, { recursive: true });
    } else if (error instanceof RenderError) {
      throw error;
    } else {
      throw new RenderError('output_unavailable', 'output directory is not writable');
    }
  }
  return target;
}

/** Write one artifact exclusively; an existing file is an explicit failure. */
export async function writeArtifact(dir: string, name: string, data: Buffer | string): Promise<{ bytes: number }> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new RenderError('internal_error', 'artifact name is invalid');
  }
  try {
    await writeFile(`${dir}/${name}`, data, { flag: 'wx' });
  } catch {
    throw new RenderError('output_unavailable', `artifact could not be written exclusively: ${name}`);
  }
  return { bytes: typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length };
}
