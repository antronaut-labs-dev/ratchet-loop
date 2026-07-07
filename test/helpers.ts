import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CheckContext,
  CheckFn,
  CheckResult,
  CommitFn,
  GenerateFn,
  LoopContext,
  LoopEvent,
  Patch,
} from '../src/index.js';

const pExecFile = promisify(execFile);

export async function tempDir(prefix = 'ratchet-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}

/**
 * A scripted maker: entries are returned per call (last entry repeats).
 * An `Error` entry throws — that's how tests simulate a crash mid-run.
 */
export function fakeGenerate(entries: Array<Patch | Error>): {
  fn: GenerateFn;
  calls: LoopContext[];
} {
  const calls: LoopContext[] = [];
  const fn: GenerateFn = (ctx) => {
    calls.push(ctx);
    const entry = entries[Math.min(calls.length, entries.length) - 1];
    if (entry === undefined) return Promise.reject(new Error('fakeGenerate: no entries'));
    if (entry instanceof Error) return Promise.reject(entry);
    return Promise.resolve(entry);
  };
  return { fn, calls };
}

/** A scripted judge: booleans, partial results, or an `Error` to simulate a crashed check. */
export function fakeCheck(
  entries: Array<boolean | Error | (Partial<CheckResult> & { passed: boolean })>,
): { fn: CheckFn; calls: CheckContext[] } {
  const calls: CheckContext[] = [];
  const fn: CheckFn = (ctx) => {
    calls.push(ctx);
    const entry = entries[Math.min(calls.length, entries.length) - 1];
    if (entry === undefined) return Promise.reject(new Error('fakeCheck: no entries'));
    if (entry instanceof Error) return Promise.reject(entry);
    if (typeof entry === 'boolean') {
      return Promise.resolve({
        passed: entry,
        evidence: entry
          ? `all green (call ${calls.length})`
          : `still failing (call ${calls.length})`,
      });
    }
    return Promise.resolve({ evidence: `evidence (call ${calls.length})`, ...entry });
  };
  return { fn, calls };
}

export function collectEvents(): { events: LoopEvent[]; onEvent: (event: LoopEvent) => void } {
  const events: LoopEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

/** Tests that don't exercise git use this to keep loops hermetic. */
export const noopCommit: CommitFn = async () => {};

export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await pExecFile('git', args, { cwd });
  return stdout.trim();
}

/** A real, isolated repo on `main` with one seed commit and a local identity. */
export async function initRepo(dir: string): Promise<void> {
  await runGit(['init', '-q', '-b', 'main'], dir);
  await runGit(['config', 'user.name', 'ratchet test'], dir);
  await runGit(['config', 'user.email', 'test@ratchet.local'], dir);
  await runGit(['config', 'commit.gpgsign', 'false'], dir);
  await fs.writeFile(path.join(dir, 'README.md'), 'seed\n', 'utf8');
  await runGit(['add', '-A'], dir);
  await runGit(['commit', '-q', '-m', 'seed'], dir);
}
