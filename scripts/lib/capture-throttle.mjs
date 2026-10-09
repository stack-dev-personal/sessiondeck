/**
 * Signature of a status payload: its sorted top-level keys plus whether rate_limits is present.
 * A change in the signature always earns a sample.
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function statusSignature(payload) {
  const keys = Object.keys(payload).sort().join(",");
  return `${keys}|rate_limits=${Object.hasOwn(payload, "rate_limits")}`;
}

/**
 * @param {{ t: number, sig: string } | undefined} previous last recorded sample for the session
 * @param {string} sig
 * @param {number} now epoch ms
 * @param {number} minIntervalMs
 * @returns {boolean}
 */
export function shouldRecordStatus(previous, sig, now, minIntervalMs) {
  if (previous === undefined) return true;
  if (previous.sig !== sig) return true;
  return now - previous.t >= minIntervalMs;
}
