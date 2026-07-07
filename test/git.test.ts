import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLoop } from '../src/index.js';
import type { Patch } from '../src/index.js';
import {
  collectEvents,
  exists,
  fakeCheck,
  fakeGenerate,
  initRepo,
  runGit,
  tempDir,
} from './helpers.js';

const filePatch = (summary: string, name: string, contents: string): Patch => ({
  summary,
  files: [{ path: name, contents }],
});

describe('git safety', () => {
  it('commits locally on pass with the default commit', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    const before = await runGit(['rev-parse', 'HEAD'], dir);

    const result = await createLoop({
      goal: 'commit the fix',
      generate: fakeGenerate([filePatch('write the fix', 'fix.txt', 'fixed\n')]).fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
    }).run();

    expect(result.status).toBe('passed');
    expect(result.commit).toBeDefined();
    const head = await runGit(['rev-parse', 'HEAD'], dir);
    expect(head).not.toBe(before);
    expect(result.commit?.sha).toBe(head);
    expect(result.history[0]?.commit?.sha).toBe(head);
    const message = await runGit(['log', '-1', '--pretty=%s'], dir);
    expect(message).toContain('ratchet: commit the fix');
  });

  it('NEVER pushes — a passing run leaves remote refs byte-for-byte untouched', async () => {
    // A local bare repo stands in for the protected remote.
    const bare = await tempDir('ratchet-bare-');
    await runGit(['init', '-q', '--bare', '-b', 'main'], bare);

    const dir = await tempDir();
    await initRepo(dir);
    await runGit(['remote', 'add', 'origin', bare], dir);
    await runGit(['push', '-q', '-u', 'origin', 'main'], dir); // test setup, not the library
    const remoteShaBefore = await runGit(['rev-parse', 'main'], bare);
    const localMainBefore = await runGit(['rev-parse', 'main'], dir);

    const result = await createLoop({
      goal: 'fix without touching the remote',
      generate: fakeGenerate([filePatch('the fix', 'fix.txt', 'fixed\n')]).fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      git: { branch: 'ratchet/fix' },
    }).run();
    expect(result.status).toBe('passed');

    // The remote saw nothing: same sha, no new refs of any kind.
    expect(await runGit(['rev-parse', 'main'], bare)).toBe(remoteShaBefore);
    expect(await runGit(['for-each-ref', '--format=%(refname)'], bare)).toBe('refs/heads/main');

    // The work landed on the local work branch; local main never moved.
    expect(await runGit(['rev-parse', 'main'], dir)).toBe(localMainBefore);
    expect(result.commit?.branch).toBe('ratchet/fix');
    expect(await runGit(['rev-parse', 'ratchet/fix'], dir)).not.toBe(localMainBefore);
  });

  it('skips the commit gracefully outside a git repo', async () => {
    const dir = await tempDir(); // deliberately not a repo
    const { events, onEvent } = collectEvents();

    const result = await createLoop({
      goal: 'no repo here',
      generate: fakeGenerate([filePatch('fix', 'fix.txt', 'x')]).fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      onEvent,
    }).run();

    expect(result.status).toBe('passed');
    expect(result.commit).toBeUndefined();
    const skipped = events.find((e) => e.type === 'commit_skipped');
    expect(skipped?.type === 'commit_skipped' && skipped.reason).toBe('not-a-git-repo');
  });

  it('fails loudly when git isolation is requested outside a repo', async () => {
    const dir = await tempDir();
    const result = await createLoop({
      goal: 'wants a branch',
      generate: fakeGenerate([filePatch('fix', 'f.txt', 'x')]).fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      git: { branch: 'ratchet/fix' },
    }).run();

    expect(result.status).toBe('failed');
    expect(String(result.error)).toContain('not a git repository');
  });

  it('isolates the run in a worktree, leaving the main checkout untouched', async () => {
    const dir = await tempDir();
    await initRepo(dir);
    const gen = fakeGenerate([filePatch('the fix', 'wt.txt', 'from the worktree\n')]);

    const result = await createLoop({
      goal: 'work in a worktree',
      generate: gen.fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      git: { worktree: true, branch: 'ratchet/wt' },
    }).run();

    expect(result.status).toBe('passed');
    const workdirUsed = gen.calls[0]?.workdir;
    expect(workdirUsed).toBeDefined();
    expect(path.resolve(workdirUsed ?? '')).not.toBe(path.resolve(dir));

    // The patch landed in the worktree and its branch — not the main checkout.
    expect(await exists(path.join(workdirUsed ?? '', 'wt.txt'))).toBe(true);
    expect(await exists(path.join(dir, 'wt.txt'))).toBe(false);
    expect(result.commit?.branch).toBe('ratchet/wt');
    const message = await runGit(['log', '-1', '--pretty=%s', 'ratchet/wt'], dir);
    expect(message).toContain('ratchet:');
    // main is where it started
    const mainFiles = await fs.readdir(dir);
    expect(mainFiles).not.toContain('wt.txt');
  });
});
