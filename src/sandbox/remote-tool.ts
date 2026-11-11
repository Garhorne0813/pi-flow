import { Fault } from "../domain/model.js";
import { remoteScript } from "./remote-script.js";

// SDKs differ in whether a nonzero exit resolves or throws. Providers normalize
// that boundary before passing results to the shared tool protocol.
export async function runRemoteTool(
  run: (
    command: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  op: string,
  args: Record<string, unknown>,
) {
  const script = Buffer.from(remoteScript).toString("base64");
  const params = Buffer.from(JSON.stringify({ op, args })).toString("base64");
  const cmd = `python3 -c "import base64;exec(base64.b64decode('${script}'))" '${params}'`;
  const result = await run(cmd);
  if (result.exitCode !== 0) {
    for (const code of [
      "SKILL_HOST_MOUNT_UNCONFIRMED",
      "WORKSPACE_MOUNT_UNCONFIRMED",
      "SKILL_HOST_SOURCE_UNSAFE",
      "SKILL_DIGEST_MISMATCH",
      "SKILL_IDENTITY_UNCONFIRMED",
    ])
      if (result.stderr.includes(code)) throw new Fault(409, code);
    if (result.stderr.includes("FileNotFoundError:"))
      throw new Fault(404, "FILE_NOT_FOUND");
    for (const code of ["EDIT_CONFLICT", "EDIT_NOT_UNIQUE"])
      if (result.stderr.includes(code)) throw new Fault(409, code);
    if (result.stderr.includes("PATH_DENIED"))
      throw new Fault(403, "PATH_DENIED");
    throw new Fault(502, "REMOTE_TOOL_FAILED");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Fault(502, "INVALID_SANDBOX_RESULT");
  }
}
