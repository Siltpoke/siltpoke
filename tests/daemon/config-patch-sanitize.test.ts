// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `POST /api/config` writes to the user's `~/.siltpoke/config.json`, and this
 * is the function standing between a request body and that file.
 */
import { describe, expect, test } from "bun:test";
import { sanitizeConfigPatch } from "../../src/daemon/routes/dashboard";

describe("sanitizeConfigPatch", () => {
  test("drops keys that are not writable", () => {
    // `triggerMode` is the specific one that matters: AC11 says the old key is
    // never rewritten on disk, and the way that holds is that nothing can put
    // it in a patch.
    expect(sanitizeConfigPatch({ triggerMode: "gates" })).toEqual({});
    expect(sanitizeConfigPatch({ budget: "anything" })).toEqual({});
  });

  test("reviewUnit accepts only the two units", () => {
    expect(sanitizeConfigPatch({ reviewUnit: "commit" })).toEqual({ reviewUnit: "commit" });
    expect(sanitizeConfigPatch({ reviewUnit: "pr" })).toEqual({ reviewUnit: "pr" });
  });

  test("reviewUnit rejects anything else instead of storing it", () => {
    // `parseReviewUnit` reads anything-but-"pr" as "commit", so a junk value
    // could never crash. It WOULD be written to config.json and then rendered
    // back into the dashboard's own select as a value that silently means
    // something else. The generic string branch above this one used to accept
    // it — any string up to 200 characters.
    expect(sanitizeConfigPatch({ reviewUnit: "banana" })).toEqual({});
    expect(sanitizeConfigPatch({ reviewUnit: "gates" })).toEqual({});
    expect(sanitizeConfigPatch({ reviewUnit: "" })).toEqual({});
    expect(sanitizeConfigPatch({ reviewUnit: 3 })).toEqual({});
    expect(sanitizeConfigPatch({ reviewUnit: null })).toEqual({});
  });

  test("a rejected key does not take a valid one down with it", () => {
    expect(sanitizeConfigPatch({ reviewUnit: "banana", name: "Mochi" })).toEqual({
      name: "Mochi",
    });
  });

  test("personality dials stay clamped and rounded", () => {
    expect(sanitizeConfigPatch({ snark: 7.4 })).toEqual({ snark: 7 });
    expect(sanitizeConfigPatch({ snark: 11 })).toEqual({});
    expect(sanitizeConfigPatch({ snark: -1 })).toEqual({});
    expect(sanitizeConfigPatch({ snark: "loud" })).toEqual({});
  });
});
