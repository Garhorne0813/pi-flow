import { openToken } from "./security/token-vault.js";
import { HarnessService } from "./service.js";
import {
  AgentConfig,
  Fault,
  admin,
  agentAllowed,
  audit,
  id,
  session,
  terminal,
  type Actor,
  type Run,
} from "./domain.js";
import type { Store } from "./store.js";
import type { Registry } from "./store/registry.js";
import { workspacePath } from "./security-path.js";
export class PersonalService extends HarnessService {
  constructor(
    store: Store,
    public registry: Registry,
    endpoints: string[] = [],
    bundles: string[] = ["default"],
    models?: { provider: string; modelId: string }[],
  ) {
    super(store, endpoints, bundles, models);
  }
  async gatewayFor(run: Run) {
    return this.registry.read((s) => {
      if (run.modelGatewayRef === null) return undefined;
      if (run.modelGatewayRef !== undefined) {
        const gateway = s.modelGatewayVersions?.[run.modelGatewayRef];
        const secret =
          gateway && s.modelSecretVersions?.[gateway.secretVersion];
        if (
          !gateway ||
          !secret ||
          gateway.model.provider !== run.model?.provider ||
          gateway.model.modelId !== run.model?.modelId
        )
          throw new Fault(503, "MODEL_SNAPSHOT_UNAVAILABLE");
        return {
          baseUrl: gateway.baseUrl,
          apiKey: openToken(
            secret.sealed,
            "platform:" + secret.ref,
            "CONFIG_SECRET_KEY",
          ),
        };
      }
      // Compatibility for Runs created before gateway versioning. Their earlier
      // endpoint/key cannot be reconstructed after a pre-upgrade catalog edit.
      const model = run.model ?? run.capabilities!.model;
      if (!s.modelCatalog?.length) return undefined;
      const entry = s.modelCatalog.find(
        (m) => m.provider === model.provider && m.modelId === model.modelId,
      );
      if (!entry) throw new Fault(403, "MODEL_NOT_APPROVED");
      const sealed = s.secrets?.[entry.secretRef];
      if (!sealed) throw new Fault(503, "MODEL_SECRET_UNAVAILABLE");
      return {
        baseUrl: entry.baseUrl,
        apiKey: openToken(
          sealed,
          "platform:" + entry.secretRef,
          "CONFIG_SECRET_KEY",
        ),
      };
    });
  }
  override async verifyActor(a: Actor) {
    if (
      !a.issuer ||
      !a.subject ||
      (await this.registry.identify(a.issuer, a.subject)) !== a.userId
    )
      throw new Fault(403, "USER_DISABLED");
  }
  async ensureWorkspace(a: Actor) {
    return this.store.tx(a.tenantId, (s) => {
      const w = (s.workspaces[a.userId] ??= {
        id: a.userId,
        name: "Personal workspace",
        ownerId: a.userId,
        members: { [a.userId]: "owner" },
        bundle: "default",
      });
      return w;
    });
  }
  async createPersonalSession(
    a: Actor,
    input: { agentId: string; cwd?: string; title?: string },
  ) {
    const cwd = workspacePath(input.cwd);
    const w = await this.ensureWorkspace(a);
    return this.store.tx(a.tenantId, (s) => {
      const av = s.managedAgents?.[input.agentId];
      if (!av || !agentAllowed(av, a)) throw new Fault(404, "AGENT_NOT_FOUND");
      const ses = {
        id: id(),
        userId: a.userId,
        workspaceId: w.id,
        agentId: av.id,
        cwd,
        title: input.title,
        entries: [],
        createdAt: new Date().toISOString(),
      };
      s.sessions[ses.id] = ses;
      audit(s, a, "session.create", ses.id);
      return ses;
    });
  }
  async updateSession(
    a: Actor,
    sid: string,
    input: { title?: string; cwd?: string },
  ) {
    return this.store.tx(a.tenantId, (s) => {
      const ses = session(s, a, sid, true);
      if (
        input.cwd !== undefined &&
        Object.values(s.runs).some(
          (r) => r.sessionId === sid && !terminal(r.state),
        )
      )
        throw new Fault(409, "SESSION_BUSY");
      if (input.title !== undefined) ses.title = input.title;
      if (input.cwd !== undefined) ses.cwd = workspacePath(input.cwd);
      return ses;
    });
  }
  async deleteSession(a: Actor, sid: string) {
    return this.store.tx(a.tenantId, (s) => {
      const ses = session(s, a, sid, true);
      if (
        Object.values(s.runs).some(
          (r) => r.sessionId === sid && !terminal(r.state),
        )
      )
        throw new Fault(409, "SESSION_BUSY");
      ses.deletedAt = new Date().toISOString();
      audit(s, a, "session.delete", sid);
      return { deleted: true };
    });
  }
  async forkSession(a: Actor, sid: string) {
    return this.store.tx(a.tenantId, (s) => {
      const old = session(s, a, sid, true);
      if (
        Object.values(s.runs).some(
          (r) => r.sessionId === sid && !terminal(r.state),
        )
      )
        throw new Fault(409, "SESSION_BUSY");
      const next = {
        ...structuredClone(old),
        id: id(),
        createdAt: new Date().toISOString(),
      };
      s.sessions[next.id] = next;
      audit(s, a, "session.fork", next.id);
      return next;
    });
  }
  override async setAccess(a: Actor, selector: string, allowedUsers: string[]) {
    admin(a);
    return this.registry.tx((s) => {
      const agent = s.managedAgents?.[selector];
      if (!agent) throw new Fault(404, "AGENT_NOT_FOUND");
      agent.allowedUsers = [...allowedUsers];
      s.configRevisions ??= { global: 0, agents: 0 };
      s.configRevisions.agents++;
      audit(s, a, "agent.access", selector);
      return { allowedUsers: agent.allowedUsers };
    });
  }
  override async publish(a: Actor, _input: unknown): Promise<never> {
    admin(a);
    throw new Fault(410, "USE_AGENT_CONFIGURATION");
  }
}
