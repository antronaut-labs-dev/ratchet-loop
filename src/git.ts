import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RatchetError } from './errors.js';
import { git, gitOrThrow } from './exec.js';
import type { CommitFn, CommitInfo } from './types.js';

export async function isGitRepo(cwd: string): Promise<boolean> {
  const { code, output } = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return code === 0 && output.trim() === 'true';
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const { code } = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  return code === 0;
}

/** Switch to `branch`, creating it from HEAD when it doesn't exist yet. */
export async function ensureBranch(cwd: string, branch: string): Promise<void> {
  if ((await currentBranch(cwd)) === branch) return;
  if (await branchExists(cwd, branch)) {
    await gitOrThrow(['switch', branch], cwd);
  } else {
    await gitOrThrow(['switch', '-c', branch], cwd);
  }
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'goal';
}

/**
 * Create (or reuse, when resuming) an isolated worktree under
 * `.ratchet/worktrees/` so the loop never disturbs the main checkout.
 */
export async function ensureWorktree(
  repoRoot: string,
  branch: string,
  existingPath?: string,
): Promise<string> {
  const dir = existingPath ?? path.join(repoRoot, '.ratchet', 'worktrees', slugify(branch));
  try {
    await fs.access(path.join(dir, '.git'));
    return dir; // resumed run: worktree already exists
  } catch {
    // fall through and create it
  }
  await fs.mkdir(path.dirname(dir), { recursive: true });
  if (await branchExists(repoRoot, branch)) {
    await gitOrThrow(['worktree', 'add', dir, branch], repoRoot);
  } else {
    await gitOrThrow(['worktree', 'add', '-b', branch, dir], repoRoot);
  }
  return dir;
}

export interface CommitOutcome {
  commit?: CommitInfo;
  /** Why no commit was made ('not-a-git-repo' | 'nothing-to-commit'). */
  skippedReason?: string;
}

/** `git add -A && git commit` in `workdir`. Local only — there is no push code path. */
export async function commitAll(workdir: string, message: string): Promise<CommitOutcome> {
  if (!(await isGitRepo(workdir))) {
    return { skippedReason: 'not-a-git-repo' };
  }
  await gitOrThrow(['add', '-A'], workdir);
  const { code, output } = await git(['commit', '-m', message], workdir);
  if (code !== 0) {
    if (/nothing (added )?to commit|working tree clean/i.test(output)) {
      return { skippedReason: 'nothing-to-commit' };
    }
    throw new RatchetError('COMMIT_FAILED', `git commit failed (exit ${code}): ${output}`);
  }
  const sha = (await gitOrThrow(['rev-parse', 'HEAD'], workdir)).trim();
  const branch = await currentBranch(workdir);
  return { commit: { sha, branch } };
}

/**
 * The default `commit` used by the loop, exported so custom commit functions
 * can wrap it. Commits everything in the workdir with a message naming the
 * goal and the passing attempt. Never pushes.
 */
export const defaultCommit: CommitFn = async (ctx) => {
  const message = `ratchet: ${ctx.goal} (attempt ${ctx.attempt} passed)`;
  const { commit } = await commitAll(ctx.workdir, message);
  return commit;
};
