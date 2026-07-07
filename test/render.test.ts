import { describe, expect, it } from 'vitest';
import { createRenderer } from '../src/index.js';
import type { AttemptRecord, LoopEvent } from '../src/index.js';

function record(attempt: number, passed: boolean, summary: string): AttemptRecord {
  return {
    attempt,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    patchSummary: summary,
    filesChanged: ['src/auth/session.ts'],
    claimedDone: false,
    check: {
      passed,
      evidence: passed ? '14 passing' : '3 failing',
      summary: passed ? '14 passing' : '3 failing',
      label: 'npm test',
    },
  };
}

function renderAll(events: LoopEvent[]): string {
  let out = '';
  const render = createRenderer({
    stream: { write: (text: string) => (out += text), isTTY: false },
    color: false,
  });
  for (const event of events) render(event);
  return out;
}

describe('the live renderer (the terminal output is the product)', () => {
  it('draws the loop as a tree and surfaces the rejected "done" claim', () => {
    const out = renderAll([
      {
        type: 'loop_start',
        goal: 'make the tests in src/auth pass',
        maxAttempts: 5,
        workdir: '/repo',
        statePath: '/repo/.ratchet/state.json',
        resumed: false,
        priorAttempts: [],
      },
      { type: 'attempt_start', attempt: 1, maxAttempts: 5 },
      { type: 'generate_start', attempt: 1 },
      { type: 'generate_end', attempt: 1, summary: 'edited src/auth/session.ts', claimsDone: true },
      { type: 'apply_end', attempt: 1, filesChanged: ['src/auth/session.ts'] },
      { type: 'check_start', attempt: 1, label: 'npm test' },
      {
        type: 'check_end',
        attempt: 1,
        result: { passed: false, evidence: '3 failing', summary: '3 failing', label: 'npm test' },
        claimedDone: true,
      },
      { type: 'claim_rejected', attempt: 1, evidence: '3 failing' },
      { type: 'attempt_end', record: record(1, false, 'edited src/auth/session.ts') },
      { type: 'attempt_start', attempt: 2, maxAttempts: 5 },
      { type: 'generate_start', attempt: 2 },
      { type: 'generate_end', attempt: 2, summary: 'fixed expiry comparison', claimsDone: false },
      { type: 'apply_end', attempt: 2, filesChanged: ['src/auth/session.ts'] },
      { type: 'check_start', attempt: 2, label: 'npm test' },
      {
        type: 'check_end',
        attempt: 2,
        result: { passed: true, evidence: '14 passing', summary: '14 passing', label: 'npm test' },
        claimedDone: false,
      },
      { type: 'commit_end', attempt: 2, commit: { sha: 'a1b2c3d4e5f6', branch: 'ratchet/fix' } },
      { type: 'attempt_end', record: record(2, true, 'fixed expiry comparison') },
      {
        type: 'loop_end',
        result: {
          status: 'passed',
          attempts: 2,
          evidence: '14 passing',
          history: [],
          commit: { sha: 'a1b2c3d4e5f6', branch: 'ratchet/fix' },
        },
      },
    ]);

    expect(out).toContain('◆ goal: make the tests in src/auth pass');
    expect(out).toContain('├─ attempt 1/5  ✎ edited src/auth/session.ts');
    expect(out).toContain('✗ 3 failing');
    expect(out).toContain('← model said "done"; check disagreed');
    expect(out).toContain('✓ 14 passing');
    expect(out).toContain('╰─ ✓ goal met in 2 attempts · committed a1b2c3d (ratchet/fix, no push)');
    expect(out).not.toContain('\r'); // no spinner frames off-TTY
  });

  it('recaps restored attempts when resuming', () => {
    const out = renderAll([
      {
        type: 'loop_start',
        goal: 'goal',
        maxAttempts: 5,
        workdir: '/repo',
        statePath: '/repo/.ratchet/state.json',
        resumed: true,
        priorAttempts: [record(1, false, 'tried the token refresh')],
      },
    ]);

    expect(out).toContain('↻ resuming — 1 earlier attempt(s)');
    expect(out).toContain('tried the token refresh');
  });

  it('renders exhaustion with the closest attempt', () => {
    const out = renderAll([
      {
        type: 'loop_end',
        result: {
          status: 'exhausted',
          attempts: 5,
          evidence: '1 failing',
          history: [],
          reason: 'max-attempts',
          closest: record(4, false, 'closest try'),
        },
      },
    ]);

    expect(out).toContain('attempts exhausted after 5 attempts');
    expect(out).toContain('closest: attempt 4');
  });
});
