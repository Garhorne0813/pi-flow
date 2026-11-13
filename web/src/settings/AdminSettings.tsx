import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { useDirtyGuard } from "../admin/shared";
import type { Identity } from "./preferences";
interface Model {
  provider: string;
  modelId: string;
  baseUrl: string;
  secretRef: string;
  default: boolean;
}
interface Global {
  revision: number;
  modelCatalog: Model[];
  policy: { disabledTools: string[] };
}
interface Configuration {
  agentDefaults: Record<string, unknown>;
  defaultsRevision: number;
  deployment: unknown;
}
export function AdminSettings({
  identity,
}: {
  identity: Identity | undefined;
}) {
  if (!identity)
    return (
      <section className="settings">
        <h1>管理权限验证</h1>
        <p role="status">正在验证身份，暂不可访问全局配置。</p>
      </section>
    );
  if (!identity.admin)
    return (
      <section className="settings">
        <h1>无权访问</h1>
        <p role="alert">全局配置仅供管理员使用。</p>
      </section>
    );
  return <AuthorizedSettings />;
}
function AuthorizedSettings() {
  const [globalDirty, setGlobalDirty] = useState(false),
    [defaultsDirty, setDefaultsDirty] = useState(false);
  useDirtyGuard(globalDirty || defaultsDirty);
  const global = useQuery({
    queryKey: ["admin", "global"],
    queryFn: () => api<Global>("/admin/config/global"),
    retry: false,
  });
  const configuration = useQuery({
    queryKey: ["admin", "configuration"],
    queryFn: () => api<Configuration>("/admin/configuration"),
    retry: false,
  });
  if (
    (!global.data && global.error) ||
    (!configuration.data && configuration.error)
  )
    return (
      <section className="settings">
        <h1>无法读取全局配置</h1>
        <p role="alert">
          {global.error?.message || configuration.error?.message}
        </p>
        <button
          onClick={() => {
            void global.refetch();
            void configuration.refetch();
          }}
        >
          重试读取
        </button>
      </section>
    );
  return (
    <section className="settings settings-page">
      <h1>全局配置</h1>
      <p>
        这些配置影响平台上的所有用户。已提交的任务继续使用各自固定的配置快照。
      </p>
      {global.data ? (
        <GlobalForm data={global.data} onDirty={setGlobalDirty} />
      ) : (
        <p role="status">正在加载模型与策略…</p>
      )}
      {configuration.data ? (
        <DefaultsForm onDirty={setDefaultsDirty} data={configuration.data} />
      ) : (
        <p role="status">正在加载默认配置…</p>
      )}
    </section>
  );
}
const errorText = (e: unknown) =>
  e instanceof ApiError && e.status === 409
    ? "配置已被其他管理员更新。你的编辑仍保留，请重新加载最新配置后再修改。"
    : e instanceof Error
      ? e.message
      : "保存失败";
