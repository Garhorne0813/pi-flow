import { token } from "./auth";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export async function request(path: string, init: RequestInit = {}) {
  const bearer = await token();
  const res = await fetch("/api/v1" + path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error?.code || `HTTP_${res.status}`);
  }
  return res;
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  key?: string,
): Promise<T> {
  return (
    await request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(key ? { headers: { "Idempotency-Key": key } } : {}),
    })
  ).json();
}
