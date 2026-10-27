// `bun build --compile` flags that keep the exe from loading anything out of the cwd. Claude Code
// runs hooks with cwd = the user's project, so an autoloaded bunfig.toml (preload), .env, tsconfig
// or package.json there would run or configure code as the user. Shared by build-exe.mjs and the
// autoload test, so the test exercises the flags the build really passes.
export const AUTOLOAD_OFF_FLAGS = [
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
];
