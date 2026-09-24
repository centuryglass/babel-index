/**
 * OpenCode's counterpart to the Claude Code `SessionStart` hook: refreshes
 * the GitHub issue cache (AGENTS.md, "Tracking open work") when OpenCode
 * starts in this repo.
 *
 * OpenCode has no hook whose output becomes session context, so the two
 * halves are split:
 *   - This plugin writes the cache by running `.claude/hooks/session-start.sh`,
 *     which owns the `gh`-or-REST-API choice. Its printed index is discarded.
 *   - `opencode.json`'s `instructions` entry puts `.claude/cache/issues/index.md`
 *     into the system prompt. OpenCode re-reads instruction files on every
 *     model call and skips a missing one.
 *
 * The refresh is not awaited, so a slow or rate-limited fetch never delays
 * startup. Until it finishes, the prompt carries the previous run's cache, or
 * none on a fresh checkout.
 *
 * OpenCode runs plugins under Bun, which loads `.ts` directly; this file is
 * outside `jsconfig.json`'s typecheck scope, so the shell type is local.
 */

type BunShellPromise = Promise<unknown> & {
  cwd(dir: string): BunShellPromise;
  quiet(): BunShellPromise;
  nothrow(): BunShellPromise;
};

type PluginInput = {
  $: (strings: TemplateStringsArray, ...values: unknown[]) => BunShellPromise;
  worktree: string;
};

export const IssueCache = async ({ $, worktree }: PluginInput) => {
  void $`bash .claude/hooks/session-start.sh`.cwd(worktree).quiet().nothrow().catch(() => {});
  return {};
};
