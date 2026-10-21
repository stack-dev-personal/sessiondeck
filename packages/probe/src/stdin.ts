export const MAX_STDIN_BYTES = 8 * 1024 * 1024;
export const STDIN_WAIT_MS = 2_000;

export type StdinResult =
  | { ok: true; data: Buffer }
  | { ok: false; reason: "timeout" | "too-large" | "read-error"; data: Buffer };

/**
 * Reads all of stdin, bounded in size and in time. Never rejects. A stdin that never closes
 * resolves as "timeout" after STDIN_WAIT_MS so the hook cannot hang.
 */
export function readStdin(
  maxBytes: number = MAX_STDIN_BYTES,
  waitMs: number = STDIN_WAIT_MS,
): Promise<StdinResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let stream: NodeJS.ReadStream | undefined;
    const finish = (r: StdinResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        stream?.pause();
        stream?.removeAllListeners("data");
      } catch {
        // ignore
      }
      resolve(r);
    };
    const buf = (): Buffer => Buffer.concat(chunks);
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout", data: buf() }), waitMs);
    try {
      stream = process.stdin;
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes)
          return finish({ ok: false, reason: "too-large", data: Buffer.alloc(0) });
        chunks.push(c);
      });
      stream.on("end", () => finish({ ok: true, data: buf() }));
      stream.on("close", () => finish({ ok: true, data: buf() }));
      stream.on("error", () => finish({ ok: false, reason: "read-error", data: buf() }));
    } catch {
      finish({ ok: false, reason: "read-error", data: Buffer.alloc(0) });
    }
  });
}
