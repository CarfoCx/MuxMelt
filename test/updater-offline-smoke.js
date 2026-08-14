'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'updater.js'),
  'utf8',
);

function orderedWithin(startMarker, endMarker, first, second) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `could not isolate ${startMarker}`);
  const body = source.slice(start, end);
  assert(body.indexOf(first) >= 0, `${first} is missing from ${startMarker}`);
  assert(body.indexOf(second) >= 0, `${second} is missing from ${startMarker}`);
  assert(
    body.indexOf(first) < body.indexOf(second),
    `${first} must run before ${second} in ${startMarker}`,
  );
}

// A configured UNC or network-mounted update folder must not be resolved,
// statted, or read before Offline Mode is consulted.
orderedWithin(
  'async function checkForUpdates(',
  'function emitManualUpdateResult',
  'networkPolicy.isOffline()',
  'loadLocalUpdateFolder()',
);

orderedWithin(
  "ipcMain.handle('download-and-update'",
  'module.exports = {',
  "networkPolicy.assertAllowed('Installing from an update source')",
  'loadLocalUpdateFolder()',
);

orderedWithin(
  "ipcMain.handle('get-local-update-folder'",
  "ipcMain.handle('select-local-update-folder'",
  'networkPolicy?.isOffline?.()',
  'loadLocalUpdateFolder()',
);
assert(source.includes(
  "networkPolicy.assertAllowed('Selecting an update source')",
));
assert(source.includes("jobRegistry?.register?.('app-updater', cancelUpdaterNetwork, { network: true })"));
assert(source.includes('for (const controller of activeSourceControllers) controller.abort()'));
assert(source.includes('await copyFileAbortable(installerPath, targetPath, signal)'));
orderedWithin(
  'function trackUpdateSourceOperation(',
  'const performUpdateCheck',
  'jobRegistry?.assertCanStart?.(label)',
  'operation(controller.signal)',
);
assert(!source.includes('electron-updater'));

console.log('Updater Offline-Mode smoke passed.');
