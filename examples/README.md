# Examples

The core of `ratchet-loop` imports **no** LLM provider — a maker is just an async
function `(ctx) => Patch`. These adapters show how thin that boundary is.

| File                                             | What it is                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [`fix-failing-tests.ts`](./fix-failing-tests.ts) | The canonical loop: any model vs. `npm test`                                                                         |
| [`anthropic.ts`](./anthropic.ts)                 | Claude via the official `@anthropic-ai/sdk` (structured outputs)                                                     |
| [`openai.ts`](./openai.ts)                       | OpenAI **and any OpenAI-compatible endpoint** — Kimi, GLM, Gemini-compat, together.ai, local servers — via `baseURL` |
| [`local.ts`](./local.ts)                         | A local model through Ollama's native API (no key, no cloud)                                                         |
| [`shared.ts`](./shared.ts)                       | Toy prompt builder + strict patch JSON schema + defensive parser                                                     |

## Run the canonical example

```sh
git clone <a repo with failing tests> target-repo

# with Claude
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/fix-failing-tests.ts ./target-repo

# with OpenAI (or any compatible provider — set baseURL in openai.ts)
OPENAI_API_KEY=sk-... npx tsx examples/fix-failing-tests.ts ./target-repo

# fully local
ollama pull qwen2.5-coder
npx tsx examples/fix-failing-tests.ts ./target-repo
```

The loop writes durable state to `<repo>/.ratchet/state.json` (kill it mid-run
and rerun to resume), commits on the `ratchet/fix` branch when the tests go
green, and never pushes.

## Notes

- The context strategy in `shared.ts` (snapshot the whole small repo into the
  prompt) is deliberately toy-grade. Replace `buildPrompt` with your own
  retrieval for real codebases — the loop doesn't care.
- `anthropic.ts` reports real USD cost per patch via `Patch.cost`, so
  `budget: { usd: 2 }` in the loop config is enforced against actual spend.
- Provider SDKs appear only in this directory and only as devDependencies.
  `npm install ratchet-loop` pulls exactly one runtime dependency (picocolors).
