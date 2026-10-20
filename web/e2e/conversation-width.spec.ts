import { expect, test } from "@playwright/test";

import { fixtureTranscript } from "@/test/handlers";
import { installApiStub } from "./fixtures/api";

// Durable conversation history replaces the fork's History reader. Measure the shipped layout,
// not class names: the old lg:max-w-screen-lg only failed on displays wider than that cap.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  await page.addInitScript(() => localStorage.setItem("collie:locale:v1", "en"));
  // A direct link can outlive the list entry; the reader still loads its transcript.
  await page.route("**/api/durable/conversations*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ available: true, items: [] }),
  }));
  await page.route("**/api/durable/conversation/*/items*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ available: true, id: "closed-thread", entries: fixtureTranscript, more: false }),
  }));
});

for (const width of [390, 820, 1920]) {
  test(`durable transcript uses the available width at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1080 });
    await page.goto("/conversations/closed-thread?state=closed");
    const reply = page.getByText("One commit: abc1234.", { exact: true });
    await expect(reply).toBeVisible();
    const main = page.getByRole("main").filter({ has: reply });
    const geometry = await main.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth };
    });
    // Gutters are inside the reader. Neither the surface nor its actual prose may be a capped column.
    expect(geometry.width / geometry.viewport).toBeGreaterThan(0.98);
    const prose = await reply.boundingBox();
    expect(prose).not.toBeNull();
    expect(prose!.width / geometry.viewport).toBeGreaterThan(0.85);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport);
  });
}
