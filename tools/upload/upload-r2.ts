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
 *   node tools/upload/upload-r2.ts
 *   node tools/upload/upload-r2.ts --images <dir> [--shared-dir assets] \
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
 * not the whole corpus. See tools/upload/lib.ts for the pure decision logic.
 *
 * The recorded manifest is only ever what a past run *believed* it wrote, so
 * a matching hash alone doesn't prove the object still exists in the bucket -
 * a manual delete, a lifecycle rule, or any other out-of-band loss would read
 * as "unchanged" forever. Every run also lists the bucket (`ListObjectsV2`,
 * scoped to this corpus's prefix and to `shared/`) and treats a key missing
 * from that listing as needing upload regardless of its recorded hash.
 *
 * ### Concurrency
 *
 * Hashing and uploading both run through the same bounded-concurrency
 * `createLimiter` used for CLIP inference in packages/server/search-cache.ts -
 * a corpus is many small files, and doing either step one file at a time pays
 * full round-trip latency per file for no reason; R2 handles many concurrent
 * requests fine.
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
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { scanDirectory } from '../../packages/server/scan.ts';
import { REMOTE_MANIFEST_NAME } from '../../packages/server/remote.ts';
import { createLimiter } from '../../packages/server/search-cache.ts';
import { contentHash } from '../../packages/pipeline/mips.mjs';
import { buildUploadList, diffAgainstManifest, guessContentType } from './lib.ts';

const MANIFEST_NAME = 'upload-manifest.json';
const CONCURRENCY = 16;

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
 * Keys this run's uploads could occupy, in two namespaces: `<prefix>/...` for
 * the corpus, `shared/...` for the center/generic tiles (shared across
 * corpora, so listed separately rather than folded into the prefix scan).
 */
async function listExistingKeys(client: S3Client, bucket: string, prefix: string): Promise<Set<string>> {
  const [corpus, shared] = await Promise.all([
    listKeys(client, bucket, `${prefix}/`),
    listKeys(client, bucket, 'shared/'),
  ]);
  return new Set([...corpus, ...shared]);
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
  const uploads = buildUploadList(manifest, { imagesDir, sharedDir, prefix }, join);
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

main().catch((err: any) => {
  // A missing credential or a real transfer failure is a message, not a
  // stack, in the common case - see tools/embed/embed.ts for the same split.
  console.error(err?.expected ? err.message : err);
  process.exit(1);
});
