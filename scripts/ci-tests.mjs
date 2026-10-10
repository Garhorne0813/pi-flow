import { spawn } from "node:child_process";
import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readdirSync,
} from "node:fs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "CI requires a dedicated TEST_DATABASE_URL; database tests must not skip",
  );
}
mkdirSync("work/ci", { recursive: true });
const log = openSync("work/ci/tests.tap", "w");
const files = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .sort();
if (!files.length) throw new Error("No test files found");
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-reporter=tap",
    "--test-reporter=junit",
    "--test-reporter-destination=stdout",
    "--test-reporter-destination=work/ci/tests.junit.xml",
    ...files.map((f) => `test/${f}`),
  ],
  {
    env: { ...process.env, REQUIRE_POSTGRES_TESTS: "true" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let tail = "";
child.stdout.on("data", (chunk) => {
  writeSync(log, chunk);
  process.stdout.write(chunk);
  tail = (tail + chunk.toString()).slice(-65536);
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  closeSync(log);
  const summary =
    /(?:^|\n)# tests (\d+)\r?\n# suites \d+\r?\n# pass \d+\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n/.exec(
      tail,
    );
  if (
    code !== 0 ||
    !summary ||
    Number(summary[1]) === 0 ||
    summary.slice(2).some((value) => Number(value) !== 0)
  ) {
    console.error(
      "CI tests must finish successfully with no failures, cancellations, skips or TODOs",
    );
    process.exitCode = 1;
  }
});
