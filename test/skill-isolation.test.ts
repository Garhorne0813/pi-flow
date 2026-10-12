import test from "node:test";
import assert from "node:assert/strict";
import {
  Sandbox,
  Volume,
  VolumeMount,
  type CreateOptions,
} from "@cubesandbox/sdk";
import {
  CubeProvider,
  DemoSandbox,
  SandboxManager,
} from "../src/adapters/sandbox.js";
import { skillScope } from "../src/adapters/skill-mounts.js";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig, Fault, type Skill } from "../src/domain.js";
import { Worker } from "../src/worker.js";
import { MCPManager } from "../src/adapters/mcp.js";

const actor = { tenantId: "isolation", userId: "tester", admin: true };
const skill = (name: string): Skill => ({
  id: `${name}@v1`,
  name,
  description: name,
  bundle: "default",
  path: `/skills/${name}/SKILL.md`,
  digest: "a".repeat(64),
  enabled: true,
});
const a = skill("a"),
  b = skill("b"),
  c = skill("c");
const config = (extra: Record<string, unknown> = {}) =>
  AgentConfig.parse({
    name: "probe",
    systemPrompt: "probe",
    model: { provider: "demo", modelId: "demo" },
    tools: ["read"],
    skillBundle: "default",
    ...extra,
  });

test("Cube mounts only selected skill volumes read-only, including auxiliary files; empty selection mounts no skills", async (t) => {
  const connected: string[] = [],
    created: CreateOptions[] = [];
  t.mock.method(Volume, "connect", async (name: string) => {
    connected.push(name);
    return { volumeId: name } as Volume;
  });
  t.mock.method(Sandbox, "create", async (options: CreateOptions = {}) => {
    created.push(options);
    return { sandboxId: "box" } as Sandbox;
  });
  const provider = new CubeProvider(
    {
      [a.id]: { bundle: a.bundle, path: a.path, volume: "skill-a" },
      [b.id]: { bundle: b.bundle, path: b.path, volume: "skill-b" },
    },
    "sandbox",
    "nfs",
  );
  await provider.create("workspace", "default", [a]);
  assert.deepEqual(connected, ["workspace", "skill-a"]);
  assert.deepEqual(Object.keys(created[0]!.volumeMounts!), [
    "/workspace",
    "/skills/a",
  ]);
  const mount = created[0]!.volumeMounts!["/skills/a"] as VolumeMount;
  assert.ok(mount instanceof VolumeMount);
  assert.equal(mount.readOnly, true);
  assert.equal((mount.volume as Volume).volumeId, "skill-a");
  await provider.create("workspace", "default", []);
  assert.deepEqual(Object.keys(created[1]!.volumeMounts!), ["/workspace"]);
  const before = connected.length;
  await assert.rejects(provider.create("workspace", "default", [c]), {
    code: "SKILL_VOLUME_NOT_REGISTERED",
  });
  await assert.rejects(
    provider.create("workspace", "default", [
      { ...a, path: "/skills/other/SKILL.md" },
    ]),
    { code: "SKILL_VOLUME_NOT_REGISTERED" },
  );
  assert.equal(connected.length, before);
});

test("skill scopes reject overlapping mounts and duplicated/shared volumes", async (t) => {
  assert.throws(
    () =>
      skillScope("default", [a, { ...b, path: "/skills/a/nested/SKILL.md" }]),
    { code: "SKILL_MOUNT_CONFLICT" },
  );
  assert.throws(() => skillScope("default", [a, a]), {
    code: "SKILL_MOUNT_CONFLICT",
  });
  assert.throws(
    () =>
      new CubeProvider(
        {
          [a.id]: { bundle: a.bundle, path: a.path, volume: "shared" },
          [b.id]: { bundle: b.bundle, path: b.path, volume: "shared" },
        },
        "sandbox",
        "nfs",
      ),
    /separate volume/,
  );
  t.mock.method(
    Volume,
    "connect",
    async () => ({ volumeId: "same-actual-volume" }) as Volume,
  );
  let creations = 0;
  t.mock.method(Sandbox, "create", async () => {
    creations++;
    return { sandboxId: "box" } as Sandbox;
  });
  const provider = new CubeProvider(
    { [a.id]: { bundle: a.bundle, path: a.path, volume: "alias" } },
    "sandbox",
    "nfs",
  );
  await assert.rejects(provider.create("workspace", "default", [a]), {
    code: "SKILL_VOLUME_CONFLICT",
  });
  assert.equal(creations, 0);
});

