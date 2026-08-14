function createJobRegistry() {
  const cancellers = new Map();
  let shuttingDown = false;
  let maintenance = false;

  function register(name, cancel, options = {}) {
    if (typeof name !== 'string' || !name || typeof cancel !== 'function') {
      throw new TypeError('Job cancellation registration requires a name and function');
    }
    cancellers.set(name, {
      cancel,
      network: options && options.network === true,
    });
    return () => cancellers.delete(name);
  }

  async function cancelAll(timeoutMs = 5000, options = {}) {
    const failures = [];
    const entries = [...cancellers.entries()].filter(([, registration]) => (
      options.networkOnly !== true || registration.network
    ));
    const cancellations = entries.map(async ([name, registration]) => {
      try { await registration.cancel(); }
      catch (err) {
        failures.push({ name, error: err.message });
        console.warn(`Failed to stop ${name}:`, err.message);
      }
    });
    let timeout;
    let timedOut = false;
    await Promise.race([
      Promise.all(cancellations),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        if (typeof timeout.unref === 'function') timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return { timedOut, failures };
  }

  function assertCanStart(name = 'This operation') {
    if (shuttingDown || maintenance) {
      const error = new Error(
        shuttingDown
          ? `${name} cannot start while MuxMelt is shutting down.`
          : `${name} cannot start while app data is being maintained.`
      );
      error.code = shuttingDown ? 'APP_SHUTTING_DOWN' : 'APP_MAINTENANCE';
      throw error;
    }
  }

  async function runMaintenance(operation, timeoutMs = 10000) {
    if (typeof operation !== 'function') throw new TypeError('Maintenance requires an operation');
    assertCanStart('Maintenance');
    maintenance = true;
    try {
      const cancelled = await cancelAll(timeoutMs);
      if (cancelled.timedOut || cancelled.failures.length > 0) {
        const error = new Error(
          cancelled.timedOut
            ? 'Active work did not stop in time; no app data was changed.'
            : 'Some active work could not be stopped; no app data was changed.'
        );
        error.code = 'ACTIVE_JOBS_NOT_STOPPED';
        error.details = cancelled;
        throw error;
      }
      return await operation();
    } finally {
      maintenance = false;
    }
  }

  async function runNetworkTransition(operation, timeoutMs = 10000, cancelNetwork = true) {
    if (typeof operation !== 'function') throw new TypeError('Network transition requires an operation');
    assertCanStart('Network transition');
    maintenance = true;
    try {
      if (cancelNetwork) {
        const cancelled = await cancelAll(timeoutMs, { networkOnly: true });
        if (cancelled.timedOut || cancelled.failures.length > 0) {
          const error = new Error(
            cancelled.timedOut
              ? 'Active network work did not stop in time.'
              : 'Some active network work could not be stopped.'
          );
          error.code = 'NETWORK_JOBS_NOT_STOPPED';
          error.details = cancelled;
          throw error;
        }
      }
      return await operation();
    } finally {
      maintenance = false;
    }
  }

  async function shutdownAll(timeoutMs = 5000) {
    if (shuttingDown) return;
    shuttingDown = true;
    return cancelAll(timeoutMs);
  }

  return Object.freeze({
    register,
    cancelAll,
    assertCanStart,
    runMaintenance,
    runNetworkTransition,
    shutdownAll,
    get isShuttingDown() { return shuttingDown; },
    get isMaintenance() { return maintenance; },
  });
}

module.exports = { createJobRegistry };
