/**
 * Reading a corpus from a remote host (R2 behind a public domain, e.g.
 * assets.centuryglass.us) instead of a local directory.
 *
 * `tools/upload/upload-r2.ts` writes the exact `scanDirectory()` result to
 * `<prefix>/manifest.json` on every run, so there is no second "list what's
 * in the bucket" implementation here - the real scan runs once, at upload
 * time, and this only fetches what it already computed.
 *
 * The manifest's urls come out of that scan rooted at the LOCAL mount paths
 * (`scan.ts`'s `IMAGES_BASE`/`SHARED_BASE`, `/images` and `/shared`), because
 * the scan has no idea it will ever be served remotely. `rebase` below
 * rewrites every one of them - `imagesBase`/`sharedBase` themselves, and every
 * url already baked into `rooms`/`shared`/`embeddings`/`metadata` - to point
 * directly at the remote host instead. That is deliberate: the browser then
 * fetches every tile, the embeddings blob and the metadata sidecar straight
 * from R2/Cloudflare, never through this server, so this VPS is never in the
 * hot path for image bytes and Cloudflare's edge cache actually gets used.
 * (Previously this module proxied `/images` and `/shared` through the server
 * with a per-request `fetch` - simpler to wire up, but it meant every tile
 * byte for every visitor round-tripped through the one cheap VPS instead of
 * Cloudflare's edge, and none of `infra/abuse-protection.tf`'s cache/rate-limit
 * rules - scoped to the R2 hostname - ever saw that traffic.)
 *
 * The R2/Cloudflare host must serve `imagesBase`/`sharedBase` with CORS
 * allowing this app's origin - `embeddings.bin` and `metadata.json` are read
 * via `fetch()` in main.jsx, which enforces CORS unlike a plain `<img>` tag.
 */
import type { Manifest } from '../map/manifest.ts';

/** The manifest filename `upload-r2.ts` writes under a corpus's prefix. */
export const REMOTE_MANIFEST_NAME = 'manifest.json';

/**
 * Rewrite every url in a manifest from one base to another. Every url this
 * module touches is exactly `${oldBase}/...` (scan.ts's contract), so a
 * prefix swap is safe and does not need to parse the url.
 */
function rebase(url: string, oldBase: string, newBase: string): string {
  return url.startsWith(`${oldBase}/`) ? `${newBase}${url.slice(oldBase.length)}` : url;
}

/**
 * @param baseUrl e.g. https://assets.centuryglass.us
 * @param prefix  the corpus prefix used at upload time
 * @returns a manifest shaped like scanDirectory()'s, with every url pointing
 *   directly at the remote host
 */
export async function scanRemote(baseUrl: string, prefix: string): Promise<Manifest> {
  const root = baseUrl.replace(/\/+$/, '');
  const url = `${root}/${prefix}/${REMOTE_MANIFEST_NAME}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch remote manifest: ${res.status} ${res.statusText} (${url})`);

  // `directory` and `mode` describe how the manifest was produced (a local
  // scan, at upload time) rather than how it is being served now.
  const { directory: _directory, mode: _mode, ...manifest } = await res.json();

  const oldImagesBase = manifest.imagesBase ?? '/images';
  const oldSharedBase = manifest.sharedBase ?? '/shared';
  const imagesBase = `${root}/${prefix}`;
  const sharedBase = `${root}/shared`;
  const toImages = (u: string) => rebase(u, oldImagesBase, imagesBase);
  const toShared = (u: string) => rebase(u, oldSharedBase, sharedBase);

  return {
    ...manifest,
    mode: 'remote',
    source: url,
    imagesBase,
    sharedBase,
    rooms: manifest.rooms.map((room) => ({ ...room, url: toImages(room.url) })),
    embeddings: manifest.embeddings && { ...manifest.embeddings, url: toImages(manifest.embeddings.url) },
    metadata: manifest.metadata && { ...manifest.metadata, url: toImages(manifest.metadata.url) },
    tagLinks: manifest.tagLinks && { ...manifest.tagLinks, url: toImages(manifest.tagLinks.url) },
    shared: {
      center: manifest.shared?.center && { ...manifest.shared.center, url: toShared(manifest.shared.center.url) },
      generic: (manifest.shared?.generic ?? []).map((g) => ({ ...g, url: toShared(g.url) })),
    },
  };
}
