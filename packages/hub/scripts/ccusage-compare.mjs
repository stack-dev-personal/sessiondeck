#!/usr/bin/env node
// R2.10 comparison harness: ccusage v19.0.3 `session --json` and `daily --json` against the hub's
// cost history for the same transcripts, both pricing from the same file, no network.
//
//   node scripts/ccusage-compare.mjs <dir> [--pricing <file>] [--ccusage <dist/index.js>]
//        [--tz UTC,Asia/Tokyo] [--tolerance 1] [--write-expected <file>]
//
// <dir> is laid out like CLAUDE_CONFIG_DIR (projects/<project>/<session>.jsonl and
// projects/<project>/<session>/subagents/*.jsonl). --pricing defaults to <dir>/pricing.json.
// ccusage runs as a child process with CLAUDE_CONFIG_DIR=<dir>, HOME pointed at an empty temp dir
// (no other agents' data) and `--import scripts/ccusage-fetch-shim.mjs`, which serves the LiteLLM
// URL from the pricing file and refuses any other fetch. Exit code is non-zero when any cost delta
// exceeds the tolerance (percent) or any token count differs. ccusage prices all cache writes at the
// 5-minute rate and the hub prices 1-hour writes at the 1-hour rate (decision 25), so each row's
// expected delta (hub split cost minus hub 5-minute-only cost) is subtracted before the tolerance
// check; the per-row figures include delta_exp and resid.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import * as prettier from "prettier";
import { expectedDelta, judgeCost, pct } from "./compare-delta.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const pricingArg = opt("--pricing");
const ccusage = opt("--ccusage", "/tmp/sd-s4-refs/ccusage-npm/package/dist/index.js");
const tzList = opt("--tz", "UTC").split(",");
const orders = opt("--order", "file,late").split(",");
const tolerance = Number(opt("--tolerance", "1"));
const writeExpected = opt("--write-expected");
const dir = args[0] ? path.resolve(args[0]) : null;
if (!dir) {
  console.error(
    "usage: ccusage-compare.mjs <dir> [--pricing f] [--ccusage cli] [--tz a,b] [--tolerance pct] [--write-expected f]",
  );
  process.exit(2);
}
const pricing = path.resolve(pricingArg ?? path.join(dir, "pricing.json"));

