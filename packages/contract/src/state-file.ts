// Sprint state files: the .sprint/<id>/ layout of PROMPT-BOOK.md section 6 plus an atomic,
// schema-checked, secret-free way to write, merge and read the two status files. This module
// touches node:fs, so it is a subpath export (@sessiondeck/contract/state-file) and is
// deliberately NOT re-exported from index.ts, which the web bundle imports.
//
// The parts, each under 300 lines and importable on its own:
//   error, secrets, schemas   shapes and guards (no I/O)
//   paths, sweep              layout, ids, stale temp cleanup
//   atomic, lock              tmp + rename writer with backoff; wx lock file
//   read, write, merge        checked read; checked write; locked read-modify-write
export * from "./state-file-atomic.ts";
export * from "./state-file-error.ts";
export * from "./state-file-lock.ts";
export * from "./state-file-merge.ts";
export * from "./state-file-paths.ts";
export * from "./state-file-read.ts";
export * from "./state-file-schemas.ts";
export * from "./state-file-secrets.ts";
export * from "./state-file-sweep.ts";
export * from "./state-file-write.ts";
