import { existsSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const output = new URL("../../work/previews/", import.meta.url).pathname;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  headless: true,
  args: ["--no-sandbox"],
});
const config = {
  name: "工作流助手",
  systemPrompt: "以清晰、可靠的方式协助完成工作。",
  agentsMd: [],
  model: { provider: "demo", modelId: "demo" },
  tools: ["read", "ls"],
  skills: [],
  mcpServers: [],
  subagents: [],
  skillBundle: "default",
  maxSteps: 30,
  maxTokens: 100000,
  timeoutSeconds: 600,
  maxSubagents: 2,
  maxDepth: 1,
};
const sid = "11111111-1111-4111-8111-111111111111";
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname,
      json = (body) => route.fulfill({ json: body });
    if (path.endsWith("/me"))
      return json({ userId: "preview-user", admin: true, role: "admin" });
    if (path.endsWith("/agents") && !path.includes("/admin/config/"))
      return json({ items: [{ id: "assistant", config }] });
    if (path.endsWith("/sessions"))
      return json({
        items: [
          {
            id: sid,
            title: "构建清晰、可靠的 Agent 工作流",
            cwd: "/workspace",
            agentId: "assistant",
          },
          {
            id: "draft-session",
            title: "整理项目架构与开发计划",
            cwd: "/workspace",
            agentId: "assistant",
          },
        ],
      });
    if (path.endsWith("/timeline"))
      return json({
        items: [
          {
            id: "run:preview",
            kind: "user",
            runId: "preview",
            text: "帮我设计一个简单、可靠的 Agent 工作流。",
          },
          {
            id: "tool:preview",
            kind: "tool",
            runId: "preview",
            callId: "read",
            name: "read",
            state: "completed",
          },
          {
            id: "event:2",
            kind: "assistant",
            runId: "preview",
            text: '## 让复杂工作，变得清晰\n\n可以将流程拆成三个步骤：**理解目标、执行任务、检查结果**。每一步都有明确的输入与输出。\n\n```typescript\nconst workflow = {\n  agent: "assistant",\n  steps: ["understand", "execute", "verify"],\n  workspace: "/workspace",\n};\n```\n\n| 阶段 | 关注点 |\n| --- | --- |\n| 理解目标 | 确认范围与约束 |\n| 执行任务 | 记录工具调用与产物 |\n| 检查结果 | 验证完成情况 |\n\n所有工具调用会保留在对话中，需要批准的操作会先向你确认。',
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith("/active-task")) return json({ activeRun: null });
    if (path.endsWith("/config/agents"))
      return json({
        revision: 1,
        items: [{ id: "assistant", config, enabled: true, allowedUsers: [] }],
      });
    if (path.endsWith("/skills") || path.endsWith("/mcp-servers"))
      return json({ items: [] });
    if (path.endsWith("/configuration"))
      return json({
        agentMode: "editable",
        agentDefaults: config,
        skillUploads: {
          enabled: false,
          maxArchiveBytes: 1000000,
          maxExpandedBytes: 2000000,
          maxFiles: 100,
        },
        deployment: {
          models: [config.model],
          bundles: ["default"],
          endpoints: [],
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND" } },
    });
  });
  await page.goto("http://127.0.0.1:5173/chat");
  await page
    .getByLabel("选择 Agent")
    .locator("option")
    .first()
    .waitFor({ state: "attached" });
  await page.getByRole("link", { name: "管理中心", exact: true }).waitFor();
  await page.screenshot({ path: output + "dsh-empty-desktop.png" });
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(255, 255, 255)",
  );
  await page.goto("http://127.0.0.1:5173/chat/" + sid);
  await page.locator(".code-card .hljs-keyword").first().waitFor();
  await page.locator(".timeline").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: output + "dsh-conversation-desktop.png" });
  assert.equal(await page.locator(".message.user").count(), 1);
  assert.equal(await page.locator(".message.assistant table").count(), 1);
  await page.getByRole("button", { name: "自动换行", exact: true }).click();
  assert.equal(await page.locator(".code-source.wrapped").count(), 1);
  await page.goto("http://127.0.0.1:5173/chat");
  await page.getByRole("button", { name: "切换深浅主题" }).click();
  await page.waitForFunction(() =>
    document.body.hasAttribute("data-ds-dark-theme"),
  );
  await page.screenshot({ path: output + "dsh-empty-dark.png" });
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(21, 21, 23)",
  );
  await page.getByRole("button", { name: "切换深浅主题" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: output + "dsh-empty-mobile.png" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.getByRole("button", { name: "展开会话列表" }).click();
  await page.getByRole("button", { name: "关闭会话列表" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("http://127.0.0.1:5173/admin/agents");
  await page.getByRole("button", { name: /工作流助手/ }).click();
  await page.getByRole("heading", { name: "编辑 Agent" }).waitFor();
  await page.screenshot({ path: output + "dsh-admin-desktop.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: DSH light/dark tokens, code highlighting/wrap, GFM, mobile drawer/overflow, admin presentation; previews in " +
      output,
  );
} finally {
  await browser.close();
}
