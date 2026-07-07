import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLoop, RatchetError } from '../src/index.js';
import { exists, fakeCheck, fakeGenerate, noopCommit, tempDir } from './helpers.js';

describe('default apply', () => {
  it('writes nested files and deletes with contents: null', async () => {
    const dir = await tempDir();
    const gen = fakeGenerate([
      { summary: 'create', files: [{ path: path.join('a', 'b', 'c.txt'), contents: 'hello' }] },
      { summary: 'delete', files: [{ path: path.join('a', 'b', 'c.txt'), contents: null }] },
    ]);
    const result = await createLoop({
      goal: 'apply things',
      generate: gen.fn,
      check: fakeCheck([false, true]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();

    expect(result.status).toBe('passed');
    // Attempt 2's delete removed the file attempt 1 created…
    expect(await fs.readFile(path.join(dir, 'a', 'b', 'c.txt'), 'utf8').catch(() => 'GONE')).toBe(
      'GONE',
    );
    // …while the nested directories attempt 1 made are still there.
    expect(await exists(path.join(dir, 'a', 'b'))).toBe(true);
  });

  it('verifies the write is on disk when the check runs', async () => {
    const dir = await tempDir();
    let seen = '';
    const result = await createLoop({
      goal: 'apply before check',
      generate: fakeGenerate([{ summary: 'w', files: [{ path: 'out.txt', contents: 'v1' }] }]).fn,
      check: async (ctx) => {
        seen = await fs.readFile(path.join(ctx.workdir, 'out.txt'), 'utf8');
        return { passed: true, evidence: seen };
      },
      maxAttempts: 1,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();

    expect(result.status).toBe('passed');
    expect(seen).toBe('v1');
  });

  it('refuses patch paths that escape the workdir', async () => {
    const dir = await tempDir();
    const result = await createLoop({
      goal: 'no escapes',
      generate: fakeGenerate([
        { summary: 'evil', files: [{ path: path.join('..', 'evil.txt'), contents: 'nope' }] },
      ]).fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 1,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(RatchetError);
    expect((result.error as RatchetError).code).toBe('PATH_ESCAPE');
    expect(await exists(path.join(dir, '..', 'evil.txt'))).toBe(false);
  });
});
