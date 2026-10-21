export {};
// Entry point. `node main.mjs` serves; `node main.mjs replay|compact [--db <path>]` run a
// maintenance command against the database and exit.
process.umask(0o077);
const sub = process.argv[2];
if (sub === undefined || sub.startsWith("-")) {
  const { serve } = await import("./serve.ts");
  await serve();
} else {
  const { runCli } = await import("./cli.ts");
  process.exitCode = await runCli(process.argv.slice(2), process.env, (l) =>
    process.stdout.write(`${l}\n`),
  );
}
