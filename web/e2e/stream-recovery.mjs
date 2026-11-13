import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const code of ["STREAM_UNAVAILABLE", "ACCESS_REVOKED"]) {
    const page = await browser.newPage();
    let streams = 0;
    await page.route("**/session-race", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div><script type="module" src="/e2e/session-race.tsx"></script>',
      }),
    );
    await page.route("**/api/v1/**", (r) => {
      const path = new URL(r.request().url()).pathname;
      const json = (body) => r.fulfill({ json: body });
      if (path.endsWith("/timeline"))
        return json({ items: [], nextCursor: null });
      if (path.endsWith("/active-task"))
        return json({
          activeRun: streams >= 2 ? null : { id: "r", state: "RUNNING" },
        });
      if (path.endsWith("/events")) {
        streams++;
        const body =
          streams === 1
            ? `event: stream.error\ndata: ${JSON.stringify({ code })}\n\n`
            : `data: ${JSON.stringify({ eventId: 1, sessionId: "A", runId: "r", type: "tool.completed", timestamp: "now", data: { callId: "c", name: "bash" } })}\n\n`;
        return r.fulfill({ contentType: "text/event-stream", body });
      }
      return json({ id: "r", state: "COMPLETED" });
    });
    await page.goto("http://localhost:5173/session-race");
    if (code === "STREAM_UNAVAILABLE") {
      await page.waitForFunction(() =>
        document.querySelector("output").textContent.includes("completed"),
      );
      assert.ok(streams >= 2);
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector("output").textContent).error === "",
      );
    } else {
      await page.waitForFunction(() =>
        document.querySelector("output").textContent.includes("ACCESS_REVOKED"),
      );
      await page.waitForTimeout(3000);
      assert.equal(streams, 1);
    }
    await page.close();
  }
  console.log(
    "PASS: transient stream error reconnects; revoked access stops retries",
  );
} finally {
  await browser.close();
}
