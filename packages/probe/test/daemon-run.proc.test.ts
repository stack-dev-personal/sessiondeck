import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StubHub, makeHome } from "../scripts/loss-lib.mjs";

const probe = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "probe.mjs");

describe("probe daemon run (R1.4)", () => {
  it("starts, heartbeats to the hub, and exits 0 on SIGTERM", async () => {
    const hub = new StubHub();
    await hub.start();
    const home = makeHome(hub);
    const claude = mkdtempSync(join(tmpdir(), "sd-run-claude-"));
    const child = spawn(process.execPath, [probe, "daemon", "run", "--home", home], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claude, SESSIONDECK_HEARTBEAT_MS: "300" },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      const end = Date.now() + 20_000;
      const beats = (): number =>
        [...hub.accepted.values()].filter(
          (a) =>
            a.kind === "probe" &&
            (a.payload as { type?: string } | undefined)?.type === "heartbeat",
        ).length;
      while (Date.now() < end && beats() === 0) await new Promise((r) => setTimeout(r, 50));
      expect(beats()).toBeGreaterThanOrEqual(1);
      child.kill("SIGTERM");
      const r = await Promise.race([
        exited,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no exit")), 15_000)),
      ]);
      // Windows has no POSIX signals: kill() terminates the process outright.
      if (process.platform !== "win32") expect(r).toEqual({ code: 0, signal: null });
      expect(stderr).not.toMatch(/did not start/);
    } finally {
      child.kill("SIGKILL");
      await hub.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
    }
  });
});
