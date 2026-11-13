import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import {
  Choices,
  Feedback,
  toolNames,
  useDirtyGuard,
  useMutationAction,
  type Agent,
  type Snapshot,
  type Configuration,
  type Config,
  type Skill,
  type MCP,
} from "./shared";
const input = (a: Agent) => ({
  key: a.id,
  config: a.config,
  enabled: a.enabled,
  allowedUsers: a.allowedUsers || [],
});
export function AgentManager({
  snapshot,
  skills,
  mcps,
  configuration,
  skillsUnavailable = false,
  mcpsUnavailable = false,
}: {
  snapshot: Snapshot;
  skills: Skill[];
  mcps: MCP[];
  configuration: Configuration;
  skillsUnavailable?: boolean;
  mcpsUnavailable?: boolean;
}) {
  const cache = useQueryClient(),
    action = useMutationAction(),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<string | undefined>(
      () => new URLSearchParams(location.search).get("agent") || undefined,
    ),
    [draft, setDraft] = useState<Agent | null>(null),
    [base, setBase] = useState(""),
    [expected, setExpected] = useState(snapshot.revision),
    [review, setReview] = useState(false),
    [accessMode, setAccessMode] = useState("all"),
    [users, setUsers] = useState(""),
    [definitions, setDefinitions] = useState("{}"),
    [validation, setValidation] = useState("");
  const dirty =
    (!!draft && JSON.stringify(draft) !== base) ||
    (!!draft &&
      (accessMode !==
        ((draft.allowedUsers || []).length ? "restricted" : "all") ||
        users !== (draft.allowedUsers || []).join("\n") ||
        definitions !==
          JSON.stringify(draft.config.subagentDefinitions || {}, null, 2)));
  useDirtyGuard(dirty);
  function open(a: Agent) {
    if (action.busy || (dirty && !confirm("放弃未保存的 Agent 修改？"))) return;
    setSelected(a.id);
    setDraft(structuredClone(a));
    setBase(JSON.stringify(a));
    setExpected(snapshot.revision);
    setUsers((a.allowedUsers || []).join("\n"));
    setAccessMode(a.allowedUsers?.length ? "restricted" : "all");
    setDefinitions(JSON.stringify(a.config.subagentDefinitions || {}, null, 2));
    setReview(false);
    setValidation("");
  }
  function create() {
    open({
      id: "agent_" + crypto.randomUUID().replaceAll("-", ""),
      config: {
        name: "新 Agent",
        systemPrompt: "",
        agentsMd: [],
        model: { provider: "demo", modelId: "demo" },
        tools: [],
        skills: [],
        mcpServers: [],
        subagents: [],
        skillBundle: "default",
        maxSteps: 30,
        maxTokens: 100000,
        timeoutSeconds: 600,
        maxSubagents: 2,
        maxDepth: 1,
        ...configuration.agentDefaults,
      },
      enabled: true,
      allowedUsers: [],
    });
  }
  const chosen = snapshot.items.find((a) => a.id === selected);
  function config(patch: Partial<Config>) {
    if (draft) {
      setDraft({ ...draft, config: { ...draft.config, ...patch } });
      setReview(false);
    }
  }
  async function save() {
    if (!draft) return;
    await action.act(async () => {
      let subagentDefinitions: unknown;
      try {
        subagentDefinitions = JSON.parse(definitions);
      } catch {
        throw new Error("子 Agent 内联配置必须是有效 JSON 对象");
      }
      if (
        !subagentDefinitions ||
        typeof subagentDefinitions !== "object" ||
        Array.isArray(subagentDefinitions)
      )
        throw new Error("子 Agent 内联配置必须是 JSON 对象");
      const allowedUsers =
        accessMode === "all"
          ? []
          : [
              ...new Set(
                users
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              ),
            ];
      if (accessMode === "restricted" && !allowedUsers.length)
        throw new Error(
          "指定用户模式至少需要一个用户 ID；拒绝所有访问请禁用 Agent。",
        );
      if (
        chosen?.allowedUsers?.length &&
        (!allowedUsers.length ||
          allowedUsers.some((id) => !chosen.allowedUsers!.includes(id))) &&
        !confirm("此操作将扩大 Agent 的访问范围，确认继续？")
      )
        return;
      const edited = {
          ...draft,
          allowedUsers,
          config: {
            ...draft.config,
            ...(Object.keys(subagentDefinitions).length ||
            draft.config.subagentDefinitions
              ? { subagentDefinitions }
              : {}),
          },
        },
        agents = snapshot.items.map(input),
        index = agents.findIndex((a) => a.key === edited.id);
      if (index < 0) agents.push(input(edited));
      else agents[index] = input(edited);
      await api("/admin/config/agents", { revision: expected, agents });
      setDraft(null);
      setReview(false);
      await cache.invalidateQueries({ queryKey: ["admin", "agents"] });
      await cache.invalidateQueries({ queryKey: ["agents"] });
    });
  }
  // Selecting a list item is explicit: background refetch must never overwrite a draft.
  return (
    <>
      <div className="settings-actions">
        <button disabled={action.busy} onClick={create}>
          新建 Agent
        </button>
        <button
          disabled={action.busy}
          onClick={() => {
            if (dirty && !confirm("重新加载会放弃未保存的修改，确认继续？"))
              return;
            setDraft(null);
            void cache.invalidateQueries({ queryKey: ["admin", "agents"] });
          }}
        >
          重新加载 Agent 列表
        </button>
      </div>
      <Feedback action={action} />
      <label>
        搜索 Agent
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <div className="agent-layout">
        <nav aria-label="Agent 列表">
          {snapshot.items
            .filter((a) =>
              (a.id + " " + a.config.name)
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((a) => (
              <button
                key={a.id}
                aria-pressed={selected === a.id}
                onClick={() => open(a)}
              >
                {a.config.name} · {a.enabled ? "启用" : "禁用"}
                <small>{a.id}</small>
              </button>
            ))}
        </nav>
        <div>
          {!draft ? (
            <section className="settings-card">
              <h2>{chosen?.config.name || "选择或新建 Agent"}</h2>
              {chosen && (
                <>
                  <p>
                    {chosen.enabled ? "已启用" : "已禁用"} · {chosen.id}
                  </p>
                  <button onClick={() => open(chosen)}>编辑 Agent</button>
                  <pre>{JSON.stringify(chosen.config, null, 2)}</pre>
                </>
              )}
            </section>
          ) : (
            <form
              className="settings-card"
              onSubmit={(e) => {
                e.preventDefault();
                setValidation("");
                if (accessMode === "restricted" && !users.trim()) {
                  setValidation("指定用户模式至少需要一个用户 ID");
                  return;
                }
                setReview(true);
              }}
            >
              <h2>编辑 Agent</h2>
              <p>
                保存基于版本 {expected}，当前服务器版本 {snapshot.revision}
                。正在运行的任务继续使用原配置快照。
              </p>
              <fieldset disabled={action.busy}>
                <legend>身份与指令</legend>
                <label>
                  Agent ID
                  <input
                    required
                    pattern="[a-z][a-z0-9_\-]{0,63}"
                    value={draft.id}
                    disabled={snapshot.items.some((a) => a.id === draft.id)}
                    onChange={(e) => {
                      setDraft({ ...draft, id: e.target.value });
                      setReview(false);
                    }}
                  />
                </label>
                <label>
                  Agent 名称
                  <input
                    required
                    maxLength={100}
                    value={draft.config.name}
                    onChange={(e) => config({ name: e.target.value })}
                  />
                </label>
                <label>
                  System Prompt
                  <textarea
                    maxLength={32000}
                    rows={7}
                    aria-label="System Prompt"
                    value={draft.config.systemPrompt}
                    onChange={(e) => config({ systemPrompt: e.target.value })}
                  />
                </label>
                {draft.config.agentsMd.map((text, index) => (
                  <div key={index}>
                    <label>
                      AGENTS.md 指令 {index + 1}
                      <textarea
                        rows={4}
                        maxLength={32000}
                        value={text}
                        onChange={(e) =>
                          config({
                            agentsMd: draft.config.agentsMd.map((v, i) =>
                              i === index ? e.target.value : v,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        config({
                          agentsMd: draft.config.agentsMd.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      移除指令 {index + 1}
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    config({ agentsMd: [...draft.config.agentsMd, ""] })
                  }
                >
                  添加指令条目
                </button>
              </fieldset>
              <fieldset disabled={action.busy}>
                <legend>模型与能力</legend>
                <label>
                  Provider
                  <input
                    required
                    list="agent-providers"
                    value={draft.config.model.provider}
                    onChange={(e) =>
                      config({
                        model: {
                          ...draft.config.model,
                          provider: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <datalist id="agent-providers">
                  {configuration.deployment.models.map((m) => (
                    <option
                      key={m.provider + "/" + m.modelId}
                      value={m.provider}
                    />
                  ))}
                </datalist>
                <label>
                  Model ID
                  <input
                    required
                    value={draft.config.model.modelId}
                    onChange={(e) =>
                      config({
                        model: {
                          ...draft.config.model,
                          modelId: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Skill Bundle
                  <input
                    required
                    list="agent-bundles"
                    value={draft.config.skillBundle}
                    onChange={(e) => config({ skillBundle: e.target.value })}
                  />
                </label>
                <datalist id="agent-bundles">
                  {configuration.deployment.bundles.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
                <Choices
                  label="工具权限"
                  values={draft.config.tools}
                  options={toolNames.map((id) => ({ id }))}
                  onChange={(tools) => config({ tools })}
                />
                <Choices
                  label="绑定 Skills"
                  disabled={skillsUnavailable}
                  values={draft.config.skills}
                  options={skills}
                  onChange={(skills) => config({ skills })}
                />
                <Choices
                  label="绑定 MCP Servers"
                  disabled={mcpsUnavailable}
                  values={draft.config.mcpServers}
                  options={mcps}
                  onChange={(mcpServers) => config({ mcpServers })}
                />
              </fieldset>
              <fieldset disabled={action.busy}>
                <legend>子 Agent 与执行限制</legend>
                <Choices
                  label="委派目标"
                  values={draft.config.subagents}
                  options={snapshot.items
                    .filter((a) => a.id !== draft.id)
                    .map((a) => ({
                      id: a.id,
                      name: a.config.name,
                      enabled: a.enabled,
                    }))}
                  onChange={(subagents) => config({ subagents })}
                />
                <details>
                  <summary>内联子 Agent 配置（JSON）</summary>
                  <label>
                    subagentDefinitions
                    <textarea
                      rows={6}
                      value={definitions}
                      onChange={(e) => {
                        setDefinitions(e.target.value);
                        setReview(false);
                      }}
                    />
                  </label>
                </details>
                {[
                  ["maxSteps", "最大步骤", 1, 100],
                  ["maxTokens", "Token 预算", 100, 1000000],
                  ["timeoutSeconds", "超时（秒）", 1, 1800],
                  ["maxSubagents", "子 Agent 上限", 0, 5],
                  ["maxDepth", "最大委派深度", 0, 3],
                ].map(([key, label, min, max]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      required
                      min={Number(min)}
                      max={Number(max)}
                      step="1"
                      value={Number(draft.config[String(key)])}
                      onChange={(e) =>
                        config({ [key]: e.target.valueAsNumber })
                      }
                    />
                  </label>
                ))}
              </fieldset>
              <fieldset disabled={action.busy}>
                <legend>状态与访问</legend>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => {
                      setDraft({ ...draft, enabled: e.target.checked });
                      setReview(false);
                    }}
                  />
                  启用 Agent
                </label>
                <label>
                  访问范围
                  <select
                    value={accessMode}
                    onChange={(e) => {
                      setAccessMode(e.target.value);
                      setReview(false);
                    }}
                  >
                    <option value="all">所有平台用户</option>
                    <option value="restricted">仅指定用户</option>
                  </select>
                </label>
                <label>
                  允许访问的用户 ID（每行一个）
                  <textarea
                    rows={4}
                    disabled={accessMode === "all"}
                    value={users}
                    onChange={(e) => {
                      setUsers(e.target.value);
                      setReview(false);
                    }}
                  />
                </label>
              </fieldset>
              <p role="alert">{validation}</p>
              {review && (
                <section className="review">
                  <h3>保存前检查</h3>
                  <p>
                    {draft.config.name} · {draft.enabled ? "启用" : "禁用"} ·{" "}
                    {accessMode === "all"
                      ? "所有平台用户可用"
                      : "仅指定用户可用"}
                  </p>
                  <pre aria-label="Agent 配置预览">
                    {JSON.stringify(
                      {
                        ...draft.config,
                        subagentDefinitions: definitions,
                        allowedUsers:
                          accessMode === "all" ? [] : users.split("\n"),
                      },
                      null,
                      2,
                    )}
                  </pre>
                  <button
                    type="button"
                    disabled={action.busy}
                    onClick={() => void save()}
                  >
                    确认保存 Agent
                  </button>
                </section>
              )}
              <button disabled={action.busy}>检查并保存</button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
