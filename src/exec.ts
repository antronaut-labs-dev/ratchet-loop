import { execFile, spawn } from 'node:child_process';
import { RatchetError } from './errors.js';

export interface ExecResult {
  code: number;
  /** stdout and stderr, merged in arrival order. */
  output: string;
}

/** Run git with argv (no shell — immune to quoting differences across platforms). */
export function git(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new RatchetError('GIT_FAILED', 'git executable not found on PATH', { cause: err }),
          );
          return;
        }
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ code, output });
      },
    );
  });
}

/** Like {@link git} but a nonzero exit becomes a thrown RatchetError with the output attached. */
export async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const { code, output } = await git(args, cwd);
  if (code !== 0) {
    throw new RatchetError('GIT_FAILED', `git ${args.join(' ')} failed (exit ${code}): ${output}`);
  }
  return output;
}

export interface ShellResult {
  /** Exit code, or `null` when the process was killed (e.g. timeout). */
  code: number | null;
  /** stdout and stderr merged, tail-capped. */
  output: string;
  timedOut: boolean;
}

const OUTPUT_CAP = 200_000;

/** Run a shell command line, capturing merged output. Used by `shellCheck` and the demo. */
export function runShell(
  command: string,
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${err.message}`.trim(), timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output: output.trim(), timedOut });
    });
  });
}

/** Keep the last `max` characters, marking truncation. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(-max)}`;
}
