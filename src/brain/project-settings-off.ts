// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Argv for a `claude -p` that runs inside a project folder siltpoke did not
 * choose to trust — chat pinned to a project, Code Map explain, architecture
 * generate. The folder can be any repo the user indexed, including one they
 * cloned and never opened in claude.
 *
 * Without it, `claude -p` loaded the folder's project and local settings:
 * its CLAUDE.md went into the model's context, and its
 * `.claude/settings.json` hooks RAN, with no trust prompt (print mode skips
 * the one an interactive session shows). Measured 2026-10-18 against a planted
 * repo: a SessionStart hook wrote a marker file outside the project; with this
 * argv it did not, and the planted CLAUDE.md was no longer in context
 * (an internal design note).
 *
 * `user` is kept on purpose: it is where a user's auth, proxy and `env`
 * settings live, and dropping it would break claude for anyone who relies on
 * them. Their own CLAUDE.md and hooks therefore still load — the user wrote
 * those, so that is not this risk.
 */
export const PROJECT_SETTINGS_OFF = ["--setting-sources", "user"] as const;
