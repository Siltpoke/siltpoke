// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WakeFile {
  schemaVersion: 1;
  expires_at_ms: number;
}

export interface WakeOptions {
  homeBase?: string;
  ttlMs?: number;
  now?: () => Date;
}

export interface WakeResult {
  wake_path: string;
  expires_at_ms: number;
}

const FILENAME = "wake.json";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function siltpokeHome(envHome: string | undefined): string {
  return join(envHome ?? "", ".siltpoke");
}

function wakePath(homeBase: string): string {
  return join(homeBase, FILENAME);
}

export async function runWake(opts: WakeOptions = {}): Promise<WakeResult> {
  const homeBase = opts.homeBase ?? siltpokeHome(process.env.HOME);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => new Date());
  const expires_at_ms = now().getTime() + ttlMs;
  const path = wakePath(homeBase);
  await mkdir(homeBase, { recursive: true });
  const payload: WakeFile = { schemaVersion: 1, expires_at_ms };
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  return { wake_path: path, expires_at_ms };
}

export async function consumeWake(
  homeBase: string,
  now: Date = new Date(),
): Promise<boolean> {
  const path = wakePath(homeBase);
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<WakeFile>;
    await unlink(path);
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.expires_at_ms !== "number"
    ) {
      return false;
    }
    return parsed.expires_at_ms >= now.getTime();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const result = await runWake();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}
