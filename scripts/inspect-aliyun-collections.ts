import { aliyunConfig } from "../src/sandbox/aliyun-provider.js";
import { ossClient } from "../src/skills/oss-packages.js";
import { collectionIO } from "../src/skills/oss-collections.js";
import {
  inspectCollectionStorage,
  collectionInventoryAlerts,
} from "../src/skills/collection-inventory.js";

// Read-only, explicitly invoked inspection. Never reclaims data or reads Skill contents.
const config = aliyunConfig();
const client = ossClient(config);
if (!client)
  throw new Error(
    "Configure OSS read/list credentials for collection inspection",
  );
const thresholds = {
  warnBytes: Number(process.env.ALIYUN_COLLECTION_WARN_BYTES ?? 1073741824),
  warnCollections: Number(process.env.ALIYUN_COLLECTION_WARN_COUNT ?? 1000),
};
const report = await inspectCollectionStorage(
  config.skillCollectionPrefix,
  collectionIO(client),
);
const alerts = collectionInventoryAlerts(report, thresholds);
console.log(
  JSON.stringify({
    measuredAt: new Date().toISOString(),
    ...report,
    thresholds,
    alerts,
    deletionPerformed: false,
  }),
);
if (alerts.length) process.exitCode = 2;
