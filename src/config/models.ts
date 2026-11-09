import { z } from "zod";
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
