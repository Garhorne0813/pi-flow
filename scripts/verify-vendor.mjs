import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = resolve(process.env.VENDOR_VERIFY_ROOT ?? ".");
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const digest = (file, algorithm = "sha512") =>
  createHash(algorithm).update(readFileSync(file)).digest("base64");
const manifest = json("vendor/provenance.json"),
  lock = json("package-lock.json");
for (const p of manifest.packages) {
  const file = join(root, p.archive),
    entry = lock.packages["node_modules/" + p.name];
  if (
    "sha512-" + digest(file) !== p.integrity ||
    entry.integrity !== p.integrity ||
    entry.version !== p.version
  )
    throw new Error("Vendor integrity/version mismatch: " + p.name);
  const installed = json("node_modules/" + p.name + "/package.json");
  if (installed.version !== p.version || installed.license !== p.license)
    throw new Error("Installed vendor metadata mismatch: " + p.name);
}
const brace = json(
  "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json",
);
if (brace.version !== "5.0.12")
  throw new Error("Installed brace-expansion must be 5.0.12");
const fixed = json("vendor/brace-fixed-dist.json");
const shrink = json(
  "node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json",
);
const entry = shrink.packages["node_modules/brace-expansion"];
if (
  entry.version !== brace.version ||
  entry.integrity !== fixed.dist.integrity ||
  entry.resolved !== fixed.dist.tarball
)
  throw new Error("Installed shrinkwrap mismatch");
mkdirSync(join(root, "work"), { recursive: true });
const temp = mkdtempSync(join(root, "work/vendor-verify-"));
const unpack = (file, name) => {
  const dir = join(temp, name);
  mkdirSync(dir);
  execFileSync("tar", ["-xzf", file, "-C", dir]);
  return join(dir, "package");
};
const files = (dir) =>
  readdirSync(dir)
    .flatMap((n) =>
      statSync(join(dir, n)).isDirectory()
        ? files(join(dir, n)).map((f) => n + "/" + f)
        : [n],
    )
    .sort();
const compare = (a, b, exclude = []) => {
  const af = files(a).filter((f) => !exclude.includes(f)),
    bf = files(b).filter((f) => !exclude.includes(f));
  if (JSON.stringify(af) !== JSON.stringify(bf))
    throw new Error("Package file set differs");
  for (const f of af)
    if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f))))
      throw new Error("Undocumented package difference: " + f);
};
if (process.argv.includes("--upstream")) {
  const original = json("vendor/pi-original-dist.json"),
    pi = join(temp, "pi.tgz");
  execFileSync("curl", ["-fsSL", original.tarball, "-o", pi]);
  if ("sha512-" + digest(pi) !== original.integrity)
    throw new Error("Upstream Pi integrity mismatch");
  const a = unpack(pi, "pi-original"),
    b = unpack(join(root, manifest.packages[1].archive), "pi-vendor");
  compare(a, b, ["npm-shrinkwrap.json"]);
  const expected = JSON.parse(readFileSync(join(a, "npm-shrinkwrap.json")));
  Object.assign(expected.packages["node_modules/brace-expansion"], {
    version: "5.0.12",
    resolved: fixed.dist.tarball,
    integrity: fixed.dist.integrity,
    dependencies: fixed.dependencies,
    engines: fixed.engines,
  });
  if (
    JSON.stringify(expected) !==
    JSON.stringify(JSON.parse(readFileSync(join(b, "npm-shrinkwrap.json"))))
  )
    throw new Error("Undocumented shrinkwrap difference");
  const source = join(temp, "cube-source.tgz");
  execFileSync("curl", ["-fsSL", manifest.cubeSource.url, "-o", source]);
  if ("sha512-" + digest(source) !== manifest.cubeSource.integrity)
    throw new Error("Cube source integrity mismatch");
  execFileSync("tar", ["-xzf", source, "-C", temp]);
  const cwd = join(
    temp,
    "CubeSandbox-" + manifest.cubeSource.commit,
    "sdk/node",
  );
  execFileSync("npm", ["ci", "--ignore-scripts"], { cwd, stdio: "pipe" });
  execFileSync("npm", ["run", "build"], { cwd, stdio: "pipe" });
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
      cwd,
      encoding: "utf8",
    }),
  )[0];
  compare(
    unpack(join(cwd, packed.filename), "cube-rebuild"),
    unpack(join(root, manifest.packages[0].archive), "cube-vendor"),
  );
}
const components = [];
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || !p.version) continue;
  const installedPath = join(root, path, "package.json");
  let installed;
  try {
    installed = JSON.parse(readFileSync(installedPath));
  } catch {
    if (!p.optional) throw new Error("Missing installed dependency: " + path);
    continue;
  }
  if (installed.version !== p.version)
    throw new Error("Installed dependency version mismatch: " + path);
  components.push({
    type: "library",
    name: installed.name,
    version: installed.version,
    "bom-ref": path,
    licenses: [{ license: { name: installed.license ?? "UNKNOWN" } }],
    properties: [
      { name: "npm:path", value: path },
      { name: "npm:integrity", value: p.integrity ?? "local" },
    ],
  });
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
writeFileSync(
  join(root, "work/sbom.cdx.json"),
  JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        properties: [{ name: "git:commit", value: commit }],
      },
      components,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    status: "verified",
    upstream: process.argv.includes("--upstream"),
    components: components.length,
    commit,
    sbom: "work/sbom.cdx.json",
  }),
);
