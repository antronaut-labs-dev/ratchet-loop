import { describe, expect, it } from 'vitest';
import { createLoop, RatchetError } from '../src/index.js';
import type { GitOptions, LoopConfig, Patch } from '../src/index.js';
import { collectEvents, fakeCheck, fakeGenerate, noopCommit, tempDir } from './helpers.js';

const patch = (summary: string, extra: Partial<Patch> = {}): Patch => ({ summary, ...extra });

async function baseConfig(): Promise<Pick<LoopConfig, 'workdir' | 'silent' | 'commit'>> {
  return { workdir: await tempDir(), silent: true, commit: noopCommit };
}

describe('the check is the judge', () => {
  it('stops the moment the check passes', async () => {
    const gen = fakeGenerate([patch('fix the bug')]);
    const chk = fakeCheck([{ passed: true, evidence: '14 passing' }]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'make the tests pass',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
    }).run();

    expect(result.status).toBe('passed');
    expect(result.attempts).toBe(1);
    expect(result.evidence).toBe('14 passing');
    expect(gen.calls).toHaveLength(1);
    expect(chk.calls).toHaveLength(1);
  });

  it('retries while the check fails, feeding the failure back to the maker', async () => {
    const gen = fakeGenerate([patch('try 1'), patch('try 2'), patch('try 3')]);
    const chk = fakeCheck([
      { passed: false, evidence: '3 failing: token refresh' },
      { passed: false, evidence: '1 failing: expiry comparison' },
      { passed: true, evidence: '14 passing' },
    ]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'make the tests pass',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
    }).run();

    expect(result.status).toBe('passed');
    expect(result.attempts).toBe(3);
    expect(gen.calls).toHaveLength(3);

    // The maker sees exactly what the judge said last time.
    expect(gen.calls[0]?.lastFailure).toBeUndefined();
    expect(gen.calls[1]?.lastFailure?.evidence).toBe('3 failing: token refresh');
    expect(gen.calls[1]?.history).toHaveLength(1);
    expect(gen.calls[2]?.lastFailure?.evidence).toBe('1 failing: expiry comparison');
    expect(gen.calls[2]?.history).toHaveLength(2);
    expect(result.history.map((r) => r.check.passed)).toEqual([false, false, true]);
  });

  it('SIGNATURE — keeps looping when the model claims done but the check disagrees', async () => {
    const gen = fakeGenerate([
      patch('everything already looks correct', { claimsDone: true }),
      patch('actually fix the expiry comparison'),
    ]);
    const chk = fakeCheck([
      { passed: false, evidence: '3 failing' },
      { passed: true, evidence: '14 passing' },
    ]);
    const { events, onEvent } = collectEvents();

    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'make the tests pass',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
      onEvent,
    }).run();

    // The self-reported "done" did not stop the loop.
    expect(result.status).toBe('passed');
    expect(result.attempts).toBe(2);
    expect(gen.calls).toHaveLength(2);

    // The moment is surfaced, and in the right order: verdict → rejection → next attempt.
    const rejected = events.find((e) => e.type === 'claim_rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.type === 'claim_rejected' && rejected.attempt).toBe(1);
    const iVerdict = events.findIndex((e) => e.type === 'check_end' && e.attempt === 1);
    const iRejected = events.findIndex((e) => e.type === 'claim_rejected');
    const iNext = events.findIndex((e) => e.type === 'attempt_start' && e.attempt === 2);
    expect(iVerdict).toBeGreaterThanOrEqual(0);
    expect(iRejected).toBeGreaterThan(iVerdict);
    expect(iNext).toBeGreaterThan(iRejected);
    expect(result.history[0]?.claimedDone).toBe(true);
  });

  it('a truthful claimsDone passes without a claim_rejected event', async () => {
    const gen = fakeGenerate([patch('already done, honestly', { claimsDone: true })]);
    const chk = fakeCheck([{ passed: true, evidence: 'all green' }]);
    const { events, onEvent } = collectEvents();

    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'make the tests pass',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 3,
      onEvent,
    }).run();

    expect(result.status).toBe('passed');
    expect(events.some((e) => e.type === 'claim_rejected')).toBe(false);
  });
});

