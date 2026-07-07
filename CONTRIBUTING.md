# Contributing to ratchet-loop

Thanks for helping! ratchet-loop is deliberately small: a bounded
generate → apply → check → commit loop where an external check — never the
model — decides when the work is done. Contributions that keep it small are
the most welcome kind.

- **Found a bug?** Open an [issue](https://github.com/antronaut-labs-dev/ratchet-loop/issues)
  with a minimal reproduction (`.ratchet/state.json` is often the best evidence).
- **Have a question or an idea?** Start a
  [discussion](https://github.com/antronaut-labs-dev/ratchet-loop/discussions).
- **Want to send code?** Read on — it's a short read.

## What belongs in core (please read before proposing features)

The core is a loop engine and nothing else. The rule that protects it:

> If a feature would encode _how a specific product or stack generates or
> verifies code_ — a prompt format, a context strategy, a provider client, an
> output validator — it belongs in an **adapter under [`/examples`](./examples)**,
> not in core.

`generate` and `check` are black boxes you supply; the core imports no LLM
provider and ships exactly one runtime dependency (picocolors). New example
adapters are very welcome. New core options need a strong reason to exist.

Two invariants are non-negotiable and test-enforced:

1. **The loop can never push.** There is no push code path; don't add one.
2. **A self-reported "done" never stops the loop.** Only the check can.

## Prerequisites

- **Node.js ≥ 20** (CI runs 20 and 24, on ubuntu and windows)
- **git** on your PATH (the engine shells out to it; some tests create real repos)

## Setup

```sh
git clone https://github.com/antronaut-labs-dev/ratchet-loop.git
cd ratchet-loop
npm install
npm run ci   # the full gate — should be green before you change anything
```

## The `npm run ci` gate

Every PR must pass `npm run ci`, which is exactly what CI runs:

| Step                   | What it does                                            |
| ---------------------- | ------------------------------------------------------- |
| `npm run build`        | tsup → dual ESM/CJS + type declarations in `dist/`      |
| `npm run typecheck`    | `tsc --noEmit`, strict mode, zero `any`                 |
| `npm run lint`         | eslint (typescript-eslint, type-checked rules)          |
| `npm run format:check` | prettier — run `npm run format` to fix                  |
| `npm test`             | vitest, deterministic, no model and no network involved |

Useful while developing:

```sh
npm run test:watch   # vitest in watch mode
npm run demo         # build + run the scripted end-to-end demo locally
```

## Making a change

1. Create a branch: `git switch -c fix/short-description`.
2. Make the change. **Engine-behavior changes need a test** that fails without
   the change — the whole library is proven by deterministic tests with no
   model anywhere, and it stays that way. Never weaken an existing test.
3. Run `npm run format`, then `npm run ci`.
4. Stage files explicitly — `git add src/loop.ts test/loop.test.ts` — rather
   than `git add .`, so nothing accidental rides along.
5. Commit using [conventional commits](https://www.conventionalcommits.org):
   `fix: resume budget totals after a crash`, `feat: …`, `docs: …`, `test: …`.
6. Push to your fork and open a pull request. The PR template asks you to
   confirm the gate passed and to link the issue it closes.

Small, focused PRs get reviewed fastest. If a change is large or reshapes the
API, open a discussion first so nobody builds in the wrong direction.

## Docs

If a change alters the public API, update the README's API section and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) in the same PR. `CHANGELOG.md` follows
[Keep a Changelog](https://keepachangelog.com); add a line under `Unreleased`.

## Code of conduct

Everyone interacting in this project's spaces is expected to follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).
