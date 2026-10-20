// CLI entry (dist/probe.mjs): probe install | uninstall | config show | daemon run | daemon install | daemon uninstall. Unlike the
// hook, this exits non-zero on errors.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPathEnv } from "./cli-paths.ts";
import { readProcessStdin, run } from "./install/run.ts";

const argv = process.argv.slice(2);
if (argv[0] === "daemon") {
  if (argv[1] === "run") {
    // Foreground, same entry as dist/daemon.mjs; runs until SIGINT/SIGTERM.
    const { runDaemon } = await import("./daemon/run.ts");
    await runDaemon(argv.slice(2));
  } else if (argv[1] === "install" || argv[1] === "uninstall") {
    const { currentAutostartEnv, runAutostart } = await import("./autostart/index.ts");
    process.exitCode = await runAutostart(argv.slice(1), {
      e: currentAutostartEnv(),
      distDir: dirname(fileURLToPath(import.meta.url)),
      nodePath: process.execPath,
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } else {
    process.stderr.write(
      "probe: usage: probe daemon run [--home <dir>] [--stderr] | probe daemon install|uninstall\n",
    );
    process.exitCode = 2;
  }
} else {
  process.exitCode = await run(argv, {
    pathEnv: currentPathEnv(),
    distDir: dirname(fileURLToPath(import.meta.url)),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readStdin: readProcessStdin,
  });
}
