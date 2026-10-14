import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONTRACT_DIR = fileURLToPath(new URL("..", import.meta.url));
const MAX_ASCII = 0x7f;

async function unitFiles(folder: string): Promise<string[]> {
  const names = await readdir(join(CONTRACT_DIR, folder));
  return names.filter((name) => name.startsWith("state-file")).map((name) => join(folder, name));
}

// An invisible character (a BOM literal, a smart quote) cannot be seen in review, so the unit
// spells such characters as escapes and stays pure ASCII.
describe("the state-file unit is pure ASCII", () => {
  it("has no byte above 0x7f in any source or test file", async () => {
    const files = [...(await unitFiles("src")), ...(await unitFiles("test"))];
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const bytes = await readFile(join(CONTRACT_DIR, file));
      const at = bytes.findIndex((byte) => byte > MAX_ASCII);
      if (at >= 0) offenders.push(`${file} at byte ${at}`);
    }
    expect(offenders).toEqual([]);
  });
});
