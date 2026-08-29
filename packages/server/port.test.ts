import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { portInUse } from './port.ts';

/** A server on an ephemeral port, closed again afterwards. */
async function holding<T>(run: (port: number) => Promise<T>): Promise<T> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, done));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(port);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test('a port someone is listening on is reported as taken', async () => {
  await holding(async (port) => {
    assert.equal(await portInUse(port), true);
  });
});

test('a free port is reported as free', async () => {
  // Take one and give it straight back, so the number is real but unheld.
  const port = await holding(async (p) => p);
  assert.equal(await portInUse(port), false);
});

test('the probe does not leave the port held behind it', async () => {
  // The check runs immediately before the server binds, so a probe that failed
  // to release would make the demo refuse to start on a port that is fine - or
  // worse, take the port the server was about to want.
  //
  // A leak fails this test by name and ALSO hangs the runner, since the open
  // handle keeps the process alive. Both at once is the expected symptom; the
  // hang is not a separate problem to go looking for.
  const port = await holding(async (p) => p);
  assert.equal(await portInUse(port), false);
  assert.equal(await portInUse(port), false, 'a second check must agree with the first');

  await new Promise<void>((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(port, () => server.close(() => done()));
  });
});

test('a port held only on loopback still counts as taken for a loopback bind', async () => {
  // The demo binds every interface, so anything holding one of them stops it.
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(await portInUse(port, '127.0.0.1'), true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
