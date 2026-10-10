import { createHash } from "node:crypto";
import { Fault, type Skill } from "../domain.js";
import { skillScope } from "../adapters/skill-mounts.js";
import type { SandboxProvider, SandboxAsset } from "./provider.js";
// Test/demo adapter stores files in memory and never executes a local command.
export class DemoSandbox implements SandboxProvider {
  operations = new Map<string, string>();
  volumes = new Map<string, Map<string, string>>();
  boxes = new Map<string, string>();
  skillSelections = new Map<string, readonly Skill[]>();
  paused = new Set<string>();
  snapshots = new Map<string, { skills: readonly Skill[] }>();
  scope(bundle: string, skills: readonly Skill[]) {
    return skillScope(bundle, skills);
  }
  async createVolume(name: string) {
    if (!this.volumes.has(name)) this.volumes.set(name, new Map());
    return name;
  }
  async create(
    v: string,
    b: string,
    skills: readonly Skill[] = [],
    snapshotId?: string,
    operation?: string,
  ) {
    if (snapshotId && !this.snapshots.has(snapshotId))
      throw new Fault(404, "SNAPSHOT_NOT_FOUND");
    skillScope(b, skills);
    if (!this.volumes.has(v)) this.volumes.set(v, new Map());
    const sid = crypto.randomUUID();
    this.boxes.set(sid, v);
    if (operation) this.operations.set(sid, operation);
    this.skillSelections.set(sid, structuredClone(skills));
    return sid;
  }
  async connect(s: string) {
    if (!this.boxes.has(s)) throw new Fault(410, "SANDBOX_GONE");
    this.paused.delete(s);
  }
  async execute(s: string, op: string, a: Record<string, unknown>) {
    await this.connect(s);
    const files = this.volumes.get(this.boxes.get(s)!)!;
    const raw = String(a.path ?? "/workspace");
    const p = raw.startsWith("/") ? raw : "/workspace/" + raw;
    if (!p.startsWith("/workspace/") && p !== "/workspace")
      throw new Fault(403, "PATH_DENIED");
    if (p.split("/").includes("..")) throw new Fault(403, "PATH_DENIED");
    if (op === "write") {
      files.set(p, String(a.content));
      return { written: true };
    }
    if (op === "read") {
      if (!files.has(p)) throw new Fault(404, "FILE_NOT_FOUND");
      const text = files.get(p)!;
      return Array.isArray(a._skillManifests) && a._skillManifests.length
        ? {
            path: p,
            text,
            sha256: createHash("sha256").update(text).digest("hex"),
          }
        : { text };
    }
    if (op === "ls" || op === "find") return { entries: [...files.keys()] };
    throw new Fault(501, "DEMO_TOOL_UNSUPPORTED");
  }
  async kill(s: string) {
    this.operations.delete(s);
    this.boxes.delete(s);
    this.skillSelections.delete(s);
    this.paused.delete(s);
  }
  async pause(s: string) {
    if (!this.boxes.has(s)) throw new Fault(410, "SANDBOX_GONE");
    this.paused.add(s);
  }
  async snapshot(s: string, _name?: string) {
    await this.connect(s);
    const id = crypto.randomUUID();
    this.snapshots.set(id, {
      skills: structuredClone(this.skillSelections.get(s)!),
    });
    return id;
  }
  async deleteSnapshot(id: string) {
    this.snapshots.delete(id);
  }
  async destroyVolume(v: string) {
    this.volumes.delete(v);
  }
  async inventory(): Promise<SandboxAsset[]> {
    return [...this.boxes].flatMap(([sandboxId, volumeId]) => {
      const operation = this.operations.get(sandboxId);
      return operation ? [{ sandboxId, volumeId, operation }] : [];
    });
  }
}
