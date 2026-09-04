// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Interactive stdin that survives `bun run <script>`.
 *
 * `bun run <package.json-script>` runs the command in a subshell, so the real
 * process is a grandchild behind a shell hop. Bun marks the inherited fd as a
 * TTY (`process.stdin.isTTY === true`) but the keyboard data never reaches the
 * grandchild — both `Bun.stdin.stream()` and `process.stdin.on("data")` hang
 * (oven-sh/bun #12222 / #13374 / #15893, confirmed on 1.3.11 / macOS). Reading
 * the controlling terminal directly via `/dev/tty` bypasses the broken hop and
 * works (empirically verified). Since README's first-run command is
 * `bun run setup`, the wizard MUST read from `/dev/tty` or every new user's
 * prompts silently swallow input.
 *
 * `isTTY` only lies about the DATA path, not about interactivity — it is still
 * true iff a human is at a terminal. So it stays the right signal: isTTY →
 * read `/dev/tty` (works whether launched directly or via `bun run`); not a
 * TTY (piped input / CI) → read the real stdin so piped bytes still flow.
 */
import { createReadStream, openSync } from "node:fs";

/** A pull-based byte source: `read()` resolves the next chunk, or `done`. */
export interface ByteSource {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

export interface TtyDeps {
  isTTY: boolean;
  openTty: () => ByteSource;
  openStdin: () => ByteSource;
}

/**
 * Choose where interactive input comes from. isTTY → the controlling terminal
 * (`/dev/tty`), which survives the `bun run` subshell hop; if that can't be
 * opened, fall back to real stdin. Not a TTY → real stdin (piped / CI).
 */
export function selectInputSource(deps: TtyDeps): ByteSource {
  if (deps.isTTY) {
    try {
      return deps.openTty();
    } catch {
      return deps.openStdin();
    }
  }
  return deps.openStdin();
}

/** Line-buffer a byte source into a `readLine()` that returns one line per call. */
export function makeLineReader(source: ByteSource): () => Promise<string> {
  let buffer = "";
  let exhausted = false;
  const decoder = new TextDecoder();
  return async function readLine(): Promise<string> {
    while (!exhausted) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return line;
      }
      const { done, value } = await source.read();
      if (done) {
        exhausted = true;
        break;
      }
      if (value) buffer += decoder.decode(value, { stream: true });
    }
    const line = buffer;
    buffer = "";
    return line;
  };
}

/** Real stdin as a pull-based byte source (Bun's Web-stream reader). */
export function openStdinByteSource(): ByteSource {
  const reader = (Bun.stdin as unknown as { stream: () => ReadableStream<Uint8Array> })
    .stream()
    .getReader();
  return { read: () => reader.read() };
}

interface DataStream {
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  on(event: "end", cb: () => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

/**
 * Adapt a Node readable stream to a pull-based ByteSource. An `"error"` event
 * REJECTS the pending read (so a caller/opener can fall back), and a second
 * concurrent read rejects rather than silently orphaning the first — the
 * single-slot pending design is only safe for serial reads (makeLineReader).
 */
export function streamToByteSource(stream: DataStream): ByteSource {
  const queued: Uint8Array[] = [];
  let ended = false;
  let failed: Error | null = null;
  let resolvePending: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;
  let rejectPending: ((e: Error) => void) | null = null;

  const flush = () => {
    if (!resolvePending) return;
    if (queued.length > 0) {
      const resolve = resolvePending;
      resolvePending = rejectPending = null;
      resolve({ done: false, value: queued.shift() });
    } else if (failed) {
      const reject = rejectPending;
      resolvePending = rejectPending = null;
      reject?.(failed);
    } else if (ended) {
      const resolve = resolvePending;
      resolvePending = rejectPending = null;
      resolve({ done: true });
    }
  };

  stream.on("data", (chunk: Buffer) => {
    queued.push(new Uint8Array(chunk));
    flush();
  });
  stream.on("end", () => {
    ended = true;
    flush();
  });
  stream.on("error", (e: Error) => {
    failed = e;
    flush();
  });

  return {
    read: () =>
      new Promise((resolve, reject) => {
        if (resolvePending) {
          reject(
            new Error("streamToByteSource: a read is already in progress (concurrent reads unsupported)"),
          );
          return;
        }
        resolvePending = resolve;
        rejectPending = reject;
        flush();
      }),
  };
}

/**
 * `/dev/tty` as a pull-based byte source. Opens with `openSync` FIRST so an
 * unopenable controlling terminal (ENXIO/EACCES — detached session, some
 * CI/containers where isTTY is true but no real tty is attached) throws
 * SYNCHRONOUSLY, letting selectInputSource's try/catch fall back to stdin.
 * (createReadStream fails via an async "error" event, which the caller's
 * sync catch cannot see — so probing with openSync is what makes the
 * documented fallback actually work.)
 */
export function openTtyByteSource(): ByteSource {
  const fd = openSync("/dev/tty", "r");
  return streamToByteSource(createReadStream("", { fd }) as unknown as DataStream);
}

/** The production `readLine` used by the installer wizard. */
export function realTtyReadLine(): () => Promise<string> {
  const source = selectInputSource({
    isTTY: process.stdin.isTTY === true,
    openTty: openTtyByteSource,
    openStdin: openStdinByteSource,
  });
  return makeLineReader(source);
}
