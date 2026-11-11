import { z } from "zod";

export const uuid = z.string().uuid();
export const params = (x: unknown) => z.record(z.string(), z.string()).parse(x);
export const page = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
