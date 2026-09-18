/**
 * Pure parsing/resolution for `docs/file_map.md`'s bullet list into the set
 * of paths it documents - no filesystem access, so it can be unit-tested
 * against small fixture strings. `index.ts` is the impure half: it walks
 * the real repo tree and diffs it against what this resolves.
 *
 * The map's bullets are three-level indentation (0/2/4 spaces), each line
 * starting with its path in backticks right after the `-`/`*` marker
 * (`AGENTS.md`'s Layout section documents the convention). A nested
 * bullet's path is relative to its nearest ancestor - normally the
 * ancestor's own path (a directory), but when the ancestor's last path
 * segment has a file extension (`tools/embed/cosine-range.ts` listing
 * `cosine-stats.ts` as a related sibling, not something inside it) it's
 * relative to the ancestor's *directory* instead. That is a fact about how
 * the map is written, not a filesystem check, which is why this file never
 * touches disk to decide it.
 */

export interface DocBullet {
  /** Leading-space count; 0/2/4 in the current map. */
  indent: number;
  /** One or more backtick-quoted paths on this bullet's own line, as written. */
  paths: string[];
}

export interface DocLeaf {
  /** Fully resolved, repo-root-relative path. */
  path: string;
  /**
   * True when the path's own last segment has no file extension (or it was
   * written with a trailing slash) - a directory by the map's own
   * convention. `index.ts` decides what that means on disk (an opaque
   * directory covers everything under it; a missing one is an error).
   */
  looksLikeDirectory: boolean;
}

const BULLET_RE = /^( *)[*-] (.+)$/;
const LEADING_PATHS_RE = /^(`[^`]+`(?:\s*\/\s*`[^`]+`)*)\s*:/;

function hasExtension(segment: string): boolean {
  const lastDot = segment.lastIndexOf('.');
  // A dot at position 0 alone is a dotfile name, not an extension
  // (`.gitignore`), unless there's a second dot further in
  // (`.release-please-manifest.json`).
  return lastDot > 0;
}

/** Extract the leading backtick-quoted path(s) from one bullet's own text. */
export function extractBullets(markdown: string): DocBullet[] {
  const bullets: DocBullet[] = [];
  for (const line of markdown.split('\n')) {
    const bulletMatch = BULLET_RE.exec(line);
    if (!bulletMatch) continue;
    const [, indentStr, rest] = bulletMatch;
    const pathsMatch = LEADING_PATHS_RE.exec(rest);
    if (!pathsMatch) continue;
    const paths = [...pathsMatch[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    bullets.push({ indent: indentStr.length, paths });
  }
  return bullets;
}

interface StackEntry {
  indent: number;
  /** Base directory a child's raw path resolves against. */
  childBase: string;
}

/**
 * Resolve every bullet's raw path(s) to repo-root-relative paths, and
 * return only the leaves (bullets with no nested bullets beneath them) -
 * an interior bullet with children contributes no path of its own, since
 * the map's convention is that its children are the documentation, not it.
 */
export function resolveDocumentedPaths(bullets: DocBullet[]): DocLeaf[] {
  const leaves: DocLeaf[] = [];
  // childBase for the implicit root: raw top-level paths are already
  // repo-root-relative, so joining against '' is a no-op.
  const stack: StackEntry[] = [{ indent: -1, childBase: '' }];

  for (let i = 0; i < bullets.length; i++) {
    const bullet = bullets[i];
    while (stack.length > 1 && stack[stack.length - 1].indent >= bullet.indent) {
      stack.pop();
    }
    const base = stack[stack.length - 1].childBase;

    const resolved = bullet.paths.map((raw) => {
      const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
      const full = base ? `${base}/${trimmed}` : trimmed;
      return { full, rawLastSegment: trimmed.split('/').pop() ?? trimmed, trailingSlash: raw.endsWith('/') };
    });

    const next = bullets[i + 1];
    const hasChildren = next !== undefined && next.indent > bullet.indent;

    if (hasChildren) {
      // Only meaningful for a single-path bullet; push its own resolved
      // path as the base children resolve against.
      const only = resolved[0];
      const parentIsFile = hasExtension(only.rawLastSegment);
      // A directory bullet with children is documented by those children,
      // not itself. A file bullet with children (`cosine-range.ts` listing
      // `cosine-stats.ts` as a related sibling) is still a real file in its
      // own right and stays documented too.
      if (parentIsFile) {
        leaves.push({ path: only.full, looksLikeDirectory: false });
      }
      const childBase = parentIsFile ? dirname(only.full) : only.full;
      stack.push({ indent: bullet.indent, childBase });
    } else {
      for (const r of resolved) {
        leaves.push({
          path: r.full,
          looksLikeDirectory: r.trailingSlash || !hasExtension(r.rawLastSegment),
        });
      }
    }
  }

  return leaves;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

export function parseFileMap(markdown: string): DocLeaf[] {
  return resolveDocumentedPaths(extractBullets(markdown));
}
