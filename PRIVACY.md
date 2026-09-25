# MuxMelt Privacy Notice

Last updated: 2026-09-16

MuxMelt is designed without ads, accounts, behavioral analytics, or automatic
crash-report uploads. This notice describes what stays local, what can connect
to the internet, and what is stored on your computer.

## Local processing

Format conversion, compression, audio extraction, GIF creation, QR creation and
scanning, basic image editing, offline Text to Speech, background processing,
stem separation, and image or video upscaling are
performed by processes on your computer. The renderer talks to the media
backend over `127.0.0.1`.

## Features that connect to third parties

| Feature | When it connects | What leaves the computer | Typical destination |
|---|---|---|---|
| Update check | At launch only if automatic checks are enabled, or when you click Check for Updates | App version, normal network metadata such as IP address and user agent | GitHub |
| First-time/component setup | When a required component is installed | Requests for the selected packages; normal network metadata | Python.org, PyPI, GitHub |
| Upscaler/background/stem models | When a needed model is not installed | Model download request; normal network metadata | The model's published host |
| Online Video Downloader | When information is requested or a download begins | The supplied URL, request metadata, and any explicitly supplied authentication/cookie material | The requested website and any redirect, media, or resource hosts it directs `yt-dlp` to; use only sources you trust because those addresses can include private-network services |
| Torrent Downloader | While a torrent is active | Torrent identifiers and peer traffic; peers and trackers can observe your IP address | Trackers, DHT participants, and peers |
| Support/source/issue links | Only when clicked | A normal browser visit | Ko-fi or GitHub |

Offline Mode blocks MuxMelt-managed network features and restarts the local
backend with additional socket and DNS restrictions. It is defense in depth,
not an operating-system firewall: native libraries and unrelated software are
outside the app's enforcement boundary. Disconnect networking or use an OS
firewall rule when you require a system-level block.

Selecting browser cookies or a cookies file for the downloader gives `yt-dlp`
access to that authentication material for the requested operation. MuxMelt
does not probe browser profiles when "None" is selected, does not persist
account/proxy secrets, and passes temporary authentication through owner-private
files instead of process arguments. The requested site still receives whatever
credentials you explicitly choose to use.

## Data stored locally

Depending on the enabled features, MuxMelt can store:

- Preferences in Electron's per-user application-data directory.
- Recent output paths, only when Remember Recent Files is enabled.
- Downloaded Python packages and processing models.
- Non-sensitive tool preferences.
- A local completed-output count and support-prompt dismissal preference. This
  only times the optional donation reminder and is never transmitted.
- Temporary processing files, which are normally removed after completion.
- Size-limited local backend diagnostics (`backend.log` and one rotated
  predecessor). The backend token, app-data/home prefixes, and recognizable
  absolute paths are redacted before persistence, but diagnostic text can still
  reveal operational details; logs can be cleared or exported from Settings.

Downloader passwords, cookie choices, and credential-bearing proxy URLs are
session-only and are not written to MuxMelt settings.

Use Settings > Privacy & network and Settings > Storage & private data to
disable history, clear private data, inspect storage, remove optional
components, or open the application-data folder.
Uninstalling a current build may preserve application data so that models do
not need to be downloaded again; delete that data explicitly if you do not want
it retained.

The removed Local Chat feature no longer runs or downloads components. Files
and preferences from older installations are preserved. If a legacy chat engine
is present, Settings lists it as unused storage that you can remove explicitly.
Downloaded models can be cleared with the model-data controls; imported files
outside the app-data folder are not deleted.

## Notifications

Desktop notifications can be shown after a task finishes. The default setting
uses generic text so media filenames are not exposed on a lock screen. You can
turn notifications off or allow detailed text in Settings.

## No sale or advertising profile

MuxMelt does not contain an ad SDK and does not sell personal data. The project
does not operate a MuxMelt analytics or account server. Third-party services
listed above apply their own privacy policies when you deliberately connect to
them.

## Questions

Open a privacy question through the repository's
[issue tracker](https://github.com/CarfoCx/MuxMelt/issues). Do not include
private files, credentials, full local paths, or browser cookies in a report.
