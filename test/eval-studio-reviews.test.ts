import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium, type Page, type Request } from "playwright-core";
import { evaluationsHTML } from "../src/admin-ui/evaluations.js";
const browserPath = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  chromium.executablePath(),
].find((p) => p && existsSync(p));
const suiteId = "00000000-0000-4000-8000-000000000001";
const oldId = "00000000-0000-4000-8000-000000000002";
const newId = "00000000-0000-4000-8000-000000000003";
const job = (jobId: string) => ({
  jobId,
  state: "COMPLETED",
  request: { agentId: "assistant" },
});
const version = (n: number) => ({ version: n, specDigest: "digest-" + n });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
type Reply = { body: unknown; status?: number };
async function studio(
  override: (url: URL, request: Request) => Promise<Reply | undefined>,
  run: (page: Page) => Promise<void>,
) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(evaluationsHTML());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({
    executablePath: browserPath,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let draft = {
      id: suiteId,
      name: "source",
      description: "original",
      draftRevision: 1,
      cases: [
        {
          caseId: "sensitive-source",
          inputs: "private-example",
          graders: [{ id: "g", type: "exact", expected: "ok" }],
        },
      ],
    };
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      let reply = await override(url, request);
      if (!reply) {
        let body: unknown;
        if (path === "/api/v1/agents")
          body = { items: [{ id: "assistant", name: "assistant" }] };
        else if (
          path === "/api/v1/evals/suites" &&
          request.method() === "POST"
        ) {
          draft = { ...draft, ...request.postDataJSON() };
          body = draft;
        } else if (path === "/api/v1/evals/suites")
          body = [{ id: suiteId, name: draft.name }];
        else if (path.endsWith("/versions")) body = [version(1)];
        else if (path.includes("/versions/"))
          body = { version: version(1), cases: draft.cases };
        else if (path === "/api/v1/evals/suites/" + suiteId) body = draft;
        else if (path === "/api/v1/evals/jobs" && request.method() === "POST")
          body = job(oldId);
        else if (path === "/api/v1/evals/jobs") body = [job(oldId), job(newId)];
        else if (path.endsWith("/report"))
          body = {
            jobId: path.split("/").at(-2),
            state: "COMPLETED",
            passed: 1,
            denominators: { total: 1 },
            executionErrorRate: 0,
            gradingErrorRate: 0,
          };
        else if (path.endsWith("/cases"))
          body = [
            {
              jobId: path.split("/").at(-2),
              caseRunId: "case",
              caseId: path.split("/").at(-2) + "-case",
              repeatIndex: 0,
              state: "PASSED",
            },
          ];
        else if (path === "/api/v1/evals/compare")
          body = { comparable: true, gate: true, warnings: [] };
        else throw Error("Unexpected API path: " + path);
        reply = { body };
      }
      await route.fulfill({ status: reply.status ?? 200, json: reply.body });
    });
    await page.goto(
      "http://127.0.0.1:" +
        (server.address() as { port: number }).port +
        "/evals/ui",
    );
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>((r, reject) =>
      server.close((e) => (e ? reject(e) : r())),
    );
  }
}
async function connect(page: Page) {
  await page.locator("#token").fill("test-placeholder");
  await page.locator("#connect").click();
  await page.locator("#status").filter({ hasText: "已连接" }).waitFor();
}
test(
  "Studio initializes new cases, pages Agents/versions and compares Job IDs across pages",
  { skip: !browserPath },
  async () => {
    let created: any, compared: any, saved: any;
    await studio(
      async (url, request) => {
        const offset = Number(url.searchParams.get("offset"));
        if (url.pathname === "/api/v1/agents")
          return {
            body: {
              items:
                offset === 50
                  ? [{ id: "assistant-tail", name: "51st Agent" }]
                  : Array.from({ length: 50 }, (_, i) => ({
                      id: "agent-" + i,
                      name: "Agent " + i,
                    })),
            },
          };
        if (url.pathname.endsWith("/versions"))
          return {
            body:
              offset === 100
                ? [version(1)]
                : Array.from({ length: 100 }, (_, i) => version(101 - i)),
          };
        if (
          url.pathname === "/api/v1/evals/jobs" &&
          request.method() === "POST"
        )
          created = request.postDataJSON();
        if (url.pathname === "/api/v1/evals/jobs" && offset === 50)
          return { body: [job(newId)] };
        if (url.pathname === "/api/v1/evals/compare")
          compared = request.postDataJSON();
        if (
          url.pathname === "/api/v1/evals/suites" &&
          request.method() === "POST"
        )
          saved = request.postDataJSON();
        return undefined;
      },
      async (page) => {
        await connect(page);
        await page.locator("#agent-next").click();
        await page
          .locator("#agent option")
          .filter({ hasText: "51st Agent" })
          .waitFor({ state: "attached" });
        await page.locator("#suite").selectOption(suiteId);
        await page
          .locator("#version option")
          .filter({ hasText: "版本 101" })
          .waitFor({ state: "attached" });
        await page.locator("#version-next").click();
        await page.waitForFunction(
          () =>
            (document.getElementById("version") as HTMLSelectElement).value ===
            "1",
        );
        await page.locator("#show-version").click();
        await page
          .locator("#version-detail")
          .filter({ hasText: '"version": 1' })
          .waitFor();
        await page.locator("#start").click();
        await page
          .locator("#status")
          .filter({ hasText: "评测已排队" })
          .waitFor();
        assert.equal(created.agentId, "assistant-tail");
        assert.equal(created.suiteVersion, 1);
        assert.equal(created.limits.maxModelCalls, 100);
        await page.locator("#baseline").fill(oldId);
        await page.locator("#job-next").click();
        await page.waitForFunction(
          (id) =>
            (document.getElementById("job") as HTMLSelectElement).value === id,
          newId,
        );
        await page.locator("#candidate").fill(newId);
        assert.equal(await page.locator("#baseline").inputValue(), oldId);
        await page.locator("#compare-button").click();
        await page
          .locator("#status")
          .filter({ hasText: "回归 Gate 通过" })
          .waitFor();
        assert.deepEqual(compared, {
          baselineJobId: oldId,
          candidateJobId: newId,
        });
        await page.locator("#new").click();
        await page.locator("#revision").filter({ hasText: "新草稿" }).waitFor();
        assert.doesNotMatch(
          await page.locator("#cases").inputValue(),
          /private-example|sensitive-source/,
        );
        await page.locator("#save").click();
        await page
          .locator("#status")
          .filter({ hasText: "草稿已保存" })
          .waitFor();
        assert.equal(saved.cases[0].caseId, "hello");
      },
    );
  },
);
test(
  "Studio ignores delayed old Job cases and immediately loads the latest selection",
  { skip: !browserPath },
  async () => {
    const entered = deferred(),
      release = deferred();
    let block = false;
    try {
      await studio(
        async (url) => {
          if (
            block &&
            url.pathname === "/api/v1/evals/jobs/" + oldId + "/cases"
          ) {
            entered.resolve();
            await release.promise;
          }
          return undefined;
        },
        async (page) => {
          await connect(page);
          block = true;
          await page.locator("#refresh").click();
          await entered.promise;
          await page.locator("#job").selectOption(newId);
          await page
            .locator("#case-detail")
            .filter({ hasText: newId + "-case" })
            .waitFor();
          const oldResponse = page.waitForResponse(
            (r) =>
              new URL(r.url()).pathname ===
              "/api/v1/evals/jobs/" + oldId + "/cases",
          );
          release.resolve();
          await oldResponse;
          await page.evaluate(
            () =>
              new Promise<void>((r) =>
                requestAnimationFrame(() => requestAnimationFrame(() => r())),
              ),
          );
          assert.match(
            await page.locator("#case-detail").innerText(),
            new RegExp(newId),
          );
          assert.match(
            (await page.locator("#report").textContent())!,
            new RegExp(newId),
          );
          assert.doesNotMatch(
            await page.locator("#case-detail").innerText(),
            new RegExp(oldId),
          );
        },
      );
    } finally {
      release.resolve();
    }
  },
);
test(
  "Studio retries transient polling failures and manual refresh resumes after an auth failure",
  { skip: !browserPath },
  async () => {
    let status = 200,
      requests = 0;
    await studio(
      async (url) => {
        if (!url.pathname.endsWith("/report")) return undefined;
        requests++;
        if (status !== 200)
          return { status, body: { error: { code: "TEST_" + status } } };
        return undefined;
      },
      async (page) => {
        await page.clock.install();
        await connect(page);
        status = 503;
        await page.clock.fastForward(2000);
        await page
          .locator("#status")
          .filter({ hasText: "将自动重试" })
          .waitFor();
        const failed = requests;
        status = 200;
        const recovered = page.waitForResponse(
          (r) => r.url().endsWith("/report") && r.status() === 200,
        );
        await page.clock.fastForward(2000);
        await recovered;
        assert.ok(requests > failed);
        status = 401;
        await page.clock.fastForward(2000);
        await page.locator("#status").filter({ hasText: "TEST_401" }).waitFor();
        const stopped = requests;
        await page.clock.fastForward(4000);
        assert.equal(requests, stopped);
        status = 200;
        await page.locator("#refresh").click();
        await page
          .locator("#case-detail")
          .filter({ hasText: "-case" })
          .waitFor();
        const resumed = page.waitForResponse(
          (r) => r.url().endsWith("/report") && r.status() === 200,
        );
        await page.clock.fastForward(2000);
        await resumed;
        assert.ok(requests > stopped);
      },
    );
  },
);

