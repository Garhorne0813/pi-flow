import { z } from "zod";
import { Fault } from "../domain.js";
import type { Fire } from "./service.js";
export const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2000).optional(),
});
const Cursor = z
  .object({
    v: z.literal(1),
    scheduleId: z.string().min(1),
    scheduledFor: z.number().int(),
    id: z.string().min(1).max(200),
  })
  .strict();
export function historyCursor(value: string | undefined, scheduleId: string) {
  if (value === undefined) return;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = Cursor.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (parsed.scheduleId !== scheduleId) throw new Error();
    return { scheduledFor: parsed.scheduledFor, id: parsed.id };
  } catch {
    throw new Fault(400, "INVALID_CURSOR");
  }
}
export function nextHistoryCursor(scheduleId: string, fire: Fire) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scheduleId,
      scheduledFor: fire.scheduledFor,
      id: fire.id,
    }),
  ).toString("base64url");
}
