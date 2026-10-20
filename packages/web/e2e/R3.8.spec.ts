import { expect, test } from "@playwright/test";
import { fullShot, setTheme, waitForCards } from "./helpers";

/**
 * R3.8, mock build: the suite serves a VITE_MOCK=1 build, so the board fills from bundled
 * fixtures replayed in the browser. Any request off the preview origin, any /api or /ws request,
 * and any WebSocket fails the test.
 */
test("R3.8 mock build runs the full board with no network beyond the preview server", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL!).origin;
  const violations: string[] = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== origin) {
      violations.push(`off-origin ${route.request().method()} ${u.href}`);
      return route.abort();
    }
    if (u.pathname.startsWith("/api") || u.pathname.startsWith("/ws")) {
      violations.push(`hub path ${u.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  page.on("websocket", (ws) => violations.push(`websocket ${ws.url()}`));
  page.on("request", (r) => {
    if (["fetch", "xhr"].includes(r.resourceType()))
      violations.push(`${r.resourceType()} ${r.url()}`);
  });

  await setTheme(page, "dark");
  await page.goto("/board");
  await waitForCards(page, 8);
  await expect(page.getByRole("list", { name: "Hosts" }).getByRole("listitem")).toHaveCount(2);
  await expect
    .poll(
      async () =>
        new Set(
          await page
            .getByTestId("session-card")
            .evaluateAll((els) => els.map((e) => e.getAttribute("data-state"))),
        ).size,
      { timeout: 90_000 },
    )
    .toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId("connection")).toContainText("mock");
  await fullShot(page, "R3.8.png");
  expect(violations).toEqual([]);
});
