import test from "node:test";
import { personalHistoryBenchmark } from "../scripts/acceptance/personal-history.js";
const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !url)
  throw new Error("TEST_DATABASE_URL required");
test(
  "personal claim and scheduler read bounded rows/bytes with 5k Runs, 50k Events and 5k Fires",
  { skip: !url },
  async () => {
    console.log(
      JSON.stringify({ personalHistory: await personalHistoryBenchmark(url!) }),
    );
  },
);
