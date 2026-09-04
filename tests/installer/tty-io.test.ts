// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { test, expect } from "bun:test";
import {
  makeLineReader,
  selectInputSource,
  streamToByteSource,
  type ByteSource,
} from "../../src/installer/tty-io";

function fakeSource(chunks: readonly string[]): ByteSource {
  let i = 0;
  return {
    read: async () => {
      if (i >= chunks.length) return { done: true };
      const s = chunks[i++] ?? "";
      return { done: false, value: new TextEncoder().encode(s) };
    },
  };
}

test("makeLineReader returns one line per call, splitting on newline", async () => {
  const readLine = makeLineReader(fakeSource(["foo\nbar\n"]));
  expect(await readLine()).toBe("foo");
  expect(await readLine()).toBe("bar");
});

test("makeLineReader joins a line split across two source chunks", async () => {
  const readLine = makeLineReader(fakeSource(["fo", "o\nba", "r\n"]));
  expect(await readLine()).toBe("foo");
  expect(await readLine()).toBe("bar");
});

test("makeLineReader returns the trailing buffer when the source ends without a newline", async () => {
  const readLine = makeLineReader(fakeSource(["last"]));
  expect(await readLine()).toBe("last");
});

test("selectInputSource reads from the tty when stdin is a tty (interactive)", () => {
  let ttyOpened = false;
  let stdinOpened = false;
  selectInputSource({
    isTTY: true,
    openTty: () => {
      ttyOpened = true;
      return fakeSource([]);
    },
    openStdin: () => {
      stdinOpened = true;
      return fakeSource([]);
    },
  });
  expect(ttyOpened).toBe(true);
  expect(stdinOpened).toBe(false);
});

test("selectInputSource falls back to stdin when opening the tty throws", () => {
  let stdinOpened = false;
  selectInputSource({
    isTTY: true,
    openTty: () => {
      throw new Error("no controlling tty");
    },
    openStdin: () => {
      stdinOpened = true;
      return fakeSource([]);
    },
  });
  expect(stdinOpened).toBe(true);
});

test("selectInputSource reads from stdin when not a tty (piped / CI)", () => {
  let ttyOpened = false;
  let stdinOpened = false;
  selectInputSource({
    isTTY: false,
    openTty: () => {
      ttyOpened = true;
      return fakeSource([]);
    },
    openStdin: () => {
      stdinOpened = true;
      return fakeSource([]);
    },
  });
  expect(ttyOpened).toBe(false);
  expect(stdinOpened).toBe(true);
});

// --- streamToByteSource: the event→pull adapter behind openTtyByteSource ---

interface FakeStream {
  on(ev: string, cb: (arg?: unknown) => void): FakeStream;
  emit(ev: string, arg?: unknown): void;
}
function fakeStream(): FakeStream {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  return {
    on(ev, cb) {
      if (!handlers[ev]) handlers[ev] = [];
      handlers[ev].push(cb);
      return this;
    },
    emit(ev, arg) {
      for (const cb of handlers[ev] ?? []) cb(arg);
    },
  };
}

test("streamToByteSource yields queued data chunks in order", async () => {
  const s = fakeStream();
  const src = streamToByteSource(s as never);
  const p = src.read();
  s.emit("data", Buffer.from("hi"));
  expect(await p).toEqual({ done: false, value: new Uint8Array([104, 105]) });
});

test("streamToByteSource reports end after the stream ends", async () => {
  const s = fakeStream();
  const src = streamToByteSource(s as never);
  const p = src.read();
  s.emit("end");
  expect(await p).toEqual({ done: true });
});

test("streamToByteSource rejects a pending read on an error event (enables fallback)", async () => {
  const s = fakeStream();
  const src = streamToByteSource(s as never);
  const p = src.read();
  s.emit("error", new Error("ENXIO: no such device or address"));
  await expect(p).rejects.toThrow("ENXIO");
});

test("streamToByteSource rejects a concurrent second read instead of orphaning the first", async () => {
  const s = fakeStream();
  const src = streamToByteSource(s as never);
  const p1 = src.read();
  const p2 = src.read();
  await expect(p2).rejects.toThrow(/concurrent|in progress|busy/i);
  // the first read is still live and resolves normally
  s.emit("data", Buffer.from("x"));
  expect(await p1).toEqual({ done: false, value: new Uint8Array([120]) });
});
