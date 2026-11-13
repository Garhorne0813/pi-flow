import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium as browserEngine } from "playwright-core";
import { buildAPI } from "../src/api/server.js";
import { MemoryStore } from "../src/storage/store.js";
import { MemoryRegistry, principal } from "../src/storage/registry.js";
import { personalStore } from "../src/storage/personal.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { seedDemo } from "../src/config/agents.js";
import { DemoSandbox, SandboxManager } from "../src/sandbox/manager.js";
import { HostSkillPackages } from "../src/skills/packages.js";
import { skillZip, skillMarkdown } from "./helpers/skill-zip.js";

const chromium = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  browserEngine.executablePath(),
].find((p): p is string => !!p && existsSync(p));
if (
  process.env.REQUIRE_POSTGRES_TESTS === "true" &&
  !existsSync("web/dist/index.html")
)
  throw new Error("Build web before React management acceptance");
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !chromium)
  throw new Error("Chromium required for personal console acceptance");

async function setup(packages?: HostSkillPackages) {
  const registry = new MemoryRegistry();
  await registry.tx(seedDemo);
  const store = personalStore(new MemoryStore(), registry);
  const service = new PersonalService(store, registry, ["gateway"]);
  const authenticated = {
    tenantId: "identity-provider",
    userId: "admin",
    admin: true,
  };
  const actor = await principal(registry, authenticated);
  const app = buildAPI(
    service,
    async (header) => ({
      ...authenticated,
      userId: header === "other" ? "other-admin" : "admin",
    }),
    new SandboxManager(store, new DemoSandbox()),
    undefined,
    packages,
  );
  return { app, registry, service, store, actor };
}

test("personal console management writes platform registry shared across principals and invalidates stale edits", async () => {
  const { app, registry } = await setup();
  try {
    const config = (
      await app.inject({ url: "/api/v1/admin/configuration" })
    ).json();
    assert.equal(config.agentMode, "editable");
    const listed = await app.inject({ url: "/api/v1/admin/agents" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items[0].id, "assistant");
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/agents/assistant/status",
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(
      await registry.read((s) => s.managedAgents!.assistant!.enabled),
      false,
    );
    const other = (
      await app.inject({
        url: "/api/v1/admin/agents",
        headers: { authorization: "other" },
      })
    ).json();
    assert.equal(other.items[0].enabled, false);
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/admin/config/agents",
      payload: { revision: config.agentsRevision, agents: [] },
    });
    assert.equal(stale.statusCode, 409);
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/admin/mcp-servers",
      payload: { id: "docs", endpointRef: "gateway", allowedTools: ["search"] },
    });
    assert.equal(registered.statusCode, 201);
    assert.equal(await registry.read((s) => s.mcp.docs!.enabled), true);
    const acl = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/logical-agents/assistant/access",
      payload: { allowedUsers: ["allowed-user"] },
    });
    assert.equal(acl.statusCode, 200);
    assert.deepEqual(
      await registry.read((s) => s.managedAgents!.assistant!.allowedUsers),
      ["allowed-user"],
    );
  } finally {
    await app.close();
  }
});

