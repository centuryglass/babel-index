#!/usr/bin/env node
/**
 * Upload a corpus to Cloudflare R2: room images at every generated pyramid
 * level, the keyword/story sidecar, the CLIP embeddings blob, and the shared
 * center/generic tiles. See docs/implementation-plan.md's Hosting section.
 *
 * R2 is S3-compatible, so this talks to it with @aws-sdk/client-s3 rather
 * than a bespoke client.
 *
 * Credentials come from the environment, never from the command line:
 *   R2_ACCOUNT_ID          Cloudflare account id (builds the default endpoint)
 *   R2_ENDPOINT            full endpoint url, overrides R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET              overridden by --bucket
 *
 *   node tools/upload/upload-r2.mjs
 *   node tools/upload/upload-r2.mjs --images <dir> [--shared-dir assets] \
 *     [--prefix <name>] [--bucket <name>] [--center center.jpg] [--dry-run]
 *
 * ### Incremental by content hash
 *
 * A previous run's manifest - key -> sha256 of what was uploaded under that
 * key - is stored in the bucket at `<prefix>/upload-manifest.json`. Every
 * local file this corpus touches (room images at every level, metadata.json,
 * the embeddings blob and sidecar, the shared tiles) is hashed fresh, with
 * the same `contentHash()` the pyramid generator uses (packages/pipeline/
 * mips.mjs) rather than a second sha256-of-bytes implementation; a file whose
 * hash matches the manifest's record for its key is skipped. Nothing is
 * deleted from R2, and no other tool reads that upload manifest - it exists
 * only so a rerun after touching a handful of images costs a handful of PUTs,
 * not the whole corpus. See tools/upload/lib.mjs for the pure decision logic.
 *
 * ### The public manifest
 *
 * Separately, the `scanDirectory()` result itself - the same shape
 * `/api/manifest` serves locally - is written to `<prefix>/manifest.json` on
 * every run, changed or not. `packages/server/remote.ts` fetches this when
 * the demo server is started with `--remote`, so a bucket holding a corpus
 * needs no listing API: the one local scan that ran here is the only place
 * "what files make up this corpus" gets decided.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { scanDirectory } from '../../packages/server/scan.ts';
import { REMOTE_MANIFEST_NAME } from '../../packages/server/remote.ts';
import { contentHash } from '../../packages/pipeline/mips.mjs';
import { buildUploadList, diffAgainstManifest, guessContentType } from './lib.mjs';

const MANIFEST_NAME = 'upload-manifest.json';

function parseArgs(args) {
  const out = {};
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

function requireEnv(name) {
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

/** The previous run's manifest, or {} if there isn't one yet (first run). */
async function fetchRemoteManifest(client, bucket, key) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body.transformToString();
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return {};
    throw err;
  }
}

async function putFile(client, bucket, key, path) {
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
  const imagesDir = resolve(process.cwd(), argv.images ?? 'assets/corpus-sample');
  const sharedDir = resolve(process.cwd(), argv['shared-dir'] ?? 'assets');
  const prefix = argv.prefix ?? basename(imagesDir);
  const dryRun = Boolean(argv['dry-run']);
  const bucket = argv.bucket ?? requireEnv('R2_BUCKET');

  const manifest = await scanDirectory(imagesDir, { center: argv.center, sharedDir });
  const uploads = buildUploadList(manifest, { imagesDir, sharedDir, prefix }, join);
  console.log(`${uploads.length} file(s) make up this corpus (prefix "${prefix}")`);

  const hashes = new Map();
  const missing = [];
  for (const { local } of uploads) {
    try {
      hashes.set(local, await contentHash(local));
    } catch {
      missing.push(local);
    }
  }
  if (missing.length) {
    console.error(`\n  ${missing.length} file(s) the manifest expects but couldn't be read:`);
    for (const m of missing.slice(0, 10)) console.error(`    ${m}`);
    if (missing.length > 10) console.error(`    ... and ${missing.length - 10} more`);
    console.error('\n  Regenerate the pyramid/embeddings, or check --images/--shared-dir, and rerun.\n');
    process.exit(1);
  }

  const manifestKey = `${prefix}/${MANIFEST_NAME}`;
  const client = makeClient();
  const remoteManifest = await fetchRemoteManifest(client, bucket, manifestKey);
  const { toUpload, unchanged } = diffAgainstManifest(uploads, hashes, remoteManifest);

  console.log(
    `${toUpload.length} new/changed, ${unchanged.length} already current` +
      (dryRun ? ' (dry run - nothing will be written)' : '')
  );

  if (!dryRun) {
    let done = 0;
    for (const { local, key } of toUpload) {
      await putFile(client, bucket, key, local);
      done++;
      if (done % 10 === 0 || done === toUpload.length) process.stdout.write(`  ${done}/${toUpload.length}\r`);
    }
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
  // this corpus with --remote. Written every run, not diffed against a hash:
  // it is small, and it must reflect this scan even when the room bytes it
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
}

main().catch((err) => {
  // A missing credential or a real transfer failure is a message, not a
  // stack, in the common case - see tools/embed/embed.mjs for the same split.
  console.error(err?.expected ? err.message : err);
  process.exit(1);
});
