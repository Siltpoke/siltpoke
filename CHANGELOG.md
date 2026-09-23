# Changelog

All notable changes to siltpoke are documented here.
Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) ·
versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-09-23

### Added

- **Setup asks whether another company's model should review Claude's code.**
  If `codex`, `agy`, `qodercli` or `codebuddy` is on your PATH, setup offers it
  once as the reviewer — a second opinion that does not share Claude's blind
  spots, paid from that CLI's own quota. It also says what is not known: reviews
  stop if you log out of that CLI, and siltpoke has not yet measured how good
  each reviewer is. Picking agy adds one caveat — agy can run Claude models, and
  if it does, it is still Claude reviewing Claude. Express setup does not ask; it
  names the command in its closing report.

### Fixed

- **Codex can install siltpoke again.** Since 1.1.0 `codex plugin add
  siltpoke@siltpoke` failed with "plugin `siltpoke` was not found in
  marketplace `siltpoke`". The repository now also carries a Codex-specific
  marketplace file, which Codex reads first.
- **Reviews now fire on machines where bun is not on the PATH your hooks get.**
  bun's installer writes its PATH line into `~/.bash_profile`, which only a
  login shell reads — and the host runs hooks in a non-login shell. So the hook
  exited in silence on every single turn: no review, ever, while the pet, the
  config file and the statusline all said the install was fine. Setup now
  records bun's absolute path, and every hook looks there before giving up.
- **A statusline that cannot find bun says so, instead of rendering nothing.**
  Previously the pet simply never appeared, with no way to learn why.
- **Upgrading the plugin now reaches your statusline.** The two small scripts
  under `~/.siltpoke/bin/` are generated, and only setup ever wrote them — so a
  fix could ship while your machine kept running a months-old copy. A session
  now brings them back in step whenever they differ from the current version.
- **Every command siltpoke writes into a host's config names bun by absolute
  path.** Seven places wrote a bare `bun`, including the diagnostic command
  whose whole job is to explain what is broken; all of them are run later by the
  host, in the same non-login shell that could not find bun in the first place.
- **Installing the background service no longer claims "bun not found in PATH"
  while bun is plainly running.** It asked the installing shell where bun was,
  instead of the process it was running inside.
- **The diagnostic stops reporting a healthy plugin install as broken**, and it
  now runs the statusline for real — twice, once with your shell's PATH and once
  with only the system PATH — so it catches a pet that works when you try it by
  hand and not when the host does it.
- **The hook no longer tells you to run setup when setup is not the problem.**

## [1.1.0] - 2026-09-22

### Added

- **A review comes back as separate findings you can point at**, instead of one
  paragraph. Each finding carries its own title, severity, file, the lines it is
  about, and a verbatim quote of the code — and says whether that quote came
  from this change or from the file around it. A line number is left out rather
  than guessed.
- **Code Map indexes the folder you picked**, not the whole repository around
  it. Indexing a sub-folder of a repo now lands on that repo's map instead of
  starting a second one.
- **Chat says which stage it is waiting in** rather than sitting silent, and
  replies with a faster model by default.

### Changed

- **Nothing is shown as current when it is not.** Stale state on the dashboard
  is labelled as stale instead of rendered like fresh data.
- **Setup says what it did.** It used to finish in silence, which read as a
  failure.
- The Code Map quiz and the timeline's review-unit control are gone from the UI.
- The README, the manual and the dashboard no longer say that dismissing a
  review teaches the reviewer. It does not, yet.

### Fixed

- **The published dashboard shipped without its JavaScript**, so every
  interaction on it was dead — menus, search, chat, the lot. The browser bundle
  and its stylesheet now ship with the plugin.
- **Review, explain and dashboard chat all failed on a clean install.** The
  reviewer was asked for one shape of output and sent another; nothing on a
  fresh machine worked until it was fixed.
- **A review can no longer succeed and say nothing.** An empty critique is
  reported as empty, with the reason, instead of handing you a blank code block.
- **A failed review tells you why.** The reason used to be dropped on its way
  out, and the dashboard pasted raw JSON at you instead.
- **A brand-new install no longer reports itself broken**: `/siltpoke-doctor`
  stopped failing a check that is correct to be absent, stopped auditing a host
  you are not using, and now checks that the statusline it installed can start.
- **The Windows statusline can start.** It was installed with an interpreter
  Windows does not have.
