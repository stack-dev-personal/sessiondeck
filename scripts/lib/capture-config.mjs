/** Named limits and names shared by the capture hook. Disk use is bounded by these. */

/**
 * Per hook event. High on purpose: the 256 MiB byte budget is the real bound on disk, and a lower
 * cap fills in about an hour of three busy sessions on PreToolUse and PostToolUse, after which
 * rarer events of the same day (AskUserQuestion, subagent calls, a second project) would be lost.
 */
export const HOOK_MAX_FILES_PER_DIR = 3000;
export const STATUSLINE_MAX_FILES = 1000;
export const SUBAGENT_STATUSLINE_MAX_FILES = 300;
export const UNPARSED_MAX_FILES = 100;
/** Stored text of an input that was not a JSON object is cut to this many bytes. */
export const UNPARSED_MAX_BYTES = 64 * 1024;
/** Total bytes of captured payloads in one out dir; counted in a running log, not by walking. */
export const OUT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Throttle state is one small file per mode and session; stop adding new ones past this. */
export const STATE_MAX_FILES = 200;
/** Orphaned temp files (killed or cancelled writes) older than this are removed. */
export const STALE_TEMP_MS = 10 * 60 * 1000;
/** Upper bound on directories directly under the out dir (event names are untrusted). */
export const MAX_OUT_SUBDIRS = 64;
/** statusLine fires on every assistant message; keep one sample per session per interval. */
export const STATUSLINE_MIN_INTERVAL_MS = 30_000;
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;
export const MAX_SEGMENT_LENGTH = 64;
export const SHORT_SESSION_ID_LENGTH = 8;
export const ERROR_LOG_MAX_BYTES = 64 * 1024;
export const RANDOM_SUFFIX_BYTES = 6;

export const UNKNOWN_SEGMENT = "_unknown";
export const NO_SESSION_SEGMENT = "nosession";
export const UNPARSED_DIR = "_unparsed";
export const STATE_DIR = "_state";
export const ERROR_LOG_NAME = "_capture-errors.log";
export const USAGE_LOG_NAME = "_usage.log";
export const GITIGNORE_NAME = ".gitignore";
/** Keeps raw captures out of git even if an ignore rule is missing from the branch. */
export const GITIGNORE_BODY = "*\n";
export const STATUSLINE_DIR = "statusLine";
export const SUBAGENT_STATUSLINE_DIR = "subagentStatusLine";
export const STATUSLINE_TEXT = "sessiondeck capture on";
/** Shown instead once a cap or the byte budget stops recording, so the stop is visible. */
export const STATUSLINE_FULL_TEXT = "sessiondeck capture full";
/**
 * Steps of the two status-sample caps. They fill on a normal day (one sample per session every 30
 * seconds) and need no action, so they stay out of the `full` signal.
 */
export const SAMPLE_CAP_STEPS = [
  `full-cap-${STATUSLINE_DIR}`,
  `full-cap-${SUBAGENT_STATUSLINE_DIR}`,
];
export const BUDGET_LOG_CODE = "FULL";
/** Error-log step names for a refused write all start with this (full-budget, full-cap-<dir>). */
export const FULL_STEP_PREFIX = "full-";
export const CAPTURE_DIR_ENV = "SESSIONDECK_CAPTURE_DIR";
