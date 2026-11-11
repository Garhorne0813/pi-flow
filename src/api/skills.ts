import { z } from "zod";
import { Fault, admin, audit } from "../domain/model.js";
import { SkillUploadFields, skillZipLimits } from "../skills/packages.js";
import { page, params } from "./validation.js";
import type { RouteContext } from "./context.js";

export function registerSkillsRoutes({
  app,
  actor,
  service,
  skillPackages,
  configurationStore,
}: Pick<
  RouteContext,
  "app" | "actor" | "service" | "skillPackages" | "configurationStore"
>) {
  app.get("/api/v1/admin/skills", async (req) => {
    const a = actor(req);
    admin(a);
    const p = page.parse(req.query);
    return configurationStore.readMetadata(a.tenantId, ["skills"], (s) => ({
      items: Object.values(s.skills).slice(p.offset, p.offset + p.limit),
    }));
  });
  app.post(
    "/api/v1/admin/skills/upload",
    { bodyLimit: skillZipLimits.maxArchiveBytes + 65536 },
    async (req, reply) => {
      const a = actor(req);
      admin(a);
      if (!skillPackages?.configuration.enabled)
        throw new Fault(
          503,
          "SKILL_UPLOAD_DISABLED",
          "Host Skill uploads are not configured",
        );
      return skillPackages.withSlot(async () => {
        if (!req.isMultipart())
          throw new Fault(
            415,
            "SKILL_ZIP_CONTENT_TYPE",
            "Send a multipart form with one archive file",
          );
        const fields: Record<string, unknown> = Object.create(null);
        let archive: Buffer | undefined;
        for await (const part of req.parts({
          limits: {
            files: 1,
            fields: 4,
            parts: 5,
            fileSize: skillZipLimits.maxArchiveBytes,
            fieldSize: 8192,
          },
        })) {
          if (part.type === "file") {
            if (part.fieldname !== "archive" || archive)
              throw new Fault(
                400,
                "INVALID_REQUEST",
                "Exactly one archive file is required",
              );
            archive = await part.toBuffer();
            if (part.file.truncated) throw new Fault(413, "SKILL_ZIP_LIMIT");
          } else {
            if (Object.hasOwn(fields, part.fieldname) || part.valueTruncated)
              throw new Fault(
                400,
                "INVALID_REQUEST",
                "Duplicate or truncated upload field",
              );
            fields[part.fieldname] = part.value;
          }
        }
        const input = SkillUploadFields.parse(fields);
        if (!archive)
          throw new Fault(400, "INVALID_REQUEST", "Choose a Skill ZIP archive");
        if (!service.hasBundle(input.bundle, a.tenantId))
          throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
        await configurationStore.readMetadata(a.tenantId, ["skills"], (s) => {
          if (s.skills[input.id])
            throw new Fault(409, "IMMUTABLE_SKILL_VERSION");
        });
        if (req.raw.aborted) throw new Fault(400, "UPLOAD_ABORTED");
        if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
          throw new Fault(401, "UNAUTHENTICATED");
        const prepared = await skillPackages.prepare(
          a.tenantId,
          input,
          archive,
        );
        let metadataMayHaveCommitted = false;
        try {
          if (req.raw.aborted) throw new Fault(400, "UPLOAD_ABORTED");
          if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
            throw new Fault(401, "UNAUTHENTICATED");
          const skill = await configurationStore.tx(a.tenantId, (s) => {
            if (req.raw.aborted) throw new Fault(400, "UPLOAD_ABORTED");
            if (a.expiresAt !== undefined && a.expiresAt <= Date.now())
              throw new Fault(401, "UNAUTHENTICATED");
            if (s.skills[input.id])
              throw new Fault(409, "IMMUTABLE_SKILL_VERSION");
            s.skills[input.id] = prepared.skill;
            audit(
              s,
              a,
              "skill.upload",
              input.id,
              JSON.stringify({
                files: prepared.skill.hostUpload!.files,
                bytes: prepared.skill.hostUpload!.bytes,
              }),
            );
            metadataMayHaveCommitted = true;
            return prepared.skill;
          });
          return reply.code(201).send(skill);
        } catch (error) {
          if (!metadataMayHaveCommitted) await prepared.discard();
          throw error;
        }
      });
    },
  );
  app.post("/api/v1/admin/skills", async (req, reply) => {
    const a = actor(req);
    admin(a);
    const b = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/),
        name: z.string().min(1).max(100),
        description: z.string().max(2000),
        bundle: z.string(),
        path: z.string().regex(/^\/skills\/(?:[a-zA-Z0-9_-]+\/)+SKILL\.md$/),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(req.body);
    if (!service.hasBundle(b.bundle, a.tenantId))
      throw new Fault(400, "UNKNOWN_SKILL_BUNDLE");
    return reply.code(201).send(
      await configurationStore.tx(a.tenantId, (s) => {
        if (s.skills[b.id]) throw new Fault(409, "IMMUTABLE_SKILL_VERSION");
        s.skills[b.id] = { ...b, enabled: true };
        audit(s, a, "skill.register", b.id);
        return s.skills[b.id];
      }),
    );
  });
  app.put("/api/v1/admin/skills/:id/status", async (req) => {
    const a = actor(req);
    admin(a);
    const key = params(req.params).id!;
    const b = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return configurationStore.tx(a.tenantId, (s) => {
      if (!s.skills[key]) throw new Fault(404, "SKILL_NOT_FOUND");
      s.skills[key]!.enabled = b.enabled;
      audit(s, a, "skill.status", key);
      return s.skills[key];
    });
  });
}