test("deployment volume changes alter scope and removed mappings cannot reuse an existing Sandbox", async () => {
  const volumes: Record<
    string,
    { bundle: string; path: string; volume: string }
  > = {
    [a.id]: { bundle: a.bundle, path: a.path, volume: "skill-a-v1" },
  };
  const provider = new CubeProvider(volumes, "sandbox", "nfs");
  const oldScope = provider.scope("default", [a]);
  volumes[a.id]!.volume = "skill-a-replacement";
  assert.notEqual(provider.scope("default", [a]), oldScope);
  const f = await fixture();
  const manager = new SandboxManager(f.store, provider);
  await f.store.tx(actor.tenantId, (s) => {
    s.workspaces[f.w.id]!.sandboxId = "old-box";
    s.workspaces[f.w.id]!.sandboxSkillScope = oldScope;
  });
  delete volumes[a.id];
  let executed = false;
  await assert.rejects(
    manager.withLease(
      actor,
      f.w.id,
      "owner",
      "default",
      async () => {
        executed = true;
      },
      [a.id],
    ),
    { code: "SKILL_VOLUME_NOT_REGISTERED" },
  );
  assert.equal(executed, false);
  assert.equal(
    (await f.store.tx(actor.tenantId, (s) => s.workspaces[f.w.id]!)).lock,
    undefined,
  );
});

class MountedFixture extends DemoSandbox {
  override async execute(
    sid: string,
    op: string,
    args: Record<string, unknown>,
  ) {
    if (String(args.path).startsWith("/skills")) {
      await this.connect(sid);
      const skills = this.skillSelections.get(sid)!;
      if (op === "ls") return { entries: skills.map((s) => s.path) };
      const selected = skills.find(
        (s) =>
          args.path === s.path ||
          args.path === s.path.replace("SKILL.md", "helper.py"),
      );
      if (!selected) throw new Fault(404, "FILE_NOT_FOUND");
      if (op !== "read") throw new Fault(403, "SKILLS_READ_ONLY");
      return { path: args.path, text: selected.name, sha256: selected.digest };
    }
    return super.execute(sid, op, args);
  }
}
async function fixture() {
  const store = new MemoryStore();
  await store.tx(actor.tenantId, (s) => {
    for (const sk of [a, b, c]) s.skills[sk.id] = sk;
  });
  const service = new HarnessService(store, [], ["default"]);
  const w = await service.createWorkspace(actor, "shared");
  const provider = new MountedFixture();
  const sandbox = new SandboxManager(store, provider);
  return { store, service, w, provider, sandbox };
}

test("switching Agent skill sets replaces Sandbox before access, retains workspace, and supports an empty Agent skill set", async () => {
  const f = await fixture();
  const run = (op: string, path: string, skills: string[], content?: string) =>
    f.sandbox.execute(
      actor,
      f.w.id,
      "owner",
      "default",
      op,
      { path, content },
      undefined,
      skills,
    );
  await run("write", "retained.txt", [a.id, b.id], "retained");
  const parent = await f.store.tx(actor.tenantId, (s) => s.workspaces[f.w.id]!);
  assert.equal(
    ((await run("read", a.path, [a.id, b.id])) as { text: string }).text,
    "a",
  );
  const unchanged = await f.store.tx(
    actor.tenantId,
    (s) => s.workspaces[f.w.id]!,
  );
  assert.equal(unchanged.sandboxId, parent.sandboxId);
  assert.deepEqual(await run("ls", "/skills", [b.id]), { entries: [b.path] });
  await assert.rejects(run("read", a.path, [b.id]), { code: "FILE_NOT_FOUND" });
  assert.equal(
    (
      (await run("read", b.path.replace("SKILL.md", "helper.py"), [b.id])) as {
        text: string;
      }
    ).text,
    "b",
  );
  const child = await f.store.tx(actor.tenantId, (s) => s.workspaces[f.w.id]!);
  assert.notEqual(child.sandboxId, parent.sandboxId);
  assert.equal(child.volumeId, parent.volumeId);
  assert.equal(f.provider.boxes.has(parent.sandboxId!), false);
  assert.deepEqual(await run("read", "retained.txt", []), { text: "retained" });
  const bare = await f.store.tx(actor.tenantId, (s) => s.workspaces[f.w.id]!);
  assert.deepEqual(f.provider.skillSelections.get(bare.sandboxId!), []);
  await assert.rejects(run("read", b.path, []), { code: "FILE_NOT_FOUND" });
  await assert.rejects(run("write", b.path, [b.id], "tamper"), {
    code: "SKILLS_READ_ONLY",
  });
});

