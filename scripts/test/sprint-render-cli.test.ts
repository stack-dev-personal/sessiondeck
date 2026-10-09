import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, loadSources, parseArgs, runCli } from "../sprint/render-prompt.mjs";
import { cleanupTempDirs, makeTempDir } from "./helpers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(repoRoot, "scripts", "sprint", "render-prompt.mjs");
const SHA = "0123abc";
const real = loadSources(repoRoot);

afterEach(cleanupTempDirs);

interface CliResult {
  code: number;
  out: string;
  err: string;
}

function cli(argv: string[]): CliResult {
  let out = "";
  let err = "";
  const code = runCli({
    argv,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    defaultRoot: repoRoot,
  });
  return { code, out, err };
}

/** A temp repo root holding the two inputs, optionally with CRLF endings. */
function fakeRoot(crlf: boolean): string {
  const root = makeTempDir();
  const eol = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
  writeFileSync(join(root, "PROMPT-BOOK.md"), eol(real.promptBook));
  writeFileSync(join(root, "MINI-SPRINT-ORDER.md"), eol(real.order));
  return root;
}

describe("sprint renderer cli: arguments", () => {
  it("parses every flag", () => {
    expect(
      parseArgs([
        "--sprint",
        "1",
        "--contract-sha",
        SHA,
        "--out",
        "x.md",
        "--repo-root",
        "r",
        "--package-json",
      ]),
    ).toEqual({ sprint: "1", contractSha: SHA, out: "x.md", repoRoot: "r", packageJson: true });
  });

  it.each([
    [["--sprint", "1", "--bogus"], "unknown argument"],
    [["--sprint"], "needs a value"],
    [["--sprint", "--out", "x"], "needs a value"],
    [["--sprint", "1", "--sprint", "2"], "more than once"],
    [["1"], "unknown argument"],
    [[], "--sprint is required"],
  ])("rejects %j with a usage error", (argv, text) => {
    const r = cli(argv);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.out).toBe("");
    expect(r.err).toContain(text);
  });
});

describe("sprint renderer cli: output and exit codes", () => {
  it("prints the prompt to stdout and exits 0", () => {
    const r = cli(["--sprint", "1", "--contract-sha", SHA]);
    expect(r).toMatchObject({ code: EXIT.OK, err: "" });
    expect(r.out).toContain("sprint/1-mvp");
  });

  it("prints the smoke prompt", () => {
    expect(cli(["--sprint", "smoke"]).out).toBe(
      "write /state/smoke/status.json with state green and exit\n",
    );
  });

  it("prints package json for the launcher", () => {
    const zero = JSON.parse(cli(["--sprint", "0", "--package-json"]).out);
    expect(zero.runs_in).toBe("local");
    const one = JSON.parse(cli(["--sprint", "1", "--package-json"]).out);
    expect(one.runs_in).toBe("container");
    expect(one.sessions).toHaveLength(6);
  });

  it("exits 2 for an unknown sprint and lists the valid ids", () => {
    const r = cli(["--sprint", "7", "--contract-sha", SHA]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain("0, 1, 2, 3, 4, 5, smoke");
  });

  it("exits 2 when sprint 1 has no contract sha", () => {
    const r = cli(["--sprint", "1"]);
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.err).toContain("--contract-sha");
  });

  it("exits 3 for a damaged input and names the file", () => {
    const root = fakeRoot(false);
    writeFileSync(
      join(root, "PROMPT-BOOK.md"),
      real.promptBook.replace("## 3. Mini", "## x. Mini"),
    );
    const r = cli(["--sprint", "1", "--contract-sha", SHA, "--repo-root", root]);
    expect(r.code).toBe(EXIT.INPUT);
    expect(r.err).toContain("PROMPT-BOOK.md section 3");
    expect(r.out).toBe("");
  });

  it("exits 4 when an input file cannot be read", () => {
    const r = cli(["--sprint", "0", "--repo-root", join(makeTempDir(), "nowhere")]);
    expect(r.code).toBe(EXIT.IO);
    expect(r.err).toContain("cannot read");
    expect(r.err).toContain("--repo-root");
  });
});

