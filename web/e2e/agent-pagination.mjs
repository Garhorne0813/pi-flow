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
  const agents = Array.from({ length: 105 }, (_, i) => ({
    id: "agent-" + i,
    config: { name: "Agent " + i },
  }));
  await page.route("**/api/v1/**", (r) => {
    const u = new URL(r.request().url());
    const json = (body) => r.fulfill({ json: body });
    if (u.pathname.endsWith("/me"))
      return json({ userId: "user", admin: false });
    if (u.pathname.endsWith("/agents")) {
      const offset = Number(u.searchParams.get("offset")),
        limit = Number(u.searchParams.get("limit") || 50);
      offsets.push(offset);
      return json({ items: agents.slice(offset, offset + limit) });
    }
    return json({ items: [] });
  });
  await page.goto("http://localhost:5173/chat");
  await page.getByLabel("选择 Agent").selectOption("agent-104");
  assert.equal(
    await page.getByLabel("选择 Agent").locator("option").count(),
    105,
  );
  assert.deepEqual(offsets, [0, 100]);
  async function refresh() {
    const result = page.waitForResponse((r) =>
      r.url().includes("/api/v1/agents?offset=100"),
    );
    await page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .find((e) => e.name.includes("/@tanstack_react-query.js")).name;
      const { focusManager } = await import(url);
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await result;
  }
  agents[0].config.name = "Renamed first Agent";
  await refresh();
  await page
    .getByRole("option", { name: "Renamed first Agent", exact: true })
    .waitFor({ state: "attached" });
  assert.equal(await page.getByLabel("选择 Agent").inputValue(), "agent-104");
  agents.pop();
  await refresh();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="选择 Agent"]').value ===
      "agent-0",
  );
  console.log("PASS: all 105 agents available via paginated loading");
} finally {
  await browser.close();
}
