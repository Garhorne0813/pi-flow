import { createRemoteJWKSet, jwtVerify } from "jose";
import { Fault, type Actor } from "./domain.js";
export type Auth = (authorization?: string) => Promise<Actor>;
export function authFromEnv(options: { personal?: boolean } = {}): Auth {
  if (process.env.HARNESS_MODE === "demo") {
    const token = process.env.DEV_TOKEN;
    if (!token || token.length < 16)
      throw new Error("DEV_TOKEN must have at least 16 characters");
    return async (header) => {
      if (header !== `Bearer ${token}`) throw new Fault(401, "UNAUTHENTICATED");
      return {
        tenantId: "demo",
        userId: "demo-admin",
        admin: true,
        ...(options.personal
          ? {
              issuer: "urn:dev",
              subject: process.env.DEV_SUBJECT ?? "demo-admin",
            }
          : {}),
      };
    };
  }
  const devToken = process.env.DEV_TOKEN;
  if (devToken) {
    // Explicit fixed-token mode supports isolated deployments without UCS.
    // It grants admin access and must not be exposed to untrusted clients.
    if (devToken.length < 16)
      throw new Error("DEV_TOKEN must have at least 16 characters");
    const tenantId = process.env.DEV_TENANT_ID ?? "local";
    const userId = process.env.DEV_USER_ID ?? "local-admin";
    console.warn(
      JSON.stringify({
        level: "warn",
        time: new Date().toISOString(),
        operation: "auth_fixed_token_enabled",
        tenantId,
      }),
    );
    return async (header) => {
      if (header !== `Bearer ${devToken}`)
        throw new Fault(401, "UNAUTHENTICATED");
      return {
        tenantId,
        userId,
        admin: true,
        ...(options.personal
          ? { issuer: "urn:dev", subject: process.env.DEV_SUBJECT ?? userId }
          : {}),
      };
    };
  }
  const { UCS_JWKS_URL, UCS_ISSUER, UCS_AUDIENCE } = process.env;
  if (!UCS_JWKS_URL || !UCS_ISSUER || !UCS_AUDIENCE)
    throw new Error("UCS OIDC configuration required");
  const url = new URL(UCS_JWKS_URL);
  if (url.protocol !== "https:") throw new Error("UCS JWKS requires HTTPS");
  const jwks = createRemoteJWKSet(url, { timeoutDuration: 5000 });
  return async (header) => {
    try {
      if (!header?.startsWith("Bearer ")) throw new Error();
      const { payload } = await jwtVerify(header.slice(7), jwks, {
        issuer: UCS_ISSUER,
        audience: UCS_AUDIENCE,
        algorithms: ["RS256", "ES256"],
        requiredClaims: options.personal
          ? ["exp", "sub"]
          : ["exp", "sub", "tenant_id"],
      });
      if (
        typeof payload.sub !== "string" ||
        (!options.personal && typeof payload.tenant_id !== "string")
      )
        throw new Error();
      return {
        ...(options.personal
          ? { issuer: UCS_ISSUER, subject: payload.sub }
          : {}),
        expiresAt: payload.exp! * 1000,
        userId: payload.sub,
        tenantId:
          typeof payload.tenant_id === "string"
            ? payload.tenant_id
            : "personal",
        admin:
          (Array.isArray(payload.roles) &&
            payload.roles.includes("harness-admin")) ||
          (process.env.UCS_ADMIN_USER_IDS ?? "")
            .split(",")
            .includes(payload.sub) ||
          (Array.isArray(payload.roles) &&
            payload.roles.some((r) =>
              (process.env.UCS_ADMIN_ROLE_KEYS ?? "")
                .split(",")
                .includes(String(r)),
            )),
      };
    } catch {
      throw new Fault(401, "UNAUTHENTICATED");
    }
  };
}
