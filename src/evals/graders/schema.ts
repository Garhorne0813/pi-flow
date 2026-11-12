import { Ajv } from "ajv";
function noRemoteRefs(v: unknown, depth = 0): void {
  if (depth > 30) throw new Error("SCHEMA_DEPTH_LIMIT");
  if (!v || typeof v !== "object") return;
  const schema = v as Record<string, unknown>;
  for (const k of ["pattern", "patternProperties", "format"])
    if (Object.hasOwn(schema, k)) throw new Error("SCHEMA_REGEX_DENIED");
  for (const k of ["$ref", "$dynamicRef"]) {
    const value = schema[k];
    if (
      Object.hasOwn(schema, k) &&
      (typeof value !== "string" || !value.startsWith("#"))
    )
      throw new Error("REMOTE_REF_DENIED");
  }
  // Only visit schema positions. Property names and const/enum/default values
  // are user data even when they contain words such as "pattern" or "$ref".
  for (const k of [
    "properties",
    "definitions",
    "$defs",
    "dependentSchemas",
    "dependencies",
  ]) {
    const value = schema[k];
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const child of Object.values(value))
        if (!Array.isArray(child)) noRemoteRefs(child, depth + 1);
  }
  for (const k of [
    "additionalProperties",
    "additionalItems",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "items",
  ])
    if (Array.isArray(schema[k]))
      for (const child of schema[k]) noRemoteRefs(child, depth + 1);
    else noRemoteRefs(schema[k], depth + 1);
  for (const k of ["allOf", "anyOf", "oneOf", "prefixItems"])
    if (Array.isArray(schema[k]))
      for (const child of schema[k]) noRemoteRefs(child, depth + 1);
}
export function compileEvalSchema(schema: boolean | Record<string, unknown>) {
  noRemoteRefs(schema);
  return new Ajv({
    strict: true,
    allErrors: false,
    validateFormats: false,
  }).compile(schema);
}
