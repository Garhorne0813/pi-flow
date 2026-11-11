// Build-time maintenance only: preserve Pi source files and update documented shrinkwrap entries.
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
const undici = JSON.parse(readFileSync("vendor/undici-fixed-dist.json"));
const http = lock.packages["node_modules/undici"];
if (http.version !== "8.10.2" || undici.version !== "8.12.2")
  throw new Error("Unexpected Undici security replacement");
Object.assign(http, {
  version: undici.version,
  resolved: undici.dist.tarball,
  integrity: undici.dist.integrity,
  engines: undici.engines,
});
lock.packages[""].dependencies.undici = undici.version;
const packagePath = dir + "/package/package.json";
const metadata = JSON.parse(readFileSync(packagePath));
if (metadata.dependencies.undici !== "8.10.2")
  throw new Error("Unexpected upstream Undici dependency");
metadata.dependencies.undici = undici.version;
writeFileSync(packagePath, JSON.stringify(metadata, null, 2) + "\n");
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
console.log(
  "Repacked Pi 0.99.2: only package.json and npm-shrinkwrap.json metadata changed.",
);
