/** Preview-server port from SD_E2E_PORT: unset or empty falls back; anything else must be 1..65535. */
export function resolvePort(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`SD_E2E_PORT must be an integer from 1 to 65535, got "${text}"`);
  }
  return n;
}
