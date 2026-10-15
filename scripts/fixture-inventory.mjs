#!/usr/bin/env node
/**
 * Fixture inventory (R0.7 tooling): event -> count -> distinct top-level key sets.
 * Prints key names and counts only, never values.
 *
 *   node scripts/fixture-inventory.mjs [captureDir] [--shapes]
 *
 * captureDir defaults to packages/contract/fixtures/raw. --shapes also lists nested key paths
 * with value types. An event with zero captures is simply absent from the list.
 */
import { existsSync } from "node:fs";
import { buildInventory } from "./lib/fixture-inventory-core.mjs";
import { RAW_ROOT } from "./lib/fixture-files.mjs";

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith("--"));
const root = dirArg ?? RAW_ROOT;
if (!existsSync(root)) {
  console.error("fixture-inventory: capture directory not found");
  process.exit(2);
}
process.stdout.write(buildInventory(root, { shapes: args.includes("--shapes") }).text);