describe('bounded (exhaustion is a result, not an infinite loop)', () => {
  it('exhausts at maxAttempts with full history and the highest-scoring attempt as closest', async () => {
    const gen = fakeGenerate([patch('a'), patch('b'), patch('c')]);
    const chk = fakeCheck([
      { passed: false, evidence: 'far off', score: 0.2 },
      { passed: false, evidence: 'nearly there', score: 0.9 },
      { passed: false, evidence: 'regressed', score: 0.5 },
    ]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'unreachable goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 3,
    }).run();

    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('max-attempts');
    expect(result.attempts).toBe(3);
    expect(result.history).toHaveLength(3);
    expect(result.closest?.attempt).toBe(2);
    expect(result.evidence).toBe('nearly there');
    expect(gen.calls).toHaveLength(3);
  });

  it('closest defaults to the last attempt when checks carry no scores', async () => {
    const gen = fakeGenerate([patch('a')]);
    const chk = fakeCheck([false]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'unreachable goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 2,
    }).run();

    expect(result.status).toBe('exhausted');
    expect(result.closest?.attempt).toBe(2);
  });

  it('stops at budget.turns before maxAttempts', async () => {
    const gen = fakeGenerate([patch('a')]);
    const chk = fakeCheck([false]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'unreachable goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 10,
      budget: { turns: 2 },
    }).run();

    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('budget-turns');
    expect(result.attempts).toBe(2);
  });

  it('stops at budget.usd accumulated from patch costs', async () => {
    const gen = fakeGenerate([patch('a', { cost: { usd: 0.6 } })]);
    const chk = fakeCheck([false]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'unreachable goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 10,
      budget: { usd: 1.0 },
    }).run();

    expect(result.status).toBe('exhausted');
    expect(result.reason).toBe('budget-usd');
    expect(result.attempts).toBe(2); // 0.6 after 1, 1.2 after 2 → third attempt never starts
  });
});

describe('failures are results, and stay resumable', () => {
  it("returns 'failed' when generate throws, keeping completed attempts", async () => {
    const gen = fakeGenerate([patch('try 1'), new Error('boom: simulated crash')]);
    const chk = fakeCheck([false]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
    }).run();

    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toBeInstanceOf(RatchetError);
    expect((result.error as RatchetError).code).toBe('GENERATE_FAILED');
    expect(String((result.error as RatchetError).message)).toContain('boom');
  });

  it("returns 'failed' when the check itself throws (a broken judge is not a failed check)", async () => {
    const gen = fakeGenerate([patch('try 1')]);
    const chk = fakeCheck([new Error('judge exploded')]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
    }).run();

    expect(result.status).toBe('failed');
    expect((result.error as RatchetError).code).toBe('CHECK_THREW');
  });
});

describe('reflect', () => {
  it('asks the maker for a self-critique after a failed check and records it', async () => {
    const gen = fakeGenerate([
      patch('try 1'),
      patch('try 2', { reflection: 'compared the wrong field; now comparing expiry' }),
    ]);
    const chk = fakeCheck([{ passed: false, evidence: 'expiry mismatch' }, true]);
    const result = await createLoop({
      ...(await baseConfig()),
      goal: 'goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
      reflect: true,
    }).run();

    expect(gen.calls[0]?.reflection).toBeUndefined();
    expect(gen.calls[1]?.reflection).toContain('Attempt 1 failed');
    expect(gen.calls[1]?.reflection).toContain('expiry mismatch');
    expect(result.history[1]?.reflection).toBe('compared the wrong field; now comparing expiry');
  });
});

describe('config validation', () => {
  const valid = {
    goal: 'g',
    generate: (): Promise<Patch> => Promise.resolve({ summary: 's' }),
    check: (): Promise<{ passed: boolean; evidence: string }> =>
      Promise.resolve({ passed: true, evidence: '' }),
    maxAttempts: 1,
  };

  it('rejects git.push at runtime, even for untyped callers', () => {
    expect(() =>
      createLoop({ ...valid, git: { push: true } as unknown as GitOptions }),
    ).toThrowError(/never pushes/);
  });

  it('rejects a non-positive maxAttempts', () => {
    expect(() => createLoop({ ...valid, maxAttempts: 0 })).toThrowError(RatchetError);
  });

  it('rejects a missing goal', () => {
    expect(() => createLoop({ ...valid, goal: '  ' })).toThrowError(/goal/);
  });
});

describe('event stream', () => {
  it('emits a coherent typed sequence for a fail-then-pass run', async () => {
    const gen = fakeGenerate([patch('try 1'), patch('try 2')]);
    const chk = fakeCheck([false, true]);
    const { events, onEvent } = collectEvents();

    await createLoop({
      ...(await baseConfig()),
      goal: 'goal',
      generate: gen.fn,
      check: chk.fn,
      maxAttempts: 5,
      onEvent,
    }).run();

    expect(events.map((e) => e.type)).toEqual([
      'loop_start',
      'attempt_start',
      'generate_start',
      'generate_end',
      'apply_end',
      'check_start',
      'check_end',
      'attempt_end',
      'attempt_start',
      'generate_start',
      'generate_end',
      'apply_end',
      'check_start',
      'check_end',
      'attempt_end',
      'loop_end',
    ]);
  });
});
