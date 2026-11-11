import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const lock = JSON.parse(
  readFileSync(new URL("../web/package-lock.json", import.meta.url), "utf8"),
);
for (const name of Object.keys(lock.packages))
  if (
    /node_modules\/(?:@deepseek-ai\/(?:dsh-agent|cordis)|@zcode\/rpc)(?:\/|$)/.test(
      name,
    )
  )
    throw new Error("Forbidden chat protocol dependency: " + name);
console.log("Chat dependency boundary verified");

const provenance = JSON.parse(
  readFileSync(
    new URL("../web/third-party/dsh/provenance.json", import.meta.url),
    "utf8",
  ),
);
for (const file of provenance.files) {
  const bytes = readFileSync(
    new URL("../web/third-party/dsh/" + file.file, import.meta.url),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== file.upstreamSha256)
    throw new Error("Vendored UI differs from documented source: " + file.file);
}
console.log(
  "DSH presentation provenance verified: " + provenance.files.length + " files",
);
