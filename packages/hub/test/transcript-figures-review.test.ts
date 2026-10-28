import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@sessiondeck/contract";
import { runCli } from "../src/cli.ts";
import { REBUILD_MAX_LINES, TranscriptDeriver } from "../src/derive/deriver.ts";
import { Ingestor } from "../src/ingest/ingestor.ts";
import { Store } from "../src/db/store.ts";
import { EnvSeq, HEADLESS_SESSION, headlessSession } from "./support/headless.ts";

const quiet = { info: () => undefined, warn: () => undefined };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hub-fig-"));
  dirs.push(d);
  return d;
};

function seeded(dir: string, seq: EnvSeq): string {
  const file = path.join(dir, "hub.sqlite");
  const s = Store.open(file);
  s.migrate();
  new Ingestor(s, quiet, Date.now, { maxOpenSessionsPerHost: 1000 }).ingest(
    seq.host,
    seq.envelopes,
  );
  s.close();
  return file;
}

const costOf = (file: string): number => {
  const s = Store.open(file);
  try {
    const row = s.getSession(HEADLESS_SESSION) as { snapshot: string };
    return (JSON.parse(row.snapshot) as SessionSnapshot).cost.usd as number;
  } finally {
    s.close();
  }
};

describe("R2.12 + R2.9: hub replay prices like serve", () => {
  it("honours HUB_PRICING_FILE, so replay cost equals what the cost route computes", async () => {
    const dir = tmp();
    const file = seeded(dir, headlessSession());
    const out: string[] = [];
    const run = (env: Record<string, string>) =>
      runCli(["replay", "--db", file], env, (l) => out.push(l), quiet);

    expect(await run({})).toBe(0);
    const bundled = costOf(file);
    expect(bundled).toBeGreaterThan(0);

    // Same list with every price doubled.
    const table = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../src/pricing/litellm-claude.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    const doubled = Object.fromEntries(
      Object.entries(table).map(([k, v]) => [
        k,
        Object.fromEntries(
          Object.entries(v).map(([f, x]) => [
            f,
            f.includes("cost") && typeof x === "number" ? x * 2 : x,
          ]),
        ),
      ]),
    );
    const pricingFile = path.join(dir, "pricing.json");
    writeFileSync(pricingFile, JSON.stringify(doubled));

    expect(await run({ HUB_PRICING_FILE: pricingFile })).toBe(0);
    expect(costOf(file)).toBeCloseTo(bundled * 2, 6);
  });
});

describe("R2.12: a rebuild reads a bounded number of lines", () => {
  it("a long transcript without a branch or text is not paged to its start", () => {
    const store = Store.open(":memory:");
    store.migrate();
    const seq = new EnvSeq();
    seq.hook("SessionStart/01-startup.json");
    const rows = Array.from({ length: REBUILD_MAX_LINES * 3 }, (_, i) =>
      JSON.stringify({ type: "user", n: i }),
    );
    seq.transcript(rows, 500);
    new Ingestor(store, quiet, Date.now, { maxOpenSessionsPerHost: 10 }).ingest(
      seq.host,
      seq.envelopes,
    );

    const spy = vi.spyOn(store, "listMainLinesBefore");
    const figures = new TranscriptDeriver(store, quiet).rebuild(HEADLESS_SESSION, "");
    const returned = spy.mock.results.reduce((n, r) => n + (r.value as unknown[]).length, 0);
    expect(returned).toBe(REBUILD_MAX_LINES);
    expect(figures.maxLine).toBe(REBUILD_MAX_LINES * 3 - 1);
    expect(figures.branch).toBeNull();
    store.close();
  });
});
