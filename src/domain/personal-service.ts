import { openToken } from "../security/token-vault.js";
import { HarnessService, digest } from "./service.js";
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
} from "./model.js";
import type { Store } from "../storage/store.js";
import type { Registry } from "../storage/registry.js";
import { workspacePath } from "../security/paths.js";
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
    if (!a.issuer || !a.subject) throw new Fault(403, "USER_DISABLED");
    await this.registry.verifyIdentity(a.issuer, a.subject, a.userId);
  }
  async ensureWorkspace(a: Actor) {
    const existing = await this.store.readMetadata(
      a.tenantId,
      ["workspaces"],
      (s) => s.workspaces[a.userId],
    );
    if (existing) return existing;
    return (
      this.store.workspaceTx?.bind(this.store) ?? this.store.tx.bind(this.store)
    )(a.tenantId, (s) => {
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
  private sessionWrite<T>(
    a: Actor,
    sid: string | undefined,
    fn: (s: import("./model.js").State) => T | Promise<T>,
    entries = false,
  ) {
    return this.store.sessionTx
      ? this.store.sessionTx(a.tenantId, sid, fn, { entries })
      : this.store.tx(a.tenantId, fn);
  }
  async createPersonalSession(
    a: Actor,
    input: { id?: string; agentId: string; cwd?: string; title?: string },
  ) {
    const cwd = workspacePath(input.cwd);
    const w = await this.ensureWorkspace(a);
    return this.sessionWrite(a, input.id, (s) => {
      const creationDigest = digest({
        agentId: input.agentId,
        cwd,
        title: input.title,
      });
      const existing = input.id ? s.sessions[input.id] : undefined;
      if (existing) {
        if (existing.userId !== a.userId || existing.deletedAt)
          throw new Fault(404, "SESSION_NOT_FOUND");
        if (existing.creationDigest !== creationDigest)
          throw new Fault(409, "SESSION_CREATE_CONFLICT");
        return existing;
      }
      const av = s.managedAgents?.[input.agentId];
      if (!av || !agentAllowed(av, a)) throw new Fault(404, "AGENT_NOT_FOUND");
      const ses = {
        creationDigest,
        id: input.id ?? id(),
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
    return this.sessionWrite(
      a,
      sid,
      (s) => {
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
      },
      true,
    );
  }
  async deleteSession(a: Actor, sid: string) {
    return this.sessionWrite(a, sid, (s) => {
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
    return this.sessionWrite(
      a,
      sid,
      (s) => {
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
      },
      true,
    );
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
