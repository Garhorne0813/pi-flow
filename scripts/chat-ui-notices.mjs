import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const web = fileURLToPath(new URL("../web/", import.meta.url)),
  lock = JSON.parse(readFileSync(join(web, "package-lock.json"), "utf8"));
let text =
  "Pi-Flow UI: third-party software notices\n\nDeepSeek Harness (MIT), source e8f7b93a344964de3dca1ace9e72b6e4d6de87cb\n" +
  readFileSync(
    join(web, "third-party/LICENSES/deepseek-harness-MIT.txt"),
    "utf8",
  );
const missing = [];
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
  a < b ? -1 : a > b ? 1 : 0,
)) {
  if (!path || entry.dev) continue;
  const root = join(web, path);
  if (!existsSync(join(root, "package.json"))) continue;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    files = readdirSync(root)
      .filter((f) => /^(license|licence|copying|notice)(?:[._-].*)?$/i.test(f))
      .sort();
  if (!files.length) {
    missing.push(pkg.name);
    continue;
  }
  text +=
    "\n\n" +
    pkg.name +
    "@" +
    pkg.version +
    " (" +
    String(pkg.license || entry.license || "see license") +
    ")\n";
  for (const file of files)
    text +=
      "\n" +
      file +
      "\n" +
      readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n").trim() +
      "\n";
}
if (missing.length)
  throw new Error("Missing runtime license files: " + missing.join(", "));
const target = join(web, "public/third-party-notices.txt");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text)
    throw new Error(
      "Regenerate UI notices with node scripts/chat-ui-notices.mjs",
    );
} else writeFileSync(target, text);
console.log(
  "Runtime UI notices " +
    (process.argv.includes("--check") ? "verified" : "generated"),
);
