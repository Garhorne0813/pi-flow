// Build-time maintenance only: preserve Pi source files and update one shrinkwrap entry.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const [source, sourceDist, fixedDist, target] = process.argv.slice(2);
if (!target)
  throw new Error(
    "Usage: node scripts/repack-pi-sdk.mjs source.tgz original-dist.json fixed-brace-dist.json output.tgz",
  );
const original = JSON.parse(readFileSync(sourceDist));
const actual =
  "sha512-" +
  createHash("sha512").update(readFileSync(source)).digest("base64");
if (actual !== original.integrity)
  throw new Error("Official source integrity mismatch");
const fixed = JSON.parse(readFileSync(fixedDist));
if (!fixed.dist.tarball.endsWith("/brace-expansion-5.0.12.tgz"))
  throw new Error("Expected brace-expansion 5.0.12");
mkdirSync("work", { recursive: true });
const dir = mkdtempSync("work/pi-repack-");
execFileSync("tar", ["-xzf", resolve(source), "-C", dir]);
const shrinkPath = dir + "/package/npm-shrinkwrap.json";
const lock = JSON.parse(readFileSync(shrinkPath));
if (lock.version !== "0.99.2") throw new Error("Expected Pi 0.99.2");
const entry = lock.packages["node_modules/brace-expansion"];
if (entry.version !== "5.0.9")
  throw new Error("Unexpected upstream shrinkwrap");
Object.assign(entry, {
  version: "5.0.12",
  resolved: fixed.dist.tarball,
  integrity: fixed.dist.integrity,
  dependencies: fixed.dependencies,
  engines: fixed.engines,
});
writeFileSync(shrinkPath, JSON.stringify(lock, null, 2) + "\n");
execFileSync("tar", [
  "--sort=name",
  "--mtime=@0",
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "-czf",
  resolve(target),
  "-C",
  dir,
  "package",
]);
console.log("Repacked Pi 0.99.2: only npm-shrinkwrap.json changed.");
