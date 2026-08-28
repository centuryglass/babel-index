/**
 * Normalising the one string that lets this app be reverse-proxied under a
 * subpath (e.g. `https://centuryglass.us/babel-index/`) instead of owning a
 * whole origin.
 *
 * This does NOT change how Express routes anything - `server-nginx.conf`'s
 * `location /babel-index/ { proxy_pass http://localhost:5173/; }` (trailing
 * slash on both) already strips the prefix before a request reaches this
 * process, so every route in app.ts stays mounted at its usual unprefixed
 * path. What breaks under a subpath instead is the BROWSER side: a
 * root-absolute url baked into served HTML/JS/JSON (`/bundle.js`,
 * `/api/manifest`, `/images/foo.jpg`) resolves against the true origin root,
 * which is one level above `/babel-index/` and never reaches nginx's proxy
 * block at all. The fix is that every such url is RELATIVE instead, resolved
 * by the browser against `<base href>` - see app.ts's index.html injection
 * and scan.ts's `IMAGES_BASE`/`SHARED_BASE`. This module is just the one
 * place the base value itself gets put in a canonical shape.
 */

/**
 * Always a leading AND trailing slash, and nothing else - `/` for the
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
