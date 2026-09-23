# Comment audits

The process for comment and documentation audits, used only when the
maintainer asks for one. `AGENTS.md`'s "Things that will bite you" routes
here, and its conventions still apply.

## Comment and documentation audits

When the maintainer asks for a comment or documentation audit ("run a
comment style audit on this change", "spot-check these comments"), the
audit process and its code-preservation tool live on the
`qwen3.8-flash-comment-fix` branch, not `main`. Pull them in, do the pass,
and remove them before committing.

Fetch the branch if needed (`git fetch origin qwen3.8-flash-comment-fix`),
then copy four files to their real paths so the plan's cross-references
resolve:

```sh
git show qwen3.8-flash-comment-fix:docs/comment-refactor-plan.md > docs/comment-refactor-plan.md
git show qwen3.8-flash-comment-fix:docs/claude_critique.md > docs/claude_critique.md
git show qwen3.8-flash-comment-fix:tools/comment-check/check.mjs > tools/comment-check/check.mjs
git show qwen3.8-flash-comment-fix:tools/comment-check/strip.mjs > tools/comment-check/strip.mjs
```

- `docs/comment-refactor-plan.md` is the process: the tell-and-move table,
  the spot-check workflow (its §3), and the verifier's contract (its §4).
  Read it first.
- `docs/claude_critique.md` is the diagnosis behind those tells, with
  evidence. Read it when a judgment call needs the reasoning.
- `tools/comment-check/check.mjs` imports `typescript-classic` from a
  gitignored `tools/comment-check/node_modules`. If that install is missing,
  pull the directory's `package.json` and run
  `npm --prefix tools/comment-check install`, or use the plan's §4 esbuild
  fallback (weaker: it can't see a type-only change). Don't pull
  `strip.test.mjs`; `npm test` picks it up and it fails without that
  install.

Rewrite comment text only, scoped to the sections the change or request
touched plus comments a fix makes untrue. Then prove no code moved:

```sh
node tools/comment-check/check.mjs <file>...              # working tree vs HEAD
node tools/comment-check/check.mjs --base <rev> <file>...  # vs another revision
```

- Every edited file must report `OK (comment-only)` or `clean (unchanged)`.
  A `-/+` listing of code lines means code moved; fix it before committing.
- `check.mjs` parses JS/TS/CSS/HTML only. For `.md` edits, confirm from
  `git diff` that only prose changed.
- `npm test`, `npm run typecheck` and `npm run lint` still apply.
- When done, delete the four pulled files (and any nested install), and
  stage only the real edits by explicit path.
