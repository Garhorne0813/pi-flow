import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Fault,
  type Actor,
  type AgentConfig,
  type McpRegistration,
} from "../domain.js";
import type { Store } from "../store.js";
export type McpEndpoint = { url: string; tokenEnv?: string };
export type ToolSpec = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};
// SDK request cancellation is supplemented by a local race so even a stalled
// transport implementation cannot keep a Worker slot forever.
function abortable<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
      return;
    }
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return start();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}
export const MCP_MAX_SERVERS = 16;
export const MCP_DISCOVERY_TIMEOUT_MS = 30000;
export const MCP_CLEANUP_TIMEOUT_MS = 250;
export class MCPManager {
  constructor(
    private store: Store,
    private endpoints: Record<string, McpEndpoint>,
    private grants?: Record<string, { endpoints: string[] }>,
    private limits = {
      discoveryTimeoutMs: MCP_DISCOVERY_TIMEOUT_MS,
      cleanupTimeoutMs: MCP_CLEANUP_TIMEOUT_MS,
    },
  ) {
    if (
      !Number.isFinite(limits.discoveryTimeoutMs) ||
      limits.discoveryTimeoutMs <= 0 ||
      !Number.isFinite(limits.cleanupTimeoutMs) ||
      limits.cleanupTimeoutMs <= 0
    )
      throw new Error("Invalid MCP time limits");
  }
  private async close(c: Client, transport: StreamableHTTPClientTransport) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Close the transport directly even when Client.close throws or stalls.
      await Promise.race([
        Promise.allSettled([
          Promise.resolve().then(() => transport.close()),
          Promise.resolve().then(() => c.close()),
        ]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.limits.cleanupTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async client(reg: McpRegistration, signal: AbortSignal) {
    signal.throwIfAborted();
    const endpoint = this.endpoints[reg.endpointRef];
    if (!endpoint) throw new Fault(403, "MCP_ENDPOINT_NOT_REGISTERED");
    const url = new URL(endpoint.url);
    if (url.protocol !== "https:") throw new Fault(400, "MCP_REQUIRES_HTTPS");
    const token = endpoint.tokenEnv
      ? process.env[endpoint.tokenEnv]
      : undefined;
    if (endpoint.tokenEnv && !token)
      throw new Fault(503, "MCP_CREDENTIAL_UNAVAILABLE");
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, signal])
            : signal,
        }),
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
      },
    });
    const c = new Client({ name: "enterprise-harness", version: "0.1.0" });
    try {
      const connecting = c.connect(transport, { timeout: 10000, signal });
      void connecting.then(
        () => {
          if (signal.aborted) return this.close(c, transport);
        },
        () => {},
      );
      await abortable(() => connecting, signal);
      signal.throwIfAborted();
      return { c, close: () => this.close(c, transport) };
    } catch (e) {
      await this.close(c, transport);
      throw e;
    }
  }
  async discover(
    a: Actor,
    config: AgentConfig,
    signal?: AbortSignal,
    deadline?: number,
  ): Promise<{
    specs: ToolSpec[];
    authorize: (name: string) => Promise<void>;
    call: (
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>;
  }> {
    signal?.throwIfAborted();
    if (config.mcpServers.length > MCP_MAX_SERVERS)
      throw new Fault(400, "MCP_SERVER_LIMIT");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const remaining = deadline === undefined ? Infinity : deadline - Date.now();
    const timeout = Math.min(this.limits.discoveryTimeoutMs, remaining);
    const expire = () =>
      controller.abort(
        new Fault(
          408,
          remaining <= this.limits.discoveryTimeoutMs
            ? "RUN_TIMEOUT"
            : "MCP_DISCOVERY_TIMEOUT",
        ),
      );
    const timer = timeout <= 0 ? undefined : setTimeout(expire, timeout);
    if (timeout <= 0) expire();
    const discoverySignal = controller.signal;
    const allowedServers = new Set(config.mcpServers);
    const mapping = new Map<
      string,
      { server: string; tool: string; endpointRef: string }
    >();
    const specs: ToolSpec[] = [];
    try {
      for (const server of config.mcpServers) {
        discoverySignal.throwIfAborted();
        const reg = await abortable(
          () => this.store.read(a.tenantId, (s) => s.mcp[server]),
          discoverySignal,
        );
        discoverySignal.throwIfAborted();
        if (!reg?.enabled) throw new Fault(403, "MCP_DISABLED");
        if (
          this.grants &&
          (!Object.hasOwn(this.grants, a.tenantId) ||
            !this.grants[a.tenantId]?.endpoints.includes(reg.endpointRef))
        )
          throw new Fault(403, "MCP_ENDPOINT_NOT_GRANTED");
        const connection = await this.client(reg, discoverySignal);
        const { c } = connection;
        try {
          let cursor: string | undefined;
          let count = 0;
          let pages = 0;
          do {
            discoverySignal.throwIfAborted();
            if (++pages > 10) throw new Fault(400, "MCP_DISCOVERY_LIMIT");
            const list = await abortable(
              () =>
                c.listTools(cursor ? { cursor } : undefined, {
                  timeout: 10000,
                  signal: discoverySignal,
                }),
              discoverySignal,
            );
            discoverySignal.throwIfAborted();
            for (const t of list.tools) {
              if (!reg.allowedTools.includes(t.name)) continue;
              const name = `mcp_${server}_${t.name}`;
              if (
                name.length > 64 ||
                !/^[a-zA-Z0-9_-]+$/.test(name) ||
                mapping.has(name)
              )
                throw new Fault(400, "MCP_TOOL_NAME_INVALID");
              mapping.set(name, {
                server,
                tool: t.name,
                endpointRef: reg.endpointRef,
              });
              specs.push({
                name,
                description: t.description ?? t.name,
                schema: t.inputSchema,
              });
              if (++count > 100) throw new Fault(400, "MCP_TOOL_LIMIT");
            }
            cursor = list.nextCursor;
          } while (cursor);
        } finally {
          await connection.close();
        }
        discoverySignal.throwIfAborted();
      }
      discoverySignal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    const authorized = async (name: string) => {
      const m = mapping.get(name);
      if (!m || !allowedServers.has(m.server))
        throw new Fault(403, "MCP_TOOL_DENIED");
      const reg = await this.store.read(a.tenantId, (s) => s.mcp[m.server]);
      if (
        !reg?.enabled ||
        reg.endpointRef !== m.endpointRef ||
        !reg.allowedTools.includes(m.tool)
      )
        throw new Fault(403, "MCP_REVOKED");
      if (
        this.grants &&
        (!Object.hasOwn(this.grants, a.tenantId) ||
          !this.grants[a.tenantId]?.endpoints.includes(reg.endpointRef))
      )
        throw new Fault(403, "MCP_ENDPOINT_NOT_GRANTED");
      return { m, reg };
    };
    return {
      specs,
      authorize: async (name) => {
        await authorized(name);
      },
      call: async (name, args, signal) => {
        const { m, reg } = await authorized(name);
        signal.throwIfAborted();
        const connection = await this.client(reg, signal);
        const { c } = connection;
        try {
          return await abortable(
            () =>
              c.callTool({ name: m.tool, arguments: args }, undefined, {
                timeout: 30000,
                signal,
              }),
            signal,
          );
        } finally {
          await connection.close();
        }
      },
    };
  }
}
