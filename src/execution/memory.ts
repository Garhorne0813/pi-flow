import { posix } from "node:path";
import {
  Fault,
  audit,
  id,
  type AgentConfig,
  type Actor,
  type Run,
  type State,
} from "../domain.js";
import type { SandboxManager } from "../adapters/sandbox.js";
import type { Store } from "../store.js";
import { workspacePath } from "../security-path.js";
export class MemoryManager {
  constructor(
    private store: Store,
    private sandbox: SandboxManager,
  ) {}
  roots(config: AgentConfig, cwd: string) {
    return !config.memory?.enabled
      ? []
      : [
          ...new Set(
            config.memory.scopes.map((s) =>
              s === "user" ? "/workspace/memory" : `${cwd}/memory`,
            ),
          ),
        ];
  }
  classify(path: string, cwd: string) {
    const roots = ["/workspace/memory", `${cwd}/memory`];
    const root = roots.find(
      (root) => path === root || path.startsWith(root + "/"),
    );
    if (!root) return undefined;
    const relative = path.slice(root.length + 1);
    return {
      root,
      relative,
      reserved:
        relative === "MEMORY.md" ||
        relative.startsWith(".") ||
        relative.includes("/") ||
        !relative.endsWith(".md"),
    };
  }
  async index(
    a: Actor,
    wid: string,
    runId: string,
    config: AgentConfig,
    cwd: string,
  ) {
    const parts: string[] = [];
    for (const root of this.roots(config, cwd)) {
      try {
        const result = (await this.sandbox.execute(
          a,
          wid,
          runId,
          config.skillBundle,
          "read",
          { path: root + "/MEMORY.md" },
          undefined,
          config.skills,
        )) as { text: string };
        parts.push(
          `Memory index (${root}):\n${result.text.slice(0, config.memory!.maxIndexBytes)}`,
        );
      } catch (e) {
        if (!(e instanceof Fault && e.code === "FILE_NOT_FOUND")) throw e;
      }
    }
    return parts.join("\n\n");
  }
  async write(
    a: Actor,
    wid: string,
    runId: string,
    config: AgentConfig,
    cwd: string,
    path: string,
    content: string,
    signal: AbortSignal,
    manual = false,
    authorize?: (s: State) => void,
  ) {
    const c = this.classify(path, cwd);
    if (!c || c.reserved || !this.roots(config, cwd).includes(c.root))
      throw new Fault(403, "MEMORY_PATH_RESERVED");
    const limits = config.memory!;
    const now = new Date().toISOString();
    const text = `---\ntype: note\nstatus: active\nupdated: ${now}\n---\n${content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}`;
    if (Buffer.byteLength(text) > limits.maxFileBytes)
      throw new Fault(429, "MEMORY_FILE_LIMIT");
    signal.throwIfAborted();
    const reservation = id();
    const transact = <T>(fn: (s: State) => T | Promise<T>) =>
      this.store.tx(a.tenantId, fn);
    await transact((s) => {
      authorize?.(s);
      if (!manual) {
        const r = s.runs[runId];
        if (!r) throw new Fault(429, "MEMORY_WRITE_LIMIT");
        // Discard only reservations from a previous Worker lease. An in-flight
        // write on the current lease still occupies a slot across managers.
        const pending = Object.fromEntries(
          Object.entries(r.memoryWriteReservations ?? {}).filter(
            ([, pending]) => pending.owner === r.lease?.owner,
          ),
        );
        if (
          (r.memoryWrites ?? 0) + Object.keys(pending).length >=
          limits.maxWritesPerRun
        )
          throw new Fault(429, "MEMORY_WRITE_LIMIT");
        pending[reservation] = { owner: r.lease?.owner };
        r.memoryWriteReservations = pending;
      }
      audit(s, a, "memory.write.attempt", path);
    });
    let succeeded = false;
    let failure: unknown;
    try {
      const execute = (op: string, args: Record<string, unknown>) =>
        this.sandbox.execute(
          a,
          wid,
          runId,
          config.skillBundle,
          op,
          args,
          signal,
          config.skills,
          authorize,
        );
      await execute("mkdir", { path: c.root });
      const found = (await execute("find", { path: c.root })) as {
        matches?: string[];
        entries?: string[];
        truncated?: boolean;
      };
      if (found.truncated) throw new Fault(429, "MEMORY_TOTAL_LIMIT");
      const paths = (found.matches ?? found.entries ?? []).filter(
        (p) =>
          p.startsWith(c.root + "/") &&
          p.endsWith(".md") &&
          p !== c.root + "/MEMORY.md",
      );
      const sizes: Record<string, number> = {};
      for (const p of paths) {
        const result = (await execute("read", { path: p })) as { text: string };
        sizes[p] = Buffer.byteLength(result.text);
      }
      sizes[path] = Buffer.byteLength(text);
      if (
        Object.keys(sizes).length > limits.maxFiles ||
        Object.values(sizes).reduce((a, b) => a + b, 0) > limits.maxTotalBytes
      )
        throw new Fault(429, "MEMORY_TOTAL_LIMIT");
      const index =
        "# Memory\n\n" +
        Object.keys(sizes)
          .sort()
          .map((p) => `- [${posix.basename(p, ".md")}](${posix.basename(p)})`)
          .join("\n") +
        "\n";
      if (Buffer.byteLength(index) > limits.maxIndexBytes)
        throw new Fault(429, "MEMORY_INDEX_LIMIT");
      await execute("write", { path, content: text });
      await execute("write", { path: c.root + "/MEMORY.md", content: index });
      succeeded = true;
      return { written: true, path };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await transact((s) => {
        if (!manual) {
          const r = s.runs[runId];
          if (r?.memoryWriteReservations?.[reservation]) {
            delete r.memoryWriteReservations[reservation];
            if (!Object.keys(r.memoryWriteReservations).length)
              delete r.memoryWriteReservations;
            if (succeeded) r.memoryWrites = (r.memoryWrites ?? 0) + 1;
          } else if (succeeded) throw new Fault(409, "LEASE_LOST");
        }
        audit(
          s,
          a,
          succeeded ? "memory.write" : "memory.write.failed",
          path,
          succeeded
            ? undefined
            : failure instanceof Fault
              ? failure.code
              : "MEMORY_WRITE_FAILED",
        );
      });
    }
  }
}
