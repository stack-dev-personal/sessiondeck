import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_CHARS = 16; // 80 bits, 5 bits each

function encodeTime(ms: number): string {
  let out = "";
  let n = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = randomBytes(RANDOM_CHARS);
  return Array.from(bytes, (b) => b & 31);
}

export interface UlidGenerator {
  (ts?: number): string;
}

/**
 * Monotonic ULID generator: within one millisecond the 80-bit random part is incremented, so ids
 * from one generator sort in creation order. Across processes the random part makes collisions
 * practically impossible.
 */
export function createUlidGenerator(): UlidGenerator {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return (ts = Date.now()) => {
    let time = ts;
    if (time <= lastTime) {
      // Same millisecond (or a clock step back): keep the time, bump the random part.
      time = lastTime;
      const next = lastRandom.slice();
      let i = RANDOM_CHARS - 1;
      while (i >= 0 && next[i] === 31) {
        next[i] = 0;
        i--;
      }
      if (i < 0) {
        // 80-bit overflow: move to the next millisecond with fresh randomness.
        time = lastTime + 1;
        lastRandom = randomDigits();
      } else {
        next[i] = (next[i] ?? 0) + 1;
        lastRandom = next;
      }
    } else {
      lastRandom = randomDigits();
    }
    lastTime = time;
    return encodeTime(time) + lastRandom.map((d) => ALPHABET[d]).join("");
  };
}

export const ulid: UlidGenerator = createUlidGenerator();
