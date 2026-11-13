import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Identity } from "../settings/preferences";
import {
  allPages,
  type Configuration,
  type Snapshot,
  type Skill,
  type MCP,
} from "./shared";
import { AgentManager } from "./AgentManager";
import { SkillManager, MCPManager } from "./Registries";
export function AdminConsole({
  identity,
  path,
}: {
  identity: Identity | undefined;
  path: string;
}) {
  if (!identity)
    return (
      <section className="settings">
        <h1>验证管理权限</h1>
        <p>确认身份后才能访问管理功能。</p>
      </section>
    );
  if (!identity.admin)
    return (
      <section className="settings">
        <h1>无权访问</h1>
        <p role="alert">此页面仅供管理员使用。</p>
      </section>
    );
  return <ConsoleContent path={path} />;
}
function ConsoleContent({ path }: { path: string }) {
  const agentPage = path === "/admin/agents";
  const skillsPage = path === "/admin/skills";
  const mcpPage = path === "/admin/mcp";
  const snapshot = useQuery({
    queryKey: ["admin", "agents"],
    queryFn: () => api<Snapshot>("/admin/config/agents"),
    enabled: agentPage || path === "/admin/delegation",
    retry: false,
  });
  const skills = useQuery({
    queryKey: ["admin", "skills"],
    queryFn: () => allPages<Skill>("/admin/skills"),
    enabled: agentPage || skillsPage,
    retry: false,
  });
  const mcps = useQuery({
    queryKey: ["admin", "mcps"],
    queryFn: () =>
      api<{ items: MCP[] }>("/admin/mcp-servers").then((r) => r.items),
    enabled: agentPage || mcpPage,
    retry: false,
  });
  const configuration = useQuery({
    queryKey: ["admin", "configuration"],
    queryFn: () => api<Configuration>("/admin/configuration"),
    enabled: agentPage || skillsPage || mcpPage,
    retry: false,
  });
  const required = agentPage
    ? [snapshot, configuration]
    : skillsPage
      ? [skills, configuration]
      : mcpPage
        ? [mcps, configuration]
        : [snapshot];
  const failed = required.filter((q) => q.isError);
  const loading = required.some((q) => !q.data);
  return (
    <section className="settings settings-page">
      <h1>管理中心</h1>
      {failed.length ? (
        <>
          <p role="alert">{failed.map((q) => q.error?.message).join(" · ")}</p>
          <button
            onClick={() => {
              for (const q of failed) void q.refetch();
            }}
          >
            重试加载
          </button>
        </>
      ) : loading ? (
        <p role="status">正在加载配置…</p>
      ) : path === "/admin/skills" ? (
        <SkillManager
          skills={skills.data!}
          configuration={configuration.data!}
        />
      ) : path === "/admin/mcp" ? (
        <MCPManager mcps={mcps.data!} configuration={configuration.data!} />
      ) : path === "/admin/delegation" ? (
        <>
          <h2>委派关系</h2>
          {snapshot.data!.items.map((a) => (
            <article className="settings-card" key={a.id}>
              <h3>
                {a.config.name} · {a.enabled ? "启用" : "禁用"}
              </h3>
              <p>{a.id}</p>
              <p>子 Agent：{a.config.subagents.join(", ") || "无"}</p>
              <p>
                子 Agent 上限：{a.config.maxSubagents} · 最大深度：
                {a.config.maxDepth}
              </p>
              {!a.config.tools.includes("delegate_to_agent") && (
                <p>此 Agent 未启用 delegate_to_agent 工具。</p>
              )}
              <Link to={"/admin/agents?agent=" + encodeURIComponent(a.id)}>
                编辑此 Agent 的委派配置
              </Link>
            </article>
          ))}
        </>
      ) : (
        <>
          {(skills.isError || mcps.isError) && (
            <p role="alert">
              部分绑定列表加载失败，其他配置仍可编辑。
              <button
                onClick={() => {
                  if (skills.isError) void skills.refetch();
                  if (mcps.isError) void mcps.refetch();
                }}
              >
                重试绑定列表
              </button>
            </p>
          )}
          <AgentManager
            snapshot={snapshot.data!}
            configuration={configuration.data!}
            skills={skills.data || []}
            mcps={mcps.data || []}
            skillsUnavailable={!skills.data || skills.isError}
            mcpsUnavailable={!mcps.data || mcps.isError}
          />
        </>
      )}
    </section>
  );
}