for (const resource of ["suites", "jobs"])
  test(
    "Studio discards previous-account " +
      resource +
      " responses after reconnect",
    { skip: !browserPath },
    async () => {
      const entered = deferred(),
        release = deferred();
      try {
        await studio(
          async (url, request) => {
            const account =
              request.headers().authorization === "Bearer A" ? "A" : "B";
            if (
              url.pathname === "/api/v1/evals/" + resource &&
              account === "A"
            ) {
              entered.resolve();
              await release.promise;
            }
            if (url.pathname === "/api/v1/evals/suites")
              return {
                body: [
                  {
                    id: account === "A" ? suiteId : newId,
                    name: account + "-private-suite",
                  },
                ],
              };
            if (url.pathname === "/api/v1/evals/jobs")
              return {
                body: [
                  {
                    ...job(account === "A" ? oldId : newId),
                    request: { agentId: account + "-private-agent" },
                  },
                ],
              };
            return undefined;
          },
          async (page) => {
            await page.locator("#token").fill("A");
            await page.locator("#connect").click();
            await entered.promise;
            await page.locator("#token").fill("B");
            await page.locator("#connect").click();
            await page
              .locator("#status")
              .filter({ hasText: "已连接" })
              .waitFor();
            const response = page.waitForResponse(
              (r) =>
                r.request().headers().authorization === "Bearer A" &&
                new URL(r.url()).pathname === "/api/v1/evals/" + resource,
            );
            release.resolve();
            await response;
            await page.evaluate(
              () =>
                new Promise<void>((r) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => r())),
                ),
            );
            assert.match(
              await page.locator("#suite").innerText(),
              /B-private-suite/,
            );
            assert.doesNotMatch(
              await page.locator("#suite").innerText(),
              /A-private/,
            );
            assert.match(
              await page.locator("#job").innerText(),
              /B-private-agent/,
            );
            assert.doesNotMatch(
              await page.locator("#job").innerText(),
              /A-private/,
            );
            assert.match(await page.locator("#status").innerText(), /已连接/);
          },
        );
      } finally {
        release.resolve();
      }
    },
  );

