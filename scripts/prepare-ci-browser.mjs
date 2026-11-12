import { appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Hosted Ubuntu runners already include Chrome and its shared libraries. Verify
// that executable rather than apt-installing Playwright's optional font bundle.
async function verify(executablePath) {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
    timeout: 15000,
  });
  try {
    const page = await browser.newPage();
    await page.setContent("<p>ci-browser-ready</p>");
    if ((await page.locator("p").textContent()) !== "ci-browser-ready")
      throw new Error("Browser rendering smoke check failed");
    return browser.version();
  } finally {
    await browser.close();
  }
}

async function use(executablePath) {
  if (/[\r\n]/.test(executablePath)) throw new Error("Invalid browser path");
  const version = await verify(executablePath);
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV, `CHROMIUM_PATH=${executablePath}\n`);
  console.log(`Verified Chromium ${version}: ${executablePath}`);
}

if (process.env.CHROMIUM_PATH) {
  // An explicit override must work; do not silently replace it.
  await use(process.env.CHROMIUM_PATH);
} else {
  const candidates = [
    ...new Set([
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      chromium.executablePath(),
    ]),
  ].filter(existsSync);
  let ready = false;
  for (const executablePath of candidates) {
    try {
      await use(executablePath);
      ready = true;
      break;
    } catch (error) {
      console.warn(
        `Browser probe failed: ${String(error.message).split("\n")[0]}`,
      );
    }
  }
  if (!ready) {
    // Fallback downloads the browser only. No sudo, apt or Docker; launch below
    // remains mandatory and fails the job if runtime libraries are missing.
    const cli = fileURLToPath(
      new URL("../node_modules/playwright-core/cli.js", import.meta.url),
    );
    const install = spawnSync(process.execPath, [cli, "install", "chromium"], {
      stdio: "inherit",
      timeout: 180000,
    });
    if (install.error || install.status !== 0)
      throw (
        install.error ??
        new Error(`Browser download failed (${install.status})`)
      );
    await use(chromium.executablePath());
  }
}
