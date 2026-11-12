import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
const pages = [
  "/chat",
  "/workspace",
  "/settings",
  "/auth/callback",
  "/admin",
  "/admin/agents",
  "/admin/skills",
  "/admin/mcp",
  "/admin/delegation",
  "/admin/settings",
];
export function publicWebPath(path: string) {
  return (
    pages.includes(path) ||
    /^\/chat\/[^/]+$/.test(path) ||
    /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2|svg)$/.test(path)
  );
}
export function webRoutes(app: FastifyInstance) {
  const root = resolve(process.env.CHAT_WEB_DIR || "web/dist");
  const shell = async (_req: unknown, reply: FastifyReply) => {
    if (process.env.CHAT_UI_ENABLED === "false")
      return reply.code(404).send({ error: { code: "CHAT_UI_DISABLED" } });
    try {
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .type("text/html; charset=utf-8")
        .send(await readFile(resolve(root, "index.html")));
    } catch {
      return reply.code(503).send({
        error: {
          code: "WEB_UI_NOT_BUILT",
          message: "Build web/ before serving the UI",
        },
      });
    }
  };
  for (const path of [...pages, "/chat/:sessionId"]) app.get(path, shell);
  app.get("/assets/:file", async (req, reply) => {
    if (
      process.env.CHAT_UI_ENABLED === "false" ||
      !publicWebPath(req.url.split("?")[0]!)
    )
      return reply.code(404).send();
    const file = (req.params as { file: string }).file,
      extension = file.split(".").at(-1)!;
    try {
      return reply
        .header("Cache-Control", "public,max-age=31536000,immutable")
        .header("X-Content-Type-Options", "nosniff")
        .type(
          (
            {
              js: "text/javascript",
              css: "text/css",
              woff2: "font/woff2",
              svg: "image/svg+xml",
            } as Record<string, string>
          )[extension]!,
        )
        .send(await readFile(resolve(root, "assets", file)));
    } catch {
      return reply.code(404).send();
    }
  });
}
