'use strict';

const assert = require('assert');
const { createJobRegistry } = require('../src/main/job-registry');

(async () => {
  const registry = createJobRegistry();
  let localCancels = 0;
  let networkCancels = 0;
  registry.register('local-work', async () => { localCancels += 1; });
  registry.register('network-work', async () => { networkCancels += 1; }, { network: true });

  const enabledResult = await registry.runNetworkTransition(async () => {
    assert.throws(() => registry.assertCanStart('new work'), /maintained/);
    return 'enabled';
  }, 1000, true);
  assert.strictEqual(enabledResult, 'enabled');
  assert.strictEqual(networkCancels, 1, 'enabling Offline Mode must stop network work');
  assert.strictEqual(localCancels, 0, 'enabling Offline Mode must preserve unrelated local work');

  await registry.runNetworkTransition(async () => {}, 1000, false);
  assert.strictEqual(networkCancels, 1, 'disabling Offline Mode must not cancel work');
  assert.strictEqual(localCancels, 0, 'disabling Offline Mode must not cancel local work');

  await registry.runMaintenance(async () => {});
  assert.strictEqual(networkCancels, 2, 'destructive maintenance must stop network work');
  assert.strictEqual(localCancels, 1, 'destructive maintenance must stop local work');

  const shutdown = await registry.shutdownAll(1000);
  assert.deepStrictEqual(shutdown, { timedOut: false, failures: [] });
  assert.throws(() => registry.assertCanStart('new work'), /shutting down/);

  console.log('Job registry smoke passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
