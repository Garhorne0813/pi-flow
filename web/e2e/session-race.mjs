import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const older of [false, true])
    for (const fail of [false, true]) {
      const page = await browser.newPage();
      await page.route("**/session-race", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: '<div id="root"></div><script type="module" src="/e2e/session-race.tsx"></script>',
        }),
      );
      await page.addInitScript(() => {
        window.reads = [];
        window.activeCalls = [];
        const original = window.fetch;
        window.fetch = async (url, init) => {
          if (!String(url).startsWith("/api/v1/")) return original(url, init);
          if (String(url).includes("/timeline"))
            return new Promise((resolve, reject) => {
              // Intentionally ignore abort so generation isolation is tested independently.
              window.reads.push({
                url: String(url),
                signal: init.signal,
                complete: (text, cursor) =>
                  resolve(
                    new Response(
                      JSON.stringify({
                        items: [
                          {
                            id: "message:" + text,
                            runId: "run",
                            kind: "assistant",
                            text,
                          },
                        ],
                        nextCursor: cursor,
                      }),
                    ),
                  ),
                fail: () => reject(new Error("obsolete history failure")),
              });
            });
          window.activeCalls.push(String(url));
          return new Response(JSON.stringify({ activeRun: null }));
        };
      });
      await page.goto("http://localhost:5173/session-race");
      const waitReads = (n) =>
        page.waitForFunction((n) => window.reads.length >= n, n);
      const complete = (index, text, cursor) =>
        page.evaluate(
          ({ index, text, cursor }) =>
            window.reads[index].complete(text, cursor),
          { index, text, cursor },
        );
      const state = async () =>
        JSON.parse(await page.locator("output").textContent());
      await waitReads(1);
      let stale = 0;
      if (older) {
        await complete(0, "first", "old-cursor");
        await waitReads(2); // The background latest-page request.
        await page.getByRole("button", { name: "older", exact: true }).click();
        await waitReads(3);
        stale = 2;
      }
      const before = await page.evaluate(() => window.reads.length);
      await page.getByRole("button", { name: "B", exact: true }).click();
      await waitReads(before + 1);
      await page.getByRole("button", { name: "A", exact: true }).click();
      await waitReads(before + 2);
      const current = before + 1;
      assert.equal(
        await page.evaluate((i) => window.reads[i].signal.aborted, stale),
        true,
      );
      if (fail) await page.evaluate((i) => window.reads[i].fail(), stale);
      else await complete(stale, "obsolete", "obsolete-cursor");
      // Flush the rejected/fulfilled promise before inspecting React output.
      await page.waitForTimeout(100);
      assert.deepEqual((await state()).items, []);
      assert.equal((await state()).error, "");
      assert.equal((await state()).hasOlder, false);
      await complete(current, "current", "new-cursor");
      await page.waitForFunction(() =>
        document.querySelector("output").textContent.includes("current"),
      );
      await page.getByRole("button", { name: "older", exact: true }).click();
      await page.waitForFunction(() =>
        window.reads.some((r) => r.url.includes("cursor=new-cursor")),
      );
      assert.equal((await state()).error, "");
      assert.equal(
        (await state()).items.some((i) => i.text === "obsolete"),
        false,
      );
      // Authentication-style reset aborts the current scope and restarts the same sid.
      const count = await page.evaluate(() => window.reads.length);
      await page.getByRole("button", { name: "logout", exact: true }).click();
      await page.getByRole("button", { name: "A", exact: true }).click();
      await waitReads(count + 1);
      await complete(count, "after-login", null);
      await page.waitForFunction(() =>
        document.querySelector("output").textContent.includes("after-login"),
      );
      await page.close();
    }
  console.log(
    "PASS: A-B-A isolates initial/older history success and failure, abort signals, new cursors and auth reset",
  );
} finally {
  await browser.close();
}
