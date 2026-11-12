import { createHash } from "node:crypto";
import { z } from "zod";
import { EvalCase } from "./types.js";
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const CaseList = z
  .array(EvalCase)
  .max(100)
  .superRefine((cases, ctx) => {
    if (new Set(cases.map((c) => c.caseId)).size !== cases.length)
      ctx.addIssue({ code: "custom", message: "Duplicate case IDs" });
    if (Buffer.byteLength(JSON.stringify(cases)) > 250000)
      ctx.addIssue({ code: "custom", message: "Dataset exceeds 250KB" });
  });
export function freezeDataset(input: unknown) {
  const cases = CaseList.parse(input);
  if (!cases.length) throw new Error("EMPTY_SUITE");
  return { cases: structuredClone(cases), specDigest: digest(cases) };
}
