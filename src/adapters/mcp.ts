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
export class MCPManager {
  constructor(
    private store: Store,
    private endpoints: Record<string, McpEndpoint>,
    private grants?: Record<string, { endpoints: string[] }>,
  ) {}
  private async client(reg: McpRegistration) {
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
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
      },
    });
    const c = new Client({ name: "enterprise-harness", version: "0.1.0" });
    try {
      await c.connect(transport, { timeout: 10000 });
      return c;
    } catch (e) {
      await transport.close();
      throw e;
    }
  }
  async discover(
    a: Actor,
    config: AgentConfig,
  ): Promise<{
    specs: ToolSpec[];
    authorize: (name: string) => Promise<void>;
    call: (
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>;
  }> {
    const allowedServers = new Set(config.mcpServers);
    const mapping = new Map<
      string,
      { server: string; tool: string; endpointRef: string }
    >();
    const specs: ToolSpec[] = [];
    for (const server of config.mcpServers) {
      const reg = await this.store.tx(a.tenantId, (s) => s.mcp[server]);
      if (!reg?.enabled) throw new Fault(403, "MCP_DISABLED");
      if (
        this.grants &&
        (!Object.hasOwn(this.grants, a.tenantId) ||
          !this.grants[a.tenantId]?.endpoints.includes(reg.endpointRef))
      )
        throw new Fault(403, "MCP_ENDPOINT_NOT_GRANTED");
      const c = await this.client(reg);
      try {
        let cursor: string | undefined;
        let count = 0;
        let pages = 0;
        do {
          if (++pages > 10) throw new Fault(400, "MCP_DISCOVERY_LIMIT");
          const list = await c.listTools(cursor ? { cursor } : undefined, {
            timeout: 10000,
          });
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
        await c.close();
      }
    }
    const authorized = async (name: string) => {
      const m = mapping.get(name);
      if (!m || !allowedServers.has(m.server))
        throw new Fault(403, "MCP_TOOL_DENIED");
      const reg = await this.store.tx(a.tenantId, (s) => s.mcp[m.server]);
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
        const c = await this.client(reg);
        try {
          return await c.callTool(
            { name: m.tool, arguments: args },
            undefined,
            { timeout: 30000, signal },
          );
        } finally {
          await c.close();
        }
      },
    };
  }
}
