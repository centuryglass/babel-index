/**
 * Normalising the one string that lets this app be reverse-proxied under a
 * subpath (e.g. `https://centuryglass.us/babel-index/`) instead of owning a
 * whole origin.
 *
 * It does not change how Express routes anything: the VPS's nginx config
 * strips the prefix before a request reaches this process, so every route
 * in app.ts stays mounted at its usual unprefixed path (docs/agents/deploy.md,
 * "Deployment and the base path" carries the whole mechanism). What a
 * subpath does break is browser-side: root-absolute urls resolve against the
 * true origin root, one level above the subpath, so every url this server
 * hands the browser is relative and goes through `<base href>` instead - see
 * app.ts's injection and scan.ts's `IMAGES_BASE`/`SHARED_BASE`.
 *
 * This module is only the canonical shape of the base value itself.
 */

/**
 * Always a leading and trailing slash, and nothing else - `/` for the
 * default (own-origin) case, `/babel-index/` for a subpath. The trailing
 * slash is what `<base href>` needs to mean "resolve under this directory"
 * rather than "resolve as a sibling of this filename".
 */
export function normalizeBasePath(input: string | undefined | null): string {
  let p = (input ?? '/').trim();
  if (!p) p = '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p = `${p}/`;
  return p;
}
