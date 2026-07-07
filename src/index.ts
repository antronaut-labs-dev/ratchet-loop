/**
 * ratchet-loop — the agent loop that doesn't trust "I'm done."
 *
 * `createLoop` runs a bounded write → check → fix → commit loop where an
 * external, verifiable check — not the model — decides when the work is done.
 */
export { createLoop } from './loop.js';
export { shellCheck, summarizeCheckOutput } from './shell.js';
export { defaultApply } from './apply.js';
export { defaultCommit } from './git.js';
export { createRenderer } from './render.js';
export { RatchetError } from './errors.js';

export type { RatchetErrorCode } from './errors.js';
export type { RendererOptions, RenderStream } from './render.js';
export type { ShellCheckOptions } from './shell.js';
export type { LoopState, LoopTotals } from './state.js';
export type {
  AttemptRecord,
  ApplyFn,
  Budget,
  CheckContext,
  CheckFn,
  CheckResult,
  CommitContext,
  CommitFn,
  CommitInfo,
  ExhaustionReason,
  FileChange,
  GenerateFn,
  GitOptions,
  Loop,
  LoopConfig,
  LoopContext,
  LoopEvent,
  LoopResult,
  LoopStatus,
  Patch,
  PatchCost,
  StateResetReason,
} from './types.js';
