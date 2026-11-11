import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Fault, type Skill } from "../src/domain/model.js";
import { SandboxCreationError } from "../src/sandbox/provider.js";
import { runAliyunSkillSmoke } from "../scripts/lib/aliyun-skill-smoke.js";

for (const mode of [
  "success",
  "volume-failure",
  "create-confirmed",
  "create-unconfirmed",
  "create-response-lost",
  "read-failure",
  "writable-skill",
  "kill-failure",
] as const)
  test(`Aliyun Skill smoke preserves artifacts until cleanup is confirmed (${mode})`, async () => {
    let discards = 0,
      kills = 0;
    const messages: string[] = [];
    const skill: Skill = {
      id: "probe@v1",
      name: "probe",
      description: "probe",
      bundle: "default",
      path: "/skills/probe/SKILL.md",
      enabled: true,
      digest: createHash("sha256").update("probe").digest("hex"),
      ossUpload: {
        key: "a".repeat(64),
        storageId: "b".repeat(64),
        archiveDigest: "c".repeat(64),
        files: 1,
        bytes: 5,
      },
    };
    const failure = new Fault(502, "TEST_FAILURE");
    const provider = {
      async createVolume() {
        if (mode === "volume-failure") throw failure;
        return "volume";
      },
      async create() {
        if (mode === "create-confirmed")
          throw new SandboxCreationError(failure, true, "box");
        if (mode === "create-unconfirmed")
          throw new SandboxCreationError(failure, false, "leaked-box", failure);
        if (mode === "create-response-lost") throw failure;
        return { sandboxId: "box" };
      },
      async execute(_sid: string, op: string) {
        if (mode === "read-failure") throw failure;
        if (op === "bash")
          return { exitCode: mode === "writable-skill" ? 1 : 0 };
        return { text: "probe" };
      },
      async kill() {
        kills++;
        if (mode === "kill-failure") throw failure;
      },
    };
    const operation = runAliyunSkillSmoke(
      provider,
      {
        skill,
        discard: async () => {
          discards++;
        },
      },
      "ws-probe",
      (message) => messages.push(message),
    );
    if (mode === "success") await operation;
    else await assert.rejects(operation);
    const uncertain = [
      "create-unconfirmed",
      "create-response-lost",
      "kill-failure",
    ].includes(mode);
    assert.equal(discards, uncertain ? 0 : 1);
    assert.equal(
      kills,
      ["success", "read-failure", "writable-skill", "kill-failure"].includes(
        mode,
      )
        ? 1
        : 0,
    );
    assert.equal(
      messages.some((m) => m.includes("manual reconciliation")),
      uncertain,
    );
    if (mode === "create-unconfirmed")
      assert.match(messages[0]!, /sandboxId=leaked-box/);
    if (mode === "create-response-lost")
      assert.match(messages[0]!, /sandboxId=unknown/);
    assert.equal(
      messages.some((m) => m.includes(": passed")),
      mode === "success",
    );
  });
