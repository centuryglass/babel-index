#!/usr/bin/env node
/**
 * Upload a corpus to Cloudflare R2: room images at every generated pyramid
 * level, the keyword/story sidecar, the CLIP embeddings blob, the shared
 * center/generic tiles, and the `scanDirectory()` manifest that
 * `packages/server/remote.ts` reads. tools/upload/README.md owns the usage,
 * credentials, bucket layout, incremental-upload and cache-purge behavior.
 *
 *   npm run upload:r2 -- --images <dir> [--shared-dir assets] \
 *     [--prefix <name>] [--bucket <name>] [--center center.jpg] [--dry-run]
 *
 * The pure decisions (what to upload, what to skip, what to purge) live in
 * lib.ts; this file does the I/O. A purge whose env vars are all set but
 * whose request fails throws, so a purge that did not happen never looks
 * like one that did.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { scanDirectory } from '../../packages/server/scan.ts';
import { REMOTE_MANIFEST_NAME } from '../../packages/server/remote.ts';
import { createLimiter } from '../../packages/server/search-cache.ts';
import { contentHash } from '../../packages/pipeline/mips.ts';
import type { AnimationManifest } from '../center-animation/lib.ts';
import { buildUploadList, crossOriginFetchedKeys, diffAgainstManifest, guessContentType } from './lib.ts';

const MANIFEST_NAME = 'upload-manifest.json';
const CONCURRENCY = 16;
const PURGE_BATCH = 30; // Cloudflare's max files per purge_cache call
const PURGE_ALL_THRESHOLD = 1000; // beyond this, one purge_everything beats hundreds of batched calls

type Args = Record<string, string | boolean>;

function parseArgs(args: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (args[i + 1] === undefined || args[i + 1].startsWith('--')) out[a.slice(2)] = true;
    else out[a.slice(2)] = args[++i];
  }
  return out;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw Object.assign(new Error(`missing required environment variable ${name}`), { expected: true });
  return value;
}

function makeClient() {
  const endpoint = process.env.R2_ENDPOINT ?? `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: 'auto', // R2 ignores region; the S3 SDK still requires one be set
    endpoint,
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
}

/**
 * The on-disk loading-animation manifest under `<sharedDir>/animation/`, or
 * null when there is none - a corpus deployed without the indicator. Handed
 * to `buildUploadList` and `crossOriginFetchedKeys`; see `animationKeys` in
 * lib.ts for which keys ride on it and why null uploads nothing.
 */
async function loadAnimationManifest(sharedDir: string): Promise<AnimationManifest | null> {
  try {
    const body = await readFile(join(sharedDir, 'animation', 'manifest.json'), 'utf8');
    const parsed = JSON.parse(body);
    return parsed && Array.isArray(parsed.cycles) ? (parsed as AnimationManifest) : null;
  } catch {
    return null;
  }
}

/** The previous run's manifest, or {} if there isn't one yet (first run). */
async function fetchRemoteManifest(client: S3Client, bucket: string, key: string): Promise<Record<string, string>> {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body!.transformToString();
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return {};
    throw err;
  }
}

/** Every key actually present in the bucket under `prefix`, paginated. */
async function listKeys(client: S3Client, bucket: string, prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let ContinuationToken: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    for (const obj of res.Contents ?? []) if (obj.Key) keys.add(obj.Key);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

/**
 * Keys actually present in the bucket that this run could occupy, in two
 * namespaces: `<prefix>/...` for the corpus and `shared/...` for the shared
 * assets - the latter live outside any corpus prefix, so they need their own
 * listing.
 */
async function listExistingKeys(client: S3Client, bucket: string, prefix: string): Promise<Set<string>> {
  const [corpus, shared] = await Promise.all([
    listKeys(client, bucket, `${prefix}/`),
    listKeys(client, bucket, 'shared/'),
  ]);
  return new Set([...corpus, ...shared]);
}

interface CloudflarePurgeConfig {
  apiToken: string;
  zoneId: string;
  hostname: string;
}

/** Reads the purge env vars; null (not thrown) when any is unset. */
function cloudflarePurgeConfig(): CloudflarePurgeConfig | null {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const hostname = process.env.CLOUDFLARE_ASSETS_HOSTNAME;
  if (!apiToken || !zoneId || !hostname) return null;
  return { apiToken, zoneId, hostname };
}

async function callPurgeApi(cfg: CloudflarePurgeConfig, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}/purge_cache`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok || !parsed?.success)
    throw new Error(`Cloudflare cache purge failed (${res.status}): ${JSON.stringify(parsed?.errors ?? parsed)}`);
}

/**
 * Purge exactly the given keys, or the whole zone past `PURGE_ALL_THRESHOLD`
 * (tools/upload/README.md, "Cache purge"). Keys are
 * turned into full urls under `cfg.hostname`, matching how
 * `packages/server/remote.ts` addresses this bucket.
 */
async function purgeCache(cfg: CloudflarePurgeConfig, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (keys.length > PURGE_ALL_THRESHOLD) {
    await callPurgeApi(cfg, { purge_everything: true });
    console.log(`cache purged: purge_everything (${keys.length} keys exceeded the ${PURGE_ALL_THRESHOLD}-key batch threshold)`);
    return;
  }
  const urls = keys.map((key) => `https://${cfg.hostname}/${key}`);
  for (let i = 0; i < urls.length; i += PURGE_BATCH) await callPurgeApi(cfg, { files: urls.slice(i, i + PURGE_BATCH) });
  console.log(`cache purged: ${keys.length} key(s)`);
}

