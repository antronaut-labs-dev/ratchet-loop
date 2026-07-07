## Summary

<!-- What does this change, and why? A sentence or two. -->

Closes #<!-- issue number, if any -->

## Checklist

- [ ] `npm run ci` passes locally (build + typecheck + lint + format:check + tests)
- [ ] Engine-behavior changes come with a test that fails without the change
- [ ] Nothing product-specific in core: prompt formats, provider clients, and
      output validators live in adapters under `/examples`
      (see [CONTRIBUTING.md](../CONTRIBUTING.md))
- [ ] Public API changes are reflected in the README, `ARCHITECTURE.md`, and
      a `CHANGELOG.md` line under `Unreleased`
