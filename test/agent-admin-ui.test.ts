import assert from "node:assert/strict";
import test from "node:test";
import { buildAPI } from "../src/api/server.js";
import { Fault } from "../src/domain/model.js";
import type { HarnessService } from "../src/domain/service.js";
import type { SandboxManager } from "../src/sandbox/manager.js";
test("legacy console URLs redirect to React management without exposing admin data", async () => {
  const app = buildAPI(
    {} as HarnessService,
    async () => {
      throw new Fault(401, "UNAUTHENTICATED");
    },
    {} as SandboxManager,
  );
  try {
    for (const url of ["/admin/ui", "/admin/agents/ui"]) {
      const response = await app.inject({ url });
      assert.equal(response.statusCode, 302);
      assert.equal(response.headers.location, "/admin/agents");
      assert.doesNotMatch(response.body, /<script/);
    }
    assert.equal(
      (await app.inject({ url: "/api/v1/admin/agents" })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: "/api/v1/admin/skills" })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: "/assets/..%2Fpackage.json" })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test("React static shell honors rollout switch and only serves configured artifacts", async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp("/tmp/pi-flow-web-static-");
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><div id="root"></div>',
  );
  await writeFile(join(root, "assets", "app-test.js"), "/* static fixture */");
  const previous = process.env.CHAT_WEB_DIR,
    enabled = process.env.CHAT_UI_ENABLED;
  process.env.CHAT_WEB_DIR = root;
  delete process.env.CHAT_UI_ENABLED;
  const app = buildAPI(
    {} as HarnessService,
    async () => {
      throw new Fault(401, "UNAUTHENTICATED");
    },
    {} as SandboxManager,
  );
  try {
    const rootShell = await app.inject({ url: "/admin" });
    assert.equal(rootShell.statusCode, 200);
    assert.match(rootShell.body, /id="root"/);
    const shell = await app.inject({ url: "/admin/skills" });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.headers["cache-control"] as string, /no-store/);
    const asset = await app.inject({ url: "/assets/app-test.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers["cache-control"] as string, /immutable/);
    assert.equal(
      (await app.inject({ url: "/assets/missing.js" })).statusCode,
      404,
    );
    process.env.CHAT_UI_ENABLED = "false";
    assert.equal((await app.inject({ url: "/admin" })).statusCode, 404);
    assert.equal((await app.inject({ url: "/admin/skills" })).statusCode, 404);
    assert.equal(
      (await app.inject({ url: "/assets/app-test.js" })).statusCode,
      404,
    );
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.CHAT_WEB_DIR;
    else process.env.CHAT_WEB_DIR = previous;
    if (enabled === undefined) delete process.env.CHAT_UI_ENABLED;
    else process.env.CHAT_UI_ENABLED = enabled;
    await rm(root, { recursive: true, force: true });
  }
});
