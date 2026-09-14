#!/usr/bin/env node
/**
 * Poll a server's /api/health until it reports the revision it was supposed
 * to be running, or give up and say why.
 *
 *   node deploy/health-check.mjs <url> <sha> [--timeout=90] [--interval=2]
 *
 * One definition of "the deploy worked", used twice: `deploy.sh` runs it on
 * the box against 127.0.0.1 (did the unit come back up on the new code?) and
 * `.github/workflows/deploy.yml` runs it from the runner against the public
 * url (can the world actually reach it, through nginx and all?). Two checks
 * that could disagree about what healthy means would be two chances to call a
 * broken release good.
 *
 * `.mjs` run by plain `node`, deliberately, where the rest of the repo would
 * be `.ts` through the loader hook (AGENTS.md): this has to run on the VPS in
 * the window right after `npm ci` has emptied and refilled node_modules, and
 * on a CI runner that has installed nothing at all. No imports, no
 * dependencies, no build step - just Node's own fetch.
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
    // Reaching something that answers but isn't this server at all - a proxy
    // error page, a default vhost - looks like a deploy problem from here and
    // will not resolve itself by waiting.
    throw new Fatal(`${url} answered with something that is not JSON - is this the right url?`);
  }

  if (health.commit === null)
    throw new Fatal(
      'the server is up but cannot name its own revision, so this deploy cannot be verified. ' +
        'It has no readable .git and no BABEL_COMMIT set - see packages/server/version.ts.'
    );
  if (health.commit !== expected) return `still serving ${String(health.commit).slice(0, 12)}`;

  // Past this point the NEW process is answering, so anything still wrong with
  // it is wrong for good. An empty corpus is the one that matters: the library
  // serves perfectly happily with nothing in it, which is exactly what a unit
  // file pointing --images somewhere that no longer exists looks like.
  if (!health.ok) throw new Fatal(`the new revision is up and reporting itself unhealthy: ${JSON.stringify(health)}`);
  if (!health.rooms)
    throw new Fatal(
      'the new revision is up and serving an EMPTY corpus - check the unit file\'s --images path ' +
        'and that the corpus directory is still where it was.'
    );
  return null;
}

const deadline = Date.now() + timeoutMs;
// Assigned on every path that reaches the loop's end, so it needs no
// initial value - the loop cannot exit without having set it.
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