test(
  "Studio coalesces double-start and reuses its idempotency key after an ambiguous failure",
  { skip: !browserPath },
  async () => {
    const entered = deferred(),
      release = deferred();
    const requests: { key: string; body: any }[] = [];
    try {
      await studio(
        async (url, request) => {
          if (
            url.pathname !== "/api/v1/evals/jobs" ||
            request.method() !== "POST"
          )
            return undefined;
          requests.push({
            key: request.headers()["idempotency-key"]!,
            body: request.postDataJSON(),
          });
          if (requests.length === 1) {
            entered.resolve();
            await release.promise;
            return { status: 503, body: { error: { code: "TEST_503" } } };
          }
          return undefined;
        },
        async (page) => {
          await connect(page);
          await page.locator("#suite").selectOption(suiteId);
          await page
            .locator("#version option")
            .first()
            .waitFor({ state: "attached" });
          await page.locator("#model-calls").fill("0");
          await page.locator("#start").click();
          await page
            .locator("#status")
            .filter({ hasText: "1 至 100" })
            .waitFor();
          assert.equal(requests.length, 0);
          await page.locator("#model-calls").fill("31");
          await page.locator("#start").evaluate((el) => {
            (el as HTMLButtonElement).click();
            (el as HTMLButtonElement).click();
          });
          await entered.promise;
          assert.equal(requests.length, 1);
          assert.equal(await page.locator("#start").isDisabled(), true);
          release.resolve();
          await page
            .locator("#status")
            .filter({ hasText: "TEST_503" })
            .waitFor();
          await page.locator("#start").click();
          await page
            .locator("#status")
            .filter({ hasText: "评测已排队" })
            .waitFor();
          assert.equal(requests.length, 2);
          assert.equal(requests[0]!.key, requests[1]!.key);
          assert.equal(requests[1]!.body.limits.maxModelCalls, 31);
          await page.locator("#start").click();
          await page.waitForFunction(
            () =>
              !(document.getElementById("start") as HTMLButtonElement).disabled,
          );
          assert.equal(requests.length, 3);
          assert.notEqual(requests[2]!.key, requests[1]!.key);
        },
      );
    } finally {
      release.resolve();
    }
  },
);

