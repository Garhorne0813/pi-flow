import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  const offsets = [];
  let detailReads = 0;
  await page.route("**/api/v1/**", (r) => {
    const u = new URL(r.request().url());
    const path = u.pathname;
    const json = (body) => r.fulfill({ json: body });
    if (path.endsWith("/me")) return json({ userId: "user", admin: false });
    if (path.endsWith("/agents"))
      return json({
        items: [
          { id: "A", config: { name: "Default Agent" } },
          { id: "B", config: { name: "Historical Agent" } },
        ],
      });
    if (path.endsWith("/sessions")) {
      const offset = Number(u.searchParams.get("offset"));
      offsets.push(offset);
      return json({
        items: Array.from({ length: 50 }, (_, i) => ({
          id: "recent-" + (offset + i),
          title: "Recent " + (offset + i),
          agentId: "A",
        })),
      });
    }
    if (path.endsWith("/history-80")) {
      detailReads++;
      return json({
        id: "history-80",
        title: "Historical conversation 80",
        agentId: "B",
      });
    }
    if (path.endsWith("/timeline"))
      return json({ items: [], nextCursor: null });
    if (path.endsWith("/active-task")) return json({ activeRun: null });
    return json({ items: [] });
  });
  for (let i = 0; i < 2; i++) {
    await page.goto("http://localhost:5173/chat/history-80");
    await page
      .locator(".app-header strong")
      .filter({ hasText: "Historical conversation 80" })
      .waitFor();
    assert.equal(await page.getByLabel("选择 Agent").inputValue(), "B");
    assert.equal(await page.getByLabel("选择 Agent").isDisabled(), true);
    assert.equal(
      await page.getByRole("link", { name: "Recent 0", exact: true }).count(),
      1,
    );
  }
  assert.equal(detailReads, 2);
  assert.ok(offsets.every((offset) => offset === 0));
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("link", { name: "Recent 50", exact: true }).waitFor();
  assert.equal(
    await page.locator(".app-header strong").textContent(),
    "Historical conversation 80",
  );
  assert.equal(await page.getByLabel("选择 Agent").inputValue(), "B");
  console.log(
    "PASS: historical deep link and reload show correct metadata independently of session list pages",
  );
} finally {
  await browser.close();
}
