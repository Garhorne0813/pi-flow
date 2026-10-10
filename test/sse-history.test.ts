import test from "node:test";
import { sseHistoryReplay } from "../scripts/acceptance/sse-history.js";
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !url)
  throw new Error("TEST_DATABASE_URL required");
test(
  "HTTP replays 5000 historical SSE events without poll waits and resumes after mid-page disconnect",
  { skip: !url },
  async () => {
    console.log(JSON.stringify(await sseHistoryReplay()));
  },
);
