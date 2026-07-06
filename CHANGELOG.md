# Changelog

All notable changes to siltpoke are documented here.
Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) ·
versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-07-06

### Changed

- **Renamed two features for clarity: "Critic" → "Code Review" and "Repo Graph"
  → "Code Map".** Display-only — same behavior, same commands.

### Fixed

- **The dashboard now works on a fresh install.** Opening it right after
  installing used to show the page but leave every button unresponsive (the
  browser bundle wasn't built yet); the daemon now builds it automatically on
  first launch.
- Documentation fixes: corrected the `bun run report` description, some
  XP/level numbers, and removed a dead UI leftover.

## [0.1.0] - 2026-07-03

### Changed

- **License: relicensed from PolyForm Noncommercial 1.0.0 to PolyForm Perimeter
  1.0.1.** Siltpoke is now usable for any purpose — including inside a for-profit
  company's own work — except building or offering a product that competes with
  it (repackaging, reselling, or hosting a SaaS version). Commercial
  bundling/reselling/hosting still requires a separate license.

### Added

- Initial public release: ambient critic (Stop-hook second opinion on every
  Claude Code turn), persistent memory (facts, episodes, conversational
  capture), statusline pet face, and the dashboard (state card, timeline,
  memory book, chat, repo graph).

[Unreleased]: https://github.com/Victoriakaey/siltpoke/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Victoriakaey/siltpoke/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Victoriakaey/siltpoke/releases/tag/v0.1.0