async function putFile(client: S3Client, bucket: string, key: string, path: string): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: await readFile(path),
      ContentType: guessContentType(key),
    })
  );
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const imagesDir = resolve(process.cwd(), (argv.images as string) ?? 'assets/corpus-sample');
  const sharedDir = resolve(process.cwd(), (argv['shared-dir'] as string) ?? 'assets');
  const prefix = (argv.prefix as string) ?? basename(imagesDir);
  const dryRun = Boolean(argv['dry-run']);
  const bucket = (argv.bucket as string) ?? requireEnv('R2_BUCKET');

  const manifest = await scanDirectory(imagesDir, { center: argv.center as string | undefined, sharedDir });
  const animation = await loadAnimationManifest(sharedDir);
  const uploads = buildUploadList(manifest, { imagesDir, sharedDir, prefix, animation }, join);
  console.log(`${uploads.length} file(s) make up this corpus (prefix "${prefix}")`);

  const limiter = createLimiter(CONCURRENCY);
  const hashes = new Map<string, string>();
  const missing: string[] = [];
  await Promise.all(
    uploads.map(({ local }) =>
      limiter(async () => {
        try {
          hashes.set(local, await contentHash(local));
        } catch {
          missing.push(local);
        }
      })
    )
  );
  if (missing.length) {
    console.error(`\n  ${missing.length} file(s) the manifest expects but couldn't be read:`);
    for (const m of missing.slice(0, 10)) console.error(`    ${m}`);
    if (missing.length > 10) console.error(`    ... and ${missing.length - 10} more`);
    console.error('\n  Regenerate the pyramid/embeddings, or check --images/--shared-dir, and rerun.\n');
    process.exit(1);
  }

  const manifestKey = `${prefix}/${MANIFEST_NAME}`;
  const client = makeClient();
  const [remoteManifest, existingKeys] = await Promise.all([
    fetchRemoteManifest(client, bucket, manifestKey),
    listExistingKeys(client, bucket, prefix),
  ]);
  const { toUpload, unchanged } = diffAgainstManifest(uploads, hashes, remoteManifest, existingKeys);

  console.log(
    `${toUpload.length} new/changed, ${unchanged.length} already current` +
      (dryRun ? ' (dry run - nothing will be written)' : '')
  );

  if (!dryRun) {
    let done = 0;
    await Promise.all(
      toUpload.map(({ local, key }) =>
        limiter(async () => {
          await putFile(client, bucket, key, local);
          done++;
          if (done % 10 === 0 || done === toUpload.length) process.stdout.write(`  ${done}/${toUpload.length}\r`);
        })
      )
    );
    if (toUpload.length) console.log('');
  } else {
    for (const { key } of toUpload) console.log(`  would upload ${key}`);
  }

  if (!dryRun && toUpload.length) {
    const newManifest = Object.fromEntries([...unchanged, ...toUpload].map(({ key, hash }) => [key, hash]));
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: manifestKey,
        Body: JSON.stringify(newManifest, null, 2) + '\n',
        ContentType: 'application/json',
      })
    );
    console.log(`manifest updated: ${manifestKey}`);
  } else if (!dryRun) {
    console.log('nothing to upload, manifest unchanged');
  }

  // The public manifest - what packages/server/remote.ts fetches to serve
  // this corpus with --remote. Written every run, not hash-diffed: it is
  // small, and it must reflect this scan even when the room bytes it
  // describes didn't change (a metadata-only or embeddings-only rerun still
  // needs it current).
  if (!dryRun) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/${REMOTE_MANIFEST_NAME}`,
        Body: JSON.stringify(manifest, null, 2) + '\n',
        ContentType: 'application/json',
      })
    );
    console.log(`public manifest updated: ${prefix}/${REMOTE_MANIFEST_NAME}`);
  } else {
    console.log(`  would update public manifest: ${prefix}/${REMOTE_MANIFEST_NAME}`);
  }

  const purgeCfg = cloudflarePurgeConfig();
  const purgeKeys = [
    ...new Set([
      ...toUpload.map(({ key }) => key),
      `${prefix}/${REMOTE_MANIFEST_NAME}`,
      ...crossOriginFetchedKeys(manifest, prefix, animation),
    ]),
  ];
  if (dryRun) {
    console.log(
      purgeCfg
        ? `  would purge ${purgeKeys.length} key(s) from Cloudflare's cache`
        : '  would purge Cloudflare cache (CLOUDFLARE_API_TOKEN/ZONE_ID/ASSETS_HOSTNAME not set - skipping)'
    );
  } else if (purgeCfg) {
    await purgeCache(purgeCfg, purgeKeys);
  } else {
    console.log('cache not purged: set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID and CLOUDFLARE_ASSETS_HOSTNAME to enable it');
  }
}

main().catch((err: any) => {
  // A missing credential sets `expected` and lands as a one-line message;
  // anything else is a real failure and keeps its stack. tools/embed/embed.ts
  // ends on the same split.
  console.error(err?.expected ? err.message : err);
  process.exit(1);
});
