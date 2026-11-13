import { ApiError } from "../api/client";
export function streamError(data: string) {
  let code: unknown;
  try {
    code = JSON.parse(data).code;
  } catch {
    /* Retry unknown stream failures. */
  }
  if (code === "AUTHENTICATION_EXPIRED" || code === "AUTH_EXPIRED")
    return new ApiError(401, String(code));
  if (code === "ACCESS_REVOKED") return new ApiError(403, code);
  return new ApiError(503, "STREAM_UNAVAILABLE");
}
