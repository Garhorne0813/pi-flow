import { posix } from "node:path";
import { Fault } from "./domain.js";
export function workspacePath(value = "/workspace", cwd = "/workspace") {
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.split("/").includes("..")
  )
    throw new Fault(400, "INVALID_WORKSPACE_PATH");
  const path = posix.resolve(cwd, value);
  if (path !== "/workspace" && !path.startsWith("/workspace/"))
    throw new Fault(403, "PATH_DENIED");
  return path;
}
