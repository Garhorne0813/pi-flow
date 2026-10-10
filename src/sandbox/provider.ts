import type { Skill } from "../domain.js";
export interface SandboxProvider {
  inventory?(): Promise<SandboxAsset[]>;
  scope(bundle: string, skills: readonly Skill[]): string;
  createVolume(name: string): Promise<string>;
  create(
    volume: string,
    bundle: string,
    skills: readonly Skill[],
    snapshotId?: string,
    operation?: string,
  ): Promise<string>;
  connect(sandboxId: string): Promise<void>;
  execute(
    sandboxId: string,
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  kill(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  snapshot(sandboxId: string, name?: string): Promise<string>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  destroyVolume(volumeId: string): Promise<void>;
}
export type SandboxAsset = {
  sandboxId: string;
  operation: string;
  volumeId: string;
};
