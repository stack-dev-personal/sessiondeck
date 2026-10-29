import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { SCREENS_DIR } from "./screens-dir";

/** Writes SCREENS_DIR/summary-mock.json (or summary-live.json in live mode): per requirement, pass/fail and its screenshot files. */
export default class SummaryReporter implements Reporter {
  private readonly results = new Map<string, { status: string; titles: string[] }>();

  onTestEnd(test: TestCase, result: TestResult): void {
    const m = /^(R\d+\.\d+)/.exec(test.title);
    if (!m) return;
    const id = m[1]!;
    const prev = this.results.get(id) ?? { status: "passed", titles: [] };
    if (result.status !== "passed") prev.status = result.status;
    prev.titles.push(test.title);
    this.results.set(id, prev);
  }

  onEnd(): void {
    mkdirSync(SCREENS_DIR, { recursive: true });
    const files = existsSync(SCREENS_DIR) ? readdirSync(SCREENS_DIR) : [];
    const requirements = [...this.results.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([id, r]) => ({
        requirement: id,
        result: r.status === "passed" ? "pass" : "fail",
        tests: r.titles,
        screenshots: files.filter((f) => f.startsWith(id) && f.endsWith(".png")).sort(),
      }));
    writeFileSync(
      join(SCREENS_DIR, process.env["SD_E2E_HUB_URL"] ? "summary-live.json" : "summary-mock.json"),
      JSON.stringify({ viewport: "1440x900", requirements }, null, 2),
    );
  }
}
