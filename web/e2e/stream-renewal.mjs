import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const renew of [false, true]) {
    const page = await browser.newPage();
    let streams = 0,
      first;
    let arrived;
    const ready = new Promise((r) => (arrived = r));
    const credentials = [];
    await page.route("**/src/api/auth.ts", (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: `let value='old';export const token=async()=>value;window.renew=()=>{value='new';};`,
      }),
    );
    await page.route("**/session-race", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div><script type="module" src="/e2e/session-race.tsx"></script>',
      }),
    );
    await page.route("**/api/v1/**", (r) => {
      const u = new URL(r.request().url());
      const json = (body) => r.fulfill({ json: body });
      if (u.pathname.endsWith("/timeline"))
        return json({ items: [], nextCursor: null });
      if (u.pathname.endsWith("/active-task"))
        return json({
          activeRun: streams >= 2 ? null : { id: "r", state: "RUNNING" },
        });
      if (u.pathname.endsWith("/events")) {
        streams++;
        credentials.push(r.request().headers().authorization);
        if (streams === 1) {
          first = r;
          arrived();
          return;
        }
        assert.equal(u.searchParams.get("after"), "1");
        return r.fulfill({
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ eventId: 2, sessionId: "A", runId: "r", type: "tool.completed", timestamp: "now", data: { callId: "c" } })}\n\n`,
        });
      }
      return json({ id: "r", state: "COMPLETED" });
    });
    await page.goto("http://localhost:5173/session-race");
    await ready;
    if (renew) await page.evaluate(() => window.renew());
    await first.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ eventId: 1, sessionId: "A", runId: "r", type: "tool.started", timestamp: "now", data: { callId: "c", name: "bash" } })}\n\nevent: stream.error\ndata: {"code":"AUTHENTICATION_EXPIRED"}\n\n`,
    });
    if (renew) {
      await page.waitForFunction(() =>
        document.querySelector("output").textContent.includes("completed"),
      );
      assert.deepEqual(credentials, ["Bearer old", "Bearer new"]);
      assert.equal(
        JSON.parse(await page.locator("output").textContent()).items[0].name,
        "bash",
      );
    } else {
      await page.waitForFunction(() =>
        document
          .querySelector("output")
          .textContent.includes("AUTHENTICATION_EXPIRED"),
      );
      await page.waitForTimeout(2800);
      assert.equal(streams, 1);
    }
    await page.close();
  }
  console.log(
    "PASS: expired old stream reconnects with refreshed token and cursor, while unchanged expired credentials stop",
  );
} finally {
  await browser.close();
}
