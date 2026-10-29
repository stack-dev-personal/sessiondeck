// probe install keeps the probe.json archive block, valid or not (R5.2, R5.3).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, runCli, sandbox, writeText } from "./fixtures/sandbox.ts";

describe("probe install and the archive block", () => {
  const abs = process.platform === "win32" ? "C:/vault" : "/vault";
  it.each([
    ["valid", { roots: [{ label: "v", path: abs }], intervalSec: 60 }],
    [
      "invalid (relative path, small interval)",
      { roots: [{ label: "v", path: "rel" }], intervalSec: 5 },
    ],
  ])("keeps a %s block across install --hub", async (_n, block) => {
    const sb = sandbox();
    mkdirSync(sb.home, { recursive: true });
    writeText(join(sb.home, "probe.json"), JSON.stringify({ host: "h1", archive: block }));
    const r = await runCli(["install", "--hub", "http://127.0.0.1:1"], sb.env);
    expect(r.code, r.stderr).toBe(0);
    const cfg = readJson(join(sb.home, "probe.json"));
    expect(cfg.hubUrl).toBe("http://127.0.0.1:1");
    expect(cfg.archive).toEqual(block);
    // And config show still works with the bad block.
    const show = await runCli(["config", "show"], sb.env);
    expect(show.code, show.stderr).toBe(0);
  });
});
