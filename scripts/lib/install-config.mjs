/** Named constants used by the installer only. The deployed hook does not import this file. */

/** Path-independent marker carried by every entry the installer writes. */
export const MARKER_FLAG = "--marker";
export const MARKER_VALUE = "sessiondeck-capture";
export const HOOK_SCRIPT_NAME = "capture-fixtures.mjs";

/** Per-hook timeout in seconds. SessionEnd gets none: a timeout there raises the shared exit budget. */
export const HOOK_TIMEOUT_SECONDS = 5;
export const NO_TIMEOUT_EVENTS = Object.freeze(["SessionEnd"]);

export const SIDECAR_VERSION = 2;
export const LEGACY_SIDECAR_VERSION = 1;

/** Environment variable that relocates the deployed copy (tests always set it). */
export const DEPLOY_HOME_ENV = "SESSIONDECK_CAPTURE_HOME";
export const APP_DIR_NAME = "sessiondeck";
export const DEPLOY_DIR_NAME = "capture";

/**
 * Exactly the files the capture hook needs, relative to scripts/. A test checks that this list is
 * the import closure of capture-fixtures.mjs, so the deployed copy imports nothing from the repo.
 */
export const DEPLOY_FILES = Object.freeze([
  "capture-fixtures.mjs",
  "lib/capture-budget.mjs",
  "lib/capture-config.mjs",
  "lib/capture-core.mjs",
  "lib/capture-paths.mjs",
  "lib/capture-store.mjs",
  "lib/capture-throttle.mjs",
]);

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Installer temp files older than this are swept; younger ones may belong to a running writer. */
export const STALE_INSTALL_TEMP_MS = 60 * 60 * 1000;
export const COPY_RETRY_ATTEMPTS = 4;
export const COPY_RETRY_DELAY_MS = 60;

export const CLAUDECODE_ENV = "CLAUDECODE";
export const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
