import type { Store } from "../storage/store.js";
import { Fault } from "../domain/model.js";
import {
  AliyunE2BProvider,
  type AliyunConfig,
} from "../sandbox/aliyun-provider.js";
import { uploadedOssSkillBinding } from "./oss-storage.js";
import { CollectionRequest, type CollectionResolver } from "./collection.js";
import type { OssSkillCollections } from "./oss-collections.js";

export function collectionService(
  store: Store,
  config: AliyunConfig,
  publisher: OssSkillCollections,
  canUseBundle: (bundle: string, tenant: string) => boolean,
): CollectionResolver {
  const provider = new AliyunE2BProvider(config);
  return async (raw) => {
    const request = CollectionRequest.parse(raw);
    const context = request.context;
    if (!context || !request.operation)
      throw new Fault(403, "SKILL_COLLECTION_LEASE_REQUIRED");
    const selected = () =>
      store.readMetadata(context.tenantId, ["skills", "workspaces"], (s) => {
        const w = s.workspaces[context.workspaceId];
        const locks = [w?.lock, w?.fileLock];
        if (
          !w ||
          w.deleting ||
          w.volumeId !== request.volume ||
          w.bundle !== request.bundle ||
          !locks.some(
            (lock) =>
              lock &&
              lock.owner === request.operation &&
              lock.expires > Date.now(),
          ) ||
          !canUseBundle(request.bundle, context.tenantId)
        )
          throw new Fault(403, "SKILL_COLLECTION_LEASE_REQUIRED");
        const skills = request.skills.map((expected) => {
          const skill = s.skills[expected.id];
          if (
            !skill?.enabled ||
            skill.bundle !== request.bundle ||
            skill.path !== expected.path ||
            skill.digest !== expected.digest ||
            skill.versionDigest !== expected.versionDigest
          )
            throw new Fault(403, "SKILL_DENIED");
          return skill;
        });
        if (provider.scope(request.bundle, skills) !== request.scope)
          throw new Fault(409, "SKILL_COLLECTION_SCOPE_CHANGED");
        return skills;
      });
    const skills = await selected();
    const result = await publisher.resolve(
      request.volume,
      request.scope,
      skills.map((skill) => {
        const binding =
          uploadedOssSkillBinding(skill, config) ?? config.skills[skill.id];
        if (!binding) throw new Fault(403, "ALIYUN_SKILL_NOT_PUBLISHED");
        return { skill, bucketPath: binding.bucketPath };
      }),
    );
    await selected();
    return result;
  };
}
