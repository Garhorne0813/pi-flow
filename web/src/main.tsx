import "../third-party/dsh/base.css";
import "../third-party/dsh/design-platform.css";
import "../third-party/dsh/gradient-shadow-text.css";
import "../third-party/dsh/scrollbar.css";
import "../third-party/dsh/shiki.css";
import { UserMessageBubble } from "../third-party/dsh/UserMessageBubble";
import { Button } from "../third-party/dsh/Button";
import { Pill } from "../third-party/dsh/Pill";
import sidebarCss from "../third-party/dsh/SidebarRoot.module.css";
import inputCss from "../third-party/dsh/InputBar.module.css";
import heroCss from "../third-party/dsh/HeroShell.module.css";
import { Icon } from "./ui/Icon";
import { AdminSettings } from "./settings/AdminSettings";
import { UserSettings } from "./settings/UserSettings";
import {
  applyTheme,
  defaults,
  loadPreferences,
  storePreferences,
  shouldSend,
  type Identity,
  type Preferences,
} from "./settings/preferences";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  RouterProvider,
  Link,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, ApiError } from "./api/client";
import { submitRun } from "./chat/submitRun";
import { auth, login, logout, setLocalToken } from "./api/auth";
import { useChatSession } from "./chat/useChatSession";
import type { Item } from "./chat/model";
import "./style.css";
const AdminConsole = React.lazy(() =>
  import("./admin/AdminConsole").then((m) => ({ default: m.AdminConsole })),
);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, e) =>
        !(e instanceof ApiError && [401, 403].includes(e.status)) && count < 2,
    },
  },
});
type Agent = { key: string; id?: string; config: { name: string } };
type Session = { id: string; agentId: string; title?: string; cwd?: string };
const AssistantMarkdown = React.lazy(() => import("./ui/AssistantMarkdown"));
function Message({
  item,
  busy,
  respond,
}: {
  item: Item;
  busy: boolean;
  respond: (id: string, response: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  if (item.kind === "tool")
    return (
      <details open={item.state === "failed"} className="tool">
        <summary>
          <Icon name="terminal" size={16} />
          <span>{item.name || "工具"}</span>
          <span className={"tool-state " + item.state}>
            {item.state === "started"
              ? "运行中"
              : item.state === "failed"
                ? "失败"
                : "已完成"}
          </span>
        </summary>
        <p>调用状态：{item.state}</p>
      </details>
    );
  if (item.kind === "interaction")
    return (
      <section className="interaction">
        <div className="interaction-heading">
          <Icon name="shield" size={18} />
          <strong>
            {item.interactionKind === "approval"
              ? "需要你的批准"
              : "Agent 提问"}
          </strong>
          <Pill>等待响应</Pill>
        </div>
        <p>{item.text || "请确认是否允许此操作。"}</p>
        {item.resolved ? (
          <p>已响应</p>
        ) : item.interactionKind === "approval" ? (
          <div>
            <button
              disabled={busy}
              onClick={() => void respond(item.interactionId!, "approve")}
            >
              批准
            </button>{" "}
            <button
              disabled={busy}
              onClick={() => void respond(item.interactionId!, "deny")}
            >
              拒绝
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void respond(item.interactionId!, answer);
            }}
          >
            <label>
              你的回答
              <input
                value={answer}
                maxLength={16000}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </label>
            <button disabled={busy || !answer.trim()}>提交回答</button>
          </form>
        )}
      </section>
    );
  if (item.kind === "notice") return <p className="notice">{item.text}</p>;
  return (
    <article className={"message " + item.kind}>
      {item.kind !== "user" && (
        <div className="message-heading">
          <span className="assistant-mark">π</span>
          <small>Pi-Flow</small>
        </div>
      )}
      {item.kind === "user" ? (
        <UserMessageBubble>{item.text}</UserMessageBubble>
      ) : (
        <React.Suspense fallback={<p>{item.text}</p>}>
          <AssistantMarkdown text={item.text || ""} />
        </React.Suspense>
      )}
    </article>
  );
}
function App() {
  const location = useLocation(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const sid = location.pathname.startsWith("/chat/")
    ? location.pathname.split("/")[2]
    : undefined;
  const [ready, setReady] = useState(!auth);
  const chat = useChatSession(ready ? sid : undefined),
    [agent, setAgent] = useState(""),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [menu, setMenu] = useState(false),
    [title, setTitle] = useState(""),
    [offset, setOffset] = useState(0),
    [sessionSearch, setSessionSearch] = useState("");
  const [credential, setCredential] = useState("");
  const [bottom, setBottom] = useState(true),
    timeline = useRef<HTMLDivElement>(null),
    creating = useRef(false);
  useEffect(() => {
    if (location.pathname === "/auth/callback" && auth) {
      void auth
        .signinRedirectCallback()
        .then((user) => {
          setReady(true);
          const target = (user.state as { returnTo?: string } | undefined)
            ?.returnTo;
          navigate(
            target &&
              (/^\/chat(?:\/[^/]+)?$/.test(target) ||
                [
                  "/settings",
                  "/workspace",
                  "/admin/settings",
                  "/admin/agents",
                  "/admin/skills",
                  "/admin/mcp",
                  "/admin/delegation",
                ].includes(target))
              ? target
              : "/chat",
            {
              replace: true,
            },
          );
        })
        .catch((e) => setError(e.message));
    } else if (auth)
      void auth.getUser().then((u) => {
        if (u && !u.expired) setReady(true);
      });
  }, []);
  const identity = useQuery({
    queryKey: ["identity"],
    queryFn: () => api<Identity>("/me"),
    enabled: ready,
    retry: false,
    refetchInterval: 15000,
  });
  useEffect(() => {
    if (
      !auth &&
      identity.error instanceof ApiError &&
      identity.error.status === 401
    )
      setReady(false);
  }, [identity.error]);
  const me = identity.error ? undefined : identity.data;
  const [preferences, setPreferences] = useState<Preferences>(defaults);
  useEffect(() => {
    setPreferences(me ? loadPreferences(me.userId) : { ...defaults });
  }, [me?.userId]);
  useEffect(() => {
    applyTheme(preferences.theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(preferences.theme);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preferences.theme]);
  function changePreferences(value: Preferences) {
    if (!me) return;
    storePreferences(me.userId, value);
    setPreferences(value);
  }
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api<{ items: Agent[] }>("/agents"),
    enabled: ready,
  });
  const sessions = useQuery({
    queryKey: ["sessions", offset],
    queryFn: () =>
      api<{ items: Session[] }>(`/sessions?offset=${offset}&limit=50`),
    enabled: ready,
    refetchInterval: 5000,
  });
  const selected = sessions.data?.items.find((s) => s.id === sid);
  useEffect(() => {
    if (!me?.admin) cache.removeQueries({ queryKey: ["admin"] });
  }, [me?.admin, cache]);
  useEffect(() => {
    if (agents.data?.items.length) {
      const preferred = agents.data.items.find(
        (a) => (a.key || a.id) === preferences.defaultAgent,
      );
      setAgent(
        preferred?.key ||
          preferred?.id ||
          agents.data.items[0].key ||
          agents.data.items[0].id ||
          "",
      );
    }
  }, [agents.data, preferences.defaultAgent]);
  useEffect(() => {
    setDraft(
      sessionStorage.getItem("pi-flow-draft:" + me?.userId + ":" + sid) || "",
    );
    setTitle("");
    setBottom(true);
  }, [sid, me?.userId]);
  useEffect(() => {
    if (bottom && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [chat.projection, bottom]);
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await cache.invalidateQueries({ queryKey: ["sessions"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    }
  };
  const saveDraft = (v: string) => {
    setDraft(v);
    sessionStorage.setItem("pi-flow-draft:" + me?.userId + ":" + sid, v);
  };
  async function submit() {
    if (!me || !draft.trim() || chat.busy || creating.current) return;
    if (!sid) {
      creating.current = true;
      await act(async () => {
        const s = await api<Session>("/sessions", {
          agentId: agent,
          title: draft.slice(0, 80),
        });
        sessionStorage.setItem(
          "pi-flow-draft:" + me?.userId + ":" + s.id,
          draft,
        );
        navigate("/chat/" + s.id);
        await submitRun(s.id, draft);
        sessionStorage.removeItem("pi-flow-draft:" + me?.userId + ":" + s.id);
        setDraft("");
      });
      creating.current = false;
      return;
    }
    if (await chat.send(draft)) saveDraft("");
  }
  const errors = [
    chat.error,
    error,
    identity.error?.message,
    agents.error?.message,
    sessions.error?.message,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!ready)
    return (
      <main className="login">
        <div className="brand">π Pi-Flow</div>
        <h1>与 Agent 一起工作</h1>
        <p>使用组织身份登录，访问个人对话与工作区。</p>
        {error && <p role="alert">{error}</p>}
        {auth ? (
          <button onClick={() => void login()}>登录</button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setLocalToken(credential);
              setCredential("");
              cache.clear();
              setReady(true);
            }}
          >
            <label>
              本地访问令牌
              <input
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                required
              />
            </label>
            <button type="submit">登录</button>
          </form>
        )}
      </main>
    );
  return (
    <div className="shell">
      <aside
        className={sidebarCss.root + " sidebar " + (menu ? "visible" : "")}
      >
        <div className={sidebarCss.logoRow + " sidebar-brand-row"}>
          <Link className={sidebarCss.brand + " brand"} to="/chat">
            <span className="brand-symbol">π</span>
            <span>Pi-Flow</span>
          </Link>
          <button
            className="icon-button mobile-close"
            aria-label="关闭会话列表"
            onClick={() => setMenu(false)}
          >
            <Icon name="panel" />
          </button>
        </div>
        <Button
          className={sidebarCss.newSession + " new"}
          icon={<Icon name="plus" size={17} />}
          onClick={() => {
            navigate("/chat");
            setMenu(false);
          }}
        >
          新建对话
        </Button>
        <Link className="sidebar-workspace" to="/workspace">
          <Icon name="folder" size={17} />
          <span>工作区文件</span>
        </Link>
        <label className="session-search">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索当前页对话"
            placeholder="搜索对话"
            value={sessionSearch}
            onChange={(e) => setSessionSearch(e.target.value)}
          />
        </label>
        <p className="section-label">对话记录</p>
        <nav>
          {sessions.data?.items
            .filter((s) =>
              (s.title || "未命名对话")
                .toLowerCase()
                .includes(sessionSearch.toLowerCase()),
            )
            .map((s) => (
              <Link
                className={s.id === sid ? "selected" : ""}
                key={s.id}
                to={"/chat/" + s.id}
                onClick={() => setMenu(false)}
              >
                <Icon name="chat" size={16} />
                <span>{s.title || "未命名对话"}</span>
              </Link>
            ))}
        </nav>
        <div
          className="pagination"
          hidden={offset === 0 && (sessions.data?.items.length || 0) < 50}
        >
          <button
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            上一页
          </button>
          <button
            disabled={(sessions.data?.items.length || 0) < 50}
            onClick={() => setOffset(offset + 50)}
          >
            下一页
          </button>
        </div>
        <footer>
          <div className="sidebar-links">
            <Link to="/settings">
              <Icon name="settings" size={16} />
              个人设置
            </Link>
          </div>
          {me?.admin && (
            <div className="admin-nav">
              <span className="section-label">管理中心</span>
              {(
                [
                  ["/admin/agents", "Agent 管理", "bot"],
                  ["/admin/skills", "Skills 管理", "skill"],
                  ["/admin/mcp", "MCP Servers", "link"],
                  ["/admin/delegation", "子 Agent 委派", "network"],
                  ["/admin/settings", "全局配置", "settings"],
                ] as const
              ).map(([href, label, icon]) => (
                <Link
                  key={href}
                  to={href}
                  className={location.pathname === href ? "active" : ""}
                >
                  <Icon name={icon} size={15} />
                  {label}
                </Link>
              ))}
            </div>
          )}
          <div className="user-profile">
            <span className="profile-avatar">P</span>
            <span className="profile-copy">
              个人空间<small>{me?.admin ? "管理员" : "普通用户"}</small>
            </span>
            <button
              className="icon-button"
              aria-label="退出登录"
              title="退出登录"
              onClick={() => {
                cache.clear();
                setReady(false);
                void logout();
              }}
            >
              <Icon name="logout" size={16} />
            </button>
          </div>
        </footer>
      </aside>
      <main className="main">
        <header className="app-header">
          <div className="header-leading">
            <button
              className="icon-button mobile"
              aria-label="展开会话列表"
              onClick={() => setMenu(!menu)}
            >
              <Icon name="panel" />
            </button>
            <span className="breadcrumb-root">个人空间</span>
            <span className="breadcrumb-slash">/</span>
            <strong>
              {location.pathname.startsWith("/admin/")
                ? "管理中心"
                : location.pathname === "/settings"
                  ? "个人设置"
                  : location.pathname === "/workspace"
                    ? "工作区"
                    : selected?.title || "新对话"}
            </strong>
          </div>
          <div className="header-actions">
            {sid && chat.run && (
              <Pill>
                <span
                  className={"status-dot " + chat.run.state.toLowerCase()}
                />
                {(
                  {
                    QUEUED: "排队中",
                    RUNNING: "运行中",
                    WAITING_INPUT: "等待响应",
                    COMPLETED: "已完成",
                    FAILED: "失败",
                    CANCELLED: "已停止",
                  } as Record<string, string>
                )[chat.run.state] || chat.run.state}
              </Pill>
            )}
            <button
              className="icon-button"
              aria-label="切换深浅主题"
              title="切换深浅主题"
              disabled={!me}
              onClick={() =>
                changePreferences({
                  ...preferences,
                  theme:
                    document.documentElement.dataset.theme === "dark"
                      ? "light"
                      : "dark",
                })
              }
            >
              <span className="theme-light-icon">
                <Icon name="moon" size={17} />
              </span>
              <span className="theme-dark-icon">
                <Icon name="sun" size={17} />
              </span>
            </button>
          </div>
        </header>

        {errors && (
          <div role="alert" className="error">
            {errors}{" "}
            <button onClick={() => (auth ? void login() : setReady(false))}>
              重新登录
            </button>
          </div>
        )}
        {location.pathname === "/workspace" ? (
          <Workspace />
        ) : location.pathname === "/settings" ? (
          me ? (
            <UserSettings
              identity={me}
              preferences={preferences}
              onChange={changePreferences}
              agents={agents.data?.items || []}
            />
          ) : (
            <section className="settings">
              <h1>个人设置</h1>
              <p role="status">无法确认当前用户身份，请重试或重新登录。</p>
            </section>
          )
        ) : [
            "/admin/agents",
            "/admin/skills",
            "/admin/mcp",
            "/admin/delegation",
          ].includes(location.pathname) ? (
          <React.Suspense fallback={<p role="status">正在加载管理中心…</p>}>
            <AdminConsole identity={me} path={location.pathname} />
          </React.Suspense>
        ) : location.pathname === "/admin/settings" ? (
          <AdminSettings identity={me} />
        ) : (
          <section className={"chat-surface " + (!sid ? "is-empty" : "")}>
            {sid && (
              <details className="session-actions">
                <summary>会话操作</summary>
                <label>
                  标题
                  <input
                    value={title}
                    placeholder={selected?.title}
                    maxLength={200}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <button
                  onClick={() =>
                    void act(() => api(`/sessions/${sid}`, { title }, "PATCH"))
                  }
                >
                  重命名
                </button>
                <button
                  onClick={() => {
                    if (confirm("删除此对话？"))
                      void act(async () => {
                        await api(`/sessions/${sid}`, undefined, "DELETE");
                        navigate("/chat");
                      });
                  }}
                >
                  删除
                </button>
              </details>
            )}
            <div
              className="timeline"
              ref={timeline}
              onScroll={(e) => {
                const el = e.currentTarget;
                setBottom(
                  el.scrollHeight - el.scrollTop - el.clientHeight < 80,
                );
              }}
            >
              {chat.hasOlder && (
                <button
                  onClick={() => {
                    const el = timeline.current,
                      h = el?.scrollHeight || 0;
                    void chat
                      .loadOlder()
                      .then(() =>
                        requestAnimationFrame(() => {
                          if (el) el.scrollTop += el.scrollHeight - h;
                        }),
                      )
                      .catch((e) => setError(e.message));
                  }}
                >
                  加载更早的消息
                </button>
              )}
              {!sid && (
                <div className={heroCss.stack + " welcome"}>
                  <div className={heroCss.headline}>
                    <span className="hero-symbol">π</span>
                    <h1>Pi-Flow</h1>
                  </div>
                  <p>把想法交给 Agent，把时间留给更重要的事。</p>
                </div>
              )}
              {chat.projection.items.map((item) => (
                <Message
                  key={item.id}
                  item={item}
                  busy={chat.busy}
                  respond={chat.respond}
                />
              ))}
              {Object.entries(chat.projection.drafts).map(([runId, text]) => (
                <Message
                  key={"draft:" + runId}
                  item={{ id: runId, runId, kind: "assistant", text }}
                  busy={false}
                  respond={chat.respond}
                />
              ))}
            </div>
            {!bottom && (
              <button className="latest" onClick={() => setBottom(true)}>
                ↓ 跳到最新
              </button>
            )}
            <div
              className={
                "composer-area " +
                inputCss.root +
                (!sid ? " " + inputCss.hero : "")
              }
            >
              {!sid && (
                <div className="hero-workspace">
                  <Icon name="folder" size={16} />
                  <span>个人工作区</span>
                  <small>/workspace</small>
                </div>
              )}
              <form
                className={inputCss.card + " composer"}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <textarea
                  aria-label="发送消息"
                  placeholder="发送消息，开始新的工作…"
                  value={draft}
                  maxLength={32000}
                  onChange={(e) => saveDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      shouldSend(
                        e.key,
                        e.shiftKey,
                        e.ctrlKey,
                        e.metaKey,
                        e.nativeEvent.isComposing || e.keyCode === 229,
                        preferences.sendShortcut,
                      )
                    ) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div className={inputCss.row + " composer-toolbar"}>
                  <div className={inputCss.tools}>
                    <Link
                      className="composer-directory"
                      title="查看工作区"
                      to="/workspace"
                    >
                      <Icon name="folder" size={16} />
                      <span>workspace</span>
                    </Link>
                  </div>
                  <div className={inputCss.trailing}>
                    <select
                      className={inputCss.select}
                      aria-label="选择 Agent"
                      value={selected?.agentId || agent}
                      disabled={!!sid}
                      onChange={(e) => setAgent(e.target.value)}
                    >
                      {agents.data?.items.map((a) => (
                        <option key={a.key || a.id} value={a.key || a.id}>
                          {a.config.name}
                        </option>
                      ))}
                    </select>
                    {draft.length > 0 && (
                      <small className="character-count">
                        {draft.length.toLocaleString()}
                      </small>
                    )}
                    {chat.run &&
                    ["QUEUED", "RUNNING", "WAITING_INPUT"].includes(
                      chat.run.state,
                    ) ? (
                      <button
                        className={inputCss.primary}
                        type="button"
                        aria-label="停止"
                        title="停止"
                        disabled={chat.busy}
                        onClick={() => void chat.cancel()}
                      >
                        <Icon name="stop" size={17} />
                      </button>
                    ) : (
                      <button
                        className={inputCss.primary}
                        aria-label={sid ? "发送 ↑" : "开始对话 →"}
                        title={sid ? "发送消息" : "开始对话"}
                        disabled={!me || chat.busy || !draft.trim() || !agent}
                      >
                        <Icon name="arrow" size={20} />
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <p className="hint" role="status">
                {chat.busy
                  ? "正在提交…"
                  : chat.run?.state === "WAITING_INPUT"
                    ? "等待你的响应"
                    : preferences.sendShortcut === "ctrlEnter"
                      ? "Ctrl / ⌘ + Enter 发送 · Shift+Enter 换行"
                      : "Enter 发送 · Shift+Enter 换行"}
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
function Workspace() {
  const [path, setPath] = useState("/workspace"),
    [operation, setOperation] = useState("ls");
  const result = useQuery({
    queryKey: ["files", path, operation],
    queryFn: () =>
      api<unknown>(
        `/me/files?path=${encodeURIComponent(path)}&operation=${operation}`,
      ),
    retry: false,
  });
  return (
    <section className="settings">
      <h1>工作区</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setPath(String(f.get("path")));
          setOperation(String(f.get("operation")));
        }}
      >
        <label>
          路径
          <input name="path" defaultValue={path} />
        </label>
        <select name="operation" aria-label="文件操作">
          <option value="ls">列出目录</option>
          <option value="read">读取文本</option>
        </select>
        <button>查看</button>
      </form>
      {result.error ? (
        <p role="alert">{result.error.message}（运行中可能暂时无法访问文件）</p>
      ) : (
        <pre>
          {typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data, null, 2)}
        </pre>
      )}
    </section>
  );
}
class Boundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main>
        <h1>页面遇到问题</h1>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
const router = createBrowserRouter([{ path: "*", element: <App /> }]);
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </Boundary>,
);
