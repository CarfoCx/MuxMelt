# Changelog

Notable changes to MuxMelt are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
semantic version numbers where practical.

## Unreleased

## 1.3.0 - 2026-08-14

### Added

- A universal-drop Home workflow that suggests compatible tools.
- Optional Media AI and Local Chat component packs with repair, removal,
  progress, cancellation, and storage controls.
- A fail-closed Offline Mode for MuxMelt-managed network features, with local
  protocol restrictions at FFmpeg and model-runner boundaries.
- Local-only text to speech using operating-system voices.
- Privacy, security, contribution, third-party notice, and release provenance
  documentation.
- Privacy controls for recent files, notification detail, logs, caches, models,
  temporary files, update checks, and component storage.
- Accessible navigation, dialogs, drop zones, status announcements, and reduced
  motion support.
- A shared theme registry used by quick themes and Settings.
- Cancellable parent-death supervision for external process trees, a guarded
  Python backend lifecycle, per-session local API authentication, and bounded
  redacted diagnostics.
- Reproducible Node installs, dependency audit gates, verified runtime/media
  downloads, smoke-test CI, an SBOM, release checksums, and mandatory two-stage
  Windows code signing.
- A complete SHA-256 wheel lock for the official Windows x64 Media AI pack,
  covering pip and every direct and transitive CPython 3.13 dependency.
- Optional, non-blocking Ko-fi links after sustained use and in Settings.

### Changed

- New installations start instantly at Home; large AI runtimes are installed
  only after the user explicitly requests the corresponding component.
- Network-capable actions are explicit and cancellable. Automatic update
  checks, recent-file memory, and detailed notifications default to off.
- Online updates now lead to the signed GitHub release page. Hash-verified
  local update sources remain available outside Offline Mode.
- The managed backend uses dynamically selected ports, a child-pipe readiness
  proof, and an authentication secret that is kept out of process arguments.
- Local Chat uses a per-launch private key file, proves that its exact child
  owns the loopback listener, and pins catalog models to immutable revisions.
- Background removal and stem separation use exact-size, full-SHA-256 model
  manifests and verified atomic cache updates; Demucs no longer probes moving
  third-party model repositories before its pinned official host.
- Packaged builds use only bundled or app-managed Python runtimes.
- FFmpeg and FFprobe now come from the same pinned, checksum-verified release.
- Privacy messaging now distinguishes local processing, optional downloads,
  and the limits of application-level Offline Mode.
- Completion notifications use generic text by default.
- Dependency versions, platform runtime manifests, setup fingerprints, and
  component health validation are pinned and checked more strictly.

### Fixed

- Removed the cloud-backed Edge TTS path that transmitted entered text.
- Added supervised, bounded cleanup for setup, download, backend, and
  conversion process trees during normal shutdown or cancellation.
- Removed the downloader's script-running hidden browser, remote thumbnail
  proxy, and in-app runtime package updater to reduce its network attack surface.
- Latched unconfirmed child-tree cleanup failures so later Offline Mode or data
  maintenance cannot incorrectly report a safe transition.
- Closed backend port, update-source, torrent-client, component-removal, log,
  and Offline Mode transition races.
- Prevented remote references embedded in selected media from bypassing
  Offline Mode through native FFmpeg or Demucs codec paths.

## 1.2.11

- Current packaged application baseline. Earlier changes were not maintained in
  a structured changelog; consult Git history for details.
