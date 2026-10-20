import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Screenshots and summary.json land here. Override with SCREENS_DIR. */
export const SCREENS_DIR =
  process.env["SCREENS_DIR"] ?? join(fileURLToPath(new URL(".", import.meta.url)), "screens");
