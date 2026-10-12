import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { AgentConfig } from "../src/domain.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";
import { MCPManager } from "../src/adapters/mcp.js";
import { Worker } from "../src/worker.js";
const actor = { tenantId: "timeouts", userId: "owner", admin: true };
const never = () => new Promise<never>(() => {});
async function fixture() {
  const store = new MemoryStore(),
    provider = new DemoSandbox();
  const sandbox = new SandboxManager(store, provider, {}, undefined, {
    remoteTimeoutMs: 70,
    cleanupTimeoutMs: 25,
  });
  const service = new HarnessService(store, [], ["default"]);
  const w = await service.createWorkspace(actor, "test");
  return { store, provider, sandbox, service, w };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Condition did not settle");
}
for (const stage of ["createVolume", "create", "connect", "kill"] as const)
  test(`Worker stop and slots are bounded when ${stage} ignores cancellation`, async () => {
    const f = await fixture();
    if (stage === "connect" || stage === "kill")
      await f.sandbox.execute(actor, f.w.id, "seed", "default", "ls", {});
    let entered!: () => void;
    const began = new Promise<void>((r) => {
      entered = r;
    });
    f.provider[stage] = async () => {
      entered();
      return never();
    };
    if (stage === "kill")
      f.provider.execute = async () => {
        entered();
        return never();
      };
    const agent = await f.service.publish(
      actor,
      AgentConfig.parse({
        name: "test",
        systemPrompt: "test",
        model: { provider: "demo", modelId: "demo" },
        tools: ["ls"],
        skillBundle: "default",
      }),
    );
    const session = await f.service.createSession(actor, f.w.id, agent.id);
    const run = await f.service.submit(actor, session.id, "blocked");
    const worker = new Worker(
      f.service,
      {
        execute: async (ctx) => {
          if (ctx.prompt === "blocked") await ctx.call("remote_ls", {});
          else await ctx.emit("message.completed", { message: "next" });
        },
      },
      f.sandbox,
      new MCPManager(f.store, {}),
      1,
    );
    await worker.tick();
    await began;
    const begin = Date.now();
    await worker.stop();
    assert.ok(Date.now() - begin < 500);
    const saved = await f.store.read(actor.tenantId, (s) => s.runs[run.id]!);
    assert.equal(saved.state, "FAILED");
    assert.equal(saved.error, "REMOTE_CANCEL_UNCONFIRMED");
    assert.equal(
      (await f.sandbox.capacity.get(actor.tenantId, f.w.id))?.state,
      "unknown",
    );
    assert.equal((await f.sandbox.capacity.usage(actor)).user.active, 1);
    // A fresh Worker can process another Run despite the abandoned SDK request.
    const next = await f.service.submit(actor, session.id, "next");
    const replacement = new Worker(
      f.service,
      { execute: async () => {} },
      f.sandbox,
      new MCPManager(f.store, {}),
      1,
    );
    await replacement.tick();
    await until(
      async () =>
        (await f.store.read(actor.tenantId, (s) => s.runs[next.id]!.state)) ===
        "COMPLETED",
    );
    await replacement.stop();
  });

test("create timeout without a returned ID remains charged, then reconciles a late ID", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const create = f.provider.create.bind(f.provider);
  f.provider.create = async (...args) => {
    await gate;
    return create(...args);
  };
  await assert.rejects(
    f.sandbox.execute(actor, f.w.id, "timeout", "default", "ls", {}),
    { code: "REMOTE_CANCEL_UNCONFIRMED" },
  );
  assert.equal(
    (await f.sandbox.capacity.get(actor.tenantId, f.w.id))?.sandboxId,
    undefined,
  );
  assert.equal((await f.sandbox.capacity.usage(actor)).user.active, 1);
  release();
  await until(
    async () => !(await f.sandbox.capacity.get(actor.tenantId, f.w.id)),
  );
  assert.equal(f.provider.boxes.size, 0);
  const audit = await f.store.read(actor.tenantId, (s) => s.audit);
  assert.ok(audit.some((e) => e.action === "sandbox.creation.late"));
  assert.ok(audit.some((e) => e.action === "sandbox.creation.reconciled"));
});

