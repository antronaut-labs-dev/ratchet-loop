# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0: minor versions may contain breaking changes, called out here).

## [Unreleased]

## [0.1.0] - 2026-07-04

### Added

- `createLoop` — a bounded generate → apply → check → commit loop where an
  external `check()` (never the model) decides when the work is done.
- The stop-hook: when a patch claims `claimsDone: true` and the check fails,
  the loop emits `claim_rejected` ("model said done; check disagreed") and
  keeps going.
- `shellCheck(command, opts?)` — turn any command line into a judge:
  `passed` = exit 0, `evidence` = real merged output, with timeout support and
  test-runner-aware one-line summaries (`summarizeCheckOutput`).
- Durable, resumable state at `.ratchet/state.json`: atomic writes after every
  attempt, corrupt-file quarantine, continuous attempt numbering and budget
  totals across resumed runs.
- Bounds: hard `maxAttempts` plus optional `budget.usd` / `budget.turns`;
  exhaustion is a first-class result carrying the closest-to-passing attempt.
- Git safety: local commit on pass, optional dedicated branch
  (`git.branch`) and `git worktree` isolation (`git.worktree`), and **no push
  code path** — `push` is typed `false` and rejected at runtime.
- `defaultApply` — writes/deletes `patch.files` under the workdir and rejects
  any path that escapes it (`PATH_ESCAPE`).
- A typed `LoopEvent` stream (`onEvent`) and `createRenderer`, the live
  terminal view attached by default.
- `RatchetError` with machine-readable codes; `failed` results stay resumable.
- `npx ratchet-loop demo` — scaffolds a tiny repo with failing tests and runs
  the real engine with a scripted maker (no API key needed).
- Example adapters under `/examples`: Anthropic (with real USD cost
  reporting), OpenAI-compatible endpoints via `baseURL`, local models through
  Ollama, and the canonical fix-failing-tests loop.
- Dual ESM/CJS build with type declarations; strict TypeScript, zero `any`;
  one runtime dependency (picocolors); tested on ubuntu + windows, node 20 + 24.

[unreleased]: https://github.com/antronaut-labs-dev/ratchet-loop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/antronaut-labs-dev/ratchet-loop/releases/tag/v0.1.0
