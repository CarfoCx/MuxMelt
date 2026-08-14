class NetworkDisabledError extends Error {
  constructor(feature = 'This feature') {
    super(`${feature} is unavailable while Offline Mode is enabled.`);
    this.name = 'NetworkDisabledError';
    this.code = 'OFFLINE_MODE';
  }
}

function createNetworkPolicy(loadSettings) {
  if (typeof loadSettings !== 'function') {
    throw new TypeError('createNetworkPolicy requires a settings loader');
  }

  const isOffline = () => {
    try {
      const settings = loadSettings();
      return !!(settings && settings.global && settings.global.offlineMode === true);
    } catch {
      // A corrupt/unreadable settings file must fail closed for external
      // traffic until the user can review their privacy preference.
      return true;
    }
  };

  const assertAllowed = (feature) => {
    if (isOffline()) throw new NetworkDisabledError(feature);
    return true;
  };

  return Object.freeze({ isOffline, assertAllowed });
}

module.exports = { createNetworkPolicy, NetworkDisabledError };
