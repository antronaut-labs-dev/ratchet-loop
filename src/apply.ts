import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RatchetError } from './errors.js';
import type { ApplyFn } from './types.js';

/**
 * Default apply: write each `patch.files` entry under `ctx.workdir`
 * (`contents: null` deletes). Paths that resolve outside the workdir are
 * rejected — a patch can never edit files it wasn't scoped to.
 */
export const defaultApply: ApplyFn = async (patch, ctx) => {
  for (const file of patch.files ?? []) {
    const abs = path.resolve(ctx.workdir, file.path);
    const rel = path.relative(ctx.workdir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new RatchetError('PATH_ESCAPE', `patch path escapes the workdir: ${file.path}`);
    }
    if (file.contents === null) {
      await fs.rm(abs, { force: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.contents, 'utf8');
    }
  }
};