for (const method of ["PATCH", "POST"])
  test(
    "Studio ignores a delayed " + method + " save after switching Suites",
    { skip: !browserPath },
    async () => {
      const entered = deferred(),
        release = deferred();
      let published: { id: string; revision: number } | undefined;
      try {
        await studio(
          async (url, request) => {
            const path = url.pathname;
            if (path === "/api/v1/evals/suites" && request.method() === "GET")
              return {
                body: [
                  { id: suiteId, name: "A" },
                  { id: newId, name: "B" },
                ],
              };
            if (path === "/api/v1/evals/suites/" + newId)
              return {
                body: {
                  id: newId,
                  name: "B-current",
                  description: "B",
                  draftRevision: 4,
                  cases: [{ caseId: "B-only", inputs: "B", graders: [] }],
                },
              };
            if (
              request.method() === method &&
              (path === "/api/v1/evals/suites" ||
                path === "/api/v1/evals/suites/" + suiteId)
            ) {
              entered.resolve();
              await release.promise;
              return {
                body: {
                  ...request.postDataJSON(),
                  id: suiteId,
                  name: "A-saved",
                  draftRevision: 2,
                },
              };
            }
            if (path.endsWith("/versions") && request.method() === "POST") {
              published = {
                id: path.split("/").at(-2)!,
                revision: request.postDataJSON().revision,
              };
              return { body: version(2) };
            }
            return undefined;
          },
          async (page) => {
            await connect(page);
            if (method === "PATCH") {
              await page.locator("#suite").selectOption(suiteId);
              await page
                .locator("#revision")
                .filter({ hasText: "revision 1" })
                .waitFor();
            }
            await page.locator("#name").fill("A-edited");
            await page.locator("#save").click();
            await entered.promise;
            await page.locator("#suite").selectOption(newId);
            await page
              .locator("#revision")
              .filter({ hasText: "revision 4" })
              .waitFor();
            const response = page.waitForResponse(
              (r) =>
                r.request().method() === method &&
                new URL(r.url()).pathname.startsWith("/api/v1/evals/suites"),
            );
            release.resolve();
            await response;
            await page.evaluate(
              () =>
                new Promise<void>((r) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => r())),
                ),
            );
            assert.equal(await page.locator("#suite").inputValue(), newId);
            assert.equal(await page.locator("#name").inputValue(), "B-current");
            assert.match(await page.locator("#cases").inputValue(), /B-only/);
            assert.doesNotMatch(
              await page.locator("#status").innerText(),
              /草稿已保存/,
            );
            await page.locator("#publish").click();
            await page
              .locator("#status")
              .filter({ hasText: "不可变版本已发布" })
              .waitFor();
            assert.deepEqual(published, { id: newId, revision: 4 });
          },
        );
      } finally {
        release.resolve();
      }
    },
  );
