import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Actor } from "../domain/model.js";
import { Page, type EvalService } from "../evals/service.js";
const params = z.object({ id: z.uuid() });
export function registerEvalRoutes(
  app: FastifyInstance,
  actor: (req: object) => Actor,
  service: EvalService,
) {
  const root = "/api/v1/evals";
  app.get(root + "/suites", async (req) => {
    const a = actor(req);
    await service.authorize(a);
    return service.store.listSuites(a.userId, Page.parse(req.query));
  });
  app.post(root + "/suites", async (req, reply) =>
    reply.code(201).send(await service.createSuite(actor(req), req.body)),
  );
  app.get(root + "/suites/:id", async (req) => {
    const a = actor(req);
    await service.authorize(a);
    return service.store.getSuite(a.userId, params.parse(req.params).id);
  });
  app.patch(root + "/suites/:id", async (req) =>
    service.patchSuite(actor(req), params.parse(req.params).id, req.body),
  );
  app.delete(root + "/suites/:id", async (req, reply) => {
    const a = actor(req);
    await service.authorize(a);
    await service.store.deleteSuite(a.userId, params.parse(req.params).id);
    return reply.code(204).send();
  });
  app.get(root + "/suites/:id/versions", async (req) => {
    const a = actor(req);
    await service.authorize(a);
    return service.store.versions(
      a.userId,
      params.parse(req.params).id,
      Page.parse(req.query),
    );
  });
  app.post(root + "/suites/:id/versions", async (req, reply) => {
    const a = actor(req);
    await service.authorize(a);
    const { revision } = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return reply
      .code(201)
      .send(
        await service.store.publish(
          a.userId,
          params.parse(req.params).id,
          revision,
        ),
      );
  });
  app.get(root + "/suites/:id/versions/:version", async (req) => {
    const a = actor(req);
    await service.authorize(a);
    const p = params
      .extend({ version: z.coerce.number().int().positive() })
      .parse(req.params);
    return {
      version: await service.store.version(a.userId, p.id, p.version),
      cases: await service.store.cases(
        a.userId,
        p.id,
        p.version,
        Page.parse(req.query),
      ),
    };
  });
}