test("late connect is cleaned only after its remote result settles", async () => {
  const f = await fixture();
  await f.sandbox.execute(actor, f.w.id, "seed", "default", "ls", {});
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const connect = f.provider.connect.bind(f.provider);
  f.provider.connect = async (sid) => {
    await gate;
    await connect(sid);
  };
  await assert.rejects(
    f.sandbox.execute(actor, f.w.id, "timeout", "default", "ls", {}),
    { code: "REMOTE_CANCEL_UNCONFIRMED" },
  );
  assert.equal(f.provider.boxes.size, 1);
  release();
  await until(
    async () => !(await f.sandbox.capacity.get(actor.tenantId, f.w.id)),
  );
  assert.equal(f.provider.boxes.size, 0);
});

test("late kill confirmation releases only its original generation", async () => {
  const f = await fixture();
  await f.sandbox.execute(actor, f.w.id, "seed", "default", "ls", {});
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const kill = f.provider.kill.bind(f.provider);
  f.provider.kill = async (sid) => {
    await gate;
    await kill(sid);
  };
  await assert.rejects(f.sandbox.release(actor, f.w.id), {
    code: "SANDBOX_REMOTE_TIMEOUT",
  });
  assert.equal(
    (await f.sandbox.capacity.get(actor.tenantId, f.w.id))?.state,
    "unknown",
  );
  release();
  await until(
    async () => !(await f.sandbox.capacity.get(actor.tenantId, f.w.id)),
  );
});

test("a late volume response is traced and releases a reservation without creating an instance", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const createVolume = f.provider.createVolume.bind(f.provider);
  f.provider.createVolume = async (name) => {
    await gate;
    return createVolume(name);
  };
  await assert.rejects(
    f.sandbox.execute(actor, f.w.id, "timeout", "default", "ls", {}),
    { code: "REMOTE_CANCEL_UNCONFIRMED" },
  );
  release();
  await until(async () =>
    (await f.store.read(actor.tenantId, (s) => s.audit)).some(
      (e) => e.action === "sandbox.volume.late",
    ),
  );
  await until(
    async () => !(await f.sandbox.capacity.get(actor.tenantId, f.w.id)),
  );
  assert.equal(f.provider.boxes.size, 0);
});

for (const reused of [false, true])
  test(`late create preserves a successor generation with ${reused ? "the same" : "a different"} instance ID`, async () => {
    const f = await fixture();
    const create = f.provider.create.bind(f.provider);
    let release!: () => void, successorId: string;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.provider.create = async (...args) => {
      await gate;
      return reused ? { sandboxId: successorId } : create(...args);
    };
    await assert.rejects(
      f.sandbox.execute(actor, f.w.id, "old", "default", "ls", {}),
      { code: "REMOTE_CANCEL_UNCONFIRMED" },
    );
    const old = (await f.sandbox.capacity.get(actor.tenantId, f.w.id))!;
    // Simulate an operator resolving/replacing the unknown generation.
    await f.sandbox.capacity.released(actor.tenantId, f.w.id, old.operation!);
    f.provider.create = create;
    await f.sandbox.execute(actor, f.w.id, "new", "default", "ls", {});
    const current = (await f.sandbox.capacity.get(actor.tenantId, f.w.id))!;
    successorId = current.sandboxId!;
    release();
    await until(async () =>
      (await f.store.read(actor.tenantId, (s) => s.audit)).some(
        (e) => e.action === "sandbox.creation.late",
      ),
    );
    if (!reused)
      await until(
        async () =>
          !!(await f.sandbox.capacity.get(
            actor.tenantId,
            `${f.w.id}:orphan:${old.operation}`,
          )),
      );
    assert.deepEqual(
      await f.sandbox.capacity.get(actor.tenantId, f.w.id),
      current,
    );
    assert.equal(f.provider.boxes.has(successorId), true);
    assert.equal(
      (await f.sandbox.capacity.usage(actor)).user.active,
      reused ? 1 : 2,
    );
  });

