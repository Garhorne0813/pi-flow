import { Fault } from "../../src/domain/model.js";
import {
  SandboxCreationError,
  type SandboxProvider,
} from "../../src/sandbox/provider.js";

type Diagnostic = {
  code:
    | "SANDBOX_CREATION_OUTCOME_UNKNOWN"
    | "SMOKE_SANDBOX_CLEANUP_UNCONFIRMED";
  operation: string;
  testOperation: string;
  workspace: string;
  volumeId: string;
  sandboxId?: string;
  unresolvedOperations?: string[];
  failedSandboxIds?: string[];
  action: string;
};

export class WorkspaceSmokeInstances {
  private instances = new Set<string>();
  private unknownOperations = new Set<string>();
  private attempt = 0;
  constructor(
    private provider: Pick<SandboxProvider, "create" | "kill">,
    private context: { operation: string; workspace: string; volumeId: string },
    private report: (diagnostic: Diagnostic) => void = (record) =>
      console.error(JSON.stringify(record)),
  ) {}

  async start() {
    const operation = `${this.context.operation}-create-${++this.attempt}`;
    try {
      const created = await this.provider.create(
        this.context.volumeId,
        "default",
        [],
        undefined,
        operation,
      );
      this.instances.add(created.sandboxId);
      return created.sandboxId;
    } catch (error) {
      if (!(error instanceof SandboxCreationError && error.cleanupConfirmed)) {
        const sandboxId =
          error instanceof SandboxCreationError ? error.sandboxId : undefined;
        if (sandboxId) this.instances.add(sandboxId);
        else this.unknownOperations.add(operation);
        // Never serialize an SDK error: it may contain headers, signed URLs or
        // credentials. These identifiers already exist in Sandbox metadata.
        this.report({
          ...this.context,
          testOperation: this.context.operation,
          operation,
          code: "SANDBOX_CREATION_OUTCOME_UNKNOWN",
          sandboxId,
          action:
            "Reconcile cloud inventory by harnessOperation and harnessWorkspaceVolume before retrying the smoke test",
        });
      }
      throw error;
    }
  }

  async stop(sandboxId: string) {
    await this.provider.kill(sandboxId);
    this.instances.delete(sandboxId);
  }

  async cleanup() {
    const pending = [...this.instances];
    const results = await Promise.allSettled(
      pending.map((sid) => this.stop(sid)),
    );
    const failed = pending.filter((_, i) => results[i]!.status === "rejected");
    if (failed.length)
      this.report({
        ...this.context,
        testOperation: this.context.operation,
        code: "SMOKE_SANDBOX_CLEANUP_UNCONFIRMED",
        failedSandboxIds: failed,
        action: "Confirm deletion of these Sandbox IDs through cloud inventory",
      });
    // Deleting every known instance does not settle a lost create response.
    // Keep the unresolved attempts visible, and do not let callers release the
    // workspace or print a success message merely because this set is empty.
    if (this.unknownOperations.size) {
      const unresolvedOperations = [...this.unknownOperations];
      this.report({
        ...this.context,
        testOperation: this.context.operation,
        operation: unresolvedOperations[0]!,
        code: "SANDBOX_CREATION_OUTCOME_UNKNOWN",
        unresolvedOperations,
        action:
          "Unknown Sandbox IDs require manual cloud inventory reconciliation; cleanup is not confirmed",
      });
      throw new Fault(502, "SANDBOX_CREATION_OUTCOME_UNKNOWN");
    }
    if (failed.length)
      throw new Fault(502, "SMOKE_SANDBOX_CLEANUP_UNCONFIRMED");
  }
}
