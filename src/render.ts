import pc from 'picocolors';
import type { AttemptRecord, CheckResult, LoopEvent } from './types.js';

/** Minimal structural sink so the renderer can be tested against a string buffer. */
export interface RenderStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface RendererOptions {
  /** Default: `process.stdout`. */
  stream?: RenderStream;
  /** Force colors on/off. Default: auto (TTY + terminal support). */
  color?: boolean;
  /** Force the spinner on/off. Default: only on a TTY. */
  spinner?: boolean;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function checkSummary(result: CheckResult): string {
  if (result.summary) return result.summary;
  const lines = result.evidence
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? (result.passed ? 'passed' : 'failed');
  return last.length > 60 ? `${last.slice(0, 57)}…` : last;
}

/**
 * The live terminal view of the loop — attached by default. Draws each
 * attempt as a tree: what the maker changed, then the judge's verdict with
 * evidence. When the model claims "done" and the check disagrees, it says so,
 * out loud, in yellow.
 */
export function createRenderer(opts: RendererOptions = {}): (event: LoopEvent) => void {
  const stream: RenderStream = opts.stream ?? process.stdout;
  const isTTY = stream.isTTY === true;
  const useSpinner = opts.spinner ?? isTTY;
  const c = pc.createColors(opts.color ?? (isTTY && pc.isColorSupported));

  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerText = '';
  let frame = 0;
  let lastLabel: string | undefined;
  let maxAttempts = 0;

  const stopSpinner = (): void => {
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
      stream.write(`\r${' '.repeat(Math.min(spinnerText.length + 4, 120))}\r`);
    }
  };

  const startSpinner = (text: string): void => {
    stopSpinner();
    if (!useSpinner) return;
    spinnerText = text;
    frame = 0;
    spinnerTimer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      stream.write(`\r${c.cyan(FRAMES[frame] ?? '⠋')} ${text}`);
    }, 90);
    stream.write(`\r${c.cyan(FRAMES[0] ?? '⠋')} ${text}`);
  };

  const line = (text: string): void => {
    stopSpinner();
    stream.write(`${text}\n`);
  };

  const attemptLine = (attempt: number, max: number, summary: string): string =>
    `├─ attempt ${attempt}/${max}  ${c.cyan('✎')} ${summary}`;

  const checkLine = (result: CheckResult, claimedDone: boolean, label?: string): string => {
    const shownLabel = result.label ?? label ?? 'check';
    const verdict = result.passed
      ? c.green(`✓ ${checkSummary(result)}`)
      : c.red(`✗ ${checkSummary(result)}`);
    const callout =
      claimedDone && !result.passed
        ? `   ${c.bold(c.yellow('← model said "done"; check disagreed'))}`
        : '';
    return `│   ⤷ check: ${shownLabel}  ${verdict}${callout}`;
  };

  const recap = (record: AttemptRecord, max: number): void => {
    line(c.dim(`├─ attempt ${record.attempt}/${max}  ✎ ${record.patchSummary}`));
    const verdict = record.check.passed ? '✓' : '✗';
    line(
      c.dim(
        `│   ⤷ check: ${record.check.label ?? 'check'}  ${verdict} ${checkSummary(record.check)}`,
      ),
    );
  };

  return (event: LoopEvent): void => {
    try {
      switch (event.type) {
        case 'loop_start': {
          maxAttempts = event.maxAttempts;
          line(`${c.magenta('◆')} ${c.bold(`goal: ${event.goal}`)}`);
          if (event.resumed) {
            line(
              c.dim(
                `│  ↻ resuming — ${event.priorAttempts.length} earlier attempt(s) restored from ${event.statePath}`,
              ),
            );
            for (const record of event.priorAttempts) recap(record, event.maxAttempts);
          }
          break;
        }
        case 'state_reset':
          line(c.dim(`│  · starting fresh (state reset: ${event.reason})`));
          break;
        case 'generate_start':
          startSpinner(c.dim(`attempt ${event.attempt}: generating…`));
          break;
        case 'generate_end': {
          const claims = event.claimsDone ? c.yellow(' (claims done)') : '';
          line(
            attemptLine(event.attempt, Math.max(maxAttempts, event.attempt), event.summary) +
              claims,
          );
          if (event.reflection) line(c.dim(`│   ↺ ${event.reflection}`));
          break;
        }
        case 'check_start':
          lastLabel = event.label;
          startSpinner(c.dim(`check: ${event.label ?? 'running…'}`));
          break;
        case 'check_end':
          line(checkLine(event.result, event.claimedDone, lastLabel));
          break;
        case 'commit_skipped':
          line(c.dim(`│   · commit skipped (${event.reason})`));
          break;
        case 'loop_end': {
          const r = event.result;
          if (r.status === 'passed') {
            const commit = r.commit
              ? ` · committed ${r.commit.sha.slice(0, 7)} (${r.commit.branch}, no push)`
              : '';
            line(
              `╰─ ${c.green('✓')} ${c.bold(`goal met in ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`)}${commit}`,
            );
          } else if (r.status === 'exhausted') {
            const closest = r.closest
              ? ` · closest: attempt ${r.closest.attempt} — ${checkSummary(r.closest.check)}`
              : '';
            line(
              `╰─ ${c.red('✗')} ${c.bold(`${reasonText(r.reason)} after ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`)}${closest}`,
            );
            line(
              c.dim(
                '   exhaustion is a result, not a hang — history is on disk; rerun to continue.',
              ),
            );
          } else {
            line(
              `╰─ ${c.red('✗')} error: ${r.error instanceof Error ? r.error.message : String(r.error)}`,
            );
            line(c.dim('   state is saved — rerun to resume from the last completed attempt.'));
          }
          break;
        }
        case 'attempt_start':
        case 'apply_end':
        case 'claim_rejected':
        case 'attempt_end':
        case 'commit_end':
        case 'bound_reached':
          break; // drawn via the composite lines above
      }
    } catch {
      // Rendering must never take down the loop.
    }
  };
}

function reasonText(reason: string | undefined): string {
  switch (reason) {
    case 'budget-usd':
      return 'budget (USD) exhausted';
    case 'budget-turns':
      return 'budget (turns) exhausted';
    default:
      return 'attempts exhausted';
  }
}
