#!/usr/bin/env node
/**
 * Poll a server's /api/health until it reports the expected revision, or give
 * up and say why. Exits 0 when healthy, 1 when not, 2 on bad arguments.
 *
 *   node deploy/health-check.mjs <url> <sha> [--timeout=90] [--interval=2]
 *
 * The one definition of "the deploy worked", run twice: `deploy.sh` runs it
 * on the box against 127.0.0.1 (did the unit come back on the new code?), and
 * `.github/workflows/deploy.yml` runs it from the runner against the public
 * url (can anyone reach it through nginx?).
 *
 * Plain `.mjs` with no imports, run by bare `node`: on the VPS it runs right
 * after `npm ci --omit=dev` has replaced node_modules, so it must not depend
 * on that tree or on the loader hook.
 */

const SHA = /^[0-9a-f]{40}$/;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const [url, expected] = args.filter((a) => !a.startsWith('--'));
const timeoutMs = flag('timeout', 90) * 1000;
const intervalMs = flag('interval', 2) * 1000;

if (!url || !expected) {
  console.error('usage: health-check.mjs <url> <sha> [--timeout=90] [--interval=2]');
  process.exit(2);
}
if (!SHA.test(expected)) {
  console.error(`not a full commit sha: ${expected}`);
  process.exit(2);
}

/** Give up now rather than at the deadline - retrying cannot change this. */
class Fatal extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One poll: the reason it is not healthy yet, or null once it is. */
async function attempt() {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
  } catch (err) {
    return `no answer yet (${err.cause?.code ?? err.name}: ${err.message})`;
  }
  if (!res.ok) return `HTTP ${res.status}`;

  let health;
  try {
    health = await res.json();
  } catch {
    // A 200 that isn't JSON is some other server (a proxy error page, a
    // default vhost), which waiting will not fix.
    throw new Fatal(`${url} answered with something that is not JSON - is this the right url?`);
  }

  if (health.commit === null)
    throw new Fatal(
      'the server is up but cannot name its own revision, so this deploy cannot be verified. ' +
        'It has no readable .git and no BABEL_COMMIT set - see packages/server/version.ts.'
    );
  if (health.commit !== expected) return `still serving ${String(health.commit).slice(0, 12)}`;

  // Past this point the new process is answering, so anything still wrong
  // with it is wrong for good.
  if (!health.ok) throw new Fatal(`the new revision is up and reporting itself unhealthy: ${JSON.stringify(health)}`);
  if (!health.rooms)
    throw new Fatal(
      'the new revision is up and serving an EMPTY corpus - check the unit file\'s --images path ' +
        'and that the corpus directory is still where it was.'
    );
  return null;
}

const deadline = Date.now() + timeoutMs;
// The latest not-yet-healthy reason, reported if the deadline passes.
let last;
process.stdout.write(`waiting for ${url} to report ${expected.slice(0, 12)}`);

for (;;) {
  let reason;
  try {
    reason = await attempt();
  } catch (err) {
    if (!(err instanceof Fatal)) throw err;
    process.stdout.write('\n');
    console.error(`unhealthy: ${err.message}`);
    process.exit(1);
  }

  if (reason === null) {
    process.stdout.write('\n');
    console.log(`healthy: ${url} is serving ${expected.slice(0, 12)}`);
    process.exit(0);
  }

  last = reason;
  if (Date.now() + intervalMs >= deadline) break;
  process.stdout.write('.');
  await sleep(intervalMs);
}

process.stdout.write('\n');
console.error(`unhealthy: gave up after ${timeoutMs / 1000}s - ${last}`);
process.exit(1);
