import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, request } from "../api/client";
import {
  Feedback,
  useMutationAction,
  type Skill,
  type MCP,
  type Configuration,
} from "./shared";
export function SkillManager({
  skills,
  configuration,
}: {
  skills: Skill[];
  configuration: Configuration;
}) {
  const cache = useQueryClient(),
    action = useMutationAction(),
    [file, setFile] = useState<File | null>(null),
    [fileError, setFileError] = useState(""),
    fileInput = useRef<HTMLInputElement>(null),
    upload = configuration.skillUploads;
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types || []).includes("Files"))
        e.preventDefault();
    };
    document.addEventListener("dragover", stop);
    document.addEventListener("drop", stop);
    return () => {
      document.removeEventListener("dragover", stop);
      document.removeEventListener("drop", stop);
    };
  }, []);
  function choose(files: File[]) {
    if (!upload.enabled || action.busy) return;
    if (
      files.length !== 1 ||
      !files[0].name.toLowerCase().endsWith(".zip") ||
      files[0].size > upload.maxArchiveBytes
    ) {
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setFileError("请选择一个未超过大小限制的 ZIP 文件。");
      return;
    }
    setFile(files[0]);
    setFileError("");
  }
  async function submit(e: React.FormEvent<HTMLFormElement>, zip: boolean) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    await action.act(async () => {
      if (zip) {
        if (!upload.enabled || !file) throw new Error("请选择 Skill ZIP 包");
        data.set("archive", file);
        await request("/admin/skills/upload", { method: "POST", body: data });
      } else await api("/admin/skills", Object.fromEntries(data));
      form.reset();
      setFile(null);
      await cache.invalidateQueries({ queryKey: ["admin", "console"] });
    });
  }
  const fields = (
    <>
      <label>
        版本 ID
        <input
          name="id"
          required
          pattern="[a-zA-Z0-9_\-]+@[a-zA-Z0-9_\-]+"
          placeholder="review@v1"
        />
      </label>
      <label>
        Skill 名称
        <input name="name" required maxLength={100} />
      </label>
      <label>
        描述
        <textarea name="description" maxLength={2000} />
      </label>
      <label>
        Bundle
        <select name="bundle" aria-label="Bundle" required>
          {configuration.deployment.bundles.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
    </>
  );
  return (
    <>
      <h2>Skills</h2>
      <Feedback action={action} />
      <p>
        Skill 版本不可变；更新内容请使用新的版本 ID。停用不会删除已部署的文件。
      </p>
      <div className="admin-resource-grid">
        {skills.map((s) => (
          <article className="settings-card" key={s.id}>
            <h3>
              {s.name} · {s.enabled ? "启用" : "禁用"}
            </h3>
            <p>{s.id}</p>
            <p>{s.description}</p>
            <dl>
              <dt>Bundle</dt>
              <dd>{s.bundle}</dd>
              <dt>路径</dt>
              <dd>{s.path}</dd>
              <dt>SHA-256</dt>
              <dd>{s.digest}</dd>
            </dl>
            <button
              disabled={action.busy}
              onClick={() => {
                if (confirm(`确认${s.enabled ? "禁用" : "启用"} ${s.id}？`))
                  void action.act(async () => {
                    await api(
                      "/admin/skills/" + encodeURIComponent(s.id) + "/status",
                      { enabled: !s.enabled },
                      "PUT",
                    );
                    await cache.invalidateQueries({
                      queryKey: ["admin", "console"],
                    });
                  });
              }}
            >
              {s.enabled ? "禁用" : "启用"} {s.id}
            </button>
          </article>
        ))}
      </div>
      <form className="settings-card" onSubmit={(e) => void submit(e, true)}>
        <h3>上传 Skill ZIP</h3>
        <p>
          {upload.enabled
            ? `ZIP 上限 ${upload.maxArchiveBytes} 字节，解压后 ${upload.maxExpandedBytes} 字节，最多 ${upload.maxFiles} 个文件。`
            : "服务端未配置上传存储；仍可登记已有部署版本。"}
        </p>
        <fieldset disabled={!upload.enabled || action.busy}>
          {fields}
          <div
            className="zip-dropzone"
            role="group"
            aria-label="Skill ZIP 拖拽上传区"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (
                Array.from(e.dataTransfer.items).some(
                  (i) => i.webkitGetAsEntry?.()?.isDirectory,
                )
              ) {
                setFile(null);
                setFileError("不支持文件夹，请先打包为 ZIP。");
                return;
              }
              choose(Array.from(e.dataTransfer.files));
            }}
          >
            <label>
              Skill ZIP 包
              <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => choose(Array.from(e.target.files || []))}
              />
            </label>
            <p>
              {file ? "已选择：" + file.name : "拖入单个 ZIP，或点击选择文件。"}
            </p>
          </div>
          <p role="alert">{fileError}</p>
          <button disabled={!file}>上传并登记版本</button>
        </fieldset>
      </form>
      <details className="settings-card">
        <summary>登记已有部署版本</summary>
        <form onSubmit={(e) => void submit(e, false)}>
          <fieldset disabled={action.busy}>
            {fields}
            <label>
              Skill 文件路径
              <input
                name="path"
                required
                pattern="/skills/([a-zA-Z0-9_\-]+/)+SKILL[.]md"
                placeholder="/skills/review/SKILL.md"
              />
            </label>
            <label>
              SHA-256 摘要
              <input
                name="digest"
                required
                pattern="[a-f0-9]{64}"
                minLength={64}
                maxLength={64}
              />
            </label>
            <button>登记版本</button>
          </fieldset>
        </form>
      </details>
    </>
  );
}
export function MCPManager({
  mcps,
  configuration,
}: {
  mcps: MCP[];
  configuration: Configuration;
}) {
  const cache = useQueryClient(),
    action = useMutationAction(),
    [result, setResult] = useState("");
  return (
    <>
      <h2>MCP Servers</h2>
      <Feedback action={action} />
      <p role="status">{result}</p>
      {mcps.map((m) => (
        <article className="settings-card" key={m.id}>
          <h3>
            {m.id} · {m.enabled ? "启用" : "禁用"}
          </h3>
          <p>Endpoint：{m.endpointRef}</p>
          <p>允许工具：{m.allowedTools.join(", ") || "无"}</p>
          <div className="settings-actions">
            <button
              disabled={action.busy}
              onClick={() => {
                if (confirm(`确认${m.enabled ? "禁用" : "启用"} ${m.id}？`))
                  void action.act(async () => {
                    await api(
                      "/admin/mcp-servers/" +
                        encodeURIComponent(m.id) +
                        "/status",
                      { enabled: !m.enabled },
                      "PUT",
                    );
                    await cache.invalidateQueries({
                      queryKey: ["admin", "console"],
                    });
                  });
              }}
            >
              {m.enabled ? "禁用" : "启用"} {m.id}
            </button>
            <button
              disabled={action.busy || !m.enabled}
              onClick={() =>
                void action.act(async () => {
                  setResult("");
                  const check = await api<{
                    tools: { name: string; description: string }[];
                  }>(
                    "/admin/mcp-servers/" + encodeURIComponent(m.id) + "/check",
                    {},
                  );
                  setResult(
                    m.id +
                      " 连接正常，白名单工具：" +
                      (check.tools.map((t) => t.name).join(", ") ||
                        "无匹配工具"),
                  );
                })
              }
            >
              检查连接 {m.id}
            </button>
          </div>
        </article>
      ))}
      <form
        className="settings-card"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget,
            data = new FormData(form);
          void action.act(async () => {
            await api("/admin/mcp-servers", {
              id: data.get("id"),
              endpointRef: data.get("endpointRef"),
              allowedTools: String(data.get("tools"))
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            });
            form.reset();
            await cache.invalidateQueries({ queryKey: ["admin", "console"] });
          });
        }}
      >
        <h3>登记 MCP Server</h3>
        <fieldset disabled={action.busy}>
          <label>
            Server ID
            <input
              name="id"
              required
              maxLength={20}
              pattern="[a-zA-Z0-9_\-]{1,20}"
            />
          </label>
          <label>
            Endpoint
            <select name="endpointRef" aria-label="Endpoint" required>
              {configuration.deployment.endpoints.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label>
            允许工具（逗号分隔）
            <input name="tools" />
          </label>
          <p>Endpoint 与凭证在部署端配置；连接检查只发现工具，不执行工具。</p>
          <button disabled={!configuration.deployment.endpoints.length}>
            登记 MCP Server
          </button>
        </fieldset>
      </form>
    </>
  );
}
