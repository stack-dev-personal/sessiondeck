/** Errors whose messages are safe to show: they never contain file content. */

export class UsageError extends Error {}

/** A safety check refused the operation; nothing was written. */
export class InstallRefused extends Error {}

/** The deployed copy could not be written or did not verify. */
export class DeployError extends Error {}
