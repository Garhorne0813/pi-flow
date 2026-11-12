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
  const query = useQuery({
    queryKey: ["admin", "console"],
    queryFn: async () => {
      const results = await Promise.all([
        api<Snapshot>("/admin/config/agents"),
        allPages<Skill>("/admin/skills"),
        api<{ items: MCP[] }>("/admin/mcp-servers").then((r) => r.items),
        api<Configuration>("/admin/configuration"),
      ]);
      return {
        snapshot: results[0],
        skills: results[1],
        mcps: results[2],
        configuration: results[3],
      };
    },
    retry: false,
  });
  return (
    <section className="settings settings-page">
      <h1>管理中心</h1>
      {query.error ? (
        <>
          <p role="alert">{query.error.message}</p>
          <button onClick={() => void query.refetch()}>重试加载</button>
        </>
      ) : !query.data ? (
        <p role="status">正在加载配置…</p>
      ) : path === "/admin/skills" ? (
        <SkillManager
          skills={query.data.skills}
          configuration={query.data.configuration}
        />
      ) : path === "/admin/mcp" ? (
        <MCPManager
          mcps={query.data.mcps}
          configuration={query.data.configuration}
        />
      ) : path === "/admin/delegation" ? (
        <>
          <h2>委派关系</h2>
          {query.data.snapshot.items.map((a) => (
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
        <AgentManager {...query.data} />
      )}
    </section>
  );
}
