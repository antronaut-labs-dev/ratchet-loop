# Architecture

This document explains how ratchet-loop is put together and, more importantly,
why it refuses to be more than it is. If you're deciding where a change
belongs, start with [Where features go](#where-features-go).

The library is a single primitive: a bounded **generate → apply → check →
commit** loop where an external, verifiable check — never the model — decides
when the work is done. Everything in `src/` exists to serve that sentence.

## One attempt, end to end

```
load state → generate → apply → check → record to disk
                                  │
                        passed? ──┼── yes → commit (local) → stop
                                  └── no  → failure becomes context for the next generate
```

Concretely, each spin of the loop in [`src/loop.ts`](./src/loop.ts):

1. **Bounds first.** Before any work: stop with `exhausted` if
   `attempts ≥ maxAttempts` or a budget (`usd`, `turns`) is already spent.
   Exhaustion is a first-class result carrying the closest-to-passing attempt.
2. **Generate.** Build a `LoopContext` — goal, full attempt history, the last
   failing check's evidence, optionally a reflection instruction — and call the
   maker. The patch it returns is validated structurally, never semantically:
   the engine has no opinion about its contents.
3. **Apply.** Write the patch to disk (default: `patch.files` under `workdir`,
   path-escape-safe). Swappable for unified-diff appliers etc.
4. **Check.** Run the judge. Its `passed: boolean` is the only signal that can
   stop the loop; its `evidence` is persisted (tail-capped at 8 kB) and fed to
   the next generate.
5. **The stop-hook.** If the patch said `claimsDone: true` and the check
   failed, emit `claim_rejected` — "model said done; check disagreed" — and
   keep going. Nothing the maker returns can end the loop except by making the
   check pass.
6. **Record.** Append the `AttemptRecord` to state and write it to disk
   _before_ the next attempt starts, so a killed process resumes exactly here.
7. **Commit on pass.** A passing check triggers a **local** `git add -A` +
   `git commit` (skipped gracefully outside a repo), the state is marked
   terminal, and the loop returns.

## The five principles

These are the rules the loop-engineering community converged on; each one is
load-bearing in the code, not aspirational.

1. **Verifiable goal.** "Done" is a `check()` returning
   `{ passed, evidence }` — test output, compiler errors — not a vibe. See
   `CheckResult` in [`src/types.ts`](./src/types.ts).
2. **Maker ≠ checker.** `generate` and `check` are separate config inputs, and
   the engine never lets one stand in for the other. The thing that writes the
   code never grades it.
3. **State on disk.** Every attempt is persisted to `.ratchet/state.json` as
   it happens ([`src/state.ts`](./src/state.ts)). The agent forgets between
   runs; the loop doesn't.
4. **Bounded.** A hard `maxAttempts` ceiling plus optional USD/turn budgets,
   all counted across resumed runs — the ceiling is on the _task_, not the
   process.
5. **Stop-hook.** A self-reported "done" never stops the loop. This is the
   soul of the library and its signature test
   ([`test/loop.test.ts`](./test/loop.test.ts)).

## Module map

Eleven small files; the arrows only point one way (helpers never import the
engine, and nothing outside `index.ts` is public).

| Module          | Job                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/loop.ts`   | The engine: orchestrates attempts, owns every stop condition, builds contexts and results                      |
| `src/types.ts`  | The entire public contract — `Patch`, `CheckResult`, `LoopConfig`, `LoopEvent`, … (no runtime code)            |
| `src/state.ts`  | Durable state: versioned schema, validation, corrupt-file quarantine, atomic save                              |
| `src/git.ts`    | Branch/worktree setup and the local-only commit (`commitAll`, `defaultCommit`) — no push exists here           |
| `src/exec.ts`   | Process plumbing: argv-style `git` calls (no shell), a shell runner with timeout + 200 kB output cap, `tail()` |
| `src/apply.ts`  | `defaultApply`: write/delete `patch.files` under `workdir`, rejecting any path that escapes it                 |
| `src/shell.ts`  | `shellCheck`: any command line as a judge (`passed` = exit 0), plus test-runner output summarizing             |
| `src/render.ts` | The live terminal renderer — a pure `LoopEvent` listener, testable against a string buffer                     |
| `src/errors.ts` | `RatchetError` with machine-readable codes (`PATH_ESCAPE`, `GIT_FAILED`, …)                                    |
| `src/cli.ts`    | `ratchet-loop demo`: scaffolds a tiny failing repo and runs the _real_ engine with a scripted maker            |
| `src/index.ts`  | The export surface; if it isn't exported here, it isn't API                                                    |

## Load-bearing invariants

Break one of these and the library stops being what it says it is. All are
test-enforced.

- **The loop can never push.** There is no push code path anywhere in `src/`.
  The option is typed `push?: false`; a runtime guard in `validateConfig`
  rejects truthy values from untyped callers; and a test proves a passing run
  leaves a real remote's refs byte-for-byte untouched. Publishing results
  stays a human decision.
- **Resumable by construction.** State is saved with a temp-file + rename
  (atomic on the same volume) after every attempt, so there is no moment when
  a crash loses history. Resume rules: same goal + `status: "running"` →
  continue with the same attempt numbering and budget totals; changed goal,
  finished run, or corrupt file → fresh state with a `state_reset` event
  saying why (corrupt files are quarantined to `state.json.corrupt-<ts>`, not
  deleted).
- **`failed` stays resumable; `passed`/`exhausted` are terminal.** A `failed`
  result means one of _your_ functions threw — infrastructure, not verdict —
  so the on-disk status remains `running` and a rerun continues. Verdicts
  about the task are final; rerunning starts fresh.
- **The core imports no model provider.** One runtime dependency
  (picocolors, for the renderer). Provider SDKs appear only under
  `/examples`, only as devDependencies.
- **Patches can't escape the workdir.** `defaultApply` resolves every path
  and throws `PATH_ESCAPE` on traversal or absolute paths.
- **Evidence is capped, never truncated from the front.** 200 kB live
  (`runShell`), 8 kB tail persisted per attempt — the end of a test run is
  where the verdict lives.
- **Listeners can't kill the loop.** `onEvent`/renderer exceptions are caught
  and muted after one warning; observability never changes control flow.

## The event stream

Every step emits a typed `LoopEvent` (`loop_start`, `generate_end`,
`check_end`, `claim_rejected`, `bound_reached`, …). The built-in renderer is
just one listener on that stream — `silent: true` removes it, and your
`onEvent` sees exactly what it sees. Anything the terminal shows you is
available programmatically; there is no private telemetry channel.

## Where features go

The question that keeps the core small: **would this feature encode how a
specific product or stack generates or verifies code?**

- _Yes_ → it's an adapter concern. Prompt formats, context strategies,
  provider clients, output validators, retry-on-bad-JSON policies: all live in
  your `generate`/`check`/`apply` functions, with worked examples under
  [`/examples`](./examples).
- _No, it changes what the loop itself guarantees_ (bounds, persistence,
  git safety, the stop-hook) → it's a core proposal. Open a discussion first;
  invariants above are not up for weakening.

The core has no opinion about models because that's the point: `generate` is
any `(ctx) => Promise<Patch>`, and the same engine runs Claude, GPT, a local
model through Ollama, or the scripted maker the demo uses.

## Testing philosophy

The suite (vitest, ubuntu + windows, node 20 + 24) proves the loop's behavior
deterministically — no model, no network:

- Fake makers and fake checks drive the engine through every path: pass on
  first try, exhaust, resume after kill, budget stops, thrown user functions.
- The **signature test**: a maker that claims `claimsDone: true` against a
  check that fails — the suite asserts the loop emits `claim_rejected` and
  continues. If that test ever goes red, the library has lost its reason to
  exist.
- Git safety is tested against real repositories, including a real local
  "remote" whose refs are asserted unchanged after a passing run.
- The CLI demo doubles as the end-to-end test in CI: it runs the actual
  engine against `node --test` and asserts the recorded state captured the
  rejected "done" claim.
