/**
 * The canonical ratchet-loop: point any model at a repo with failing tests and
 * let the real test runner decide when it's done.
 *
 *   npx tsx examples/fix-failing-tests.ts [repo-dir] ["goal"]
 *
 * Maker selection (the loop itself never changes):
 *   ANTHROPIC_API_KEY set → Claude
 *   OPENAI_API_KEY set    → OpenAI (or any compatible endpoint via baseURL)
 *   neither               → local model via Ollama
 */
import { createLoop, shellCheck } from 'ratchet-loop';
import { anthropicGenerate } from './anthropic.js';
import { localGenerate } from './local.js';
import { openaiGenerate } from './openai.js';

const workdir = process.argv[2] ?? process.cwd();
const goal = process.argv[3] ?? 'make `npm test` pass';

const generate =
  process.env['ANTHROPIC_API_KEY'] !== undefined
    ? anthropicGenerate()
    : process.env['OPENAI_API_KEY'] !== undefined
      ? openaiGenerate()
      : localGenerate();

const result = await createLoop({
  goal,
  generate, // the maker: swappable, untrusted
  check: shellCheck('npm test', { timeoutMs: 300_000 }), // the judge: your real tests
  maxAttempts: 5,
  budget: { turns: 8 },
  workdir,
  git: { branch: 'ratchet/fix' }, // commits land here; never pushed
  reflect: true,
}).run();

process.exitCode = result.status === 'passed' ? 0 : 1;
