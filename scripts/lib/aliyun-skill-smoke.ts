import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  SandboxCreationError,
  type SandboxProvider,
} from "../../src/sandbox/provider.js";
import type { SkillPackages } from "../../src/skills/packages.js";

export async function runAliyunSkillSmoke(
  provider: Pick<
    SandboxProvider,
    "createVolume" | "create" | "execute" | "kill"
  >,
  prepared: Awaited<ReturnType<SkillPackages["prepare"]>>,
  volumeName: string,
  report: (message: string) => void = console.log,
) {
  let sid: string | undefined;
  let safeToDiscard = true;
  const retain = (sandboxId?: string) =>
    report(
      `Skill package retained for manual reconciliation: sandboxId=${sandboxId ?? "unknown"} packageKey=${prepared.skill.ossUpload?.key ?? "unknown"}`,
    );
  try {
    const volume = await provider.createVolume(volumeName);
    // An unstructured create failure may mean the response was lost. Only
    // explicit cleanup confirmation makes the package safe to discard again.
    safeToDiscard = false;
    try {
      sid = (await provider.create(volume, "default", [prepared.skill]))
        .sandboxId;
    } catch (error) {
      safeToDiscard =
        error instanceof SandboxCreationError && error.cleanupConfirmed;
      if (!safeToDiscard)
        retain(
          error instanceof SandboxCreationError ? error.sandboxId : undefined,
        );
      throw error;
    }
    const read = (await provider.execute(sid, "read", {
      path: prepared.skill.path,
      _skillIds: [prepared.skill.id],
      _skillManifests: [
        { path: prepared.skill.path, digest: prepared.skill.digest },
      ],
      _skillOssUploads: [prepared.skill],
    })) as { text: string };
    assert.equal(
      createHash("sha256").update(read.text).digest("hex"),
      prepared.skill.digest,
    );
    // Test write denial without modifying the caller's manifest: opening an
    // existing file for append performs no write and must itself be rejected.
    const python = `import os,errno,sys
try:
 fd=os.open(${JSON.stringify(prepared.skill.path)},os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW)
except OSError as e:
 if e.errno not in (errno.EROFS,errno.EACCES,errno.EPERM): raise
else:
 os.close(fd); sys.exit('SKILL_WRITABLE')`;
    const encoded = Buffer.from(python).toString("base64");
    const denied = (await provider.execute(sid, "bash", {
      command: `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`,
      timeoutSeconds: 10,
      _skillIds: [prepared.skill.id],
      _skillManifests: [
        { path: prepared.skill.path, digest: prepared.skill.digest },
      ],
      _skillOssUploads: [prepared.skill],
    })) as { exitCode: number };
    assert.equal(denied.exitCode, 0, "Skill mount must reject write access");
  } finally {
    if (sid) {
      try {
        await provider.kill(sid);
        safeToDiscard = true;
      } catch (error) {
        retain(sid);
        throw error;
      }
    }
    if (safeToDiscard) await prepared.discard();
  }
  report(
    "OSS ZIP publication / dynamic Skill mount / manifest verification / write denial: passed",
  );
}
