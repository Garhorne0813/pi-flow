import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { jobsFixture } from "./eval-job-fixture.js";
import { databaseUrl } from "./eval-fixture.js";
import { report, compare } from "../src/evals/report.js";
import { EvalWorker, EvalDemoRuntime } from "../src/evals/worker.js";
import { EvalExecutor } from "../src/evals/executor.js";
import { buildAPI } from "../src/api/server.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { personalStore } from "../src/storage/personal.js";
import { MemoryStore } from "../src/storage/store.js";
import { SandboxManager, DemoSandbox } from "../src/sandbox/manager.js";
const browserPath = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  chromium.executablePath(),
].find((p) => p && existsSync(p));
test(
  "eval report keeps errors/cancellations in denominators and rejects incomparable regression gates",
  { skip: !databaseUrl },
  async () => {
    const f = await jobsFixture();
    try {
      const job = await f.jobs.create(f.actor, f.request, "a");
      await new EvalWorker(
        f.jobs,
        new EvalExecutor(new EvalDemoRuntime()),
      ).tick();
      const finished = await f.jobs.job(f.actor.userId, job.jobId),
        rows = await f.jobs.caseRuns(f.actor.userId, job.jobId, {
          offset: 0,
          limit: 100,
        });
      const summary = report(
        finished,
        [
          ...rows,
          {
            ...rows[0]!,
            caseRunId: "error",
            state: "EXECUTION_ERROR",
            result: { errorCode: "EVAL_TIMEOUT" },
          },
          { ...rows[0]!, caseRunId: "cancel", state: "CANCELLED", result: {} },
        ],
        await f.jobs.usage(f.actor.userId, job.jobId),
      );
      assert.equal(summary.passRate, 1 / 3);
      assert.equal(summary.executionErrorRate, 1 / 3);
      assert.equal(summary.completedCaseCount, 1);
      assert.equal(summary.target.estimated, true);
      assert.equal(summary.target.unknownRequests, 1);
      assert.equal(compare(finished, finished, rows, rows).gate, true);
      assert.equal(
        compare(finished, { ...finished, suiteDigest: "different" }, rows, rows)
          .gate,
        null,
      );
      assert.equal(
        compare(finished, finished, rows, [
          { ...rows[0]!, state: "FAILED_ASSERTION", result: { score: 0 } },
        ]).gate,
        false,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "Evaluation Studio browser completes private draft/version/job/report/compare with mobile and keyboard access",
  { skip: !databaseUrl || !browserPath },
  async () => {
    const f = await jobsFixture(),
      backing = new MemoryStore(),
      normal = new PersonalService(
        personalStore(backing, f.registry),
        f.registry,
      );
    const app = buildAPI(
      normal,
      async () => f.actor,
      new SandboxManager(backing, new DemoSandbox()),
      undefined,
      undefined,
      undefined,
      f.service,
    );
    const browser = await chromium.launch({
      executablePath: browserPath,
      args: ["--no-sandbox"],
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 }),
        page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(address + "/evals/ui");
      await page.locator("#token").fill("test");
      await page.locator("#connect").click();
      await page.locator("#status").filter({ hasText: "已连接" }).waitFor();
      await page.locator("#name").fill("<img src=x onerror=alert(1)>");
      await page.locator("#save").click();
      await page.locator("#status").filter({ hasText: "草稿已保存" }).waitFor();
      await page.locator("#publish").click();
      await page
        .locator("#status")
        .filter({ hasText: "不可变版本已发布" })
        .waitFor();
      await page.locator("#start").click();
      await page.locator("#status").filter({ hasText: "评测已排队" }).waitFor();
      await new EvalWorker(
        f.jobs,
        new EvalExecutor(new EvalDemoRuntime()),
      ).tick();
      await page.locator("#refresh").click();
      await page.locator("#metrics").filter({ hasText: "COMPLETED" }).waitFor();
      await page.locator("#compare-button").click();
      await page
        .locator("#comparison")
        .filter({ hasText: '"comparable": true' })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.locator("#token").focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        "connect",
      );
      assert.equal(await page.locator("#suite img").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
      await f.close();
    }
  },
);
