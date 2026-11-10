import test from "node:test";
import { queuePlans } from "../scripts/acceptance/queue-plans.js";
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !url)
  throw new Error("TEST_DATABASE_URL required");
test(
  "100k single/multi-user backlog and 10k/100k due Workspace execution plans avoid backlog DISTINCT scans and maintenance sorts",
  { skip: !url },
  async () => {
    await queuePlans(url!);
  },
);
