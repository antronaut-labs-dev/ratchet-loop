import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AttemptRecord, LoopStatus } from './types.js';

/** Accumulated spend, persisted so budgets survive crashes and resumes. */
export interface LoopTotals {
  turns: number;
  usd: number;
}

/**
 * The durable on-disk shape (`statePath`, default `.ratchet/state.json`).
 * Written atomically after every attempt: the agent forgets between runs; the
 * loop doesn't.
 */
export interface LoopState {
  version: 1;
  goal: string;
  startedAt: string;
  updatedAt: string;
  /** `running` means resumable — including runs that crashed or returned `failed`. */
  status: 'running' | LoopStatus;
  attempts: AttemptRecord[];
  totals: LoopTotals;
  branch?: string;
  worktree?: string;
}

export function freshState(goal: string): LoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    goal,
    startedAt: now,
    updatedAt: now,
    status: 'running',
    attempts: [],
    totals: { turns: 0, usd: 0 },
  };
}

function isValidState(value: unknown): value is LoopState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    s['version'] === 1 &&
    typeof s['goal'] === 'string' &&
    typeof s['status'] === 'string' &&
    Array.isArray(s['attempts']) &&
    typeof s['totals'] === 'object' &&
    s['totals'] !== null
  );
}

export interface LoadStateResult {
  state?: LoopState;
  /** True when a file existed but could not be trusted; it was backed up, not deleted. */
  corrupt: boolean;
}

/** Read persisted state. Corrupt files are moved to `<statePath>.corrupt-<ts>` and reported. */
export async function loadState(statePath: string): Promise<LoadStateResult> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath, 'utf8');
  } catch {
    return { corrupt: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidState(parsed)) throw new Error('unrecognized shape');
    return { state: parsed, corrupt: false };
  } catch {
    const backup = `${statePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(statePath, backup);
    } catch {
      // Racing writers or a locked file: leave it in place; a fresh save will overwrite.
    }
    return { corrupt: true };
  }
}

/** Atomic save: write to a temp file in the same directory, then rename over the target. */
export async function saveState(statePath: string, state: LoopState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, statePath);
}
