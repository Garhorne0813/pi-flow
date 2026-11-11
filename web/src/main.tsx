import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
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
import Markdown from "react-markdown";
import { api, ApiError } from "./api/client";
import { auth, login, logout } from "./api/auth";
import { useChatSession } from "./chat/useChatSession";
import type { Item } from "./chat/model";
import "./style.css";
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
function Code({ children, ...props }: React.ComponentProps<"code">) {
  const text = String(children);
  return (
    <span>
      <code {...props}>{children}</code>
      {text.includes("\n") && (
        <button
          className="copy"
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          复制代码
        </button>
      )}
    </span>
  );
}
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
          {item.state === "started" ? "◌" : item.state === "failed" ? "!" : "✓"}{" "}
          {item.name || "工具"} · {item.state}
        </summary>
        <p>调用状态：{item.state}</p>
      </details>
    );
  if (item.kind === "interaction")
    return (
      <section className="interaction">
        <strong>
          {item.interactionKind === "approval" ? "需要你的批准" : "Agent 提问"}
        </strong>
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
      <small>{item.kind === "user" ? "你" : "Pi-Flow"}</small>
      {item.kind === "user" ? (
        <p>{item.text}</p>
      ) : (
        <Markdown skipHtml components={{ code: Code, img: () => null }}>
          {item.text || ""}
        </Markdown>
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
  const chat = useChatSession(sid),
    [agent, setAgent] = useState(""),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [menu, setMenu] = useState(false),
    [title, setTitle] = useState(""),
    [offset, setOffset] = useState(0);
  const [ready, setReady] = useState(!auth),
    [bottom, setBottom] = useState(true),
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
          navigate(target?.startsWith("/chat/") ? target : "/chat", {
            replace: true,
          });
        })
        .catch((e) => setError(e.message));
    } else if (auth)
      void auth.getUser().then((u) => {
        if (u && !u.expired) setReady(true);
      });
  }, []);
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
    if (!agent && agents.data?.items[0])
      setAgent(agents.data.items[0].key || agents.data.items[0].id || "");
  }, [agents.data]);
  useEffect(() => {
    setDraft(sessionStorage.getItem("pi-flow-draft:" + sid) || "");
    setTitle("");
    setBottom(true);
  }, [sid]);
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
    sessionStorage.setItem("pi-flow-draft:" + sid, v);
  };
  async function submit() {
    if (!draft.trim() || chat.busy || creating.current) return;
    if (!sid) {
      creating.current = true;
      await act(async () => {
        const s = await api<Session>("/sessions", {
          agentId: agent,
          title: draft.slice(0, 80),
        });
        sessionStorage.setItem("pi-flow-draft:" + s.id, draft);
        navigate("/chat/" + s.id);
        await api(
          `/sessions/${s.id}/runs`,
          { message: draft },
          "POST",
          crypto.randomUUID(),
        );
        sessionStorage.removeItem("pi-flow-draft:" + s.id);
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
        <button onClick={() => void login()}>登录</button>
      </main>
    );
  return (
    <div className="shell">
      <aside className={menu ? "visible" : ""}>
        <Link className="brand" to="/chat">
          π{" "}
          <span>
            Pi-Flow<small>PERSONAL AGENT</small>
          </span>
        </Link>
        <button
          className="new"
          onClick={() => {
            navigate("/chat");
            setMenu(false);
          }}
        >
          ＋ 新建对话
        </button>
        <p className="section-label">对话记录</p>
        <nav>
          {sessions.data?.items.map((s) => (
            <Link
              className={s.id === sid ? "selected" : ""}
              key={s.id}
              to={"/chat/" + s.id}
              onClick={() => setMenu(false)}
            >
              {s.title || "未命名对话"}
            </Link>
          ))}
        </nav>
        <div className="pagination">
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
          <Link to="/workspace">工作区文件</Link>
          <Link to="/settings">设置</Link>
          <button onClick={() => void logout()}>退出登录</button>
        </footer>
      </aside>
      <main className="main">
        <header>
          <button
            className="mobile"
            aria-label="展开会话列表"
            onClick={() => setMenu(!menu)}
          >
            ☰
          </button>
          <div>
            <strong>{selected?.title || "新的对话"}</strong>
            <small>
              {selected?.cwd || "/workspace"} · {chat.run?.state || "就绪"}
            </small>
          </div>
          <select
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
        </header>
        {errors && (
          <div role="alert" className="error">
            {errors}{" "}
            {auth && <button onClick={() => void login()}>重新登录</button>}
          </div>
        )}
        {location.pathname === "/workspace" ? (
          <Workspace />
        ) : location.pathname === "/settings" ? (
          <section className="settings">
            <h1>设置</h1>
            <p>Enter 发送，Shift+Enter 换行。中文组词时不会发送。</p>
            <p>任务按用户串行执行。支持文本对话与只读工作区。</p>
            <label>
              主题
              <select
                onChange={(e) =>
                  (document.documentElement.dataset.theme = e.target.value)
                }
              >
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
          </section>
        ) : (
          <>
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
                <div className="welcome">
                  <span>π</span>
                  <h1>今天想完成什么？</h1>
                  <p>选择一个 Agent，开始你的下一项工作。</p>
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
            <div className="composer-area">
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <textarea
                  aria-label="发送消息"
                  placeholder={sid ? "输入消息…" : "输入消息，创建对话…"}
                  value={draft}
                  maxLength={32000}
                  onChange={(e) => saveDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing &&
                      e.keyCode !== 229
                    ) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div>
                  <small>{draft.length.toLocaleString()} / 32,000</small>
                  {chat.run &&
                  ["QUEUED", "RUNNING", "WAITING_INPUT"].includes(
                    chat.run.state,
                  ) ? (
                    <button
                      type="button"
                      disabled={chat.busy}
                      onClick={() => void chat.cancel()}
                    >
                      停止
                    </button>
                  ) : (
                    <button disabled={chat.busy || !draft.trim() || !agent}>
                      {sid ? "发送 ↑" : "开始对话 →"}
                    </button>
                  )}
                </div>
              </form>
              <p className="hint" role="status">
                {chat.busy
                  ? "正在提交…"
                  : chat.run?.state === "WAITING_INPUT"
                    ? "等待你的响应"
                    : "文本对话 · Enter 发送 · Shift+Enter 换行"}
              </p>
            </div>
          </>
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
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </Boundary>,
);