test("legacy unscoped Sandbox is replaced; revoked or cross-bundle skills fail before tools run", async () => {
  const f = await fixture();
  const oldVolume = await f.provider.createVolume("legacy-workspace");
  const oldBox = (await f.provider.create(oldVolume, "default", [a, b, c]))
    .sandboxId;
  await f.store.tx(actor.tenantId, (s) => {
    s.workspaces[f.w.id]!.volumeId = oldVolume;
    s.workspaces[f.w.id]!.sandboxId = oldBox;
  });
  await f.sandbox.execute(
    actor,
    f.w.id,
    "owner",
    "default",
    "ls",
    { path: "/skills" },
    undefined,
    [a.id],
  );
  assert.equal(f.provider.boxes.has(oldBox), false);
  const current = await f.store.tx(
    actor.tenantId,
    (s) => s.workspaces[f.w.id]!,
  );
  assert.deepEqual(
    f.provider.skillSelections.get(current.sandboxId!)!.map((s) => s.id),
    [a.id],
  );
  await f.store.tx(actor.tenantId, (s) => {
    s.skills[b.id]!.enabled = false;
    s.skills[c.id]!.bundle = "other";
  });
  for (const id of [b.id, c.id, "missing@v1"])
    await assert.rejects(
      f.sandbox.execute(
        actor,
        f.w.id,
        "owner",
        "default",
        "ls",
        {},
        undefined,
        [id],
      ),
      { code: "SKILL_DENIED" },
    );
  assert.equal(
    (await f.store.tx(actor.tenantId, (s) => s.workspaces[f.w.id]!)).lock,
    undefined,
  );
});

test("failed Sandbox termination blocks skill scope change instead of using the broader mount", async () => {
  const f = await fixture();
  await f.sandbox.execute(
    actor,
    f.w.id,
    "owner",
    "default",
    "ls",
    { path: "/skills" },
    undefined,
    [a.id, b.id],
  );
  f.provider.kill = async () => {
    throw new Error("kill failed");
  };
  let executed = false;
  await assert.rejects(
    f.sandbox.withLease(
      actor,
      f.w.id,
      "owner",
      "default",
      async () => {
        executed = true;
      },
      [a.id],
    ),
    /kill failed/,
  );
  assert.equal(executed, false);
});

