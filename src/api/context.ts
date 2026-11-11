import type { FastifyInstance } from "fastify";
import type { Actor } from "../domain/model.js";
import type { HarnessService } from "../domain/service.js";
import type { SandboxManager } from "../sandbox/manager.js";
import type { MCPManager } from "../mcp/manager.js";
import type { HostSkillPackages } from "../skills/packages.js";

/** Shared dependencies supplied by buildAPI; route modules register on the same app. */
export interface RouteContext {
  app: FastifyInstance;
  actor: (request: object) => Actor;
  service: HarnessService;
  sandbox: SandboxManager;
  mcp?: MCPManager;
  skillPackages?: HostSkillPackages;
  configurationStore: Pick<HarnessService["store"], "readMetadata" | "tx">;
  agentKey: (value: unknown) => string;
}
