/**
 * ratchet-loop — public types.
 *
 * The whole library is a single primitive: a bounded write → check → fix →
 * commit loop where an external, verifiable check decides when the agent is
 * done. The model is the maker; the check is the judge; they are never the
 * same thing.
 */

/** A single file edit inside a {@link Patch}. `contents: null` deletes the file. */
export interface FileChange {
  /** Path relative to the loop's working directory. Must not escape it. */
  path: string;
  /** New full contents of the file, or `null` to delete it. */
  contents: string | null;
}

/** Optional cost accounting attached to a {@link Patch} by the maker. */
export interface PatchCost {
  /** Dollars spent producing this patch. Counted against `budget.usd`. */
  usd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * What the maker (`generate`) returns for one attempt.
 *
 * A patch is a claim, never a verdict: even `claimsDone: true` only means the
 * model *believes* the goal is met. The loop still runs the check, and only
 * the check can stop the loop.
 */
export interface Patch {
  /** One-line human summary of what changed. Shown live in the terminal. */
  summary: string;
  /** File edits for the default `apply`. Omit or leave empty for "no changes". */
  files?: FileChange[];
  /**
   * The model asserts the goal is already met. ratchet-loop does not trust
   * this: the check still runs, and if it fails the loop continues and emits
   * a `claim_rejected` event ("model said done; check disagreed").
   */
  claimsDone?: boolean;
  /** Model self-critique of the previous failure (when `reflect: true`). Recorded in history. */
  reflection?: string;
  /** Cost of producing this patch; accumulated against the budget. */
  cost?: PatchCost;
  /** Free-form payload for a custom `apply` (e.g. a unified diff). Ignored by the default apply. */
  data?: unknown;
}

/** Verdict from the judge (`check`). `passed` is the only thing that can stop the loop. */
export interface CheckResult {
  /** Did the external check pass? */
  passed: boolean;
  /** Raw proof: test runner output, compiler errors, etc. Persisted (tail-truncated) to state. */
  evidence: string;
  /** Short one-line verdict for the terminal (e.g. "3 failing"). Derived from evidence if omitted. */
  summary?: string;
  /**
   * Optional closeness score in [0, 1]. When the loop exhausts its bounds,
   * the highest-scoring attempt is reported as `closest`. Without scores the
   * last attempt is used.
   */
  score?: number;
  /** What the check was (e.g. "npm test"). Shown in the terminal. */
  label?: string;
}

/** A commit produced after a passing check. */
export interface CommitInfo {
  sha: string;
  branch: string;
}

/** Durable record of one completed attempt. Persisted to `statePath` as it happens. */
export interface AttemptRecord {
  /** 1-based attempt number, continuous across resumed runs. */
  attempt: number;
  startedAt: string;
  endedAt: string;
  patchSummary: string;
  filesChanged: string[];
  /** The model claimed the goal was met on this attempt. */
  claimedDone: boolean;
  reflection?: string;
  check: CheckResult;
  cost?: PatchCost;
  /** Present when this attempt passed and produced a commit. */
  commit?: CommitInfo;
}

/**
 * Context handed to the maker on every attempt. It carries everything the
 * model needs to do better than last time: the goal, the full attempt
 * history, and the evidence from the last failing check.
 */
export interface LoopContext {
  goal: string;
  /** 1-based number of the attempt being generated. */
  attempt: number;
  maxAttempts: number;
  /** Directory the loop operates in (the git worktree when `git.worktree` is on). */
  workdir: string;
  /** All prior attempts, oldest first — including ones from crashed/resumed runs. */
  history: readonly AttemptRecord[];
  /** The failing check verdict from the previous attempt, if it failed. */
  lastFailure?: CheckResult;
  /**
   * Present when `reflect: true` and the previous attempt failed: an
   * instruction asking the model for a 1–2 sentence self-critique (returned
   * via `Patch.reflection`) before it produces the corrected patch.
   */
  reflection?: string;
}

/** Context for `check`: the loop context plus the patch that was just applied. */
export interface CheckContext extends LoopContext {
  patch: Patch;
}

/** Context for `commit`: the check context plus the passing verdict. */
export interface CommitContext extends CheckContext {
  check: CheckResult;
}

/** The maker. Any model, any provider, or no model at all — the core never imports one. */
export type GenerateFn = (ctx: LoopContext) => Promise<Patch>;

/**
 * The judge. Runs after every applied patch; only its `passed: true` stops
 * the loop. May carry a `label` property (as {@link shellCheck} sets) for the
 * live renderer.
 */
export type CheckFn = ((ctx: CheckContext) => Promise<CheckResult>) & { label?: string };

/** Applies a patch to disk. Defaults to writing `patch.files` under `workdir`. */
export type ApplyFn = (patch: Patch, ctx: LoopContext) => Promise<void>;

/**
 * Runs after a passing check. Defaults to `git add -A && git commit` in
 * `workdir` (never a push). Return {@link CommitInfo} to have it recorded in
 * history and the result.
 */
export type CommitFn = (ctx: CommitContext) => Promise<CommitInfo | void>;

/** Hard spending bounds. Exhaustion is a first-class result, not an error. */
export interface Budget {
  /** Max dollars, accumulated from `Patch.cost.usd`. */
  usd?: number;
  /** Max maker invocations, across resumed runs. */
  turns?: number;
}

/**
 * Git behavior. ratchet-loop only ever commits locally.
 *
 * `push` is typed `false` — there is no push code path in the library, so a
 * run can never touch a protected branch on a remote. The type (and a runtime
 * guard for untyped callers) makes that a guarantee rather than a default.
 */
export interface GitOptions {
  /** Branch to create/switch to before the first attempt. */
  branch?: string;
  /** Isolate the run in a `git worktree` (under `.ratchet/worktrees/`). */
  worktree?: boolean;
  /** Never `true`. ratchet-loop cannot push; publishing results stays a human decision. */
  push?: false;
}

export type LoopStatus = 'passed' | 'failed' | 'exhausted';

export type ExhaustionReason = 'max-attempts' | 'budget-usd' | 'budget-turns';

/** Why persisted state was discarded instead of resumed. */
export type StateResetReason = 'corrupt' | 'goal-changed' | 'previous-run-finished';

/** Final outcome of `loop.run()`. */
export interface LoopResult {
  /**
   * `passed` — the check passed and (by default) the work was committed.
   * `exhausted` — maxAttempts or budget hit; see `reason` and `closest`.
   * `failed` — a supplied function threw; see `error`. State stays resumable.
   */
  status: LoopStatus;
  /** Total completed attempts, including ones restored from disk. */
  attempts: number;
  /** Evidence from the final (or closest-to-passing) check. */
  evidence: string;
  /** Full durable attempt history. */
  history: AttemptRecord[];
  /** The commit created on pass, when one was made. */
  commit?: CommitInfo;
  /** Which bound was hit, when `status` is `exhausted`. */
  reason?: ExhaustionReason;
  /** The closest-to-passing attempt (highest `check.score`, else the last), when exhausted. */
  closest?: AttemptRecord;
  /** The thrown error, when `status` is `failed`. */
  error?: unknown;
}

/** Typed live event stream. Everything the built-in renderer draws is available here. */
export type LoopEvent =
  | {
      type: 'loop_start';
      goal: string;
      maxAttempts: number;
      workdir: string;
      statePath: string;
      /** True when attempts were restored from `statePath`. */
      resumed: boolean;
      priorAttempts: readonly AttemptRecord[];
    }
  | { type: 'state_reset'; reason: StateResetReason }
  | { type: 'attempt_start'; attempt: number; maxAttempts: number }
  | { type: 'generate_start'; attempt: number }
  | {
      type: 'generate_end';
      attempt: number;
      summary: string;
      claimsDone: boolean;
      reflection?: string;
    }
  | { type: 'apply_end'; attempt: number; filesChanged: string[] }
  | { type: 'check_start'; attempt: number; label?: string }
  | { type: 'check_end'; attempt: number; result: CheckResult; claimedDone: boolean }
  | {
      /**
       * The soul of the library: the model said "done", the check said no.
       * The loop logs it and keeps going.
       */
      type: 'claim_rejected';
      attempt: number;
      evidence: string;
    }
  | { type: 'attempt_end'; record: AttemptRecord }
  | { type: 'commit_end'; attempt: number; commit: CommitInfo }
  | { type: 'commit_skipped'; attempt: number; reason: string }
  | { type: 'bound_reached'; kind: ExhaustionReason; attempts: number }
  | { type: 'loop_end'; result: LoopResult };

/** Configuration for {@link createLoop}. `generate` and `check` are black boxes you supply. */
export interface LoopConfig {
  /** The task, in plain language. Changing it invalidates persisted state. */
  goal: string;
  /** The maker: produces a patch each attempt. Bring any model. */
  generate: GenerateFn;
  /** The judge: the external check that alone decides "done". */
  check: CheckFn;
  /** How patches land on disk. Default: write/delete `patch.files` under `workdir`. */
  apply?: ApplyFn;
  /** What happens on pass. Default: local `git commit` (never a push). */
  commit?: CommitFn;
  /** Hard ceiling on total attempts (including resumed ones). */
  maxAttempts: number;
  /** Optional cost ceilings; hitting one yields `status: 'exhausted'`. */
  budget?: Budget;
  /**
   * Where durable state lives. Default: `.ratchet/state.json` under
   * `workdir`. A killed run resumes from here.
   */
  statePath?: string;
  /** Directory the loop operates in. Default: `process.cwd()`. */
  workdir?: string;
  git?: GitOptions;
  /** Ask the maker for a short self-critique after each failed check. Default: false. */
  reflect?: boolean;
  /** Observe every loop event (in addition to the built-in renderer). */
  onEvent?: (event: LoopEvent) => void;
  /** Disable the built-in live terminal renderer. Default: false. */
  silent?: boolean;
}

/** A configured loop. Call `run()` to start or resume it. */
export interface Loop {
  run(): Promise<LoopResult>;
}
