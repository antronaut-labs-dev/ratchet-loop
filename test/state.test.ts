import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLoop } from '../src/index.js';
import type { LoopState, Patch } from '../src/index.js';
import { collectEvents, fakeCheck, fakeGenerate, noopCommit, tempDir } from './helpers.js';

const patch = (summary: string, extra: Partial<Patch> = {}): Patch => ({ summary, ...extra });

const statePathIn = (dir: string): string => path.join(dir, '.ratchet', 'state.json');

async function readState(dir: string): Promise<LoopState> {
  return JSON.parse(await fs.readFile(statePathIn(dir), 'utf8')) as LoopState;
}

describe('state on disk (the agent forgets; the loop does not)', () => {
  it('persists every attempt as it happens', async () => {
    const dir = await tempDir();
    const gen = fakeGenerate([patch('try 1'), patch('try 2')]);
    const chk = fakeCheck([false, true]);
    await createLoop({
      goal: 'persist me',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();

    const state = await readState(dir);
    expect(state.version).toBe(1);
    expect(state.goal).toBe('persist me');
    expect(state.status).toBe('passed');
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts[0]?.check.passed).toBe(false);
    expect(state.totals.turns).toBe(2);
  });

  it('resumes exactly where a crashed run stopped', async () => {
    const dir = await tempDir();
    const goal = 'survive a crash';

    // Run A: attempt 1 completes (check fails); attempt 2 crashes mid-generate.
    const genA = fakeGenerate([patch('first idea'), new Error('simulated crash')]);
    const resultA = await createLoop({
      goal,
      generate: genA.fn,
      check: fakeCheck([{ passed: false, evidence: '2 failing: auth' }]).fn,
      maxAttempts: 5,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();
    expect(resultA.status).toBe('failed');
    expect(resultA.attempts).toBe(1);

    const stateAfterCrash = await readState(dir);
    expect(stateAfterCrash.status).toBe('running'); // resumable, not terminal
    expect(stateAfterCrash.attempts).toHaveLength(1);

    // Run B: a brand-new loop (fresh process, same statePath) picks up at attempt 2.
    const genB = fakeGenerate([patch('second idea')]);
    const { events, onEvent } = collectEvents();
    const resultB = await createLoop({
      goal,
      generate: genB.fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 5,
      workdir: dir,
      silent: true,
      commit: noopCommit,
      onEvent,
    }).run();

    const start = events.find((e) => e.type === 'loop_start');
    expect(start?.type === 'loop_start' && start.resumed).toBe(true);
    expect(start?.type === 'loop_start' && start.priorAttempts).toHaveLength(1);
    expect(genB.calls[0]?.attempt).toBe(2);
    expect(genB.calls[0]?.history[0]?.patchSummary).toBe('first idea');
    expect(genB.calls[0]?.lastFailure?.evidence).toBe('2 failing: auth');
    expect(resultB.status).toBe('passed');
    expect(resultB.attempts).toBe(2);
  });

  it('maxAttempts is a ceiling across resumed runs, not per process', async () => {
    const dir = await tempDir();
    const goal = 'bounded across runs';

    const genA = fakeGenerate([patch('a1'), patch('a2'), new Error('crash before attempt 3')]);
    const resultA = await createLoop({
      goal,
      generate: genA.fn,
      check: fakeCheck([false]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();
    expect(resultA.status).toBe('failed');
    expect(resultA.attempts).toBe(2);

    const genB = fakeGenerate([patch('b1')]);
    const resultB = await createLoop({
      goal,
      generate: genB.fn,
      check: fakeCheck([false]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();

    expect(genB.calls).toHaveLength(1); // exactly one attempt left
    expect(resultB.status).toBe('exhausted');
    expect(resultB.reason).toBe('max-attempts');
    expect(resultB.attempts).toBe(3);
  });

  it('starts fresh when the goal changes', async () => {
    const dir = await tempDir();

    const genA = fakeGenerate([patch('a1'), new Error('crash')]);
    await createLoop({
      goal: 'goal A',
      generate: genA.fn,
      check: fakeCheck([false]).fn,
      maxAttempts: 5,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    }).run();

    const { events, onEvent } = collectEvents();
    const resultB = await createLoop({
      goal: 'goal B',
      generate: fakeGenerate([patch('b1')]).fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 5,
      workdir: dir,
      silent: true,
      commit: noopCommit,
      onEvent,
    }).run();

    const reset = events.find((e) => e.type === 'state_reset');
    expect(reset?.type === 'state_reset' && reset.reason).toBe('goal-changed');
    expect(resultB.attempts).toBe(1); // numbering restarted
  });

  it('starts fresh after a previous run finished', async () => {
    const dir = await tempDir();
    const goal = 'run me twice';
    const config = {
      goal,
      maxAttempts: 5,
      workdir: dir,
      silent: true,
      commit: noopCommit,
    };

    await createLoop({
      ...config,
      generate: fakeGenerate([patch('first run')]).fn,
      check: fakeCheck([true]).fn,
    }).run();

    const { events, onEvent } = collectEvents();
    const resultB = await createLoop({
      ...config,
      generate: fakeGenerate([patch('second run')]).fn,
      check: fakeCheck([true]).fn,
      onEvent,
    }).run();

    const reset = events.find((e) => e.type === 'state_reset');
    expect(reset?.type === 'state_reset' && reset.reason).toBe('previous-run-finished');
    const start = events.find((e) => e.type === 'loop_start');
    expect(start?.type === 'loop_start' && start.resumed).toBe(false);
    expect(resultB.attempts).toBe(1);
  });

  it('backs up corrupt state and starts fresh instead of crashing', async () => {
    const dir = await tempDir();
    await fs.mkdir(path.dirname(statePathIn(dir)), { recursive: true });
    await fs.writeFile(statePathIn(dir), '{{{ not json at all', 'utf8');

    const { events, onEvent } = collectEvents();
    const result = await createLoop({
      goal: 'recover',
      generate: fakeGenerate([patch('p')]).fn,
      check: fakeCheck([true]).fn,
      maxAttempts: 3,
      workdir: dir,
      silent: true,
      commit: noopCommit,
      onEvent,
    }).run();

    expect(result.status).toBe('passed');
    const reset = events.find((e) => e.type === 'state_reset');
    expect(reset?.type === 'state_reset' && reset.reason).toBe('corrupt');
    const backups = (await fs.readdir(path.dirname(statePathIn(dir)))).filter((f) =>
      f.includes('.corrupt-'),
    );
    expect(backups.length).toBe(1);
  });
});
