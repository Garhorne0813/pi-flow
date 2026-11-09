import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Fault } from "../domain.js";
function key(variable = "RUN_TOKEN_KEY") {
  const raw = process.env[variable];
  if (!raw) throw new Fault(503, variable + "_REQUIRED");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Fault(503, "INVALID_" + variable);
  return bytes;
}
export function sealToken(
  token: string,
  context: string,
  variable = "RUN_TOKEN_KEY",
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(variable), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function openToken(
  sealed: string,
  context: string,
  variable = "RUN_TOKEN_KEY",
) {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 3) throw new Error();
    const [iv, tag, data] = parts.map((v) => Buffer.from(v, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", key(variable), iv!);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag!);
    return Buffer.concat([cipher.update(data!), cipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new Fault(503, "RUN_TOKEN_UNAVAILABLE");
  }
}
