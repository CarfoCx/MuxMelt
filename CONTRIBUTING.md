# Contributing to MuxMelt

Thanks for helping keep MuxMelt useful, private, and free.

## Before opening a change

- Search existing issues and keep one issue or pull request focused on one
  problem.
- For substantial new tools, discuss the workflow and maintenance cost first.
- Never include copyrighted test media, browser cookies, credentials, local
  paths, model weights, or generated installers in a pull request.

## Development setup

Use Node.js 18+ and Python 3.11 through 3.13. Follow the source instructions in
[README.md](README.md), then run:

```bash
npm test
```

## Product checklist

Every user-facing tool or workflow should include:

- A plain-language purpose and a sensible default before expert controls.
- Explicit Offline/Online behavior and first-use consent for uploaded content.
- Bounded input validation and safe output naming.
- Progress, cancellation, retry, and cleanup for long-running work.
- Keyboard access, associated labels, focus management, live status, and
  reduced-motion behavior.
- Tests for its renderer/main bridge and failure states.
- Dependency and model versions, checksums where possible, and license notices.
- A way to remove downloaded components and local history.

New outbound analytics, advertisements, fingerprinting, automatic crash
uploads, or required accounts are outside the project's privacy promise.

## Pull requests

Describe the user problem, behavior before and after, privacy/network impact,
storage impact, test results, and screenshots for visual changes. Preserve
unrelated work and avoid bulk formatting changes.

Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
