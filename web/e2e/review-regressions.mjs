import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  let timelines = 0;
  const cursors = [];
  let authorized = false;
  await page.route("**/api/v1/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body) => route.fulfill({ json: body });
    if (route.request().headers().authorization === "Bearer local-test-token")
      authorized = true;
    if (!authorized)
      return route.fulfill({
        status: 401,
        json: { error: { code: "UNAUTHENTICATED" } },
      });
    if (path.endsWith("/me")) return json({ userId: "demo", admin: true });
    if (path.endsWith("/admin/config/agents"))
      return json({ revision: 1, items: [] });
    if (path.endsWith("/configuration"))
      return json({
        agentDefaults: {},
        deployment: { bundles: [], endpoints: [], models: [] },
      });
    if (path.endsWith("/agents"))
      return json({
        items: [{ id: "assistant", config: { name: "Assistant" } }],
      });
    if (path.endsWith("/sessions"))
      return json({
        items: [{ id: "s1", title: "Conversation", agentId: "assistant" }],
      });
    if (path.endsWith("/timeline")) {
      timelines++;
      cursors.push(url.searchParams.get("cursor"));
      if (timelines === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: "TEMPORARY" } },
        });
      return json({
        items:
          url.searchParams.get("cursor") === "A"
            ? [
                {
                  id: "event:10",
                  kind: "interaction",
                  runId: "r1",
                  interactionId: "approval1",
                  interactionKind: "approval",
                  text: "Historical approval",
                  resolved: false,
                },
              ]
            : [
                {
                  id: "event:20",
                  kind: "resolved",
                  runId: "r1",
                  interactionId: "approval1",
                },
              ],
        nextCursor: url.searchParams.get("cursor") === "A" ? "B" : "A",
      });
    }
    if (path.endsWith("/active-task")) return json({ activeRun: null });
    return json({ items: [] });
  });
  await page.goto("http://localhost:5173/chat/s1");
  await page.getByLabel("本地访问令牌").fill("local-test-token");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "加载更早的消息" }).waitFor();
  await page.getByRole("button", { name: "加载更早的消息" }).click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "加载更早的消息" }).click();
  await page.waitForTimeout(200);
  assert.deepEqual(cursors.filter(Boolean), ["A", "B"]);
  await page.getByText("Historical approval", { exact: true }).waitFor();
  assert.equal(await page.getByText("等待响应", { exact: true }).count(), 0);
  assert.equal(await page.getByText("已响应", { exact: true }).count(), 2);
  assert.equal(await page.locator(".interaction button").count(), 0);
  assert.equal(await page.locator(".message.resolved").count(), 0);
  await page.getByLabel("退出登录", { exact: true }).click();
  await page.getByLabel("本地访问令牌").waitFor();
  authorized = false;
  await page.getByLabel("本地访问令牌").fill("local-test-token");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "加载更早的消息" }).waitFor();
  await page.getByRole("link", { name: "管理中心", exact: true }).click();
  await page.waitForURL("**/admin/agents");
  await page.getByRole("button", { name: "新建 Agent", exact: true }).click();
  await page
    .getByLabel("System Prompt", { exact: true })
    .fill("unsaved prompt");
  const dialog = page.waitForEvent("dialog");
  const back = page.goBack();
  await (await dialog).dismiss();
  await back;
  await page.waitForURL("**/admin/agents");
  assert.match(page.url(), /admin\/agents/);
  assert.equal(
    await page.getByLabel("System Prompt", { exact: true }).inputValue(),
    "unsaved prompt",
  );
  const accepted = page.waitForEvent("dialog");
  const leave = page.goBack();
  await (await accepted).accept();
  await leave;
  await page.waitForURL("**/chat/s1");
  console.log(
    "PASS: token login/logout/relogin, initial history retry, pagination survives polling, back navigation draft protection",
  );
} finally {
  await browser.close();
}
