import {
  lstat,
  readFile,
  readdir,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { Skill } from "../domain/model.js";
export function frontmatter(source: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!m) return { metadata: {}, body: source };
  const doc = parseDocument(m[1]!, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  return {
    metadata: z
      .record(z.string(), z.unknown())
      .parse(doc.toJS({ maxAliasCount: 0 })),
    body: source.slice(m[0].length),
  };
}
export async function readSkillTree(root: string): Promise<Skill[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const result: Skill[] = [];
  for (const dir of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dir.isDirectory() || !/^[a-z][a-z0-9_-]{0,63}$/.test(dir.name))
      throw new Error("Invalid skill directory");
    const files: Record<string, string> = {};
    let bytes = 0;
    const walk = async (path: string, relative = "") => {
      for (const e of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const local = join(path, e.name),
          key = relative ? `${relative}/${e.name}` : e.name;
        if (e.isSymbolicLink())
          throw new Error("Skill symlinks are not allowed");
        if (e.isDirectory()) {
          await walk(local, key);
          continue;
        }
        if (!e.isFile()) throw new Error("Invalid skill file");
        const content = await readFile(local);
        bytes += content.length;
        if (bytes > 8 * 1024 * 1024 || Object.keys(files).length >= 1000)
          throw new Error("Skill archive limit");
        files[key] = content.toString("base64");
      }
    };
    await walk(join(root, dir.name));
    if (!files["SKILL.md"]) throw new Error(`Missing SKILL.md: ${dir.name}`);
    const source = Buffer.from(files["SKILL.md"], "base64").toString("utf8"),
      { metadata } = frontmatter(source);
    const name = z
        .string()
        .min(1)
        .parse(metadata.name ?? dir.name),
      description = z.string().min(1).parse(metadata.description);
    const hash = createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex"),
      md = createHash("sha256").update(source).digest("hex");
    const subagentDefinitions: Record<string, unknown> = {};
    for (const [path, content] of Object.entries(files)) {
      const m = /^agents\/([a-zA-Z0-9_-]+)\.md$/.exec(path);
      if (m) {
        const parsed = frontmatter(
          Buffer.from(content, "base64").toString("utf8"),
        );
        subagentDefinitions[m[1]!] = {
          ...parsed.metadata,
          systemPrompt: parsed.body,
        };
      }
    }
    result.push({
      id: dir.name,
      name,
      description,
      bundle: "default",
      path: `/skills/${dir.name}/${hash}/SKILL.md`,
      digest: md,
      versionDigest: hash,
      files,
      enabled: true,
      disableModelInvocation: metadata["disable-model-invocation"] === true,
      subagentDefinitions,
    });
  }
  return result;
}
export async function materializeSkills(skills: Skill[], root: string) {
  await mkdir(root, { recursive: true });
  for (const skill of skills) {
    if (!skill.files || !skill.versionDigest) continue;
    const parent = join(root, skill.id);
    await mkdir(parent, { recursive: true });
    const target = join(parent, skill.versionDigest),
      temporary = join(parent, `.tmp-${randomUUID()}`);
    const verify = async () => {
      const dir = await lstat(target);
      if (!dir.isDirectory() || dir.isSymbolicLink())
        throw new Error("Invalid delivered Skill directory");
      for (const [path, content] of Object.entries(skill.files!)) {
        let current = target;
        for (const part of path.split("/")) {
          current = join(current, part);
          if ((await lstat(current)).isSymbolicLink())
            throw new Error("Delivered Skill symlink");
        }
        if ((await readFile(current)).toString("base64") !== content)
          throw new Error("Delivered Skill digest mismatch");
      }
    };
    try {
      await lstat(target);
      await verify();
      continue;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await mkdir(temporary);
    try {
      for (const [path, content] of Object.entries(skill.files)) {
        if (
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").includes("..")
        )
          throw new Error("Invalid archive path");
        const parts = path.split("/");
        await mkdir(join(temporary, ...parts.slice(0, -1)), {
          recursive: true,
        });
        await writeFile(join(temporary, path), Buffer.from(content, "base64"), {
          mode: 0o444,
        });
      }
      await writeFile(
        join(temporary, ".pa-skill.json"),
        JSON.stringify({ acceptedDigest: skill.versionDigest }),
        { mode: 0o444 },
      );
      try {
        await rename(temporary, target);
      } catch (e) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (e as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw e;
        await verify();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
