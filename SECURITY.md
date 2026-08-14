# Security Policy

## Supported releases

Security fixes are provided for the newest published MuxMelt release. Older
builds should be upgraded after reviewing the release notes and checksum.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could put users at
risk. Use GitHub's private vulnerability-reporting feature for this repository
when it is available. If private reporting is unavailable, open a minimal issue
asking the maintainer for a private contact channel without publishing exploit
details.

Include the affected version and operating system, the smallest reproducible
description, impact, and any suggested mitigation. Remove media files,
credentials, cookies, tokens, usernames, and full local filesystem paths.

The maintainer should acknowledge a valid report within seven days when
possible and coordinate disclosure after a fix is available. This is a
best-effort community project, not a guaranteed response-time contract.

## Safe download guidance

- Download releases only from the official GitHub repository.
- Compare the installer SHA-256 with the checksum published in the same release.
- Prefer a build whose installer and application executable have a valid
  publisher signature.
- Do not install “codec packs,” models, or updates offered by unrelated sites.

The supported Windows x64 Media AI pack is installed from a checked-in,
platform-specific lock containing the exact SHA-256 of every CPython 3.13 wheel,
including transitive dependencies and pip itself. The installer also rejects a
different package-manager bootstrap payload. Updating any Python dependency
therefore requires an explicit lock review rather than accepting whatever a
package index resolves at install time.

## Scope notes

MuxMelt intentionally handles untrusted media and network identifiers. Reports
about path traversal, unsafe process arguments, malformed media crashes,
loopback API access, updater integrity, credential handling, dependency
downloads, and torrent/download isolation are especially useful.
