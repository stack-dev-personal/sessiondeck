import { afterEach, beforeEach } from "vitest";

// Setup file for the sprint tooling run (vitest.sprint.config.ts only).
//
// The PowerShell files run whole batches with spawnSync inside beforeAll, so the worker thread is
// blocked for tens of seconds at a time. Vitest moves from hook to test with promises alone, which
// never lets the event loop read the reply to the reporter update it just sent. After about 60 s of
// that, vitest's fixed worker RPC timeout throws 'Timeout calling "onTaskUpdate"' and the run exits
// 1 although every test passed. Yielding one macrotask before and after each test lets the reply
// in. It adds no waiting.
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(yieldToEventLoop);
afterEach(yieldToEventLoop);
