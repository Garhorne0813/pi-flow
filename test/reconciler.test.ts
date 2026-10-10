import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { SandboxManager, DemoSandbox } from "../src/adapters/sandbox.js";
import { SandboxReconciler } from "../src/sandbox-reconciler.js";
const actor = { tenantId: "reconcile", userId: "owner", admin: true };
async function fixture() {
  const store = new MemoryStore(),
    provider = new DemoSandbox(),
    manager = new SandboxManager(store, provider);
  const w = {
    id: crypto.randomUUID(),
    name: "crashed",
    ownerId: "owner",
    members: { owner: "owner" as const },
    volumeId: "volume",
  };
  await provider.createVolume("volume");
  await store.tx(actor.tenantId, (s) => {
    s.workspaces[w.id] = w;
  });
  await manager.capacity.reserve(
    actor.tenantId,
    w,
    "create-operation",
    undefined,
  );
  const sid = await provider.create(
    "volume",
    "default",
    [],
    undefined,
    "create-operation",
  );
  return { store, provider, manager, w, sid };
}
test("restart discovers a created instance whose ID was not persisted, and repeated scans are idempotent", async () => {
  const f = await fixture(); // no process-local late callback or Sandbox ID exists in Store
  const restarted = new SandboxManager(f.store, f.provider),
    scanner = new SandboxReconciler(f.store, restarted);
  assert.equal((await scanner.scan()).reclaimed, 1);
  assert.equal(f.provider.boxes.has(f.sid), false);
  assert.equal(
    (await restarted.capacity.inspect(actor.tenantId, f.w.id))?.state,
    "released",
  );
  assert.equal((await scanner.scan()).examined, 0);
});
test("concurrent reconcilers and newer creation generations never delete a successor", async () => {
  const f = await fixture();
  const original = await f.manager.capacity.inspect(actor.tenantId, f.w.id);
  await f.store.tx(actor.tenantId, (s) => {
    s.workspaces[f.w.id]!.lock = {
      owner: "new-operation",
      expires: Date.now() + 60000,
    };
  });
  const scanner = new SandboxReconciler(f.store, f.manager);
  assert.equal((await scanner.scan()).reclaimed, 0);
  assert.ok(f.provider.boxes.has(f.sid));
  await f.store.tx(actor.tenantId, (s) => {
    delete s.workspaces[f.w.id]!.lock;
  });
  await f.manager.capacity.claim(
    actor.tenantId,
    f.w.id,
    original!,
    "successor",
  );
  await assert.rejects(
    f.manager.reconcileOrphan(original!, {
      sandboxId: f.sid,
      volumeId: "volume",
      operation: "create-operation",
    }),
    { code: "CAPACITY_LEASE_LOST" },
  );
  assert.ok(f.provider.boxes.has(f.sid));
});
test("failed kill keeps unknown charged and a subsequent confirmed retry releases it", async () => {
  const f = await fixture();
  const kill = f.provider.kill.bind(f.provider);
  f.provider.kill = async () => {
    throw new Error("transport lost");
  };
  const scanner = new SandboxReconciler(f.store, f.manager);
  assert.equal((await scanner.scan()).failed, 1);
  assert.equal(
    (await f.manager.capacity.inspect(actor.tenantId, f.w.id))?.state,
    "unknown",
  );
  assert.equal((await f.manager.capacity.usage(actor)).global.active, 1);
  f.provider.kill = kill;
  assert.equal((await scanner.scan()).reclaimed, 1);
  assert.equal((await f.manager.capacity.usage(actor)).global.active, 0);
});
test("missing enumeration, duplicate identity, active leases and foreign volumes do not free quota", async () => {
  const f = await fixture();
  const inventory = f.provider.inventory.bind(f.provider),
    scanner = new SandboxReconciler(f.store, f.manager);
  f.provider.inventory = async () => [];
  assert.equal((await scanner.scan()).unresolved, 1);
  f.provider.inventory = async () => {
    const a = await inventory();
    return [...a, ...a];
  };
  assert.equal((await scanner.scan()).unresolved, 1);
  f.provider.inventory = async () => [
    { sandboxId: f.sid, volumeId: "foreign", operation: "create-operation" },
  ];
  assert.equal((await scanner.scan()).failed, 1);
  assert.equal((await f.manager.capacity.usage(actor)).global.active, 1);
  assert.ok(f.provider.boxes.has(f.sid));
});