describe("sprint renderer cli: --out", () => {
  it("writes the file with LF endings, creates the parent, and leaves no temp file", () => {
    const dir = makeTempDir();
    const target = join(dir, "state", "1", "sprint-prompt.md");
    const r = cli(["--sprint", "1", "--contract-sha", SHA, "--out", target]);
    expect(r).toMatchObject({ code: EXIT.OK, out: "", err: "" });
    const bytes = readFileSync(target);
    expect(bytes.includes(13)).toBe(false);
    expect(bytes.toString("utf8")).toContain("sprint/1-mvp");
    expect(readdirSync(dirname(target))).toEqual(["sprint-prompt.md"]);
  });

  it("replaces an existing file", () => {
    const dir = makeTempDir();
    const target = join(dir, "p.md");
    writeFileSync(target, "old");
    expect(cli(["--sprint", "smoke", "--out", target]).code).toBe(EXIT.OK);
    expect(readFileSync(target, "utf8")).toBe(
      "write /state/smoke/status.json with state green and exit\n",
    );
    expect(readdirSync(dir)).toEqual(["p.md"]);
  });

  it("writes LF output from CRLF inputs", () => {
    const root = fakeRoot(true);
    expect(readFileSync(join(root, "PROMPT-BOOK.md")).includes(13)).toBe(true);
    const target = join(makeTempDir(), "p.md");
    const r = cli(["--sprint", "2", "--contract-sha", SHA, "--repo-root", root, "--out", target]);
    expect(r.code).toBe(EXIT.OK);
    expect(readFileSync(target).includes(13)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(cli(["--sprint", "2", "--contract-sha", SHA]).out);
  });

  it("exits 4 and leaves nothing behind when the output cannot be written", () => {
    const dir = makeTempDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const r = cli(["--sprint", "smoke", "--out", join(blocker, "p.md")]);
    expect(r.code).toBe(EXIT.IO);
    expect(r.err).toContain("cannot write");
    expect(readdirSync(dir)).toEqual(["blocker"]);
  });

  it("removes its temp file when the rename fails (the output path is a directory)", () => {
    const dir = makeTempDir();
    const target = join(dir, "p.md");
    mkdirSync(target);
    const r = cli(["--sprint", "smoke", "--out", target]);
    expect(r.code).toBe(EXIT.IO);
    expect(r.err).toContain("cannot write");
    expect(readdirSync(dir)).toEqual(["p.md"]);
  });

  it("does not create the output when rendering fails", () => {
    const dir = makeTempDir();
    const target = join(dir, "out", "p.md");
    expect(cli(["--sprint", "1", "--out", target]).code).toBe(EXIT.USAGE);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("sprint renderer cli: real process", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
  }

  it("renders to stdout with exit 0", () => {
    const r = run(["--sprint", "3", "--contract-sha", SHA]);
    expect(r.status).toBe(EXIT.OK);
    expect(r.stdout).toContain("sprint/3-organize");
    expect(r.stderr).toBe("");
  });

  it("exits with the error class code and a message on stderr", () => {
    const usage = run(["--sprint", "3"]);
    expect(usage.status).toBe(EXIT.USAGE);
    expect(usage.stderr).toContain("render-prompt: ");
    expect(usage.stdout).toBe("");
    expect(run(["--sprint", "0", "--repo-root", join(makeTempDir(), "none")]).status).toBe(EXIT.IO);
  });

  it("still runs when started through a directory junction or symlink", (ctx) => {
    const linkParent = makeTempDir();
    const link = join(linkParent, "linked-sprint");
    try {
      symlinkSync(dirname(script), link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      console.warn(
        `SKIPPED: cannot create a link here (${code}); the link-invocation test did not run`,
      );
      ctx.skip(`cannot create a link (${code})`);
      return;
    }
    const viaLink = join(link, "render-prompt.mjs");
    const go = (args: string[]) =>
      spawnSync(process.execPath, [viaLink, ...args], { encoding: "utf8", windowsHide: true });

    const keep = spawnSync(process.execPath, ["--preserve-symlinks-main", viaLink, "--bogus"], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(keep.status).toBe(EXIT.USAGE);
    expect(keep.stderr).toContain("unknown argument");

    const bogus = go(["--bogus"]);
    expect(bogus.status).toBe(EXIT.USAGE);
    expect(bogus.stderr).toContain("unknown argument");

    const noSha = go(["--sprint", "1"]);
    expect(noSha.status).toBe(EXIT.USAGE);

    const smoke = go(["--sprint", "smoke"]);
    expect(smoke.status).toBe(EXIT.OK);
    expect(smoke.stdout).toBe("write /state/smoke/status.json with state green and exit\n");

    const out = join(linkParent, "out", "p.md");
    expect(go(["--sprint", "3", "--contract-sha", SHA, "--out", out]).status).toBe(EXIT.OK);
    expect(readFileSync(out, "utf8")).toContain("sprint/3-organize");
  });
});
