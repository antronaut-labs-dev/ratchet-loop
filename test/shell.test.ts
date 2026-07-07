import { describe, expect, it } from 'vitest';
import { shellCheck, summarizeCheckOutput } from '../src/index.js';
import type { CheckContext } from '../src/index.js';
import { tempDir } from './helpers.js';

async function ctx(): Promise<CheckContext> {
  return {
    goal: 'g',
    attempt: 1,
    maxAttempts: 1,
    workdir: await tempDir(),
    history: [],
    patch: { summary: 's' },
  };
}

describe('shellCheck', () => {
  it('passes on exit 0 and captures real output as evidence', async () => {
    const check = shellCheck(`node -e "console.log('4 passing')"`);
    const result = await check(await ctx());
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain('4 passing');
    expect(result.summary).toBe('4 passing');
    expect(result.label).toBe(`node -e "console.log('4 passing')"`);
    expect(check.label).toBeDefined();
  });

  it('fails on a nonzero exit with the output preserved', async () => {
    const check = shellCheck(`node -e "console.error('2 failing'); process.exit(1)"`, {
      label: 'npm test',
    });
    const result = await check(await ctx());
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('2 failing');
    expect(result.summary).toBe('2 failing');
    expect(result.label).toBe('npm test');
  });
});

describe('summarizeCheckOutput', () => {
  it('reads node --test TAP counts', () => {
    expect(summarizeCheckOutput('# tests 4\n# pass 2\n# fail 2', 1)).toBe('2 failing');
    expect(summarizeCheckOutput('# tests 4\n# pass 4\n# fail 0', 0)).toBe('4 passing');
  });

  it('reads mocha/vitest style counts', () => {
    expect(summarizeCheckOutput('  3 passing\n  1 failing', 1)).toBe('1 failing');
    expect(summarizeCheckOutput('Tests  2 failed | 3 passed', 1)).toBe('2 failing');
    expect(summarizeCheckOutput('  14 passing (32ms)', 0)).toBe('14 passing');
  });

  it('falls back to the last line, then the exit code', () => {
    expect(summarizeCheckOutput('error: something exploded', 2)).toBe('error: something exploded');
    expect(summarizeCheckOutput('', 0)).toBe('passed');
    expect(summarizeCheckOutput('', 3)).toBe('exit 3');
  });
});
