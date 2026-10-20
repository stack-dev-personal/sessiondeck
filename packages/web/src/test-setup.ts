import { afterEach } from "vitest";

// Pure-logic files opt into `// @vitest-environment node`; DOM helpers load only under jsdom.
if (typeof document !== "undefined") {
  const { configure, cleanup } = await import("@testing-library/react");
  await import("@testing-library/jest-dom/vitest");
  // Lazy routes on slow CI runners (Windows) can take longer than the 1000 ms default.
  configure({ asyncUtilTimeout: 5000 });
  afterEach(() => cleanup());
}

// Files share one environment (isolate: false), so reset per-viewer state between tests.
afterEach(async () => {
  const { vi } = await import("vitest");
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (typeof document !== "undefined") {
    try {
      localStorage.clear();
    } catch {
      /* storage unavailable */
    }
    for (const a of Array.from(document.documentElement.attributes)) {
      document.documentElement.removeAttribute(a.name);
    }
  }
});
