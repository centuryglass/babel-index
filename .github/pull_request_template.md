<!--
This repo squash-merges, so the PR title becomes the commit on main -
release-please reads only that title to decide the next version and write
CHANGELOG.md (pr-title-lint.yml enforces the format below; AGENTS.md has the
full rationale). The description below is for reviewers, not for release
notes.

Title format: `<type>[!]: <summary>`, e.g. `fix: correct off-by-one in
catalog paging` or `feat!: drop the v0 search endpoint`.

  type    what it means for CHANGELOG.md / the version bump
  feat    a new capability                    -> minor
  fix     a bug fix                           -> patch
  perf    a performance improvement           -> patch
  docs    documentation only                  -> no bump
  style   formatting, no behavior change      -> no bump
  refactor  no behavior change                -> no bump
  test    tests only                          -> no bump
  build   build/tooling/dependencies          -> no bump
  ci      CI/workflow changes                 -> no bump
  chore   anything else with no release value -> no bump
  revert  reverts a previous commit           -> patch

Add `!` right after the type (before any `:`) for a breaking change -> major.
Since only the title survives the squash, that `!` is the one place to mark
it; a `BREAKING CHANGE:` footer in the PR description will not be seen.
-->

## What changed and why

## Testing

<!-- What you ran: npm test / lint / typecheck / test:e2e, or why not applicable. -->
