/**
 * Is a port already taken?
 *
 * Its own module so it can be tested without starting the demo server, which
 * `index.mjs` does at import time.
 *
 * This exists because the failure it prevents is silent and expensive. Node
 * fires `listen`'s callback and only THEN emits `EADDRINUSE`, so a second
 * `npm run demo` prints "the library is open at http://localhost:5173", tears
 * the handle down, empties the event loop and exits 0. Nothing is being served
 * by that process, and the older one still holding the port answers every
 * request - including for the code you just changed. A whole round of "the
 * gesture is broken on my phone" came out of exactly that.
 */
import { createServer } from 'node:net';

/**
 * @param host bind address; the default matches `app.listen(port)`, which
 *   binds every interface, so a port held on any of them counts as taken
 */
export function portInUse(port: number, host?: string): Promise<boolean> {
  // A probe bind rather than a connection attempt: it asks the same question
  // the server is about to ask, so a port held by something that never answers
  // a request is still reported as taken.
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => done(false)));
    if (host) probe.listen(port, host);
    else probe.listen(port);
  });
}
