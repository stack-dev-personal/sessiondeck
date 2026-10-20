// Seams for `probe daemon install|uninstall`. Every OS call goes through ExecFn and every file
// write through AutostartFs, so unit tests assert the exact argv and bytes without touching the host.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";

export interface ExecResult {
  /** Exit code; null when the process could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be spawned (ENOENT and the like). */
  spawnError?: string;
}

/** Exec form only: a program and its argv. Never a shell string. */
export type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

export interface AutostartFs {
  /** Creates the directory and parents. */
  mkdirp(dir: string): Promise<void>;
  /**
   * Replaces the file with these exact bytes (default mode 0o600). The real implementation writes a
   * new temp file exclusively and renames it over the target, so an existing file, symlink or
   * junction at the target is replaced, never written through, and its mode is not inherited.
   */
  write(file: string, data: string | Uint8Array, mode?: number): Promise<void>;
  /** Owner and permission bits of a path, or undefined when it does not exist. */
  statPath(path: string): Promise<{ uid: number; mode: number } | undefined>;
  /** The file's text, or undefined when it does not exist. */
  read(file: string): Promise<string | undefined>;
  /** Removes the file; a missing file is fine. */
  remove(file: string): Promise<void>;
}

export interface AutostartEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** The user's home directory. */
  home: string;
  /** Account name without the domain, used when the environment has none. */
  userName: string;
  /** Numeric user id (POSIX); used to check that a probe home is ours. */
  uid?: number;
}

export interface AutostartIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface AutostartDeps extends AutostartIo {
  e: AutostartEnv;
  exec: ExecFn;
  fs: AutostartFs;
}

/** What gets started: absolute node, the daemon script and the probe home it runs with. */
export interface DaemonCommand {
  node: string;
  script: string;
  probeHome: string;
}

export const realExec: ExecFn = (file, args) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    try {
      const child = spawn(file, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Not spawn's own `timeout` option: after a spawn error its timer would keep the process alive.
      timer = setTimeout(() => {
        child.kill();
        done({ code: null, stdout, stderr, spawnError: "timed out after 60 s" });
      }, 60_000);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => done({ code: null, stdout, stderr, spawnError: err.message }));
      child.on("close", (code) => done({ code, stdout, stderr }));
    } catch (err) {
      done({
        code: null,
        stdout,
        stderr,
        spawnError: err instanceof Error ? err.message : "spawn",
      });
    }
  });

export const realFs: AutostartFs = {
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  write: async (file, data, mode = 0o600) => {
    const tmp = `${file}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
    let renamed = false;
    try {
      const fh = await open(tmp, "wx", mode);
      try {
        await fh.writeFile(data);
        if (process.platform !== "win32") await fh.chmod(mode);
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
      renamed = true;
    } finally {
      if (!renamed) await rm(tmp, { force: true });
    }
  },
  statPath: async (path) => {
    try {
      const st = await stat(path);
      return { uid: st.uid, mode: st.mode };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  },
  read: async (file) => {
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  },
  remove: (file) => rm(file, { force: true }),
};

/** A word is refused (not escaped) when it holds a control character: no path needs one. */
export function assertPlain(label: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} contains a control character`);
}
