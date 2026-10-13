import assert from "node:assert/strict";
import { chromium as browserEngine } from "playwright-core";
import { existsSync } from "node:fs";
import test from "node:test";
import { AgentConfig } from "../src/domain.js";
import { agentAdminHTML } from "../src/agent-admin-ui.js";
import { buildAPI } from "../src/api.js";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";

const chromium = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  browserEngine.executablePath(),
].find((path): path is string => !!path && existsSync(path));
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !chromium)
  throw new Error("Chromium required for mandatory console acceptance");

test(
  "console publishes logical versions, preserves ACL and rolls back without losing task identity",
  { skip: !chromium },
  async () => {
    const store = new MemoryStore();
    const admin = { tenantId: "browser", userId: "admin", admin: true };
    const service = new HarnessService(
      store,
      [],
      ["default"],
      [{ provider: "demo", modelId: "demo" }],
    );
    const app = buildAPI(
      service,
      async () => admin,
      new SandboxManager(store, new DemoSandbox()),
    );
    const browser = await browserEngine.launch({
      executablePath: chromium,
      args: ["--no-sandbox"],
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const page = await browser.newPage();
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(address + "/admin/ui");
      await page.locator("#token").fill("test-admin");
      await page.locator("#connect").click();
      await page.locator("#connection").filter({ hasText: "已连接" }).waitFor();
      await page.locator("#name").fill("Browser Agent");
      await page.locator("#publish").click();
      await page.locator("#confirm-publish").click();
      await page.locator("#message").filter({ hasText: "发布成功" }).waitFor();
      const v1 = await page.locator("#version-id").textContent();
      const agentId = await page.locator("#agent-id").textContent();
      assert.ok(v1 && agentId && v1 !== agentId);
      await page.locator("#access-mode").selectOption("restricted");
      await page.locator("#allowed-users").fill("admin\nalice");
      await page.locator("#save-access").click();
      await page
        .locator("#message")
        .filter({ hasText: "访问权限已保存" })
        .waitFor();
      const workspace = await service.createWorkspace(
        admin,
        "browser workspace",
      );
      const session = await service.createSession(admin, workspace.id, v1);
      await page.locator("#clone").click();
      await page.locator("#prompt").fill("Second version");
      await page.locator("#publish").click();
      await page.locator("#confirm-publish").click();
      await page.locator("#message").filter({ hasText: "发布成功" }).waitFor();
      const v2 = await page.locator("#version-id").textContent();
      assert.ok(v2 && v2 !== v1);
      assert.equal(await page.locator("#agent-id").textContent(), agentId);
      assert.equal(
        await page.locator("#allowed-users").inputValue(),
        "admin\nalice",
      );
      const run = await service.submit(
        admin,
        session.id,
        "new task",
        "browser-v2",
      );
      assert.equal(run.agentVersionId, v2);
      await service.cancel(admin, run.id);
      await page
        .locator("#list .agent-item")
        .filter({ hasText: v1.slice(0, 8) })
        .click();
      await page.locator("#activate").click();
      await page
        .locator("#message")
        .filter({ hasText: "生效版本已更新" })
        .waitFor();
      assert.equal(
        await page.locator("#allowed-users").inputValue(),
        "admin\nalice",
      );
      const rolledBack = await service.submit(
        admin,
        session.id,
        "rollback task",
        "browser-v1",
      );
      assert.equal(rolledBack.agentVersionId, v1);
      await service.cancel(admin, rolledBack.id);
      await store.tx(admin.tenantId, (s) => {
        s.workspaces[workspace.id]!.members.bob = "editor";
      });
      await assert.rejects(
        service.createSession(
          { ...admin, userId: "bob", admin: false },
          workspace.id,
          v1,
        ),
        { code: "AGENT_NOT_FOUND" },
      );
      const listed = (await app.inject({ url: "/api/v1/admin/agents" })).json()
        .items;
      assert.equal(listed.length, 2);
      assert.ok(
        listed.every(
          (v: {
            agentId: string;
            activeVersionId: string;
            allowedUsers: string[];
          }) =>
            v.agentId === agentId &&
            v.activeVersionId === v1 &&
            v.allowedUsers.join() === "admin,alice",
        ),
      );
      const state = await store.read(admin.tenantId, (s) => s);
      assert.equal(Object.keys(state.logicalAgents).length, 1);
      assert.equal(state.agents[v1]!.allowedUsers, undefined);
      assert.equal(state.agents[v2]!.allowedUsers, undefined);
    } finally {
      await browser.close();
      await app.close();
      await store.close();
    }
  },
);

test(
  "native browser constraint validation permits an empty System Prompt",
  { skip: !chromium },
  async () => {
    const browser = await browserEngine.launch({
      executablePath: chromium,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      // Native validation uses the actual form markup without controller requests.
      await page.setContent(
        agentAdminHTML.replace(/<script[^>]*>[\s\S]*?<\/script>/, ""),
      );
      const valid = await page.evaluate(() => {
        for (const input of document.querySelectorAll<HTMLInputElement>(
          "#form input[required]",
        ))
          input.value = input.type === "number" ? input.min || "1" : "test";
        (document.getElementById("prompt") as HTMLTextAreaElement).value = "";
        return (
          document.getElementById("form") as HTMLFormElement
        ).checkValidity();
      });
      assert.equal(valid, true);
    } finally {
      await browser.close();
    }
  },
);

test("empty System Prompt matches the API schema and the form's declared constraint", () => {
  assert.equal(
    AgentConfig.parse({
      name: "Minimal",
      systemPrompt: "",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
      skillBundle: "default",
    }).systemPrompt,
    "",
  );
  const promptTag = agentAdminHTML.match(
    /<textarea\b[^>]*\bid="prompt"[^>]*>/,
  )?.[0];
  assert.ok(promptTag);
  assert.doesNotMatch(promptTag, /\brequired\b/);
});

test(
  "Agent workflow supports grouped versions, keyboard tabs, mobile review and dirty draft protection",
  { skip: !chromium },
  async () => {
    const store = new MemoryStore();
    const admin = { tenantId: "studio-browser", userId: "admin", admin: true };
    const service = new HarnessService(
      store,
      [],
      ["default"],
      [{ provider: "demo", modelId: "demo" }],
    );
    const config = AgentConfig.parse({
      name: "Grouped Agent",
      systemPrompt: "First prompt",
      agentsMd: [
        "# Rules\n\n- Keep formatting\n```ts\nconst x = 1;\n```\n",
        "",
      ],
      model: { provider: "demo", modelId: "demo" },
      tools: ["read"],
      skillBundle: "default",
    });
    const v1 = await service.publish(admin, config);
    const v2 = await service.publish(
      admin,
      { ...config, systemPrompt: "Second prompt" },
      v1.agentId,
    );
    // A same-name independent Agent must not share this Agent's ACL/version group.
    await service.publish(admin, config);
    const app = buildAPI(
      service,
      async () => admin,
      new SandboxManager(store, new DemoSandbox()),
    );
    const browser = await browserEngine.launch({
      executablePath: chromium,
      args: ["--no-sandbox"],
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let approve = false;
      page.on("dialog", (dialog) =>
        approve ? dialog.accept() : dialog.dismiss(),
      );
      await page.goto(address + "/admin/ui");
      await page.locator("#token").fill("admin");
      await page.locator("#connect").click();
      await page.locator("#connection").filter({ hasText: "已连接" }).waitFor();
      assert.equal(await page.locator(".agent-group").count(), 2);
      assert.equal(await page.locator(".agent-item").count(), 3);
      await page.locator(".agent-item").filter({ hasText: v2.id }).click();
      await page.locator("#clone").click();
      await page.locator("#editor-tab-basic").focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.locator("#editor-tab-model").getAttribute("aria-selected"),
        "true",
      );
      assert.equal(await page.locator("#editor-model").isVisible(), true);
      await page.keyboard.press("End");
      assert.equal(await page.locator("#editor-limits").isVisible(), true);
      // Constraint errors reveal their field even if its panel is hidden.
      await page.locator("#editor-tab-model").click();
      await page.locator("#model").fill("");
      await page.locator("#editor-tab-basic").click();
      await page.locator("#publish").click();
      assert.equal(await page.locator("#editor-model").isVisible(), true);
      assert.equal(await page.locator("#publish-review").isVisible(), false);
      await page.locator("#model").fill("demo");
      await page.locator("#editor-tab-basic").click();
      await page.locator("#prompt").fill("Changed draft");
      await page.locator("#refresh-console").click();
      await page
        .locator("#message")
        .filter({ hasText: "数据已刷新" })
        .waitFor();
      await page.locator("#new").click();
      assert.equal(await page.locator("#prompt").inputValue(), "Changed draft");
      await page.locator(".agent-item").filter({ hasText: v1.id }).click();
      assert.equal(await page.locator("#prompt").inputValue(), "Changed draft");
      await page.locator("#disconnect").click();
      assert.equal(await page.locator("#connection").textContent(), "已连接");
      await page.locator("#publish").click();
      assert.equal(
        Object.keys((await store.read(admin.tenantId, (s) => s)).agents).length,
        3,
      );
      assert.match(
        (await page.locator("#review-diff").textContent()) || "",
        /Second prompt/,
      );
      assert.match(
        (await page.locator("#review-diff").textContent()) || "",
        /Changed draft/,
      );
      assert.doesNotMatch(
        (await page.locator("#review-diff").textContent()) || "",
        /agentsMd/,
      );
      await page.locator("#prompt").fill("Final prompt");
      assert.equal(await page.locator("#publish-review").isVisible(), false);
      await page.locator("#publish").click();
      approve = true;
      await page.locator("#confirm-publish").click();
      await page.locator("#message").filter({ hasText: "发布成功" }).waitFor();
      const state = await store.read(admin.tenantId, (s) => s);
      assert.equal(Object.keys(state.agents).length, 4);
      const versionId = await page.locator("#version-id").textContent();
      assert.ok(versionId);
      assert.deepEqual(
        state.agents[versionId]!.config.agentsMd,
        config.agentsMd,
      );
      assert.equal(state.agents[v2.id]!.config.systemPrompt, "Second prompt");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.deepEqual(errors, []);
      await page.setViewportSize({ width: 1024, height: 768 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    } finally {
      await browser.close();
      await app.close();
      await store.close();
    }
  },
);
