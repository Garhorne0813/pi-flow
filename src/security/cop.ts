import { createHash } from "node:crypto";
import { Fault, type Actor } from "../domain.js";
import type { Auth } from "../auth.js";
export function copAuth(url: string): Auth {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && process.env.UCS_ALLOW_HTTP === "true")
  )
    throw new Error("COP verification requires HTTPS");
  const cache = new Map<string, { until: number; actor?: Actor }>(),
    pending = new Map<string, Promise<Actor>>();
  let failures = 0,
    openUntil = 0;
  const adminUsers = (process.env.UCS_ADMIN_USER_IDS ?? "")
      .split(",")
      .filter(Boolean),
    adminRoles = (process.env.UCS_ADMIN_ROLE_KEYS ?? "")
      .split(",")
      .filter(Boolean);
  return async (header) => {
    if (!header?.startsWith("Bearer ") || !header.slice(7))
      throw new Fault(401, "UNAUTHENTICATED");
    const token = header.slice(7),
      key = createHash("sha256").update(token).digest("hex"),
      cached = cache.get(key);
    if (cached && cached.until > Date.now()) {
      if (!cached.actor) throw new Fault(401, "UNAUTHENTICATED");
      return { ...cached.actor };
    }
    if (pending.has(key)) return pending.get(key)!;
    if (Date.now() < openUntil)
      throw new Fault(503, "IDENTITY_PROVIDER_UNAVAILABLE");
    const request = (async () => {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "GET",
          headers: { Token: token },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
      } catch {
        if (++failures >= 5) openUntil = Date.now() + 10000;
        throw new Fault(503, "IDENTITY_PROVIDER_UNAVAILABLE");
      }
      if (response.status >= 500) {
        if (++failures >= 5) openUntil = Date.now() + 10000;
        throw new Fault(503, "IDENTITY_PROVIDER_UNAVAILABLE");
      }
      failures = 0;
      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {}
      const data = body.data as Record<string, unknown> | undefined,
        subject = data?.userId ?? data?.id;
      if (
        !response.ok ||
        !(body.success === true || body.code === 200 || body.code === 0) ||
        (typeof subject !== "string" && typeof subject !== "number")
      ) {
        cache.set(key, { until: Date.now() + 3000 });
        throw new Fault(401, "UNAUTHENTICATED");
      }
      const roles = Array.isArray(data?.roleKeys) ? data.roleKeys : [];
      const a: Actor = {
        tenantId: "personal",
        userId: String(subject),
        issuer: "urn:ucs",
        subject: String(subject),
        admin:
          adminUsers.includes(String(subject)) ||
          roles.some((r) => typeof r === "string" && adminRoles.includes(r)),
      };
      const until = Date.now() + 30000;
      if (cache.size >= 10000) cache.delete(cache.keys().next().value!);
      cache.set(key, { until, actor: a });
      return a;
    })();
    pending.set(key, request);
    try {
      return await request;
    } finally {
      pending.delete(key);
    }
  };
}
