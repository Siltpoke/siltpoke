// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

type Exec = (cmd: string, args: string[]) => { status: number; stdout: string };

/**
 * The macOS account's home from the user database (`id -P`, field 9), or null
 * when it cannot be read. Not `os.userInfo().homedir`: under Bun that returns
 * `$HOME` (measured 2026-10-05), which is the very value being checked.
 *
 * Why anything needs it: `defaults`, `launchctl`, `killall` and `open` act on
 * the ACCOUNT, whatever `HOME` says. Under any other home (a sandbox, a test,
 * `HOME=… siltpoke`) following them reads or changes a different home's
 * SwiftBar — defects `[66]` (uninstall, the read side) and `[71]` (setup).
 */
export function accountHome(exec: Exec): string | null {
  const r = exec("/usr/bin/id", ["-P"]);
  // name:passwd:uid:gid:class:change:expire:gecos:home:shell — counted from the
  // END, because the gecos field (the person's full name) may hold a colon.
  const fields = r.status === 0 ? r.stdout.trim().split(":") : [];
  const home = fields.length >= 10 ? fields[fields.length - 2] : undefined;
  return home?.startsWith("/") ? home.replace(/\/+$/, "") : null;
}

/** What a menu-bar command says instead of acting, when `HOME` is not the account's home. */
export function notThisAccount(home: string, account: string): string {
  return `HOME (${home || "not set"}) is not this macOS account's home (${account}), and the menu bar belongs to the account.`;
}

/**
 * The account's home when `home` is a DIFFERENT folder, else null. Null also
 * when the account's home cannot be read: unknown is not a mismatch. Links are
 * followed where both folders are on disk, so two spellings of one folder
 * (`/var/…` and `/private/var/…`) are one home.
 */
export function otherAccountHome(home: string, exec: Exec): string | null {
  const account = accountHome(exec);
  if (account === null || home.replace(/\/+$/, "") === account) return null;
  try {
    if (realpathSync(home) === realpathSync(account)) return null;
  } catch {
    // One of them is not on disk: the spelling is all there is to compare.
  }
  return account;
}

/** Real `id -P`, with stdout — the default probe for `otherAccountHome`. */
export const realAccountProbe: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: typeof r.stdout === "string" ? r.stdout : "" };
};

/**
 * What an uninstall prints when it removed files under a home that is not the
 * account's own and therefore did NOT ask launchd to stop the service — launchd
 * answers for the account (`gui/<uid>`), whatever `HOME` says, so a bootout
 * from here would stop the real account's daemon / login item (defect `[86]`).
 */
export function leftRunningNote(what: string, home: string, account: string): string {
  return `  left the ${what} alone (not stopped): it belongs to the account whose home is ${account}, not to this HOME (${home || "not set"}). Only the files under this HOME were removed.\n`;
}
