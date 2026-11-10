import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { HarnessService } from "../src/service.js";
import { DemoSandbox, SandboxManager } from "../src/adapters/sandbox.js";

const actor = { tenantId: "queue", userId: "owner", admin: true };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function fixture(leaseWaitTimeoutMs = 1000) {
  const store = new MemoryStore();
  const provider = new DemoSandbox();
  const makeManager = () =>
    new SandboxManager(store, provider, {}, undefined, {
      remoteTimeoutMs: 1000,
      cleanupTimeoutMs: 100,
      leaseWaitTimeoutMs,
    });
  const sandbox = makeManager();
  const service = new HarnessService(store, [], ["default"]);
  const w = await service.createWorkspace(actor, "queue");
  const began = deferred(),
    gate = deferred();
  const held = sandbox.withLease(
    actor,
    w.id,
    "first-run",
    "default",
    async () => {
      began.resolve();
      await gate.promise;
    },
  );
  await began.promise;
  return { store, provider, sandbox, service, w, makeManager, held, gate };
}

test("different managers and Runs wait for the durable workspace lease while other workspaces proceed", async () => {
  const f = await fixture();
  const second = f.makeManager();
  const started = deferred();
  const waiting = second.withLease(
    actor,
    f.w.id,
    "second-run",
    "default",
    async () => {
      started.resolve();
    },
  );
  let entered = false;
  void started.promise.then(() => {
    entered = true;
  });
  try {
    const other = await f.service.createWorkspace(actor, "other");
    await second.execute(actor, other.id, "other-run", "default", "ls", {});
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(entered, false);
    f.gate.resolve();
    await Promise.all([f.held, waiting]);
    assert.equal(entered, true);
    assert.equal((await f.sandbox.capacity.usage(actor)).user.active, 2);
    assert.equal(
      await f.store.read(actor.tenantId, (s) => s.workspaces[f.w.id]!.lock),
      undefined,
    );
  } finally {
    f.gate.resolve();
    await Promise.allSettled([f.held, waiting]);
  }
});

for (const mode of ["cancel", "timeout", "revoked"] as const)
  test(`a ${mode} waiter leaves the active lease, instance and capacity untouched`, async () => {
    const f = await fixture(mode === "timeout" ? 30 : 1000);
    const controller = new AbortController();
    const reason = new Error("Run cancelled");
    let calls = 0,
      kills = 0;
    f.provider.execute = async () => {
      calls++;
      return {};
    };
    f.provider.kill = async () => {
      kills++;
    };
    const before = await f.store.read(
      actor.tenantId,
      (s) => s.workspaces[f.w.id]!.lock,
    );
    const capacity = await f.sandbox.capacity.get(actor.tenantId, f.w.id);
    const waiting = f
      .makeManager()
      .execute(
        actor,
        f.w.id,
        "second-run",
        "default",
        "ls",
        {},
        controller.signal,
      );
    const checked = assert.rejects(
      waiting,
      mode === "cancel"
        ? (error: unknown) => error === reason
        : {
            code:
              mode === "timeout"
                ? "WORKSPACE_QUEUE_TIMEOUT"
                : "WORKSPACE_NOT_FOUND",
          },
    );
    try {
      // Allow at least one acquisition attempt before cancellation/revocation.
      await new Promise((r) => setTimeout(r, 10));
      if (mode === "cancel") controller.abort(reason);
      if (mode === "revoked")
        await f.store.tx(actor.tenantId, (s) => {
          delete s.workspaces[f.w.id]!.members[actor.userId];
        });
      await checked;
      assert.equal(calls, 0);
      assert.equal(kills, 0);
      assert.deepEqual(
        await f.store.read(actor.tenantId, (s) => s.workspaces[f.w.id]!.lock),
        before,
      );
      assert.deepEqual(
        await f.sandbox.capacity.get(actor.tenantId, f.w.id),
        capacity,
      );
      assert.equal(f.provider.boxes.size, 1);
    } finally {
      await f.store.tx(actor.tenantId, (s) => {
        s.workspaces[f.w.id]!.members[actor.userId] = "owner";
      });
      f.gate.resolve();
      await f.held;
      await checked;
    }
    await f.sandbox.execute(actor, f.w.id, "next-run", "default", "ls", {});
    assert.equal(calls, 1);
  });

test("failed tool releases the lease for queued work", async () => {
  const f = await fixture();
  const began = deferred(),
    gate = deferred();
  f.provider.execute = async (_sid, op) => {
    if (op === "read") {
      began.resolve();
      await gate.promise;
      throw new Error("tool failed");
    }
    return { text: "next" };
  };
  f.gate.resolve();
  await f.held;
  const first = f.sandbox.execute(
    actor,
    f.w.id,
    "first",
    "default",
    "read",
    {},
  );
  const checked = assert.rejects(first, /tool failed/);
  await began.promise;
  const next = f
    .makeManager()
    .execute(actor, f.w.id, "second", "default", "ls", {});
  try {
    gate.resolve();
    await checked;
    assert.deepEqual(await next, { text: "next" });
  } finally {
    gate.resolve();
    await Promise.allSettled([first, next]);
  }
});

