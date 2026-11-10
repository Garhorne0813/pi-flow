import test from "node:test";
import { runtimeHotpaths } from "../scripts/acceptance/runtime-hotpaths.js";
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !url)
  throw new Error("TEST_DATABASE_URL required");
test(
  "personal runtime SQL remains bounded with 1000 idle users, 50k historical Events, SSE and real model/tool/checkpoint execution",
  { skip: !url },
  async () => {
    console.log(
      JSON.stringify({
        runtimeHotpaths: await runtimeHotpaths(url!, {
          httpDurationMs: 500,
          activeRuns: 12,
          sseConnections: 20,
          sseDurationMs: 1200,
        }),
      }),
    );
  },
);
