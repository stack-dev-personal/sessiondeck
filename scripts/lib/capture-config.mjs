/** Named limits and names shared by the capture hook. Disk use is bounded by these. */

export const HOOK_MAX_FILES_PER_DIR = 500;
export const STATUSLINE_MAX_FILES = 1000;
export const SUBAGENT_STATUSLINE_MAX_FILES = 300;
export const UNPARSED_MAX_FILES = 100;
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
export const STATUSLINE_DIR = "statusLine";
export const SUBAGENT_STATUSLINE_DIR = "subagentStatusLine";
export const STATUSLINE_TEXT = "sessiondeck capture on";
export const CAPTURE_DIR_ENV = "SESSIONDECK_CAPTURE_DIR";
