import { createHash } from "node:crypto";
import type pg from "pg";
import { personalConnection } from "../personal-context.js";
import { emptyState, Fault, id, type Actor, type State } from "../domain.js";
export interface Registry {
  read<T>(fn: (s: State) => T | Promise<T>): Promise<T>;
  tx<T>(fn: (s: State) => T | Promise<T>): Promise<T>;
  identify(issuer: string, subject: string): Promise<string>;
  verifyIdentity(
    issuer: string,
    subject: string,
    userId: string,
  ): Promise<void>;
}
export class MemoryRegistry implements Registry {
  private state = emptyState();
  private tail: Promise<unknown> = Promise.resolve();
  async read<T>(fn: (s: State) => T | Promise<T>) {
    await this.tail;
    return structuredClone(await fn(structuredClone(this.state)));
  }
  tx<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      const s = structuredClone(this.state);
      const result = await fn(s);
      this.state = s;
      return structuredClone(result);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async verifyIdentity(issuer: string, subject: string, userId: string) {
    const key = createHash("sha256")
      .update(JSON.stringify([issuer, subject]))
      .digest("hex");
    await this.read((s) => {
      const u = s.identities?.[key];
      if (!u?.enabled || u.id !== userId) throw new Fault(403, "USER_DISABLED");
    });
  }
  async identify(issuer: string, subject: string) {
    const key = createHash("sha256")
      .update(JSON.stringify([issuer, subject]))
      .digest("hex");
    return this.tx((s) => {
      s.identities ??= {};
      const u = (s.identities[key] ??= {
        id: id(),
        issuer,
        subject,
        enabled: true,
      });
      if (!u.enabled) throw new Fault(403, "USER_DISABLED");
      return u.id;
    });
  }
}
export class PostgresRegistry implements Registry {
  private cache?: { revision: string; state: State };
  constructor(private pool: pg.Pool) {}
  async read<T>(fn: (s: State) => T | Promise<T>) {
    const context = personalConnection.getStore();
    const source = context?.pool === this.pool ? context.client : this.pool;
    const cached = this.cache;
    const r = await source.query(
      `SELECT revision::text AS revision,
      CASE WHEN revision::text=$1 THEN NULL ELSE document END AS document,
      CASE WHEN revision::text=$1 THEN NULL ELSE COALESCE((SELECT jsonb_object_agg(id,data) FROM personal_agents),'{}'::jsonb) END AS agents
      FROM platform_config WHERE scope='runtime'`,
      [cached?.revision ?? null],
    );
    const row = r.rows[0];
    const state =
      row && cached && cached.revision === row.revision
        ? cached.state
        : {
            ...emptyState(),
            ...row?.document,
            managedAgents: row?.agents ?? {},
          };
    if (
      row &&
      (!this.cache || BigInt(row.revision) >= BigInt(this.cache.revision))
    )
      this.cache = { revision: row.revision, state };
    return structuredClone(await fn(structuredClone(state)));
  }

  async tx<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO platform_config(scope,document,revision) VALUES('runtime',$1,0) ON CONFLICT DO NOTHING",
        [JSON.stringify(emptyState())],
      );
      const r = await c.query(
        "SELECT document FROM platform_config WHERE scope='runtime' FOR UPDATE",
      );
      const agents = await c.query("SELECT id,data FROM personal_agents");
      const s: State = {
        ...emptyState(),
        ...r.rows[0].document,
        managedAgents: Object.fromEntries(
          agents.rows.map((v) => [v.id, structuredClone(v.data)]),
        ),
      };
      const result = await fn(s);
      for (const agent of Object.values(s.managedAgents ?? {}))
        if (
          JSON.stringify(agent) !==
          JSON.stringify(agents.rows.find((v) => v.id === agent.id)?.data)
        )
          await c.query(
            "INSERT INTO personal_agents(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            [agent.id, JSON.stringify(agent)],
          );
      for (const [ref, sealed] of Object.entries(s.secrets ?? {}))
        await c.query(
          "INSERT INTO platform_secrets(ref,sealed) VALUES($1,$2) ON CONFLICT(ref) DO UPDATE SET sealed=excluded.sealed",
          [ref, sealed],
        );
      for (const sk of Object.values(s.skills)) {
        await c.query(
          "INSERT INTO personal_skills(id,active_digest,enabled) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET active_digest=excluded.active_digest,enabled=excluded.enabled",
          [sk.id, sk.versionDigest ?? sk.digest, sk.enabled],
        );
        const { files, ...manifest } = sk;
        await c.query(
          "INSERT INTO personal_skill_versions(skill_id,digest,manifest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [sk.id, sk.versionDigest ?? sk.digest, JSON.stringify(manifest)],
        );
        if (files)
          await c.query(
            "INSERT INTO personal_skill_archives(skill_id,digest,files) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [sk.id, sk.versionDigest ?? sk.digest, JSON.stringify(files)],
          );
      }
      await c.query(
        "UPDATE platform_config SET document=$1,revision=revision+1 WHERE scope='runtime'",
        [JSON.stringify({ ...s, managedAgents: undefined })],
      );
      await c.query("COMMIT");
      return structuredClone(result);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async verifyIdentity(issuer: string, subject: string, userId: string) {
    const result = await this.pool.query(
      "SELECT id,enabled FROM personal_users WHERE issuer=$1 AND subject=$2",
      [issuer, subject],
    );
    const u = result.rows[0];
    if (!u?.enabled || u.id !== userId) throw new Fault(403, "USER_DISABLED");
  }
  async identify(issuer: string, subject: string) {
    const lookup = () =>
      this.pool.query(
        "SELECT id,enabled FROM personal_users WHERE issuer=$1 AND subject=$2",
        [issuer, subject],
      );
    let row = (await lookup()).rows[0];
    if (!row)
      row =
        (
          await this.pool.query(
            "INSERT INTO personal_users(id,issuer,subject) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO NOTHING RETURNING id,enabled",
            [id(), issuer, subject],
          )
        ).rows[0] ?? (await lookup()).rows[0];
    if (!row?.enabled) throw new Fault(403, "USER_DISABLED");
    return row.id as string;
  }
}
export async function principal(registry: Registry, a: Actor): Promise<Actor> {
  if (a.personal) return a;
  const issuer = a.issuer ?? `urn:legacy:${a.tenantId}`;
  const subject = a.subject ?? a.userId;
  const userId = await registry.identify(issuer, subject);
  return { ...a, userId, tenantId: userId, issuer, subject, personal: true };
}
