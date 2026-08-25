/**
 * Reading a corpus from a remote host (R2 behind a public domain, e.g.
 * assets.centuryglass.us) instead of a local directory.
 *
 * `tools/upload/upload-r2.mjs` writes the exact `scanDirectory()` result to
 * `<prefix>/manifest.json` on every run, so there is no second "list what's
 * in the bucket" implementation here - the real scan runs once, at upload
 * time, and this only fetches what it already computed. The manifest's urls
 * stay the local shape (`/images/...`, `/shared/...`); `mountProxy` below is
 * what makes those paths resolve to the remote host instead of a static
 * directory, so nothing else in the server or the client has to know the
 * corpus isn't on disk.
 */
import { Readable } from 'node:stream';

/** The manifest filename `upload-r2.mjs` writes under a corpus's prefix. */
export const REMOTE_MANIFEST_NAME = 'manifest.json';

/**
 * @param {string} baseUrl  e.g. https://assets.centuryglass.us
 * @param {string} prefix   the corpus prefix used at upload time
 * @returns {Promise<object>} a manifest shaped like scanDirectory()'s
 */
export async function scanRemote(baseUrl, prefix) {
  const url = `${baseUrl.replace(/\/+$/, '')}/${prefix}/${REMOTE_MANIFEST_NAME}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch remote manifest: ${res.status} ${res.statusText} (${url})`);

  // `directory` and `mode` describe how the manifest was produced (a local
  // scan, at upload time) rather than how it is being served now.
  const { directory: _directory, mode: _mode, ...manifest } = await res.json();
  return { ...manifest, mode: 'remote', source: url };
}

/**
 * Mount `mountPath` (e.g. `/images`) as a proxy onto `targetBase` (e.g.
 * `https://assets.centuryglass.us/corpus-sample`), streaming each upstream
 * response through rather than buffering it - metadata.json alone can run to
 * megabytes (see scan.mjs).
 *
 * @param {import('express').Express} app
 * @param {string} mountPath
 * @param {string} targetBase
 */
export function mountProxy(app, mountPath, targetBase) {
  const target = targetBase.replace(/\/+$/, '');
  app.get(`${mountPath}/*splat`, async (req, res, next) => {
    try {
      const rest = req.params.splat.join('/');
      // The same escape express.static refuses on the local mounts - Express
      // decodes each segment before we see it, so an encoded `..%2f` lands
      // here exactly like a literal one.
      if (rest.split('/').includes('..')) return res.status(400).end();

      const upstream = await fetch(`${target}/${rest}`);
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status || 502).end();
        return;
      }
      res.status(upstream.status);
      const type = upstream.headers.get('content-type');
      if (type) res.type(type);
      const length = upstream.headers.get('content-length');
      if (length) res.set('content-length', length);
      res.set('cache-control', 'public, max-age=3600, immutable');
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      next(err);
    }
  });
}
