import { runShell } from './exec.js';
import type { CheckFn } from './types.js';

export interface ShellCheckOptions {
  /** Working directory for the command. Default: the loop's `workdir`. */
  cwd?: string;
  /** Kill the command after this long; a timeout is a failed check, not a crash. */
  timeoutMs?: number;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Display label. Default: the command itself. */
  label?: string;
}

const FAIL_PATTERNS = [
  /(\d+)\s+fail(?:ing|ed|ures?)?\b/i, // mocha "3 failing", vitest "2 failed"
  /#\s*fail(?:ed)?\s+(\d+)/i, // node --test TAP "# fail 2"
  /fail(?:ing|ed|ures?)?[:\s]+(\d+)\b/i, // "failures: 1"
];

const PASS_PATTERNS = [
  /(\d+)\s+pass(?:ing|ed)?\b/i,
  /#\s*pass(?:ed)?\s+(\d+)/i,
  /pass(?:ing|ed)?[:\s]+(\d+)\b/i,
];

function firstNumber(patterns: RegExp[], text: string): number | undefined {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return undefined;
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? '';
  return last.length > 60 ? `${last.slice(0, 57)}…` : last;
}

/** One short line for the terminal, sniffed from common test-runner output. */
export function summarizeCheckOutput(output: string, code: number | null): string {
  const fails = firstNumber(FAIL_PATTERNS, output);
  const passes = firstNumber(PASS_PATTERNS, output);
  if (fails !== undefined && fails > 0) return `${fails} failing`;
  if (code === 0 && passes !== undefined) return `${passes} passing`;
  if (code === 0) return 'passed';
  const line = lastLine(output);
  return line.length > 0 ? line : `exit ${code ?? 'killed'}`;
}

/**
 * Turn a shell command into a judge: `passed` is `exit 0`, `evidence` is the
 * command's real output. This is the check most loops want —
 * `shellCheck('npm test')`, `shellCheck('tsc --noEmit')`, `shellCheck('cargo build')`.
 */
export function shellCheck(command: string, opts: ShellCheckOptions = {}): CheckFn {
  const label = opts.label ?? command;
  const fn: CheckFn = async (ctx) => {
    const { code, output, timedOut } = await runShell(command, {
      cwd: opts.cwd ?? ctx.workdir,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    const evidence = timedOut
      ? `${output}\n(check timed out after ${opts.timeoutMs}ms)`.trim()
      : output.length > 0
        ? output
        : `(no output; exit ${code ?? 'killed'})`;
    return {
      passed: code === 0,
      evidence,
      summary: timedOut ? 'timed out' : summarizeCheckOutput(output, code),
      label,
    };
  };
  fn.label = label;
  return fn;
}