- **The pet no longer calls itself hungry and well-fed on the same screen.**
- **`/siltpoke-menubar status` tells you whether the pet is actually showing** —
  whether SwiftBar is running, and which folder it reads — instead of only
  whether a file exists.
- **One daemon port**, read the same way everywhere, and Siltpoke no longer
  mistakes another program holding that port for itself.
- **Antigravity users get a setup path**, and each host's first-run nudge names
  a command that host really has.
- **The Codex install command in the README works when you paste it.**
- **The dashboard stopped pointing at commands that do not exist.**
- **A quoted line of real code is no longer thrown out as fabricated** when the
  quote spans several lines, and the rule engine now passes the code it
  collected on to the rules that need it.
- **An empty corpus is reported as "nothing to judge"**, not as a verdict about
  your code.
- **Installing gets you the release.** `/plugin install` used to fetch whatever
  was on the default branch, which could be newer than the release it reported
  itself as; the marketplace entry now points at the release tag.

## [1.0.0] - 2026-09-03

### Added

- **Siltpoke installs into Codex, CodeBuddy, Qoder and Antigravity too** —
  plugin-native on each, reviews included, no source clone.
- **Pick which CLI and model reviews your code**, per host you build with —
  `/siltpoke-brain`, or a Settings page on the dashboard. A non-Claude host
  now reviews with its own model instead of needing Claude.
- **A macOS menu-bar pet** (`/siltpoke-menubar`) — pending reviews across every
  session, tagged by repo and branch.
- **Tell the pet something in plain chat and it remembers** — "remember I use
  pnpm, not npm" saves a real fact. Correcting it works the same way.
- **Your Memory Book has an Episodic section** — a day's coding moments grouped
  into a short narrative, not a scatter of one-line events.
- **See what changed in a repo since YOU last looked** — for when the agent
  wrote code while you weren't watching and you lost the thread.
- **A dark mode**, following your system by default.

### Changed

- **Reviews now fire when you finish a piece of work, not when the agent stops
  talking.** The old trigger stopped 2 of 39,422 real events; two of its four
  settings needed a command that no longer exists.
- **Installing is a plugin install** — no more `git clone` + `bun install` + a
  20-question terminal wizard. `/siltpoke-setup` has an express path: one
  confirmation for a default pet.
- **The background daemon is opt-in** (default off) — installing no longer
  starts a server you didn't ask for. Reviews don't need it.
- **Two commands renamed for accuracy**: `/siltpoke-report` →
  `/siltpoke-dashboard`, `/siltpoke-report-stop` → `/siltpoke-restart-daemon`.

### Fixed

- **Reviews actually run on CodeBuddy and Antigravity.** Both installed, both
  fired their hook, and both silently reviewed nothing — each reads its
  transcript in a shape Siltpoke did not understand.
- **The Memory Book shows the reviews written about the repo you are looking
  at.** It had been asking Siltpoke's home folder, which holds almost none.
- **A review is no longer thrown away because one citation came back
  malformed** — the bad citation is dropped, the findings survive.
- **The pet no longer comes back forgetful or mute after a reboot.**
- **Siltpoke stopped silently discarding most of what it learned** because of
  how the sentences were phrased.
- **Siltpoke stopped reviewing your build logs and scratch files** as if they
  were source code.
- **Siltpoke can learn from a session you started outside the repo** — it used
  to record its starting point against a folder that was not a repository, and
  then learn nothing for the rest of that session.
- **Windows setup no longer crashes** with `EPERM: operation not permitted,
  symlink`.
- **One oversized legacy rule no longer wipes your pet's memory on upgrade.**

## [0.1.1] - 2026-07-06

### Changed

- **Renamed two features for clarity: "Critic" → "Code Review" and "Repo Graph"
  → "Code Map".** Display-only — same behavior, same commands.

### Fixed

- **The dashboard now works on a fresh install.** Opening it right after
  installing used to show the page but leave every button unresponsive (the
  browser bundle wasn't built yet); the daemon now builds that on first launch.
  Its stylesheet was a second, separate hole — never built and never published,
  so every release up to and including 0.1.1 served a dashboard missing its
  layout layer, which collapsed the chat panel into unstyled text at the foot
  of the page. The stylesheet now ships with the release, and publishing fails
  rather than proceeds if it or any other asset the pages ask for is absent.
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

[Unreleased]: https://github.com/Siltpoke/siltpoke/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Siltpoke/siltpoke/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/Siltpoke/siltpoke/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Siltpoke/siltpoke/releases/tag/v0.1.0
