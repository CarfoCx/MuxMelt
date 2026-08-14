const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');

const {
  setPythonPort,
  waitForServer,
  __test,
} = require('../src/main/python-manager');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const token = 'a'.repeat(64);
  let requestCount = 0;
  let authenticated = false;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    authenticated = request.url === `/health?token=${token}`;
    response.statusCode = authenticated ? 200 : 403;
    response.end();
  });
  const port = await listen(server);
  setPythonPort(port);

  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child._readinessProof = false;

  const waiting = waitForServer(token, 4, child);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(
    requestCount,
    0,
    'the bearer token must not be sent before the child-pipe readiness proof',
  );
  child._readinessProof = true;
  child.emit('muxmelt-ready');
  await waiting;
  assert.strictEqual(requestCount, 1);
  assert.strictEqual(authenticated, true);

  const invalidChild = new EventEmitter();
  invalidChild.exitCode = null;
  invalidChild.signalCode = null;
  invalidChild._readinessProof = false;
  const invalid = waitForServer(token, 4, invalidChild);
  invalidChild.emit('muxmelt-ready-invalid');
  await assert.rejects(invalid, /invalid readiness proof/i);

  requestCount = 0;
  authenticated = false;
  const preProofChild = { _readinessProof: false, exitCode: null, signalCode: null };
  assert.strictEqual(__test.requestAuthenticatedShutdown(preProofChild, token), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(
    requestCount,
    0,
    'pre-proof shutdown must not disclose the bearer token to the selected port',
  );
  preProofChild._readinessProof = true;
  assert.strictEqual(__test.requestAuthenticatedShutdown(preProofChild, token), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(requestCount, 1);
  assert.strictEqual(authenticated, false, 'the test listener must distinguish shutdown from health');
  preProofChild.exitCode = 0;
  assert.strictEqual(__test.requestAuthenticatedShutdown(preProofChild, token), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.strictEqual(
    requestCount,
    1,
    'a formerly proven child must not disclose the token after it exits',
  );

  await close(server);
  setPythonPort(8765);
  console.log('Backend readiness smoke test passed (3 checks).');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
