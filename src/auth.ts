import { createRemoteJWKSet, jwtVerify } from "jose";
import { Fault, type Actor } from "./domain.js";
export type Auth = (authorization?: string) => Promise<Actor>;
export function authFromEnv(): Auth {
  if (process.env.HARNESS_MODE === "demo") {
    const token = process.env.DEV_TOKEN;
    if (!token || token.length < 16)
      throw new Error("DEV_TOKEN must have at least 16 characters");
    return async (header) => {
      if (header !== `Bearer ${token}`) throw new Fault(401, "UNAUTHENTICATED");
      return { tenantId: "demo", userId: "demo-admin", admin: true };
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
        requiredClaims: ["exp", "sub", "tenant_id"],
      });
      if (
        typeof payload.sub !== "string" ||
        typeof payload.tenant_id !== "string"
      )
        throw new Error();
      return {
        expiresAt: payload.exp! * 1000,
        userId: payload.sub,
        tenantId: payload.tenant_id,
        admin:
          Array.isArray(payload.roles) &&
          payload.roles.includes("harness-admin"),
      };
    } catch {
      throw new Fault(401, "UNAUTHENTICATED");
    }
  };
}