const tmp = mkdtempSync(path.join(os.tmpdir(), "sd-compare-"));
try {
  // Bundle the hub half (TypeScript, extensionless contract imports) the way bundle.mjs does.
  const outfile = path.join(here, "..", "dist", "compare-hub.mjs"); // inside the package so node_modules resolves
  await build({
    entryPoints: [path.join(here, "compare-hub.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["better-sqlite3", "fastify", "ws"],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: "warning",
    absWorkingDir: path.join(here, ".."),
  });
  const { hubReport } = await import(pathToFileURL(outfile).href);

  const runCcusage = (cmd, tz) => {
    const home = mkdtempSync(path.join(tmp, "home-"));
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(here, "ccusage-fetch-shim.mjs"),
        ccusage,
        cmd,
        "--json",
        "--timezone",
        tz,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: dir,
          CCUSAGE_COMPARE_PRICING: pricing,
          NO_COLOR: "1",
        },
        encoding: "utf8",
        maxBuffer: 64 << 20,
      },
    );
    if (r.status !== 0) throw new Error(`ccusage ${cmd} failed (${r.status}): ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const norm = (r) => ({
    id: r.period,
    input: r.inputTokens,
    output: r.outputTokens,
    cacheCreation: r.cacheCreationTokens,
    cacheRead: r.cacheReadTokens,
    cost: r.totalCost,
    models: [...r.modelsUsed],
  });
  const normHub = (r, id) => ({
    id,
    input: r.input_tokens,
    output: r.output_tokens,
    cacheCreation: r.cache_creation_tokens,
    cacheRead: r.cache_read_tokens,
    cost: r.cost_usd,
    models: [...r.models],
  });

  let failures = 0;
  const expected = {};
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(6) : String(n));
  const compare = (title, ref, hubRows, legacyRows) => {
    console.log(`\n${title}`);
    console.log(
      [
        "id",
        "ccusage_usd",
        "hub_usd",
        "delta_%",
        "d_in",
        "d_out",
        "d_cc",
        "d_cr",
        "delta_exp",
        "resid",
        "models",
        "ok",
      ].join("\t"),
    );
    const ids = new Set([...ref.map((r) => r.id), ...hubRows.map((r) => r.id)]);
    for (const id of [...ids].sort()) {
      const c = ref.find((r) => r.id === id);
      const h = hubRows.find((r) => r.id === id);
      if (!c || !h) {
        failures++;
        console.log(
          `${id}\t${c ? "present" : "MISSING"}\t${h ? "present" : "MISSING"}\t\t\t\t\t\t\t\t\tFAIL`,
        );
        continue;
      }
      const lg = legacyRows.find((r) => r.id === id);
      const delta = lg ? expectedDelta(h.cost, lg.cost) : 0;
      const j = judgeCost({ hub: h.cost, cc: c.cost, delta, tolerancePct: tolerance });
      const d = pct(h.cost - delta, c.cost);
      const dt = [
        h.input - c.input,
        h.output - c.output,
        h.cacheCreation - c.cacheCreation,
        h.cacheRead - c.cacheRead,
      ];
      const modelsOk = JSON.stringify(h.models) === JSON.stringify(c.models);
      const ok = j.ok && dt.every((x) => x === 0) && modelsOk;
      if (!ok) failures++;
      console.log(
        [
          id,
          fmt(c.cost),
          fmt(h.cost),
          fmt(d),
          ...dt,
          fmt(delta),
          `${j.residual.toExponential(2)}${j.exact ? "" : "!"}`,
          modelsOk ? "same" : "DIFF",
          ok ? "ok" : "FAIL",
        ].join("\t"),
      );
    }
  };

  for (const tz of tzList) {
    const sess = runCcusage("session", tz);
    const daily = runCcusage("daily", tz);
    const cSess = sess.session.map(norm);
    const cDay = daily.daily.map(norm);
    for (const order of orders) {
      const hub = await hubReport({ dir, pricingFile: pricing, tz, order });
      const legacy = await hubReport({
        dir,
        pricingFile: pricing,
        tz,
        order,
        legacyCacheWrites: true,
      });
      console.log(`\n=== timezone ${tz}  arrival order ${order}  tolerance ${tolerance}% ===`);
      compare(
        "per session: ccusage session vs hub GET /history/sessions",
        cSess,
        hub.sessions.map((s) => normHub(s, s.session_id)),
        legacy.sessions.map((s) => normHub(s, s.session_id)),
      );
      compare(
        "per session: ccusage session vs hub GET /sessions/:id/cost",
        cSess,
        Object.entries(hub.sessionCost).map(([id, s]) => normHub(s, id)),
        Object.entries(legacy.sessionCost).map(([id, s]) => normHub(s, id)),
      );
      compare(
        "per day: ccusage daily vs hub GET /history/daily",
        cDay,
        hub.days.map((d) => normHub(d, d.date)),
        legacy.days.map((d) => normHub(d, d.date)),
      );
    }
    expected[tz] = { sessions: cSess, days: cDay };
  }

  if (writeExpected) {
    const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
    const json = JSON.stringify(
      {
        provenance: {
          generator: "packages/hub/scripts/ccusage-compare.mjs --write-expected",
          ccusage: "ccusage 19.0.3 (npm), `session --json` and `daily --json --timezone <tz>`",
          ccusage_license: "MIT, Copyright (c) 2025 ryoppippi",
          pricing_file: path.basename(pricing),
          pricing_sha256: sha(pricing),
          generated: new Date().toISOString(),
        },
        byTimezone: expected,
      },
      null,
      1,
    );
    // Format with the repo's prettier config so `pnpm format:check` passes on the output.
    const target = path.resolve(writeExpected);
    const cfg = (await prettier.resolveConfig(target)) ?? {};
    writeFileSync(target, await prettier.format(json, { ...cfg, filepath: target }));
    console.log(`\nwrote ${writeExpected}`);
  }
  console.log(
    failures === 0
      ? "\nPASS: all deltas within tolerance"
      : `\nFAIL: ${failures} row(s) outside tolerance`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
