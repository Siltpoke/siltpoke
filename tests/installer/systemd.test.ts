import { describe, test, expect } from "bun:test";
import { renderUnit } from "../../src/installer/systemd";

describe("renderUnit", () => {
  test("includes absolute bun + daemon script paths in ExecStart", () => {
    const unit = renderUnit({
      bunPath: "/home/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
    });
    expect(unit).toContain("ExecStart=/home/x/.bun/bin/bun /abs/cli/daemon.ts start");
  });

  test("sets Restart=always and RestartSec=10", () => {
    const unit = renderUnit({ bunPath: "/x", daemonScript: "/y" });
    expect(unit).toMatch(/Restart=always/);
    expect(unit).toMatch(/RestartSec=10/);
  });

  test("has [Unit], [Service], [Install] sections", () => {
    const unit = renderUnit({ bunPath: "/x", daemonScript: "/y" });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("escapes spaces in ExecStart paths", () => {
    const unit = renderUnit({
      bunPath: "/Users/a b/.bun/bin/bun",
      daemonScript: "/abs path/cli/daemon.ts",
    });
    expect(unit).toContain(
      "ExecStart=/Users/a\\x20b/.bun/bin/bun /abs\\x20path/cli/daemon.ts start",
    );
  });
});
