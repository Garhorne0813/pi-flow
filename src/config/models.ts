import { z } from "zod";
import { createHash } from "node:crypto";
import { Fault, type State } from "../domain/model.js";
export const ModelEntry = z
  .object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    baseUrl: z
      .url()
      .refine(
        (v) =>
          new URL(v).protocol === "https:" ||
          (new URL(v).protocol === "http:" &&
            process.env.LLM_ALLOW_HTTP === "true"),
        "Model gateway requires HTTPS",
      ),
    secretRef: z.string().min(1),
    default: z.boolean().default(false),
  })
  .strict();
export type ModelEntry = z.infer<typeof ModelEntry>;
export type CatalogModel = ModelEntry & { gatewayRef?: string };
export type ModelGateway = {
  model: { provider: string; modelId: string };
  baseUrl: string;
  secretVersion: string;
};
// Versions are append-only. Rotating a mutable secret alias or replacing a
// catalog entry must not change a previously queued Run's execution inputs.
export function versionModelCatalog(s: State) {
  const digest = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  for (const entry of s.modelCatalog ?? []) {
    const sealed = s.secrets?.[entry.secretRef];
    if (!sealed) throw new Fault(400, "MODEL_SECRET_REQUIRED");
    const secret = { ref: entry.secretRef, sealed };
    const secretVersion = digest(secret);
    (s.modelSecretVersions ??= {})[secretVersion] ??= secret;
    const gateway: ModelGateway = {
      model: { provider: entry.provider, modelId: entry.modelId },
      baseUrl: entry.baseUrl,
      secretVersion,
    };
    const ref = digest(gateway);
    (s.modelGatewayVersions ??= {})[ref] ??= gateway;
    entry.gatewayRef = ref;
  }
}
