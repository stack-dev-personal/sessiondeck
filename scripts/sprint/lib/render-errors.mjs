// Error type and exit codes shared by the sprint prompt renderer.

/** Process exit codes. Success is 0; each error class has its own code. */
export const EXIT = Object.freeze({
  OK: 0,
  /** Bad flags, unknown sprint id, missing contract SHA. */
  USAGE: 2,
  /** A markdown input is missing a section or fence, a block is malformed, a placeholder has no value. */
  INPUT: 3,
  /** An input file could not be read or the output could not be written. */
  IO: 4,
});

/** An error whose message is meant to be shown to a person as is. */
export class RenderError extends Error {
  /**
   * @param {string} message what is wrong and what to do about it
   * @param {number} exitCode one of EXIT
   */
  constructor(message, exitCode) {
    super(message);
    this.name = "RenderError";
    this.exitCode = exitCode;
  }
}

/**
 * @param {string} message
 * @returns {RenderError}
 */
export const usageError = (message) => new RenderError(message, EXIT.USAGE);

/**
 * @param {string} message
 * @returns {RenderError}
 */
export const inputError = (message) => new RenderError(message, EXIT.INPUT);

/**
 * @param {string} message
 * @returns {RenderError}
 */
export const ioError = (message) => new RenderError(message, EXIT.IO);