for (const kind of ["lifecycle", "files"] as const)
  test(`tools still reject an active ${kind} lock`, async () => {
    const f = await fixture();
    f.gate.resolve();
    await f.held;
    await f.store.tx(actor.tenantId, (s) => {
      s.workspaces[f.w.id]!.lock = {
        owner: "external",
        expires: Date.now() + 1000,
        kind,
      };
    });
    await assert.rejects(
      f.sandbox.execute(actor, f.w.id, "run", "default", "ls", {}),
      { code: "WORKSPACE_BUSY" },
    );
    assert.equal(
      await f.store.read(
        actor.tenantId,
        (s) => s.workspaces[f.w.id]!.lock?.owner,
      ),
      "external",
    );
  });

for (const op of ["write", "edit", "bash"])
  test(`queued ${op} cannot execute after editor is downgraded to viewer`, async () => {
    const f = await fixture();
    const editor = { ...actor, userId: "editor", admin: false };
    await f.store.tx(actor.tenantId, (s) => {
      s.workspaces[f.w.id]!.members.editor = "editor";
    });
    let calls = 0;
    f.provider.execute = async () => {
      calls++;
      return {};
    };
    const waiting = f
      .makeManager()
      .execute(editor, f.w.id, "editor-run", "default", op, {});
    const checked = assert.rejects(waiting, { code: "READ_ONLY" });
    try {
      await new Promise((r) => setTimeout(r, 10));
      await f.store.tx(actor.tenantId, (s) => {
        s.workspaces[f.w.id]!.members.editor = "viewer";
      });
      f.gate.resolve();
      await Promise.all([f.held, checked]);
      assert.equal(calls, 0);
      // Direct read-only access remains available to a viewer.
      await f.sandbox.execute(
        editor,
        f.w.id,
        "viewer-read",
        "default",
        "ls",
        {},
      );
      assert.equal(calls, 1);
    } finally {
      f.gate.resolve();
      await Promise.allSettled([f.held, waiting, checked]);
    }
  });

test("write permission is rechecked atomically after an available-lock observation", async () => {
  const f = await fixture();
  f.gate.resolve();
  await f.held;
  let calls = 0;
  f.provider.execute = async () => {
    calls++;
    return {};
  };
  const readMetadata = f.store.readMetadata.bind(f.store);
  f.store.readMetadata = async (tenant, keys, fn) => {
    const observed = await readMetadata(tenant, keys, fn);
    await f.store.tx(tenant, (s) => {
      s.workspaces[f.w.id]!.members[actor.userId] = "viewer";
    });
    return observed;
  };
  await assert.rejects(
    f.sandbox.execute(actor, f.w.id, "writer", "default", "write", {}),
    { code: "READ_ONLY" },
  );
  assert.equal(calls, 0);
  assert.equal(
    await f.store.read(actor.tenantId, (s) => s.workspaces[f.w.id]!.lock),
    undefined,
  );
});

test("twenty blocked waiters use metadata reads without write transactions or full-state reads", async () => {
  const f = await fixture(5000);
  const tx = f.store.tx.bind(f.store),
    read = f.store.read.bind(f.store);
  let writes = 0,
    fullReads = 0;
  f.store.tx = (tenant, fn) => {
    writes++;
    return tx(tenant, fn);
  };
  f.store.read = (tenant, fn) => {
    fullReads++;
    return read(tenant, fn);
  };
  // MemoryStore's metadata implementation delegates to read; mirror the
  // PostgreSQL implementation so full-state instrumentation stays meaningful.
  f.store.readMetadata = (tenant, keys, fn) =>
    read(tenant, (s) =>
      fn({
        ...s,
        runs: {},
        sessions: {},
        events: [],
      }),
    );
  const controller = new AbortController(),
    reason = new Error("stop waiters");
  const waiting = Array.from({ length: 20 }, (_, i) =>
    f.sandbox.execute(
      actor,
      f.w.id,
      `waiter-${i}`,
      "default",
      "ls",
      {},
      controller.signal,
    ),
  );
  const checked = waiting.map((p) =>
    assert.rejects(p, (error: unknown) => error === reason),
  );
  try {
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(writes, 0);
    assert.equal(fullReads, 0);
    controller.abort(reason);
    await Promise.all(checked);
    assert.equal(writes, 0);
  } finally {
    controller.abort(reason);
    await Promise.allSettled(checked);
    f.gate.resolve();
    await f.held;
  }
});
