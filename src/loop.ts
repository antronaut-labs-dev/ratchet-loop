import path from 'node:path';
import { defaultApply } from './apply.js';
import { RatchetError } from './errors.js';
import { tail } from './exec.js';
import { commitAll, ensureBranch, ensureWorktree, isGitRepo, slugify } from './git.js';
import { createRenderer } from './render.js';
import { freshState, loadState, saveState, type LoopState } from './state.js';
import type {
  AttemptRecord,
  CheckContext,
  CheckResult,
  CommitContext,
  CommitInfo,
  ExhaustionReason,
  Loop,
  LoopConfig,
  LoopContext,
  LoopEvent,
  LoopResult,
  Patch,
  StateResetReason,
} from './types.js';

const EVIDENCE_CAP = 8_000;

function validateConfig(config: LoopConfig): void {
  const bad = (msg: string): never => {
    throw new RatchetError('CONFIG_INVALID', msg);
  };
  if (typeof config.goal !== 'string' || config.goal.trim().length === 0)
    bad('goal must be a non-empty string');
  if (typeof config.generate !== 'function') bad('generate must be a function (the maker)');
  if (typeof config.check !== 'function') bad('check must be a function (the judge)');
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1)
    bad('maxAttempts must be an integer >= 1');
  if (config.budget?.usd !== undefined && !(config.budget.usd > 0))
    bad('budget.usd must be a positive number');
  if (
    config.budget?.turns !== undefined &&
    (!Number.isInteger(config.budget.turns) || config.budget.turns < 1)
  )
    bad('budget.turns must be an integer >= 1');
  // Runtime twin of the `push?: false` type, for untyped callers: there is no
  // push code path in this library, so pretending to enable one is an error.
  if ((config.git as { push?: unknown } | undefined)?.push)
    bad('ratchet-loop never pushes — remove git.push; publishing results stays a human decision');
}

function validatePatch(patch: unknown): asserts patch is Patch {
  const p = patch as Patch | null | undefined;
  if (typeof p !== 'object' || p === null || typeof p.summary !== 'string') {
    throw new RatchetError(
      'GENERATE_FAILED',
      'generate() must return a Patch: { summary: string, files?: FileChange[], claimsDone?: boolean }',
    );
  }
  for (const file of p.files ?? []) {
    if (
      typeof file !== 'object' ||
      file === null ||
      typeof file.path !== 'string' ||
      (typeof file.contents !== 'string' && file.contents !== null)
    ) {
      throw new RatchetError(
        'GENERATE_FAILED',
        'each Patch file must be { path: string, contents: string | null }',
      );
    }
  }
}

function normalizeCheckResult(result: unknown): CheckResult {
  const r = result as CheckResult | null | undefined;
  if (typeof r !== 'object' || r === null || typeof r.passed !== 'boolean') {
    throw new RatchetError(
      'CHECK_THREW',
      'check() must return a CheckResult: { passed: boolean, evidence: string }',
    );
  }
  return {
    ...r,
    passed: r.passed,
    evidence: typeof r.evidence === 'string' ? r.evidence : String(r.evidence ?? ''),
  };
}

function pickClosest(attempts: readonly AttemptRecord[]): AttemptRecord | undefined {
  let best: AttemptRecord | undefined;
  for (const record of attempts) {
    if (typeof record.check.score !== 'number') continue;
    if (best?.check.score === undefined || record.check.score >= best.check.score) best = record;
  }
  return best ?? attempts[attempts.length - 1];
}

function buildReflection(previous: AttemptRecord): string {
  return (
    `Attempt ${previous.attempt} failed its check. Evidence (tail):\n` +
    `${tail(previous.check.evidence, 1_200)}\n\n` +
    `In 1-2 sentences: why did it fail, and what will you change this attempt? ` +
    `Return that critique in the patch's "reflection" field, then the corrected files.`
  );
}

/**
 * Create the loop. Nothing runs until `run()` is called; `run()` starts fresh
 * or resumes from `statePath` and returns only when the check passes, a bound
 * is hit, or a supplied function throws.
 */
export function createLoop(config: LoopConfig): Loop {
  validateConfig(config);
  return { run: () => runLoop(config) };
}

