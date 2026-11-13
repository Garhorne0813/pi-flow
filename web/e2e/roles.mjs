import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
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
  for (const admin of [false, true]) {
    const page = await browser.newPage();
    let adminCalls = 0,
      revision = 0,
      defaultsRevision = 0;
    const writes = [];
    let conflict = false;
    const defaults = {
      model: { provider: "demo", modelId: "demo" },
      tools: ["read"],
      skillBundle: "default",
      maxSteps: 30,
      maxTokens: 100000,
      timeoutSeconds: 600,
      maxSubagents: 2,
      maxDepth: 1,
    };
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname,
        json = (body) => route.fulfill({ json: body });
      if (path === "/api/v1/me")
        return json({
          userId: admin ? "admin-id" : "user-id",
          admin,
          role: admin ? "admin" : "user",
        });
      if (path.endsWith("/agents"))
        return json({
          items: [{ id: "assistant", config: { name: "Assistant" } }],
        });
      if (path.endsWith("/sessions")) return json({ items: [] });
      if (path.includes("/admin/")) {
        adminCalls++;
        if (!admin)
          return route.fulfill({
            status: 403,
            json: { error: { code: "ADMIN_REQUIRED" } },
          });
      }
      if (path.endsWith("/config/global")) {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          writes.push(body);
          if (conflict)
            return route.fulfill({
              status: 409,
              json: { error: { code: "CONFIG_REVISION_CONFLICT" } },
            });
          revision++;
        }
        return json({
          revision,
          policy: { disabledTools: [] },
          modelCatalog: [],
        });
      }
      if (path.endsWith("/configuration/defaults")) {
        const body = route.request().postDataJSON();
        writes.push(body);
        const { expectedRevision, ...values } = body;
        Object.assign(defaults, values);
        defaultsRevision++;
        return json({ agentDefaults: defaults, defaultsRevision });
      }
      if (path.endsWith("/configuration"))
        return json({
          agentDefaults: defaults,
          defaultsRevision,
          deployment: { editable: false },
        });
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND" } },
      });
    });
    await page.goto("http://127.0.0.1:5173/settings");
    await page.getByRole("heading", { name: "登录身份" }).waitFor();
    assert.equal(
      await page.getByRole("link", { name: "管理中心", exact: true }).count(),
      admin ? 1 : 0,
    );
    await page.getByLabel("外观").selectOption("dark");
    await page.getByLabel("发送快捷键").selectOption("ctrlEnter");
    await page.reload();
    await page.getByRole("heading", { name: "登录身份" }).waitFor();
    assert.equal(await page.getByLabel("外观").inputValue(), "dark");
    assert.equal(await page.getByLabel("发送快捷键").inputValue(), "ctrlEnter");
    await page.goto("http://127.0.0.1:5173/admin/settings");
    if (!admin) {
      await page.getByRole("heading", { name: "无权访问" }).waitFor();
      assert.equal(adminCalls, 0);
      for (const path of [
        "/admin/agents",
        "/admin/skills",
        "/admin/mcp",
        "/admin/delegation",
      ]) {
        await page.goto("http://127.0.0.1:5173" + path);
        await page.getByRole("heading", { name: "无权访问" }).waitFor();
        assert.equal(adminCalls, 0);
      }
    } else {
      await page.getByRole("heading", { name: "模型与工具策略" }).waitFor();
      await page.getByLabel("全局禁用工具（逗号分隔）").fill("bash, write");
      await page
        .getByRole("button", { name: "保存全局配置", exact: true })
        .click();
      await page.getByText("当前配置版本：1。", { exact: false }).waitFor();
      assert.deepEqual(writes[0].policy.disabledTools, ["bash", "write"]);
      assert.equal(writes[0].revision, 0);
      await page.getByRole("button", { name: "添加模型", exact: true }).click();
      await page.getByLabel("提供商", { exact: true }).fill("example");
      await page.getByLabel("模型 ID", { exact: true }).fill("chat-model");
      await page
        .getByLabel("API 地址", { exact: true })
        .fill("https://model.example.com");
      await page.getByLabel("密钥引用", { exact: true }).fill("model-key");
      await page
        .getByLabel("写入新密钥（留空保留现有值）")
        .fill("test-write-only-secret");
      await page
        .getByRole("button", { name: "保存全局配置", exact: true })
        .click();
      await page.getByText("当前配置版本：2。", { exact: false }).waitFor();
      assert.deepEqual(writes.at(-1).secrets, {
        "model-key": "test-write-only-secret",
      });
      assert.equal(await page.locator("input[type=password]").count(), 0);
      assert.equal(
        await page.getByText("test-write-only-secret", { exact: true }).count(),
        0,
      );
      conflict = true;
      await page.getByLabel("全局禁用工具（逗号分隔）").fill("edit");
      await page
        .getByRole("button", { name: "保存全局配置", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "配置已被其他管理员更新" })
        .waitFor();
      assert.equal(
        await page.getByLabel("全局禁用工具（逗号分隔）").inputValue(),
        "edit",
      );
      await page.getByLabel("最大执行步数").fill("42");
      await page
        .getByRole("button", { name: "保存 Agent 默认配置", exact: true })
        .click();
      await page.getByText("Agent 默认配置已保存", { exact: true }).waitFor();
      assert.equal(writes.at(-1).maxSteps, 42);
      assert.equal(writes.at(-1).expectedRevision, 0);
      await page.getByLabel("最大执行步数").fill("43");
      const globalDraft = await page
        .getByLabel("全局禁用工具（逗号分隔）")
        .inputValue();
      revision++;
      const refreshed = page.waitForResponse(
        (r) =>
          r.url().includes("/admin/config/global") &&
          r.request().method() === "GET",
      );
      await page.evaluate(async () => {
        const url = performance
          .getEntriesByType("resource")
          .find((e) => e.name.includes("/@tanstack_react-query.js")).name;
        const { focusManager } = await import(url);
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await refreshed;
      assert.equal(await page.getByLabel("最大执行步数").inputValue(), "43");
      assert.equal(
        await page.getByLabel("全局禁用工具（逗号分隔）").inputValue(),
        globalDraft,
      );
      const guard = page.waitForEvent("dialog");
      const navigation = page
        .getByRole("link", { name: "Skills 管理", exact: true })
        .click();
      await (await guard).dismiss();
      await navigation;
      assert.match(page.url(), /admin\/settings/);
      assert.equal(await page.getByLabel("最大执行步数").inputValue(), "43");
      const leave = page.waitForEvent("dialog");
      const accepted = page
        .getByRole("link", { name: "Skills 管理", exact: true })
        .click();
      await (await leave).accept();
      await accepted;
      await page.waitForURL("**/admin/skills");
    }
    await page.close();
  }
  console.log(
    "PASS: trusted role navigation, direct admin denial without requests, per-user preferences, revision save/conflict, Agent defaults",
  );
} finally {
  await browser.close();
}
