import { existsSync } from "node:fs";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const kind of ["approval", "question"]) {
    const page = await browser.newPage();
    let continued = false;
    const responses = [];
    const event = (eventId, type, data, runId = "root") => ({
      eventId,
      runId,
      sessionId: "session",
      type,
      timestamp: "2026-11-11T00:00:00.000Z",
      data,
    });
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      const json = (body) => route.fulfill({ json: body });
      if (path.endsWith("/agents"))
        return json({
          items: [{ id: "assistant", config: { name: "Assistant" } }],
        });
      if (path.endsWith("/sessions"))
        return json({
          items: [
            { id: "session", agentId: "assistant", title: "Interaction" },
          ],
        });
      if (path.endsWith("/timeline"))
        return json({ items: [], nextCursor: null });
      if (path.endsWith("/active-task"))
        return json({
          activeRun: continued
            ? { id: "next", state: "RUNNING", taskId: "task" }
            : { id: "root", state: "WAITING_INPUT", taskId: "task" },
        });
      if (path.endsWith("/response")) {
        responses.push(route.request().postDataJSON().response);
        continued = true;
        return json({ id: "next", state: "QUEUED", taskId: "task" });
      }
      if (path.endsWith("/events")) {
        const es = path.includes("/next/")
          ? [
              event(
                1,
                "message.completed",
                {
                  message: {
                    role: "assistant",
                    content:
                      "Continued safely <script>window.pwned=1</script> [bad](javascript:alert(1))",
                  },
                },
                "next",
              ),
            ]
          : [
              event(1, "interaction.required", {
                interaction: {
                  id: "interaction",
                  kind,
                  payload:
                    kind === "approval"
                      ? { name: "bash" }
                      : { question: "What should I do?" },
                },
              }),
            ];
        return route.fulfill({
          contentType: "text/event-stream",
          body: es.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        });
      }
      if (path.includes("/runs/"))
        return json({
          id: continued ? "next" : "root",
          state: continued ? "COMPLETED" : "WAITING_INPUT",
          taskId: "task",
        });
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND" } },
      });
    });
    await page.goto("http://127.0.0.1:5173/chat/session");
    if (kind === "approval")
      await page.getByRole("button", { name: "批准", exact: true }).click();
    else {
      await page.getByLabel("你的回答").fill("Please continue");
      await page.getByRole("button", { name: "提交回答" }).click();
    }
    await page
      .getByText(/Continued safely/)
      .first()
      .waitFor({ timeout: 10000 });
    assert.deepEqual(responses, [
      kind === "approval" ? "approve" : "Please continue",
    ]);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    await page.close();
  }
  console.log(
    "PASS: approval/question responses, continuation stream, HTML and unsafe URL rejection",
  );
} finally {
  await browser.close();
}
