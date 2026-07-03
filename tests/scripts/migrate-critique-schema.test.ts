import { describe, test, expect } from "bun:test";
import { migrateCritiqueFile } from "../../scripts/migrate-critique-schema";

describe("migrateCritiqueFile", () => {
  test("v1 critique frontmatter gets v2 fields with defaults", () => {
    const v1md = `---
id: c-abc
severity: medium
confidence: high
---
body here`;
    const v2 = migrateCritiqueFile(v1md);
    expect(v2).toContain("schema_version: 2");
    expect(v2).toContain("category: ");
    expect(v2).toContain("intent_classification: ");
    expect(v2).toContain("body here");
  });

  test("already v2 → idempotent (no double migration)", () => {
    const v2md = `---
schema_version: 2
id: c-abc
severity: medium
confidence: high
category: correctness
intent_classification: exploration
---
body`;
    expect(migrateCritiqueFile(v2md)).toBe(v2md);
  });
});
