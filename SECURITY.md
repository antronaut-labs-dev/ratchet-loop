# Security Policy

## What ratchet-loop actually does (the honest surface)

Be clear-eyed about what this library is before deciding how to run it:

- **It executes shell commands.** `shellCheck('npm test')` runs that command
  line through your shell, and any custom `check`/`generate`/`commit` you
  supply runs with your process's privileges. The engine also shells out to
  `git` (argv-style, no shell interpolation).
- **It writes model-generated files to disk.** The default `apply` writes
  whatever the maker returned under the loop's `workdir`.
- **Your check usually executes the code the model just wrote.** Running
  `npm test` on a patched repo _is_ executing model output. Treat a loop over
  an untrusted or weakly-supervised maker the way you'd treat running untrusted
  code: prefer `git: { worktree: true }`, a container, or CI; set
  `maxAttempts` and a `budget`.

## Safety properties you can rely on

These are enforced in code and covered by the test suite:

- **Patches cannot escape the workdir.** The default `apply` resolves every
  path and rejects any that lands outside `workdir` (`PATH_ESCAPE`), including
  `../` traversal and absolute paths.
- **The loop can never `git push`.** There is no push code path in the
  library. The option is typed `push?: false`, a runtime guard rejects truthy
  values from untyped callers, and a test asserts a passing run leaves a real
  remote's refs byte-for-byte untouched. Publishing results stays a human
  decision.
- **State writes are atomic** (temp file + rename), and corrupt state files
  are backed up and replaced rather than trusted.

A bug that breaks any of these properties is a security vulnerability — please
report it privately.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability.

- Preferred: [open a private security advisory](https://github.com/antronaut-labs-dev/ratchet-loop/security/advisories/new)
  (GitHub → Security → "Report a vulnerability").
- Or email **antronautlabs@gmail.com** with a description and, if you can, a
  minimal reproduction.

You'll get an acknowledgement within 7 days. Once the report is confirmed,
we'll agree on a disclosure timeline with you, ship a fix, and credit you in
the release notes unless you'd rather stay anonymous.

## Supported versions

| Version        | Supported                   |
| -------------- | --------------------------- |
| latest `0.x`   | ✅ fixes land here          |
| older releases | ❌ please upgrade to latest |
