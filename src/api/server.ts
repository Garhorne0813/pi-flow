import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { timingSafeEqual, createHash } from "node:crypto";
import {
  collectionRoute,
  CollectionRequest,
  type CollectionResolver,
} from "../skills/collection.js";
import { z } from "zod";
import { Fault, id, type Actor, type State } from "../domain/model.js";
import { PersonalService } from "../domain/personal-service.js";
import { principal } from "../storage/registry.js";
import { personalRoutes } from "./personal.js";
import { uuid } from "./validation.js";
import type { Auth } from "./auth.js";
import type { HarnessService } from "../domain/service.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { MCPManager } from "../mcp/manager.js";
import type { SkillPackages } from "../skills/packages.js";
import type { RouteContext } from "./context.js";
import { registerConfigurationRoutes } from "./configuration.js";
import { registerAgentsRoutes } from "./agents.js";
import { registerSkillsRoutes } from "./skills.js";
import { registerMcpRoutes } from "./mcp.js";
import { registerOperationsRoutes } from "./operations.js";
import { registerWorkspacesRoutes } from "./workspaces.js";
import { registerSandboxesRoutes } from "./sandboxes.js";
import { registerSessionsRoutes } from "./sessions.js";
import { registerRunsRoutes } from "./runs.js";
import { registerEventsRoutes } from "./events.js";
import { registerFilesRoutes } from "./files.js";

export function buildAPI(
  service: HarnessService,
  auth: Auth,
  sandbox: SandboxManager,
  mcp?: MCPManager,
  skillPackages?: SkillPackages,
  collections?: { token: string; resolve: CollectionResolver },
) {
  if (collections && collections.token.length < 32)
    throw new Error("Collection API token must have at least 32 characters");
  const authenticateCollection = (header?: string) => {
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (
      !collections ||
      !timingSafeEqual(hash(header ?? ""), hash(`Bearer ${collections.token}`))
    )
      throw new Fault(401, "UNAUTHENTICATED");
  };
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization"],
      level: process.env.LOG_LEVEL ?? "info",
    },
    bodyLimit: 350000,
    requestTimeout: 30000,
  });
  void app.register(multipart);
  const configurationStore =
    service instanceof PersonalService
      ? {
          readMetadata: <T>(
            _tenant: string,
            _keys: (keyof State)[],
            fn: (s: State) => T | Promise<T>,
          ) => service.registry.read(fn),
          tx: <T>(_tenant: string, fn: (s: State) => T | Promise<T>) =>
            service.registry.tx(fn),
        }
      : service.store;
  const agentKey = (value: unknown) =>
    service instanceof PersonalService
      ? z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,63}$/)
          .parse(value)
      : uuid.parse(value);
  const actors = new WeakMap<object, Actor>();
  const actor = (req: object) => actors.get(req)!;
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number };
    const status =
      err instanceof Fault
        ? err.status
        : err instanceof z.ZodError
          ? 400
          : e.statusCode && e.statusCode < 500
            ? e.statusCode
            : 500;
    void reply.code(status).send({
      error: {
        code:
          err instanceof Fault
            ? err.code
            : err instanceof z.ZodError
              ? "INVALID_REQUEST"
              : status === 500
                ? "INTERNAL_ERROR"
                : "REQUEST_ERROR",
        message: status === 500 ? "Internal server error" : e.message,
        requestId: req.id,
      },
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-ID", req.id);
    if (collections && req.url.split("?")[0] === collectionRoute) {
      authenticateCollection(req.headers.authorization);
      return;
    }
    // Only the static shell is public; all data and mutations still require admin auth.
    if (
      req.method === "GET" &&
      ["/admin/agents/ui", "/admin/ui"].includes(req.url.split("?")[0]!)
    )
      return;
    if (
      ["/health", "/health/live", "/health/ready"].includes(
        req.url.split("?")[0]!,
      )
    )
      return;
    const authenticated = await auth(req.headers.authorization);
    if (service instanceof PersonalService) {
      if (req.url.startsWith("/api/v1/workspaces"))
        throw new Fault(404, "ROUTE_NOT_FOUND");
      actors.set(req, await principal(service.registry, authenticated));
    } else actors.set(req, authenticated);
  });
  app.addHook("onResponse", async (req, reply) => {
    const a = actors.get(req);
    if (
      a &&
      !(
        service instanceof PersonalService &&
        ["GET", "HEAD", "OPTIONS"].includes(req.method)
      )
    )
      await service.store.appendAudit(a.tenantId, {
        id: id(),
        timestamp: new Date().toISOString(),
        actorId: a.userId,
        action: `${req.method} ${req.routeOptions.url}`,
        resource: req.id,
        result: String(reply.statusCode),
      });
  });
  const context: RouteContext = {
    app,
    actor,
    service,
    sandbox,
    mcp,
    skillPackages,
    configurationStore,
    agentKey,
  };
  if (collections)
    app.post(collectionRoute, async (req, reply) => {
      authenticateCollection(req.headers.authorization);
      reply.header("Cache-Control", "no-store");
      return collections.resolve(CollectionRequest.parse(req.body));
    });
  registerConfigurationRoutes(context);
  registerAgentsRoutes(context);
  registerSkillsRoutes(context);
  registerMcpRoutes(context);
  registerOperationsRoutes(context);
  registerWorkspacesRoutes(context);
  registerSandboxesRoutes(context);
  registerSessionsRoutes(context);
  registerRunsRoutes(context);
  registerEventsRoutes(context);
  registerFilesRoutes(context);
  if (service instanceof PersonalService)
    personalRoutes(app, service, sandbox, actor);
  return app;
}
