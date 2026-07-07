/**
 * Compile-time guarantees, enforced by `tsc --noEmit` in CI.
 * This file is type-checked, never executed.
 */
import { createLoop } from '../src/index.js';
import type { LoopConfig } from '../src/index.js';

const base: Omit<LoopConfig, 'git'> = {
  goal: 'g',
  generate: () => Promise.resolve({ summary: 's' }),
  check: () => Promise.resolve({ passed: true, evidence: '' }),
  maxAttempts: 1,
};

// Allowed: no git options, explicit push: false, branch/worktree isolation.
void createLoop({ ...base });
void createLoop({ ...base, git: { push: false } });
void createLoop({ ...base, git: { branch: 'ratchet/fix', worktree: true } });

// @ts-expect-error — push can never be true: ratchet-loop has no push code path.
void createLoop({ ...base, git: { push: true } });
