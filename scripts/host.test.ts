import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { findAvailablePort, portIsAvailable } from './host.ts';

test('portIsAvailable reports a port held by another server', async (context) => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, resolve));
  context.after(() => occupied.close());

  const address = occupied.address();
  assert.ok(address !== null && typeof address === 'object');
  assert.equal(await portIsAvailable(address.port), false);
});

test('findAvailablePort skips an occupied preferred port', async (context) => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, resolve));
  context.after(() => occupied.close());

  const address = occupied.address();
  assert.ok(address !== null && typeof address === 'object');

  const selected = await findAvailablePort(address.port, 5);
  assert.notEqual(selected, address.port);
  assert.equal(await portIsAvailable(selected), true);
});