test("parent and child skills intersect physically and parent mounts are restored on the next tool call", async () => {
  const f = await fixture();
  const child = await f.service.publish(
    actor,
    config({ skills: [a.id, b.id] }),
  );
  const parent = await f.service.publish(
    actor,
    config({
      skills: [a.id, c.id],
      tools: ["read", "ls", "delegate_to_agent"],
      subagents: [child.id],
    }),
  );
  const ses = await f.service.createSession(actor, f.w.id, parent.id);
  const worker = new Worker(
    f.service,
    {
      execute: async (ctx) => {
        if (ctx.prompt === "parent") {
          assert.deepEqual(await ctx.call("ls", { path: "/skills" }), {
            entries: [a.path, c.path],
          });
          await ctx.call("delegate_to_agent", {
            agentVersionId: child.id,
            task: "child",
          });
          assert.deepEqual(await ctx.call("ls", { path: "/skills" }), {
            entries: [a.path, c.path],
          });
        } else {
          assert.deepEqual(ctx.config.skills, [a.id]);
          assert.deepEqual(
            ctx.skills.map((s) => s.id),
            [a.id],
          );
          assert.equal(
            (
              (await ctx.call("read", { path: a.path })) as {
                text: string;
              }
            ).text,
            "a",
          );
          await assert.rejects(ctx.call("read", { path: b.path }), {
            code: "FILE_NOT_FOUND",
          });
          await assert.rejects(ctx.call("read", { path: c.path }), {
            code: "FILE_NOT_FOUND",
          });
        }
      },
    },
    f.sandbox,
    new MCPManager(f.store, {}),
  );
  const run = await f.service.submit(actor, ses.id, "parent");
  try {
    for (let i = 0; i < 150; i++) {
      await worker.tick();
      const r = await f.store.tx(actor.tenantId, (s) => s.runs[run.id]!);
      if (["COMPLETED", "FAILED"].includes(r.state) && !r.lease) {
        assert.equal(r.state, "COMPLETED", r.error);
        const children = await f.store.tx(actor.tenantId, (s) =>
          Object.values(s.runs).filter((r) => r.parentRunId === run.id),
        );
        assert.equal(children[0]!.state, "COMPLETED");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Run did not settle");
  } finally {
    await worker.stop();
  }
});

test("viewer file APIs run alongside a skilled Agent without changing its instance, scope or lifecycle", async () => {
  const f = await fixture();
  await f.sandbox.execute(
    actor,
    f.w.id,
    "setup",
    "default",
    "write",
    { path: "retained.txt", content: "retained" },
    undefined,
    [a.id],
  );
  const viewer = { ...actor, userId: "viewer", admin: false };
  await f.store.tx(actor.tenantId, (s) => {
    s.workspaces[f.w.id]!.members.viewer = "viewer";
  });
  const before = await f.store.read(
    actor.tenantId,
    (s) => s.workspaces[f.w.id]!,
  );
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const execute = f.provider.execute.bind(f.provider);
  const observed: {
    sid: string;
    skills: readonly Skill[];
    args: Record<string, unknown>;
  }[] = [];
  f.provider.execute = async (sid, op, args) => {
    observed.push({ sid, skills: f.provider.skillSelections.get(sid)!, args });
    if (sid === before.sandboxId && op === "read") {
      entered();
      await gate;
    }
    return execute(sid, op, args);
  };
  const { buildAPI } = await import("../src/api.js");
  const app = buildAPI(
    f.service,
    async (h) => (h === "Bearer viewer" ? viewer : actor),
    f.sandbox,
  );
  const agent = f.sandbox.execute(
    actor,
    f.w.id,
    "agent",
    "default",
    "read",
    { path: a.path },
    undefined,
    [a.id],
  );
  try {
    await started;
    const held = await f.store.read(
      actor.tenantId,
      (s) => s.workspaces[f.w.id]!,
    );
    for (const suffix of [
      "",
      "/" + Buffer.from("retained.txt").toString("base64url"),
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/workspaces/${f.w.id}/files${suffix}`,
        headers: { authorization: "Bearer viewer" },
      });
      assert.equal(response.statusCode, 200, response.body);
      const current = await f.store.read(
        actor.tenantId,
        (s) => s.workspaces[f.w.id]!,
      );
      for (const field of [
        "sandboxId",
        "sandboxSkillScope",
        "sandboxState",
        "sandboxLastUsedAt",
        "lock",
      ] as const)
        assert.deepEqual(current[field], held[field]);
    }
    for (const path of [
      a.path,
      "/workspace/../skills/a/SKILL.md",
      "../skills/a/SKILL.md",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/workspaces/${f.w.id}/files/${Buffer.from(path).toString("base64url")}`,
        headers: { authorization: "Bearer viewer" },
      });
      assert.ok([400, 403].includes(response.statusCode), response.body);
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${f.w.id}/files`,
          payload: { path: "x", content: "x" },
          headers: { authorization: "Bearer viewer" },
        })
      ).statusCode,
      403,
    );
    const files = observed.filter((o) => o.sid !== before.sandboxId);
    assert.equal(files.length, 2);
    assert.ok(
      files.every(
        (o) => o.skills.length === 0 && o.args._workspaceOnly === true,
      ),
    );
    assert.equal(f.provider.boxes.size, 1, "file instances must be cleaned up");
    assert.equal((await f.sandbox.capacity.usage(actor)).user.active, 1);
  } finally {
    release();
    await agent;
    await app.close();
  }
  assert.equal(f.provider.boxes.has(before.sandboxId!), true);
});

test("file instances obey owner capacity limits and retain uncertain cleanup for retry", async () => {
  const f = await fixture();
  const manager = new SandboxManager(f.store, f.provider, {
    maxActivePerUser: 1,
  });
  await manager.execute(
    actor,
    f.w.id,
    "agent",
    "default",
    "write",
    { path: "x", content: "x" },
    undefined,
    [a.id],
  );
  const before = await manager.status(actor, f.w.id);
  await assert.rejects(
    manager.executeFile(actor, f.w.id, "files", "read", { path: "x" }),
    { code: "USER_SANDBOX_LIMIT" },
  );
  assert.deepEqual(await manager.status(actor, f.w.id), before);
  const kill = f.provider.kill.bind(f.provider);
  f.provider.kill = async (sid) => {
    if (sid !== before.sandboxId) throw Error("lost kill");
    return kill(sid);
  };
  await assert.rejects(
    f.sandbox.executeFile(actor, f.w.id, "files", "read", { path: "x" }),
    { code: "FILE_SANDBOX_CLEANUP_UNCONFIRMED" },
  );
  assert.equal((await f.sandbox.capacity.usage(actor)).user.active, 2);
  f.provider.kill = kill;
  assert.deepEqual(
    await f.sandbox.executeFile(actor, f.w.id, "retry", "read", { path: "x" }),
    { text: "x" },
  );
  assert.equal((await f.sandbox.capacity.usage(actor)).user.active, 1);
  assert.deepEqual(await f.sandbox.status(actor, f.w.id), before);
});

test("Sandbox injects only registered selected manifest identities, overriding untrusted arguments", async () => {
  const f = await fixture();
  let seen: Record<string, unknown> | undefined;
  f.provider.execute = async (_sid, _op, args) => {
    seen = args;
    return {};
  };
  await f.sandbox.execute(
    actor,
    f.w.id,
    "agent",
    "default",
    "grep",
    { pattern: "x", _skillManifests: [], _skillIds: [] },
    undefined,
    [a.id],
  );
  assert.deepEqual(seen!._skillManifests, [{ path: a.path, digest: a.digest }]);
  assert.deepEqual(seen!._skillIds, [a.id]);
});

test("Worker verifies resolved manifest identities for aliases and rejects unconfirmed identities", async () => {
  const f = await fixture();
  const agent = await f.service.publish(actor, config({ skills: [a.id] }));
  const session = await f.service.createSession(actor, f.w.id, agent.id);
  let checked = 0;
  f.provider.execute = async (_sid, _op, args) =>
    args.path === "unknown"
      ? { text: "unconfirmed", sha256: a.digest }
      : { path: a.path, text: "drifted", sha256: "0".repeat(64) };
  const worker = new Worker(
    f.service,
    {
      execute: async (ctx) => {
        for (const path of [
          a.path,
          "/skills/a/../a/SKILL.md",
          "/workspace/link",
          "unknown",
        ]) {
          await assert.rejects(ctx.call("read", { path }), {
            code:
              path === "unknown"
                ? "SKILL_IDENTITY_UNCONFIRMED"
                : "SKILL_DIGEST_MISMATCH",
          });
          checked++;
        }
      },
    },
    f.sandbox,
    new MCPManager(f.store, {}),
  );
  const run = await f.service.submit(actor, session.id, "integrity");
  try {
    await worker.tick();
    for (let i = 0; i < 100; i++) {
      const current = await f.store.read(
        actor.tenantId,
        (s) => s.runs[run.id]!,
      );
      if (current.state === "COMPLETED" && !current.lease) break;
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(checked, 4);
    assert.equal(
      await f.store.read(
        actor.tenantId,
        (s) =>
          s.events.filter(
            (e) => e.runId === run.id && e.type === "tool.completed",
          ).length,
      ),
      0,
    );
  } finally {
    await worker.stop();
  }
});

test("file lease blocks lifecycle and writes, allows Agent reads, and later file writes retain Agent scope", async () => {
  const f = await fixture();
  await f.sandbox.execute(
    actor,
    f.w.id,
    "setup",
    "default",
    "write",
    { path: "x", content: "before" },
    undefined,
    [a.id],
  );
  const agent = await f.sandbox.status(actor, f.w.id);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const original = f.provider.execute.bind(f.provider);
  f.provider.execute = async (sid, op, args) => {
    if (sid !== agent.sandboxId && op === "read") {
      entered();
      await gate;
    }
    return original(sid, op, args);
  };
  const file = f.sandbox.executeFile(actor, f.w.id, "file", "read", {
    path: "x",
  });
  try {
    await started;
    await assert.rejects(f.sandbox.pause(actor, f.w.id), {
      code: "WORKSPACE_BUSY",
    });
    await assert.rejects(f.sandbox.destroy(actor, f.w.id), {
      code: "WORKSPACE_BUSY",
    });
    await assert.rejects(
      f.sandbox.executeFile(actor, f.w.id, "writer", "write", {
        path: "x",
        content: "blocked",
      }),
      { code: "WORKSPACE_BUSY" },
    );
    const read = await f.sandbox.execute(
      actor,
      f.w.id,
      "agent",
      "default",
      "read",
      { path: a.path },
      undefined,
      [a.id],
    );
    assert.equal((read as { text: string }).text, "a");
  } finally {
    release();
    await file;
  }
  const beforeWrite = await f.sandbox.status(actor, f.w.id);
  await f.sandbox.executeFile(actor, f.w.id, "write", "write", {
    path: "x",
    content: "after",
  });
  assert.deepEqual(await f.sandbox.status(actor, f.w.id), beforeWrite);
  assert.deepEqual(
    f.provider.skillSelections.get(agent.sandboxId!)!.map((s) => s.id),
    [a.id],
  );
  assert.deepEqual(
    await f.sandbox.executeFile(actor, f.w.id, "read", "read", { path: "x" }),
    { text: "after" },
  );
});
