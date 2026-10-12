import { z } from "zod";
import type { ToolSpec } from "./adapters/mcp.js";
const path = z.string().min(1).max(2048);
export const argumentsSchemas: Record<
  string,
  z.ZodType<Record<string, unknown>>
> = {
  read: z.object({ path }).strict(),
  write: z.object({ path, content: z.string().max(262144) }).strict(),
  edit: z
    .object({
      path,
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
      oldText: z.string().min(1).max(262144),
      newText: z.string().max(262144),
    })
    .strict(),
  bash: z
    .object({
      command: z.string().min(1).max(16000),
      timeoutSeconds: z.number().int().min(1).max(120).default(60),
    })
    .strict(),
  ls: z.object({ path: path.default("/workspace") }).strict(),
  find: z.object({ path: path.default("/workspace") }).strict(),
  grep: z
    .object({
      path: path.default("/workspace"),
      pattern: z.string().min(1).max(1000),
    })
    .strict(),
  todo: z
    .object({
      items: z
        .array(
          z.object({
            text: z.string().max(1000),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .max(100),
    })
    .strict(),
  ask_user_question: z
    .object({ question: z.string().min(1).max(8000) })
    .strict(),
  delegate_to_agent: z
    .object({ agentVersionId: z.string(), task: z.string().min(1).max(16000) })
    .strict(),
};
export function specs(names: string[]): ToolSpec[] {
  return names.map((name) => ({
    name,
    description: `${name} in the authorized workspace. Mutations and shell require approval.`,
    schema: z.toJSONSchema(argumentsSchemas[name]!) as Record<string, unknown>,
  }));
}