async function runLoop(config: LoopConfig): Promise<LoopResult> {
  const workdirRoot = path.resolve(config.workdir ?? process.cwd());
  const statePathInput = config.statePath ?? path.join('.ratchet', 'state.json');
  const statePath = path.isAbsolute(statePathInput)
    ? statePathInput
    : path.resolve(workdirRoot, statePathInput);

  const listeners: Array<(event: LoopEvent) => void> = [];
  if (config.silent !== true) listeners.push(createRenderer());
  if (config.onEvent) listeners.push(config.onEvent);
  let warnedListener = false;
  const emit = (event: LoopEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        if (!warnedListener) {
          warnedListener = true;
          console.warn('ratchet-loop: onEvent listener threw; further failures muted', err);
        }
      }
    }
  };

  // ── durable state: load, and decide whether it is resumable ─────────────
  const loaded = await loadState(statePath);
  let resetReason: StateResetReason | undefined;
  let state: LoopState;
  if (loaded.corrupt) {
    resetReason = 'corrupt';
    state = freshState(config.goal);
  } else if (loaded.state === undefined) {
    state = freshState(config.goal);
  } else if (loaded.state.goal !== config.goal) {
    resetReason = 'goal-changed';
    state = freshState(config.goal);
  } else if (loaded.state.status !== 'running') {
    resetReason = 'previous-run-finished';
    state = freshState(config.goal);
  } else {
    state = loaded.state;
  }
  const resumed = state.attempts.length > 0;
  const priorAttempts: readonly AttemptRecord[] = [...state.attempts];

  const finishFailed = async (
    code: 'GENERATE_FAILED' | 'APPLY_FAILED' | 'CHECK_THREW' | 'COMMIT_FAILED' | 'GIT_FAILED',
    cause: unknown,
  ): Promise<LoopResult> => {
    const error =
      cause instanceof RatchetError
        ? cause
        : new RatchetError(
            code,
            `${code.toLowerCase().replace('_', ' ')}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
    // Status stays 'running' on disk: a failed run is a resumable run.
    await saveState(statePath, state);
    const last = state.attempts[state.attempts.length - 1];
    const result: LoopResult = {
      status: 'failed',
      attempts: state.attempts.length,
      evidence: last?.check.evidence ?? '',
      history: [...state.attempts],
      error,
    };
    emit({ type: 'loop_end', result });
    return result;
  };

  // ── git setup (branch / worktree isolation) ──────────────────────────────
  let workdir = workdirRoot;
  let gitSetupError: unknown;
  if (config.git?.worktree === true || config.git?.branch !== undefined) {
    try {
      if (!(await isGitRepo(workdirRoot))) {
        throw new RatchetError(
          'GIT_FAILED',
          `git.branch/git.worktree requested but ${workdirRoot} is not a git repository`,
        );
      }
      const branch = config.git.branch ?? state.branch ?? `ratchet/${slugify(config.goal)}`;
      state.branch = branch;
      if (config.git.worktree === true) {
        workdir = await ensureWorktree(workdirRoot, branch, state.worktree);
        state.worktree = workdir;
      } else {
        await ensureBranch(workdirRoot, branch);
      }
    } catch (err) {
      gitSetupError = err;
    }
  }

  emit({
    type: 'loop_start',
    goal: config.goal,
    maxAttempts: config.maxAttempts,
    workdir,
    statePath,
    resumed,
    priorAttempts,
  });
  if (resetReason !== undefined) emit({ type: 'state_reset', reason: resetReason });
  if (gitSetupError !== undefined) return finishFailed('GIT_FAILED', gitSetupError);

  await saveState(statePath, state);

  const apply = config.apply ?? defaultApply;
  const checkLabel = config.check.label;

  // ── the loop: generate → apply → check → record → (commit | continue) ───
  for (;;) {
    // Rule 4 — bounded: exhaustion is a first-class result, not an infinite loop.
    if (state.attempts.length >= config.maxAttempts) {
      return finishExhausted('max-attempts');
    }
    if (config.budget?.turns !== undefined && state.totals.turns >= config.budget.turns) {
      return finishExhausted('budget-turns');
    }
    if (config.budget?.usd !== undefined && state.totals.usd >= config.budget.usd) {
      return finishExhausted('budget-usd');
    }

    const attempt = state.attempts.length + 1;
    emit({ type: 'attempt_start', attempt, maxAttempts: config.maxAttempts });

    const last = state.attempts[state.attempts.length - 1];
    const lastFailure = last !== undefined && !last.check.passed ? last.check : undefined;
    const ctx: LoopContext = {
      goal: config.goal,
      attempt,
      maxAttempts: config.maxAttempts,
      workdir,
      history: [...state.attempts],
      ...(lastFailure !== undefined ? { lastFailure } : {}),
      ...(config.reflect === true && last !== undefined && !last.check.passed
        ? { reflection: buildReflection(last) }
        : {}),
    };

    const startedAt = new Date().toISOString();

    // Maker (Rule 2: the thing that writes code never grades itself).
    emit({ type: 'generate_start', attempt });
    let patch: Patch;
    try {
      const produced: unknown = await config.generate(ctx);
      validatePatch(produced);
      patch = produced;
    } catch (err) {
      return finishFailed('GENERATE_FAILED', err);
    }
    state.totals.turns += 1;
    state.totals.usd += patch.cost?.usd ?? 0;
    emit({
      type: 'generate_end',
      attempt,
      summary: patch.summary,
      claimsDone: patch.claimsDone === true,
      ...(patch.reflection !== undefined ? { reflection: patch.reflection } : {}),
    });

    try {
      await apply(patch, ctx);
    } catch (err) {
      return finishFailed('APPLY_FAILED', err);
    }
    emit({ type: 'apply_end', attempt, filesChanged: (patch.files ?? []).map((f) => f.path) });

    // Judge (Rule 1: "done" is a check with evidence, not a vibe).
    const checkCtx: CheckContext = { ...ctx, patch };
    emit({
      type: 'check_start',
      attempt,
      ...(checkLabel !== undefined ? { label: checkLabel } : {}),
    });
    let result: CheckResult;
    try {
      result = normalizeCheckResult(await config.check(checkCtx));
    } catch (err) {
      return finishFailed('CHECK_THREW', err);
    }
    const persisted: CheckResult = { ...result, evidence: tail(result.evidence, EVIDENCE_CAP) };
    emit({ type: 'check_end', attempt, result, claimedDone: patch.claimsDone === true });

    // Rule 5 — the stop-hook: a self-reported "done" never stops the loop.
    if (patch.claimsDone === true && !result.passed) {
      emit({ type: 'claim_rejected', attempt, evidence: persisted.evidence });
    }

    const record: AttemptRecord = {
      attempt,
      startedAt,
      endedAt: new Date().toISOString(),
      patchSummary: patch.summary,
      filesChanged: (patch.files ?? []).map((f) => f.path),
      claimedDone: patch.claimsDone === true,
      check: persisted,
      ...(patch.reflection !== undefined ? { reflection: patch.reflection } : {}),
      ...(patch.cost !== undefined ? { cost: patch.cost } : {}),
    };

    if (!result.passed) {
      // Rule 3 — state on disk before the next spin: a killed run resumes here.
      state.attempts.push(record);
      await saveState(statePath, state);
      emit({ type: 'attempt_end', record });
      continue;
    }

    // Check passed: commit (locally — never a push), persist, stop.
    let commitInfo: CommitInfo | undefined;
    try {
      if (config.commit !== undefined) {
        const commitCtx: CommitContext = { ...checkCtx, check: result };
        const returned = await config.commit(commitCtx);
        if (returned !== undefined) commitInfo = returned;
      } else {
        const outcome = await commitAll(
          workdir,
          `ratchet: ${config.goal} (attempt ${attempt} passed)`,
        );
        if (outcome.commit !== undefined) commitInfo = outcome.commit;
        else if (outcome.skippedReason !== undefined) {
          emit({ type: 'commit_skipped', attempt, reason: outcome.skippedReason });
        }
      }
    } catch (err) {
      state.attempts.push(record);
      await saveState(statePath, state);
      return finishFailed('COMMIT_FAILED', err);
    }
    if (commitInfo !== undefined) {
      record.commit = commitInfo;
      emit({ type: 'commit_end', attempt, commit: commitInfo });
    }

    state.attempts.push(record);
    state.status = 'passed';
    await saveState(statePath, state);
    emit({ type: 'attempt_end', record });

    const finalResult: LoopResult = {
      status: 'passed',
      attempts: state.attempts.length,
      evidence: result.evidence,
      history: [...state.attempts],
      ...(commitInfo !== undefined ? { commit: commitInfo } : {}),
    };
    emit({ type: 'loop_end', result: finalResult });
    return finalResult;
  }

  async function finishExhausted(kind: ExhaustionReason): Promise<LoopResult> {
    state.status = 'exhausted';
    await saveState(statePath, state);
    emit({ type: 'bound_reached', kind, attempts: state.attempts.length });
    const closest = pickClosest(state.attempts);
    const result: LoopResult = {
      status: 'exhausted',
      attempts: state.attempts.length,
      evidence: closest?.check.evidence ?? '',
      history: [...state.attempts],
      reason: kind,
      ...(closest !== undefined ? { closest } : {}),
    };
    emit({ type: 'loop_end', result });
    return result;
  }
}
