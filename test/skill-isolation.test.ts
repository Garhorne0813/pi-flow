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
      return { text: selected.name, sha256: selected.digest };
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

test("switching Agent skill sets replaces Sandbox before access, retains workspace, and clears skills for file APIs", async () => {
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
  const oldBox = await f.provider.create(oldVolume, "default", [a, b, c]);
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
          assert.deepEqual(await ctx.call("remote_ls", { path: "/skills" }), {
            entries: [a.path, c.path],
          });
          await ctx.call("delegate_to_agent", {
            agentVersionId: child.id,
            task: "child",
          });
          assert.deepEqual(await ctx.call("remote_ls", { path: "/skills" }), {
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
              (await ctx.call("remote_read", { path: a.path })) as {
                text: string;
              }
            ).text,
            "a",
          );
          await assert.rejects(ctx.call("remote_read", { path: b.path }), {
            code: "FILE_NOT_FOUND",
          });
          await assert.rejects(ctx.call("remote_read", { path: c.path }), {
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
