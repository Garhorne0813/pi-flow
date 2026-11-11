import test from "node:test";
import assert from "node:assert/strict";
import { Sandbox, type SandboxOpts } from "e2b";
import {
  AliyunConfigSchema,
  AliyunE2BProvider,
} from "../src/sandbox/aliyun-provider.js";
import { SandboxCreationError } from "../src/sandbox/provider.js";
import { WorkspaceSmokeInstances } from "../scripts/lib/aliyun-workspace-smoke.js";

const context = {
  operation: "smoke-test-run",
  workspace: "ws-smoke-test",
  volumeId: "test-volume",
};

test("workspace smoke cleans only remaining known instances and uses a unique operation per create", async () => {
  const operations: (string | undefined)[] = [],
    killed: string[] = [],
    records: unknown[] = [];
  const instances = new WorkspaceSmokeInstances(
    {
      async create(_volume, _bundle, _skills, _snapshot, operation) {
        operations.push(operation);
        return { sandboxId: `box-${operations.length}` };
      },
      async kill(id) {
        killed.push(id);
      },
    },
    context,
    (record) => records.push(record),
  );
  const first = await instances.start();
  await instances.start();
  await instances.stop(first);
  await instances.cleanup();
  await instances.cleanup();
  assert.deepEqual(killed, ["box-1", "box-2"]);
  assert.equal(new Set(operations).size, 2);
  assert.deepEqual(records, []);
});

test("workspace smoke reports a server-created Sandbox whose create response was lost", async (t) => {
  const serverInstances: {
    sandboxId: string;
    metadata: Record<string, string>;
  }[] = [];
  const records: any[] = [];
  t.mock.method(
    Sandbox,
    "create",
    async (_template: string, opts: SandboxOpts) => {
      // The server side succeeded; the client never receives its Sandbox ID.
      serverInstances.push({
        sandboxId: "server-created-but-unknown-to-client",
        metadata: opts.metadata!,
      });
      throw new Error("SDK response lost; sensitive credential detail");
    },
  );
  const kill = t.mock.method(Sandbox, "kill", async () => true);
  const provider = new AliyunE2BProvider(
    AliyunConfigSchema.parse({
      apiKey: "test-key",
      apiUrl: "https://api.cn-hangzhou.sandbox.aliyuncs.com",
      domain: "cn-hangzhou.sandbox.aliyuncs.com",
      template: "test",
      user: "user",
      bucket: "pi-flow-test",
      endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
      roleArn: "acs:ram::123456789:role/test",
    }),
  );
  const volumeId = await provider.createVolume(context.workspace);
  const instances = new WorkspaceSmokeInstances(
    provider,
    { ...context, volumeId },
    (record) => records.push(record),
  );
  await assert.rejects(instances.start());
  assert.equal(serverInstances.length, 1, "must never retry an unknown create");
  assert.equal(records[0].code, "SANDBOX_CREATION_OUTCOME_UNKNOWN");
  assert.equal(
    records[0].operation,
    serverInstances[0]!.metadata.harnessOperation,
  );
  assert.equal(
    records[0].volumeId,
    serverInstances[0]!.metadata.harnessWorkspaceVolume,
  );
  assert.equal(records[0].workspace, context.workspace);
  assert.equal(records[0].testOperation, context.operation);
  assert.equal(records[0].sandboxId, undefined);
  assert.match(records[0].action, /cloud inventory/);
  await assert.rejects(instances.cleanup(), {
    code: "SANDBOX_CREATION_OUTCOME_UNKNOWN",
  });
  assert.deepEqual(records.at(-1).unresolvedOperations, [records[0].operation]);
  assert.equal(records.at(-1).operation, records[0].operation);
  assert.equal(
    kill.mock.callCount(),
    0,
    "unknown IDs cannot be guessed for deletion",
  );
  assert.ok(!JSON.stringify(records).includes("sensitive credential detail"));
});

test("cleanup deletes all known instances but retains uncertainty from a later unidentified create", async () => {
  const records: any[] = [],
    operations: (string | undefined)[] = [],
    killed: string[] = [];
  const instances = new WorkspaceSmokeInstances(
    {
      async create(_volume, _bundle, _skills, _snapshot, operation) {
        operations.push(operation);
        if (operations.length === 2) throw Error("response lost");
        return { sandboxId: "known-instance" };
      },
      async kill(id) {
        killed.push(id);
      },
    },
    context,
    (record) => records.push(record),
  );
  await instances.start();
  await assert.rejects(instances.start());
  await assert.rejects(instances.cleanup(), {
    code: "SANDBOX_CREATION_OUTCOME_UNKNOWN",
  });
  assert.deepEqual(killed, ["known-instance"]);
  assert.deepEqual(operations, [
    "smoke-test-run-create-1",
    "smoke-test-run-create-2",
  ]);
  assert.deepEqual(records.at(-1).unresolvedOperations, [operations[1]]);
  await assert.rejects(instances.cleanup(), {
    code: "SANDBOX_CREATION_OUTCOME_UNKNOWN",
  });
  assert.equal(killed.length, 1, "cleaned instances must not be killed twice");
});

for (const mode of [
  "confirmed",
  "known-unconfirmed",
  "known-kill-failed",
  "unidentified-unconfirmed",
] as const)
  test(`workspace smoke respects creation cleanup certainty (${mode})`, async () => {
    const records: any[] = [],
      killed: string[] = [];
    const instances = new WorkspaceSmokeInstances(
      {
        async create() {
          throw new SandboxCreationError(
            Error("failure"),
            mode === "confirmed",
            mode === "unidentified-unconfirmed" ? undefined : "known",
          );
        },
        async kill(id) {
          killed.push(id);
          if (mode === "known-kill-failed") throw Error("offline");
        },
      },
      context,
      (record) => records.push(record),
    );
    await assert.rejects(instances.start());
    if (mode === "known-kill-failed")
      await assert.rejects(instances.cleanup(), {
        code: "SMOKE_SANDBOX_CLEANUP_UNCONFIRMED",
      });
    else if (mode === "unidentified-unconfirmed")
      await assert.rejects(instances.cleanup(), {
        code: "SANDBOX_CREATION_OUTCOME_UNKNOWN",
      });
    else await instances.cleanup();
    assert.equal(
      records.some((r) => r.code === "SANDBOX_CREATION_OUTCOME_UNKNOWN"),
      mode !== "confirmed",
    );
    assert.deepEqual(
      killed,
      ["known-unconfirmed", "known-kill-failed"].includes(mode)
        ? ["known"]
        : [],
    );
  });
