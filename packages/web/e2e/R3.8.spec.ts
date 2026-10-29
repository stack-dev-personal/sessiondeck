import { expect, test } from "@playwright/test";
import { fullShot, gotoDevCards, openSettledBoard, setTheme, settledMix } from "./helpers";

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
  await openSettledBoard(page);
  await expect(page.getByRole("list", { name: "Hosts" }).getByRole("listitem")).toHaveCount(2);
  const mix = await settledMix(page);
  console.log(`R3.8 settled board: ${JSON.stringify(mix)}`);
  expect(Object.keys(mix.states).length).toBeGreaterThanOrEqual(6);
  expect(mix.withContext).toBeGreaterThanOrEqual(6);
  expect(new Set(mix.names).size).toBe(mix.names.length);
  expect(mix.withBranch).toBeGreaterThanOrEqual(6);
  await expect(page.getByTestId("connection")).toContainText("mock");
  await fullShot(page, "R3.8.png", { baseline: true });

  // The rest of the app stays offline too: the popout, /settings and /dev/cards.
  await page.getByTestId("session-card").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await gotoDevCards(page);
  await page.goto("/board?replay=fast");
  await expect(page.locator("html")).toHaveAttribute("data-replay", "done", { timeout: 30_000 });
  expect(violations).toEqual([]);
});