function GlobalForm({
  data,
  onDirty,
}: {
  data: Global;
  onDirty: (dirty: boolean) => void;
}) {
  const [base, setBase] = useState(data);
  const cache = useQueryClient(),
    [models, setModels] = useState(data.modelCatalog),
    [disabled, setDisabled] = useState(data.policy.disabledTools.join(", ")),
    [secrets, setSecrets] = useState<Record<string, string>>({}),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false);
  const dirty =
    JSON.stringify(models) !== JSON.stringify(base.modelCatalog) ||
    disabled !== base.policy.disabledTools.join(", ") ||
    Object.values(secrets).some(Boolean);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  function reset(fresh: Global) {
    setBase(fresh);
    setModels(fresh.modelCatalog);
    setDisabled(fresh.policy.disabledTools.join(", "));
    setSecrets({});
  }
  useEffect(() => {
    if (!dirty) reset(data);
  }, [data]);
  async function reload() {
    const fresh = await cache.fetchQuery({
      queryKey: ["admin", "global"],
      queryFn: () => api<Global>("/admin/config/global"),
      staleTime: 0,
    });
    reset(fresh);
  }
  function change(index: number, patch: Partial<Model>) {
    setModels((current) =>
      current.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    );
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFailed(false);
    setMessage("");
    try {
      const saved = await api<Global>("/admin/config/global", {
        revision: base.revision,
        modelCatalog: models,
        policy: {
          disabledTools: disabled
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        },
        ...(Object.values(secrets).some(Boolean)
          ? {
              secrets: Object.fromEntries(
                Object.entries(secrets).filter(
                  ([ref, value]) =>
                    ref && value && models.some((m) => m.secretRef === ref),
                ),
              ),
            }
          : {}),
      });
      reset(saved);
      cache.setQueryData(["admin", "global"], saved);
      try {
        await reload();
        setMessage("全局配置已保存");
      } catch {
        setFailed(true);
        setMessage(
          "全局配置已保存；重新读取失败，请单独重新加载。无需重复保存。",
        );
      }
    } catch (e) {
      setFailed(true);
      setMessage(errorText(e));
      setSecrets({});
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="settings-card" onSubmit={save}>
      <h2>模型与工具策略</h2>
      <p>当前配置版本：{base.revision}。模型密钥仅可写入，保存后不会回显。</p>
      {models.map((model, index) => (
        <fieldset key={index} disabled={saving}>
          <legend>模型 {index + 1}</legend>
          <label>
            提供商
            <input
              required
              value={model.provider}
              onChange={(e) => change(index, { provider: e.target.value })}
            />
          </label>
          <label>
            模型 ID
            <input
              required
              value={model.modelId}
              onChange={(e) => change(index, { modelId: e.target.value })}
            />
          </label>
          <label>
            API 地址
            <input
              required
              type="url"
              value={model.baseUrl}
              onChange={(e) => change(index, { baseUrl: e.target.value })}
            />
          </label>
          <label>
            密钥引用
            <input
              required
              value={model.secretRef}
              onChange={(e) => change(index, { secretRef: e.target.value })}
            />
          </label>
          <label>
            写入新密钥（留空保留现有值）
            <input
              type="password"
              autoComplete="new-password"
              value={secrets[model.secretRef] || ""}
              onChange={(e) =>
                setSecrets({ ...secrets, [model.secretRef]: e.target.value })
              }
            />
          </label>
          <label className="inline">
            <input
              type="radio"
              name="default-model"
              checked={model.default}
              onChange={() =>
                setModels(
                  models.map((m, i) => ({ ...m, default: i === index })),
                )
              }
            />{" "}
            默认模型
          </label>
          <button
            type="button"
            onClick={() => setModels(models.filter((_, i) => i !== index))}
          >
            移除此模型
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={saving}
        onClick={() =>
          setModels([
            ...models,
            {
              provider: "",
              modelId: "",
              baseUrl: "",
              secretRef: "",
              default: models.length === 0,
            },
          ])
        }
      >
        添加模型
      </button>
      <label>
        全局禁用工具（逗号分隔）
        <input
          value={disabled}
          disabled={saving}
          onChange={(e) => setDisabled(e.target.value)}
        />
      </label>
      <p>例如 bash, write。工具权限仍会经过后端策略校验。</p>
      <div className="settings-actions">
        <button
          disabled={
            saving ||
            (models.length > 0 && models.filter((m) => m.default).length !== 1)
          }
        >
          {saving ? "正在保存…" : "保存全局配置"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            if (confirm("重新加载会丢弃此表单未保存的修改，是否继续？"))
              void reload()
                .then(() => {
                  setFailed(false);
                  setMessage("配置已重新加载");
                })
                .catch((e) => {
                  setFailed(true);
                  setMessage(errorText(e));
                });
          }}
        >
          重新加载全局配置
        </button>
      </div>
      <p role={failed ? "alert" : "status"}>{message}</p>
    </form>
  );
}
function DefaultsForm({
  data,
  onDirty,
}: {
  data: Configuration;
  onDirty: (dirty: boolean) => void;
}) {
  const [base, setBase] = useState(data);
  const cache = useQueryClient(),
    [defaults, setDefaults] = useState(data.agentDefaults),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false);
  const dirty = JSON.stringify(defaults) !== JSON.stringify(base.agentDefaults);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  function reset(fresh: Configuration) {
    setBase(fresh);
    setDefaults(fresh.agentDefaults);
  }
  useEffect(() => {
    if (!dirty) reset(data);
  }, [data]);
  async function reload() {
    const fresh = await cache.fetchQuery({
      queryKey: ["admin", "configuration"],
      queryFn: () => api<Configuration>("/admin/configuration"),
      staleTime: 0,
    });
    reset(fresh);
  }
  const model = (defaults.model || {}) as {
    provider?: string;
    modelId?: string;
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage("");
    setFailed(false);
    try {
      const saved = await api<
        Pick<Configuration, "agentDefaults" | "defaultsRevision">
      >(
        "/admin/configuration/defaults",
        { ...defaults, expectedRevision: base.defaultsRevision },
        "PUT",
      );
      const fresh = { ...base, ...saved };
      reset(fresh);
      cache.setQueryData(["admin", "configuration"], fresh);
      try {
        await reload();
        setMessage("Agent 默认配置已保存");
      } catch {
        setFailed(true);
        setMessage(
          "Agent 默认配置已保存；重新读取失败，请单独重新加载。无需重复保存。",
        );
      }
    } catch (e) {
      setFailed(true);
      setMessage(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <form className="settings-card" onSubmit={save}>
        <h2>新建 Agent 的默认配置</h2>
        <p>
          只影响后续新建 Agent，不批量修改现有 Agent。版本：
          {base.defaultsRevision}
        </p>
        <fieldset disabled={saving}>
          <label>
            默认模型提供商
            <input
              required
              value={model.provider || ""}
              onChange={(e) =>
                setDefaults({
                  ...defaults,
                  model: { ...model, provider: e.target.value },
                })
              }
            />
          </label>
          <label>
            默认模型 ID
            <input
              required
              value={model.modelId || ""}
              onChange={(e) =>
                setDefaults({
                  ...defaults,
                  model: { ...model, modelId: e.target.value },
                })
              }
            />
          </label>
          <label>
            技能包
            <input
              required
              value={String(defaults.skillBundle || "")}
              onChange={(e) =>
                setDefaults({ ...defaults, skillBundle: e.target.value })
              }
            />
          </label>
          <label>
            默认工具（逗号分隔）
            <input
              value={
                Array.isArray(defaults.tools) ? defaults.tools.join(", ") : ""
              }
              onChange={(e) =>
                setDefaults({
                  ...defaults,
                  tools: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          {[
            ["maxSteps", "最大执行步数"],
            ["maxTokens", "最大 Token 数"],
            ["timeoutSeconds", "超时秒数"],
            ["maxSubagents", "最大子 Agent 数"],
            ["maxDepth", "最大子 Agent 深度"],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                required
                min={key === "maxDepth" || key === "maxSubagents" ? 0 : 1}
                step="1"
                value={Number(defaults[key] || 0)}
                onChange={(e) =>
                  setDefaults({ ...defaults, [key]: e.target.valueAsNumber })
                }
              />
            </label>
          ))}
        </fieldset>
        <div className="settings-actions">
          <button disabled={saving}>
            {saving ? "正在保存…" : "保存 Agent 默认配置"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (confirm("重新加载会丢弃未保存的 Agent 默认配置，是否继续？"))
                void reload()
                  .then(() => {
                    setFailed(false);
                    setMessage("配置已重新加载");
                  })
                  .catch((e) => {
                    setFailed(true);
                    setMessage(errorText(e));
                  });
            }}
          >
            重新加载 Agent 默认配置
          </button>
        </div>
        <p role={failed ? "alert" : "status"}>{message}</p>
      </form>
      <details className="settings-card">
        <summary>部署信息（只读）</summary>
        <p>部署配置修改需要在服务端完成，并重启服务。</p>
        <pre>{JSON.stringify(data.deployment, null, 2)}</pre>
      </details>
    </>
  );
}
