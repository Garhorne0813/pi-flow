import { z } from "zod";
import { AgentConfig, Fault, admin, audit } from "../domain/model.js";
import { params } from "./validation.js";
import type { RouteContext } from "./context.js";

export function registerMcpRoutes({
  app,
  actor,
  service,
  mcp,
  configurationStore,
}: Pick<
  RouteContext,
  "app" | "actor" | "service" | "mcp" | "configurationStore"
>) {
  app.post("/api/v1/admin/mcp-servers/:id/check", async (req) => {
    const a = actor(req);
    admin(a);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const key = params(req.params).id!;
    const reg = await configurationStore.readMetadata(
      a.tenantId,
      ["mcp"],
      (s) => s.mcp[key],
    );
    if (!reg) throw new Fault(404, "MCP_NOT_FOUND");
    if (!reg.enabled) throw new Fault(403, "MCP_DISABLED");
    if (!service.hasEndpoint(reg.endpointRef, a.tenantId))
      throw new Fault(403, "MCP_ENDPOINT_NOT_GRANTED");
    if (!mcp) throw new Fault(503, "MCP_CHECK_UNAVAILABLE");
    // Discovery only: no tool execution. Existing MCP transport enforces HTTPS,
    // server-side credentials, grants, whitelists, pagination and a total deadline.
    const result = await mcp.discover(
      a,
      AgentConfig.parse({
        name: "connection-check",
        systemPrompt: "",
        model: { provider: "check", modelId: "check" },
        tools: [],
        skillBundle: "check",
        mcpServers: [key],
      }),
      undefined,
      Date.now() + 10000,
    );
    return {
      status: "ok",
      tools: result.specs.map((t) => ({
        name: t.name,
        description: t.description,
      })),
      checkedAt: new Date().toISOString(),
    };
  });
  app.get("/api/v1/admin/mcp-servers", async (req) => {
    const a = actor(req);
    admin(a);
    return configurationStore.readMetadata(a.tenantId, ["mcp"], (s) => ({
      items: Object.values(s.mcp),
    }));
  });
  app.post("/api/v1/admin/mcp-servers", async (req, reply) => {
    const a = actor(req);
    admin(a);
    const b = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,20}$/),
        endpointRef: z.string().min(1),
        allowedTools: z.array(z.string().min(1).max(64)).max(100),
      })
      .strict()
      .parse(req.body);
    if (!service.hasEndpoint(b.endpointRef, a.tenantId))
      throw new Fault(400, "MCP_ENDPOINT_NOT_REGISTERED");
    return reply.code(201).send(
      await configurationStore.tx(a.tenantId, (s) => {
        if (s.mcp[b.id]) throw new Fault(409, "MCP_ALREADY_REGISTERED");
        s.mcp[b.id] = { ...b, enabled: true };
        audit(s, a, "mcp.register", b.id);
        return s.mcp[b.id];
      }),
    );
  });
  app.put("/api/v1/admin/mcp-servers/:id/status", async (req) => {
    const a = actor(req);
    admin(a);
    const key = params(req.params).id!;
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return configurationStore.tx(a.tenantId, (s) => {
      if (!s.mcp[key]) throw new Fault(404, "MCP_NOT_FOUND");
      s.mcp[key]!.enabled = b.enabled;
      audit(s, a, "mcp.status", key);
      return s.mcp[key];
    });
  });
}
