import type { Skill } from "../domain.js";
export type CreatedSandbox = {
  sandboxId: string;
  // Cube returns this only from create. Callers must persist it and pass it
  // back to execute for sandboxes that require traffic-token authorization.
  trafficToken?: string;
};
export interface SandboxProvider {
  readonly requiresTrafficToken?: boolean;
  readonly supportsSnapshotClone?: boolean;
  scope(bundle: string, skills: readonly Skill[]): string;
  createVolume(name: string): Promise<string>;
  create(
    volume: string,
    bundle: string,
    skills: readonly Skill[],
    snapshotId?: string,
    operation?: string,
  ): Promise<CreatedSandbox>;
  connect(sandboxId: string): Promise<void>;
  execute(
    sandboxId: string,
    op: string,
    args: Record<string, unknown>,
    trafficToken?: string,
  ): Promise<unknown>;
  kill(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  snapshot(sandboxId: string, name?: string): Promise<string>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  destroyVolume(volumeId: string): Promise<void>;
}
