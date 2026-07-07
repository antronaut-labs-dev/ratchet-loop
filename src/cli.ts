#!/usr/bin/env node
/**
 * ratchet-loop CLI.
 *
 * `ratchet-loop demo` scaffolds a tiny repo with deliberately failing tests
 * and runs the loop live with a scripted maker (no API key, no install): the
 * model claims "done" on attempt 1, the check disagrees, the loop keeps going
 * until the tests are actually green — then commits.
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import pc from 'picocolors';
import { gitOrThrow } from './exec.js';
import { createLoop } from './loop.js';
import { shellCheck } from './shell.js';
import type { GenerateFn, Patch } from './types.js';

const require = createRequire(import.meta.url);

function version(): string {
  const pkg = require('../package.json') as { version: string };
  return pkg.version;
}

const MATHY_BUGGY = `export function add(a, b) {
  return a - b;
}

export function clamp(value, lo, hi) {
  return Math.max(value, lo);
}
`;

const MATHY_ADD_FIXED = `export function add(a, b) {
  return a + b;
}

export function clamp(value, lo, hi) {
  return Math.max(value, lo);
}
`;

const MATHY_ALL_FIXED = `export function add(a, b) {
  return a + b;
}

export function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}
`;

const MATHY_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add, clamp } from './mathy.js';

test('add adds', () => assert.equal(add(2, 3), 5));
test('add identity', () => assert.equal(add(7, 0), 7));
test('clamp respects the lower bound', () => assert.equal(clamp(-1, 0, 10), 0));
test('clamp respects the upper bound', () => assert.equal(clamp(99, 0, 10), 10));
`;

/** The scripted maker: a stand-in for any model, indexed by attempt number. */
const DEMO_PATCHES: Patch[] = [
  {
    summary: 'reviewed the helpers — everything already looks correct',
    claimsDone: true,
  },
  {
    summary: 'fix add(): use + instead of -',
    files: [{ path: 'mathy.js', contents: MATHY_ADD_FIXED }],
  },
  {
    summary: 'clamp(): bound the top end with Math.min',
    files: [{ path: 'mathy.js', contents: MATHY_ALL_FIXED }],
  },
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function scaffoldDemoRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'ratchet-demo-app', private: true, type: 'module', scripts: { test: 'node --test' } },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await fs.writeFile(path.join(dir, '.gitignore'), '.ratchet/\nnode_modules/\n', 'utf8');
  await fs.writeFile(path.join(dir, 'mathy.js'), MATHY_BUGGY, 'utf8');
  await fs.writeFile(path.join(dir, 'mathy.test.js'), MATHY_TESTS, 'utf8');

  await gitOrThrow(['init', '-q'], dir);
  await gitOrThrow(['config', 'user.name', 'ratchet demo'], dir);
  await gitOrThrow(['config', 'user.email', 'demo@ratchet.local'], dir);
  await gitOrThrow(['config', 'commit.gpgsign', 'false'], dir);
  await gitOrThrow(['add', '-A'], dir);
  await gitOrThrow(['commit', '-q', '-m', 'red: demo starts with failing tests'], dir);
}

async function demo(args: string[]): Promise<number> {
  let dir = path.resolve('ratchet-demo');
  let force = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--force') force = true;
    else if (arg === '--dir') {
      const value = args[i + 1];
      if (value === undefined) {
        console.error(pc.red('--dir requires a path'));
        return 1;
      }
      dir = path.resolve(value);
      i += 1;
    } else if (arg?.startsWith('--dir=')) {
      dir = path.resolve(arg.slice('--dir='.length));
    } else {
      console.error(pc.red(`unknown flag for demo: ${arg ?? ''}`));
      return 1;
    }
  }

  const exists = await fs.stat(dir).then(
    () => true,
    () => false,
  );
  if (exists) {
    if (!force) {
      console.error(pc.red(`${dir} already exists — pass --force to recreate it`));
      return 1;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log(pc.bold(`\n▶ ratchet-loop demo`));
  console.log(
    pc.dim(
      `  Scaffolding a tiny repo with deliberately failing tests in ${path.relative(process.cwd(), dir) || dir}.\n` +
        `  A scripted maker (no API key needed) stands in for the model.\n` +
        `  Watch attempt 1: the "model" claims it's done. The check is the judge.\n`,
    ),
  );
  await scaffoldDemoRepo(dir);

  const pace = process.stdout.isTTY ? 900 : 0;
  const generate: GenerateFn = async (ctx) => {
    await sleep(pace);
    const patch = DEMO_PATCHES[Math.min(ctx.attempt, DEMO_PATCHES.length) - 1];
    return patch ?? { summary: 'no further ideas', claimsDone: false };
  };

  const result = await createLoop({
    goal: 'make `node --test` pass in the demo repo',
    generate,
    check: shellCheck('node --test', { timeoutMs: 120_000 }),
    maxAttempts: 5,
    workdir: dir,
    git: { branch: 'ratchet/demo' },
  }).run();

  if (result.status === 'passed') {
    const rel = path.relative(process.cwd(), dir) || dir;
    console.log(
      `\n${pc.bold('The check decided "done" — the model never did.')} Attempt 1 claimed success;\n` +
        `the loop ignored it and kept working until the tests were actually green.\n\n` +
        `  ${pc.dim('state ')}  ${path.join(rel, '.ratchet', 'state.json')}  ${pc.dim('(kill a run mid-flight; it resumes)')}\n` +
        `  ${pc.dim('commit')}  git -C ${rel} log --oneline ratchet/demo\n` +
        `  ${pc.dim('next  ')}  bring your own model — see the examples/ directory in the repo\n`,
    );
    return 0;
  }
  return 1;
}

function help(): void {
  console.log(`
${pc.bold('ratchet-loop')} v${version()} — the agent loop that doesn't trust "I'm done."

${pc.bold('Usage')}
  ratchet-loop demo [--dir <path>] [--force]   run the 30-second live demo
  ratchet-loop --version                       print the version
  ratchet-loop --help                          this text

${pc.bold('Library')}
  import { createLoop, shellCheck } from 'ratchet-loop';
`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'demo':
      process.exitCode = await demo(rest);
      break;
    case '--version':
    case '-v':
      console.log(version());
      break;
    case '--help':
    case '-h':
    case undefined:
      help();
      break;
    default:
      help();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
