import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
export interface Config {
  name: string;
  systemPrompt: string;
  agentsMd: string[];
  model: { provider: string; modelId: string };
  tools: string[];
  skills: string[];
  mcpServers: string[];
  subagents: string[];
  skillBundle: string;
  maxSteps: number;
  maxTokens: number;
  timeoutSeconds: number;
  maxSubagents: number;
  maxDepth: number;
  [key: string]: unknown;
}
export interface Agent {
  id: string;
  config: Config;
  enabled: boolean;
  allowedUsers?: string[];
  updatedAt?: string;
}
export interface Snapshot {
  revision: number;
  items: Agent[];
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  bundle: string;
  path: string;
  digest: string;
  enabled: boolean;
}
export interface MCP {
  id: string;
  endpointRef: string;
  allowedTools: string[];
  enabled: boolean;
}
export interface Configuration {
  agentMode: string;
  agentDefaults: Partial<Config>;
  skillUploads: {
    enabled: boolean;
    maxArchiveBytes: number;
    maxExpandedBytes: number;
    maxFiles: number;
  };
  deployment: {
    bundles: string[];
    endpoints: string[];
    models: { provider: string; modelId: string }[];
    [key: string]: unknown;
  };
}
export const toolNames = [
  "read",
  "write",
  "edit",
  "bash",
  "ls",
  "grep",
  "find",
  "todo",
  "ask_user_question",
  "delegate_to_agent",
  "web_search",
  "web_fetch",
];
export async function allPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await api<{ items: T[] }>(
      `${path}?offset=${offset}&limit=100`,
    );
    items.push(...page.items);
    if (page.items.length < 100) return items;
  }
}
export function useMutationAction() {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(false),
    lock = useRef(false);
  return {
    busy,
    message,
    error,
    async act(fn: () => Promise<void>) {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      setMessage("");
      setError(false);
      try {
        await fn();
        setMessage("操作成功");
      } catch (e) {
        setError(true);
        setMessage(
          e instanceof ApiError && e.status === 409
            ? "服务器记录已更新或此版本已登记。你的输入已保留，请刷新核对后再提交。"
            : e instanceof Error
              ? e.message
              : "请求失败",
        );
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
  };
}
export function Feedback({
  action,
}: {
  action: ReturnType<typeof useMutationAction>;
}) {
  return (
    <p role={action.error ? "alert" : "status"}>
      {action.busy ? "正在提交…" : action.message}
    </p>
  );
}
export function Choices({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: { id: string; name?: string; enabled?: boolean }[];
  onChange: (v: string[]) => void;
}) {
  const list = [
    ...options,
    ...values
      .filter((v) => !options.some((o) => o.id === v))
      .map((id) => ({ id, name: id + "（当前未登记）", enabled: undefined })),
  ];
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="admin-choices">
        {list.map((o) => (
          <label className="inline" key={o.id}>
            <input
              type="checkbox"
              checked={values.includes(o.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...values, o.id]
                    : values.filter((v) => v !== o.id),
                )
              }
            />
            {o.name || o.id}
            {o.enabled === false ? "（已禁用）" : ""}
          </label>
        ))}
      </div>
      {!list.length && <p>暂无可选条目</p>}
    </fieldset>
  );
}
export function useDirtyGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const click = (e: MouseEvent) => {
      const anchor = (e.target as Element)?.closest?.("a");
      if (
        anchor &&
        anchor.origin === location.origin &&
        anchor.pathname !== location.pathname &&
        !confirm("有未保存的修改，确认离开？")
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}