test("a timed-out provisioning request frees the same Worker's slot for the next Run", async () => {
  const f = await fixture();
  f.provider.create = never;
  const agent = await f.service.publish(
    actor,
    AgentConfig.parse({
      name: "test",
      systemPrompt: "test",
      model: { provider: "demo", modelId: "demo" },
      tools: ["ls"],
      skillBundle: "default",
    }),
  );
  const session = await f.service.createSession(actor, f.w.id, agent.id);
  const first = await f.service.submit(actor, session.id, "blocked");
  const worker = new Worker(
    f.service,
    {
      execute: async (ctx) => {
        if (ctx.prompt === "blocked") await ctx.call("remote_ls", {});
      },
    },
    f.sandbox,
    new MCPManager(f.store, {}),
    1,
  );
  try {
    await worker.tick();
    await until(
      async () =>
        (await f.store.read(actor.tenantId, (s) => s.runs[first.id]!.state)) ===
        "FAILED",
    );
    const next = await f.service.submit(actor, session.id, "next");
    await worker.tick();
    await until(
      async () =>
        (await f.store.read(actor.tenantId, (s) => s.runs[next.id]!.state)) ===
        "COMPLETED",
    );
  } finally {
    await worker.stop();
  }
});

test("Worker stop reports unsettled work within its shutdown budget", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    began = new Promise<void>((r) => {
      entered = r;
    });
  const agent = await f.service.publish(
    actor,
    AgentConfig.parse({
      name: "test",
      systemPrompt: "test",
      model: { provider: "demo", modelId: "demo" },
      tools: [],
      skillBundle: "default",
    }),
  );
  const session = await f.service.createSession(actor, f.w.id, agent.id);
  await f.service.submit(actor, session.id, "blocked runtime");
  const worker = new Worker(
    f.service,
    {
      execute: async () => {
        entered();
        await gate;
      },
    },
    f.sandbox,
    new MCPManager(f.store, {}),
    1,
    25,
  );
  await worker.tick();
  await began;
  try {
    await assert.rejects(worker.stop(), { code: "WORKER_SHUTDOWN_UNSETTLED" });
  } finally {
    release();
    await worker.stop();
  }
});

test("Run remaining deadline bounds provisioning even when the remote timeout is longer", async () => {
  const f = await fixture();
  f.provider.createVolume = never;
  const sandbox = new SandboxManager(f.store, f.provider);
  const agent = await f.service.publish(
    actor,
    AgentConfig.parse({
      name: "deadline",
      systemPrompt: "test",
      model: { provider: "demo", modelId: "demo" },
      tools: ["ls"],
      skillBundle: "default",
      timeoutSeconds: 1,
    }),
  );
  const session = await f.service.createSession(actor, f.w.id, agent.id);
  const run = await f.service.submit(actor, session.id, "blocked");
  const worker = new Worker(
    f.service,
    {
      execute: async (ctx) => {
        await ctx.call("remote_ls", {});
      },
    },
    sandbox,
    new MCPManager(f.store, {}),
    1,
  );
  const begin = Date.now();
  try {
    await worker.tick();
    await until(
      async () =>
        (await f.store.read(actor.tenantId, (s) => s.runs[run.id]!.state)) ===
        "FAILED",
    );
    assert.ok(Date.now() - begin < 2000);
    assert.equal(
      await f.store.read(actor.tenantId, (s) => s.runs[run.id]!.error),
      "REMOTE_CANCEL_UNCONFIRMED",
    );
    assert.equal((await sandbox.capacity.usage(actor)).user.active, 1);
  } finally {
    await worker.stop();
  }
});