test(
  "personal browser console edits stable configurations without losing snapshots or extra fields and uploads Skills",
  { skip: !chromium },
  async () => {
    const root = await mkdtemp(resolve("work/personal-console-"));
    const { app, registry, service, actor, store } = await setup(
      new HostSkillPackages(root),
    );
    await registry.tx((s) => {
      s.managedAgents!.assistant!.config.userTokenAccess = true;
      s.managedAgents!.assistant!.config.agentsMd = [
        "",
        "  preserved whitespace\n\n",
        "# Rules\n- Keep boundaries",
      ];
    });
    const session = await service.createPersonalSession(actor, {
      agentId: "assistant",
    });
    // Queue a snapshot without caller token access, then restore the editable field.
    await registry.tx((s) => {
      s.managedAgents!.assistant!.config.userTokenAccess = false;
    });
    const queued = await service.submit(
      actor,
      session.id,
      "queued before edit",
    );
    await registry.tx((s) => {
      s.managedAgents!.assistant!.config.userTokenAccess = true;
    });
    const browser = await browserEngine.launch({
      executablePath: chromium,
      args: ["--no-sandbox"],
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const page = await browser.newPage();
      page.on("dialog", (d) => d.accept());
      page.on("pageerror", (e) =>
        console.error("React management page error:", e.message),
      );
      await page.route("**/api/v1/**", (route) =>
        route.continue({
          headers: { ...route.request().headers(), authorization: "admin" },
        }),
      );
      await page.goto(address + "/admin/agents");
      await page.getByRole("button", { name: /Personal Assistant/ }).click();
      await page
        .getByLabel("System Prompt", { exact: true })
        .fill("Edited from personal console");
      await page
        .getByRole("button", { name: "检查并保存", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认保存 Agent", exact: true })
        .click();
      await page.getByRole("status").filter({ hasText: "操作成功" }).waitFor();
      const current = await registry.read((s) => s.managedAgents!.assistant!);
      assert.equal(current.config.systemPrompt, "Edited from personal console");
      assert.equal(current.config.userTokenAccess, true);
      assert.deepEqual(current.config.agentsMd, [
        "",
        "  preserved whitespace\n\n",
        "# Rules\n- Keep boundaries",
      ]);
      assert.equal(await registry.read((s) => Object.keys(s.agents).length), 0);
      assert.equal(
        await store.readRun(
          actor.tenantId,
          queued.id,
          (s) => s.runs[queued.id]!.capabilities!.systemPrompt,
        ),
        queued.capabilities!.systemPrompt,
      );
      await page
        .getByRole("link", { name: "Skills 管理", exact: true })
        .click();
      const upload = page.locator("form").filter({
        has: page.getByRole("heading", {
          name: "上传 Skill ZIP",
          exact: true,
        }),
      });
      await upload
        .getByLabel("版本 ID", { exact: true })
        .fill("personal-review@v1");
      await upload
        .getByLabel("Skill 名称", { exact: true })
        .fill("Personal review");
      await upload.getByLabel("Skill ZIP 包", { exact: true }).setInputFiles({
        name: "skill.zip",
        mimeType: "application/zip",
        buffer: skillZip([{ path: "SKILL.md", content: skillMarkdown }]),
      });
      await upload
        .getByRole("button", { name: "上传并登记版本", exact: true })
        .click();
      await page.getByRole("heading", { name: /Personal review/ }).waitFor();
      assert.equal(
        await registry.read((s) => s.skills["personal-review@v1"]?.enabled),
        true,
      );
      const toggled = page.waitForResponse(
        (r) =>
          r.url().includes("/skills/personal-review%40v1/status") &&
          r.request().method() === "PUT",
      );
      await page
        .getByRole("button", { name: "禁用 personal-review@v1", exact: true })
        .click();
      assert.equal((await (await toggled).json()).enabled, false);
      await page
        .getByRole("button", { name: "启用 personal-review@v1", exact: true })
        .waitFor();
      await page
        .getByRole("link", { name: "MCP Servers", exact: true })
        .first()
        .click();
      const mcpForm = page.locator("form").filter({
        has: page.getByRole("heading", {
          name: "登记 MCP Server",
          exact: true,
        }),
      });
      await mcpForm.getByLabel("Server ID", { exact: true }).fill("docs");
      await mcpForm
        .getByLabel("Endpoint", { exact: true })
        .selectOption("gateway");
      await mcpForm.getByLabel("允许工具（逗号分隔）").fill("search");
      await mcpForm
        .getByRole("button", { name: "登记 MCP Server", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "docs · 启用", exact: true })
        .waitFor();
      assert.deepEqual(await registry.read((s) => s.mcp.docs!.allowedTools), [
        "search",
      ]);
      await page
        .getByRole("button", { name: "检查连接 docs", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "MCP_CHECK_UNAVAILABLE" })
        .waitFor();
      await page
        .getByRole("link", { name: "子 Agent 委派", exact: true })
        .first()
        .click();
      await page
        .getByRole("heading", { name: "委派关系", exact: true })
        .waitFor();
      await page.getByRole("link", { name: "Agent 管理", exact: true }).click();
      await page
        .getByRole("button", { name: "新建 Agent", exact: true })
        .click();
      await page
        .getByLabel("Agent 名称", { exact: true })
        .fill("New managed agent");
      await page.getByLabel("Provider", { exact: true }).fill("demo");
      await page.getByLabel("Model ID", { exact: true }).fill("demo");
      await page
        .getByRole("button", { name: "检查并保存", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认保存 Agent", exact: true })
        .click();
      await page.getByRole("button", { name: /New managed agent/ }).waitFor();
      assert.equal(
        await registry.read((s) => Object.keys(s.managedAgents!).length),
        2,
      );
    } finally {
      await browser.close();
      await app.close();
      async function unseal(dir: string) {
        await chmod(dir, 0o755);
        for (const entry of await readdir(dir, { withFileTypes: true }))
          if (entry.isDirectory()) await unseal(dir + "/" + entry.name);
      }
      await unseal(root);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("client-selected session IDs deduplicate committed creation retries", async () => {
  const { app, service, actor, store } = await setup();
  const id = "0a4982dc-9b94-4c44-8a86-79053c47d112";
  const payload = { id, agentId: "assistant", title: "first message" };
  try {
    // Treat the first committed response as lost, then repeat via the API.
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload,
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload,
    });
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().id, id);
    const recreated = new PersonalService(store, service.registry, ["gateway"]);
    const [a, b] = await Promise.all([
      recreated.createPersonalSession(actor, payload),
      recreated.createPersonalSession(actor, payload),
    ]);
    assert.equal(a.id, b.id);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { ...payload, title: "different" },
    });
    assert.equal(conflict.statusCode, 409);
    const list = await app.inject({ url: "/api/v1/sessions" });
    assert.equal(
      list.json().items.filter((s: { id: string }) => s.id === id).length,
      1,
    );
  } finally {
    await app.close();
  }
});
