import { createHash } from "node:crypto";
import { z } from "zod";
import { Fault } from "../domain/model.js";

export const collectionLimits = Object.freeze({
  maxSkills: 64,
  maxFiles: 4096,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
});
export const CollectionRequest = z
  .object({
    volume: z.string().min(1).max(300),
    bundle: z.string().min(1).max(200),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    skills: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            path: z.string().max(2048),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            versionDigest: z.string().optional(),
          })
          .strict(),
      )
      .max(collectionLimits.maxSkills),
    operation: z.string().min(1).max(500).optional(),
    context: z
      .object({
        tenantId: z.string().min(1).max(200),
        workspaceId: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CollectionRequest = z.infer<typeof CollectionRequest>;
export const CollectionLocation = z
  .object({
    selectionId: z.string().regex(/^[a-f0-9]{64}$/),
    artifact: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export type CollectionLocation = z.infer<typeof CollectionLocation>;
export type CollectionResolver = (
  request: CollectionRequest,
) => Promise<CollectionLocation>;
export const collectionId = (volume: string, scope: string) =>
  createHash("sha256")
    .update(JSON.stringify(["selected-skills-v1", volume, scope]))
    .digest("hex");
export const collectionPath = (prefix: string, location: CollectionLocation) =>
  `${prefix}/${Buffer.from(location.selectionId, "hex").toString("base64url")}/${location.artifact}`;
export const collectionRoute = "/internal/skill-collections/resolve";

export function remoteCollectionResolver(
  url: string,
  token: string,
): CollectionResolver {
  const endpoint = new URL(url);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    )
  )
    throw new Error("Collection API requires HTTPS or loopback HTTP");
  if (token.length < 32)
    throw new Error("Collection API token must have at least 32 characters");
  return async (request) => {
    const response = await fetch(new URL(collectionRoute, endpoint), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(115000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { error?: { code?: string } }
        | undefined;
      const code = body?.error?.code;
      throw new Fault(
        response.status,
        code && /^[A-Z0-9_]{1,80}$/.test(code)
          ? code
          : "SKILL_COLLECTION_SERVICE_FAILED",
      );
    }
    return CollectionLocation.parse(await response.json());
  };
}
