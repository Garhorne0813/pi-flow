/** Standalone management console served by the Fastify API. */
export const agentAdminHTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>管理控制台 · Pi-Flow</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1e293b; background: #f5f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, input, textarea { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .48; }
    .topbar { background: #111b35; color: #fff; padding: 18px clamp(18px, 3vw, 46px); display: flex; justify-content: space-between; align-items: center; gap: 20px; flex-wrap: wrap; }
    .brand { font-size: 19px; font-weight: 800; letter-spacing: -.5px; }
    .brand span { color: #90a9fd; font-weight: 500; margin-left: 12px; }
    .auth { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    .auth input { width: 270px; background: #202e50; color: white; border: 1px solid #435475; }
    .auth input::placeholder { color: #a4b2cb; }
    .muted { color: #64748b; }
    .shell { max-width: 1510px; margin: 0 auto; padding: 30px clamp(16px, 3vw, 44px); }
    .intro { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 26px; flex-wrap: wrap; }
    h1 { font-size: 29px; margin: 0 0 7px; letter-spacing: -.8px; color: #101d37; }
    .intro p { margin: 0; line-height: 1.6; }
    .layout { display: grid; grid-template-columns: 285px minmax(0,1fr) 300px; gap: 18px; align-items: start; }
    .panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 5px 22px rgba(25,37,65,.045); overflow: hidden; }
    .panel-head { padding: 19px 20px; border-bottom: 1px solid #e9edf4; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    h2 { margin: 0; font-size: 16px; letter-spacing: -.2px; }
    h3 { font-size: 14px; margin: 0 0 12px; color: #172744; }
    .pad { padding: 20px; }
    .full { width: 100%; }
    input, textarea { padding: 10px 12px; border: 1px solid #d3dce9; border-radius: 9px; outline-offset: 2px; background: #fff; color: #17243b; min-width: 0; }
    input:focus, textarea:focus { outline: 2px solid #a0b4ff; border-color: #6479e9; }
    input:disabled, textarea:disabled { background: #f5f7fb; color: #64748b; }
    textarea { resize: vertical; min-height: 84px; line-height: 1.55; }
    label.field { display: block; font-weight: 650; font-size: 13px; margin-bottom: 6px; }
    label.field small { display: block; font-weight: 400; color: #64748b; margin-top: 4px; }
    .field-wrap { margin-bottom: 18px; }
    .field-wrap:last-child { margin-bottom: 0; }
    .grid2 { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 15px; }
    .grid3 { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 13px; }
    .section { border-top: 1px solid #e9edf4; padding: 22px 20px; }
    .section:first-child { border-top: none; }
    .section-note { font-size: 12px; color: #718096; margin: -5px 0 15px; line-height: 1.6; }
    .btn { padding: 10px 15px; border: 1px solid #d2dce9; border-radius: 9px; color: #253552; background: #fff; font-weight: 650; font-size: 13px; }
    .btn:hover:not(:disabled) { background: #edf2ff; }
    .primary { border-color: #405cf5; background: #405cf5; color: white; }
    .primary:hover:not(:disabled) { background: #304be0; }
    .danger { color: #b32635; background: #fff6f6; border-color: #ffd0d0; }
    .btn-sm { padding: 7px 10px; font-size: 12px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
    .pill { font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 100px; background: #edf1ff; color: #4056b4; }
    .pill.off { background: #f1f5f9; color: #778399; }
    .agent-list { max-height: 75vh; overflow: auto; padding: 10px; }
    .agent-item { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 9px; padding: 12px; background: white; margin-bottom: 5px; }
    .agent-item:hover { background: #f7f9ff; }
    .agent-item.active { background: #eff3ff; border-color: #c7d4ff; }
    .agent-name { display: flex; align-items: center; justify-content: space-between; font-size: 13px; gap: 8px; font-weight: 700; }
    .agent-id { font-size: 11px; font-weight: 450; margin-top: 6px; color: #8290a5; font-family: ui-monospace, monospace; }
    .choices { display: flex; flex-wrap: wrap; gap: 8px; }
    .choice { display: inline-flex; gap: 7px; align-items: center; border: 1px solid #dde4ee; padding: 8px 10px; border-radius: 9px; font-size: 12px; cursor: pointer; max-width: 100%; overflow-wrap: anywhere; }
    .choice:has(input:checked) { border-color: #94a9f7; background: #f1f4ff; }
    .choice input { accent-color: #405cf5; }
    .detail-row { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid #edf0f5; padding: 12px 0; font-size: 12px; }
    .detail-row span { color: #64748b; }
    .detail-row strong { text-align: right; overflow-wrap: anywhere; font-size: 12px; }
    .note { font-size: 12px; line-height: 1.6; color: #64748b; }
    .note a { color: #405cf5; }
    .message { margin: 0 0 16px; padding: 12px 14px; border-radius: 9px; font-size: 13px; line-height: 1.5; display: none; white-space: pre-wrap; overflow-wrap: anywhere; }
    .message.show { display: block; background: #eaf8f1; color: #176943; }
    .message.error { display: block; background: #fff0ef; color: #9b2230; }
    .empty { color: #8996a9; text-align: center; padding: 30px 14px; font-size: 13px; line-height: 1.6; }
    .footer-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; padding: 18px 20px; border-top: 1px solid #edf0f5; background: #fbfcfe; }
    code { font-size: 11px; overflow-wrap: anywhere; }
    @media(max-width:1150px) { .layout { grid-template-columns: 260px minmax(0,1fr); } .side-detail { grid-column: 2; } }
    @media(max-width:750px) { .layout { display:block; } .layout > .panel { margin-bottom: 16px; } .agent-list { max-height: 260px; } .grid2, .grid3 { grid-template-columns: 1fr; } .auth input { width: 200px; } }
    [hidden] { display:none !important; }
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 22px; }
    .tabs .active { background:#111b35; color:white; border-color:#111b35; }
    .console-grid { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(300px,1fr); gap:20px; align-items:start; }
    .resource-list { display:grid; gap:14px; }
    .resource-card { background:white; border:1px solid #e2e8f0; border-radius:12px; padding:20px; overflow-wrap:anywhere; }
    .resource-card .toolbar { margin-top:14px; }
    .resource-card h3 { margin:0; }
    .resource-card p { white-space:pre-wrap; }
    .summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:20px; }
    .summary .resource-card strong { font-size:26px; display:block; margin-top:8px; }
    select { font:inherit; padding:10px 12px; border:1px solid #d3dce9; border-radius:9px; background:white; color:#17243b; max-width:100%; }
    .config-table { width:100%; border-collapse:collapse; font-size:13px; }
    .config-table td { padding:12px 0; border-bottom:1px solid #edf0f5; overflow-wrap:anywhere; }
    .config-table td:last-child { text-align:right; }
    @media(max-width:850px) { .console-grid { grid-template-columns:1fr; } .summary { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">◆ Pi-Flow <span>Admin Console</span></div>
    <div class="auth">
      <input id="token" type="password" autocomplete="off" placeholder="输入管理员 Bearer Token" aria-label="管理员令牌">
      <button class="btn primary btn-sm" id="connect" type="button">连接</button>
      <button class="btn btn-sm" id="disconnect" type="button" disabled>断开</button>
      <span id="connection" style="font-size:12px;color:#a4b2cb">未连接</span>
    </div>
  </header>
  <main class="shell">
    <div class="intro">
      <div><h1>Pi-Flow 管理控制台</h1><p class="muted">管理 Agent、能力登记、委派关系与租户默认配置。</p></div>
      <button id="new" class="btn primary" type="button" disabled>＋ 新建 Agent</button>
    </div>
    <div id="message" role="status" aria-live="polite" class="message"></div>
    <nav class="tabs" aria-label="控制台导航">
      <button id="tab-agents" class="btn active" type="button" aria-pressed="true">Agents</button>
      <button id="tab-skills" class="btn" type="button" aria-pressed="false">Skills</button>
      <button id="tab-mcp" class="btn" type="button" aria-pressed="false">MCP Servers</button>
      <button id="tab-delegation" class="btn" type="button" aria-pressed="false">子 Agent 委派</button>
      <button id="tab-settings" class="btn" type="button" aria-pressed="false">全局配置</button>
      <button id="refresh-console" class="btn" type="button" disabled>刷新数据</button>
    </nav>
    <div id="view-agents" class="layout">
      <aside class="panel">
        <div class="panel-head"><h2>Agents 与历史版本</h2><span id="count" class="pill">0</span></div>
        <div class="pad" style="padding-bottom:0"><input class="full" id="search" placeholder="搜索 Agent 名称…" aria-label="搜索 Agent" type="search"></div>
        <div id="list" class="agent-list"><div class="empty">连接 API 后查看 Agent 版本</div></div>
      </aside>
      <section class="panel">
        <div class="panel-head"><h2 id="form-title">新建 Agent</h2><span class="pill" id="mode">草稿</span></div>
        <form id="form">
          <div class="section">
            <h3>基本信息</h3>
            <div class="field-wrap"><label class="field" for="name">Agent 名称</label><input class="full" id="name" required maxlength="100" placeholder="例如：企业代码助手"></div>
            <div class="field-wrap"><label class="field" for="prompt">System Prompt <small>定义角色、职责与行为边界</small></label><textarea class="full" id="prompt" maxlength="32000" rows="6" placeholder="你是一位…"></textarea></div>
            <div class="field-wrap"><label class="field">AGENTS.md 指令 <small>每个条目可包含完整的多行 Markdown，按原样保存；不是文件路径。</small></label><div id="agents-md"></div><button id="add-agents-md" class="btn btn-sm" type="button" disabled>＋ 添加指令条目</button></div>
          </div>
          <div class="section">
            <h3>模型配置</h3>
            <div class="grid2">
              <div class="field-wrap"><label class="field" for="provider">Provider</label><input class="full" id="provider" list="provider-options" required placeholder="enterprise / demo"></div>
              <div class="field-wrap"><label class="field" for="model">Model ID</label><input class="full" id="model" list="model-options" required placeholder="coding-model / demo"></div>
            </div>
            <p class="section-note">模型必须与服务端 LLM_PROVIDER / LLM_MODEL_ID 的获批配置一致。此页面不管理密钥。</p>
          </div>
          <div class="section">
            <h3>工具权限</h3>
            <div id="tools" class="choices"></div>
          </div>
          <div class="section">
            <h3>扩展能力</h3>
            <div class="field-wrap"><label class="field" for="bundle">Skill Bundle</label><input class="full" id="bundle" required value="default" placeholder="default"></div>
            <label class="field">Skills</label><p class="section-note">只能启用管理员已登记、部署端已挂载且属于指定 Bundle 的 Skill。</p>
            <div id="skills" class="choices" style="margin-bottom:18px"></div>
            <label class="field">MCP Servers</label><p class="section-note">使用已登记的 MCP Server ID；Endpoint 与凭证在部署端配置。</p>
            <div id="mcps" class="choices" style="margin-bottom:18px"></div>
            <label class="field">子 Agent</label><p class="section-note">引用已有 AgentVersion ID。要实际委派，需启用 delegate_to_agent 工具。</p>
            <div id="subagents" class="choices"></div>
          </div>
          <div class="section">
            <h3>执行配额</h3>
            <div class="grid3">
              <div class="field-wrap"><label class="field" for="steps">最大步骤</label><input class="full" id="steps" type="number" min="1" max="100" required></div>
              <div class="field-wrap"><label class="field" for="tokens">Token 预算</label><input class="full" id="tokens" type="number" min="100" max="1000000" required></div>
              <div class="field-wrap"><label class="field" for="timeout">超时（秒）</label><input class="full" id="timeout" type="number" min="1" max="1800" required></div>
              <div class="field-wrap"><label class="field" for="max-subagents">子 Agent 上限</label><input class="full" id="max-subagents" type="number" min="0" max="5" required></div>
              <div class="field-wrap"><label class="field" for="depth">最大委派深度</label><input class="full" id="depth" type="number" min="0" max="3" required></div>
            </div>
          </div>
          <div class="footer-actions">
            <button type="button" class="btn" id="clone" disabled>发布后续版本</button>
            <button type="submit" class="btn primary" id="publish" disabled>发布 Agent</button>
          </div>
        </form>
      </section>
      <aside class="panel side-detail">
        <div class="panel-head"><h2>版本与访问控制</h2></div>
        <div class="pad">
          <div class="note" id="selection-note">选中一个已发布版本后，可以管理其状态和访问范围。</div>
          <div id="details" style="display:none">
            <div class="detail-row"><span>Agent ID</span><strong><code id="agent-id"></code></strong></div>
            <div class="detail-row"><span>版本 ID</span><strong><code id="version-id"></code></strong></div>
            <div class="detail-row"><span>发布时间</span><strong id="published-at"></strong></div>
            <div class="detail-row"><span>状态</span><strong id="enabled-label"></strong></div>
            <div class="detail-row"><span>摘要</span><strong><code id="digest"></code></strong></div>
            <div class="field-wrap" style="margin-top:24px">
              <label class="field" for="access-mode">访问范围</label>
              <select id="access-mode" class="full"><option value="restricted">仅指定用户</option><option value="all">租户内所有用户</option></select>
              <label class="field" for="allowed-users" style="margin-top:12px">允许访问的用户 ID <small>指定用户模式至少填写一个 UCS Subject，每行一个。拒绝所有用户访问请禁用版本。</small></label>
              <textarea class="full" id="allowed-users" rows="5"></textarea>
            </div>
            <div class="toolbar">
              <button id="save-access" type="button" class="btn primary btn-sm">保存访问权限</button>
              <button id="activate" type="button" class="btn primary btn-sm">激活此版本</button>
              <button id="toggle" type="button" class="btn danger btn-sm">禁用版本</button>
            </div>
          </div>
          <hr style="border:0;border-top:1px solid #edf0f5;margin:23px 0">
          <p class="note">仅管理员可以访问管理 API。此页不保存令牌到 localStorage、Cookie 或 URL。关闭或刷新页面后需要重新连接。</p>
          <p class="note">发布后续版本会更新当前生效版本。会话在下一次独立任务时跟随生效版本；续跑和子任务保留原任务版本。访问范围统一作用于该 Agent 的全部版本。</p>
          <p class="note"><a href="https://github.com/Garhorne0813/pi-flow/blob/main/docs/api.md" target="_blank" rel="noopener noreferrer">API 文档 ↗</a></p>
        </div>
      </aside>
    </div>
    <section id="view-skills" hidden>
      <div class="console-grid">
        <div><div class="panel-head"><h2>已登记 Skills</h2><span id="skill-count" class="pill">0</span></div><div id="skill-registry" class="resource-list"></div></div>
        <section class="panel"><div class="panel-head"><h2>登记 Skill 版本</h2></div><form id="skill-form" class="pad">
          <p class="note">Skill 版本不可变。更新内容需登记新的版本 ID；Skill 文件和卷需先部署到服务器。</p>
          <div class="field-wrap"><label class="field" for="skill-id">版本 ID</label><input id="skill-id" class="full" required pattern="[a-zA-Z0-9_\-]+@[a-zA-Z0-9_\-]+" placeholder="code-review@v1"></div>
          <div class="field-wrap"><label class="field" for="skill-name">名称</label><input id="skill-name" class="full" required maxlength="100"></div>
          <div class="field-wrap"><label class="field" for="skill-description">描述</label><textarea id="skill-description" class="full" maxlength="2000"></textarea></div>
          <div class="field-wrap"><label class="field" for="skill-bundle">Bundle</label><select id="skill-bundle" class="full" required></select></div>
          <div class="field-wrap"><label class="field" for="skill-path">文件路径</label><input id="skill-path" class="full" required pattern="/skills/([a-zA-Z0-9_\-]+/)+SKILL\.md" placeholder="/skills/code-review/SKILL.md"></div>
          <div class="field-wrap"><label class="field" for="skill-digest">SHA-256 摘要</label><input id="skill-digest" class="full" required pattern="[a-f0-9]{64}" minlength="64" maxlength="64" placeholder="Skill 文件的 SHA-256"></div>
          <button id="register-skill" class="btn primary" type="submit" disabled>登记版本</button>
        </form></section>
      </div>
    </section>
    <section id="view-mcp" hidden>
      <div class="console-grid">
        <div><div class="panel-head"><h2>已登记 MCP Servers</h2><span id="mcp-count" class="pill">0</span></div><div id="mcp-registry" class="resource-list"></div></div>
        <section class="panel"><div class="panel-head"><h2>登记 MCP Server</h2></div><form id="mcp-form" class="pad">
          <p class="note">选择服务器已配置并授权给当前租户的 Endpoint。连接检查只发现白名单工具，不执行工具。</p>
          <div class="field-wrap"><label class="field" for="mcp-id">Server ID</label><input id="mcp-id" class="full" required maxlength="20" pattern="[a-zA-Z0-9_\-]{1,20}" placeholder="docs"></div>
          <div class="field-wrap"><label class="field" for="mcp-endpoint">Endpoint</label><select id="mcp-endpoint" class="full" required></select></div>
          <div class="field-wrap"><label class="field" for="mcp-tools">允许的工具 <small>每行一个工具名；留空不授权任何工具</small></label><textarea id="mcp-tools" class="full" rows="5" placeholder="search
fetch"></textarea></div>
          <button id="register-mcp" class="btn primary" type="submit" disabled>登记服务</button>
          <p id="mcp-check-result" class="note" role="status" aria-live="polite"></p>
        </form></section>
      </div>
    </section>
    <section id="view-delegation" hidden>
      <div class="summary" id="delegation-summary"></div>
      <section class="panel"><div class="panel-head"><h2>Agent 版本与委派关系</h2></div><div class="pad">
        <p class="note">子 Agent 复用已发布的 AgentVersion。选择父 Agent 后，发布后续版本即可调整子 Agent、并发上限和委派深度。实际委派能力取父子权限交集。</p>
        <div id="delegation-registry" class="resource-list"></div>
      </div></section>
    </section>
    <section id="view-settings" hidden>
      <div class="console-grid">
        <section class="panel"><div class="panel-head"><h2>部署配置与租户授权</h2><span class="pill">只读</span></div><div class="pad">
          <p class="note">模型、Sandbox、Skill Bundle 和 MCP Endpoint 由服务端部署配置管理，修改后需重启相关 API / Worker。此处展示当前租户可用资源，不显示凭证或 Endpoint URL。</p>
          <table class="config-table"><tbody id="deployment-settings"></tbody></table>
        </div></section>
        <section class="panel"><div class="panel-head"><h2>新建 Agent 默认值</h2><span class="pill">租户范围</span></div><form id="defaults-form" class="pad">
          <p class="note">保存后应用于新建草稿，不修改已发布 Agent 或已有会话。Demo 默认值保存在内存中，生产默认值保存在数据库中。</p>
          <div class="grid2"><div class="field-wrap"><label class="field" for="default-provider">Provider</label><input id="default-provider" class="full" required list="provider-options"></div><div class="field-wrap"><label class="field" for="default-model">Model ID</label><input id="default-model" class="full" required list="model-options"></div></div>
          <div class="field-wrap"><label class="field" for="default-bundle">Bundle</label><select id="default-bundle" class="full" required></select></div>
          <div class="field-wrap"><label class="field">默认工具</label><div id="default-tools" class="choices"></div></div>
          <div class="grid2">
            <div class="field-wrap"><label class="field" for="default-steps">最大步骤</label><input id="default-steps" class="full" required type="number" min="1" max="100"></div>
            <div class="field-wrap"><label class="field" for="default-tokens">Token 预算</label><input id="default-tokens" class="full" required type="number" min="100" max="1000000"></div>
            <div class="field-wrap"><label class="field" for="default-timeout">超时（秒）</label><input id="default-timeout" class="full" required type="number" min="1" max="1800"></div>
            <div class="field-wrap"><label class="field" for="default-subagents">子 Agent 上限</label><input id="default-subagents" class="full" required type="number" min="0" max="5"></div>
            <div class="field-wrap"><label class="field" for="default-depth">最大委派深度</label><input id="default-depth" class="full" required type="number" min="0" max="3"></div>
          </div>
          <p id="defaults-conflict" class="note" role="status" aria-live="polite" hidden></p>
          <button id="reload-defaults" class="btn" type="button" hidden disabled>放弃草稿并载入服务器默认值</button>
          <button id="save-defaults" class="btn primary" type="submit" disabled>保存默认值</button>
        </form></section>
      </div>
    </section>
    <datalist id="provider-options"></datalist><datalist id="model-options"></datalist>
  </main>
  <script nonce="__AGENT_UI_NONCE__">
    "use strict";
    const $ = (id) => document.getElementById(id);
    const toolNames = ["read","write","edit","bash","ls","grep","find","todo","ask_user_question","delegate_to_agent"];
    const defaults = {
      name:"",systemPrompt:"",agentsMd:[],model:{provider:"",modelId:""},
      tools:["read","ls","grep","find"],skills:[],mcpServers:[],subagents:[],
      skillBundle:"default",maxSteps:30,maxTokens:100000,timeoutSeconds:600,maxSubagents:2,maxDepth:1
    };
    let token = "";
    let connection = new AbortController();
    let agents = [], skills = [], mcps = [], selected = null, draft = null, busy = false;
    let formMode = "new";
    let configuration = null;
    let defaultsFormInitialized = false;
    let defaultsBaseline = "", defaultsServerBaseline = "", defaultsConflict = false, defaultsExpectedRevision = 0;
    function notify(message, error) {
      $("message").textContent = message;
      $("message").className = "message " + (error ? "error" : "show");
    }
    function resetMessage() { $("message").className = "message"; }
    function current(session) {
      if (session !== connection || session.signal.aborted) throw new DOMException("连接已结束", "AbortError");
    }
    function endConnection() {
      connection.abort();
      connection = new AbortController();
      token = "";agents = [];skills = [];mcps = [];selected = null;configuration = null;defaultsFormInitialized = false;
      $("mcp-check-result").textContent = "";
      $("token").value = "";
      $("disconnect").disabled = true;$("connection").textContent = "未连接";
      newDraft();renderConsole();setBusy(false);
    }
    async function api(path, method, body, session = connection) {
      current(session);
      if (!token) throw new Error("请先连接管理员令牌");
      const response = await fetch("/api/v1" + path, {
        method: method || "GET",
        headers: {Authorization: "Bearer " + token, ...(body === undefined ? {} : {"Content-Type":"application/json"})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        cache:"no-store",
        credentials:"omit",
        signal:session.signal
      });
      const data = await response.json().catch(() => ({}));
      current(session);
      if (!response.ok) {
        const err = data.error || {};
        const error = new Error((err.code || "HTTP_" + response.status) + ": " + (err.message || response.statusText));
        error.code = err.code;error.status = response.status;throw error;
      }
      return data;
    }
    async function allPages(path, session) {
      const output = [];
      for (let offset = 0; offset < 10000; offset += 100) {
        const data = await api(path + "?offset=" + offset + "&limit=100", undefined, undefined, session);
        output.push(...(data.items || []));
        if (!data.items || data.items.length < 100) return output;
      }
      throw new Error("管理列表超过 10000 条，请缩小数据范围");
    }
    function el(tag, text, cls) {
      const item = document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (cls) item.className = cls;
      return item;
    }
    function selectedValues(group) {
      return [...document.querySelectorAll('input[data-group="' + group + '"]:checked')].map(x => x.value);
    }
    function checkboxGroup(id, options, values) {
      const root = $(id);
      root.replaceChildren();
      const known = new Set(options.map(x => x.value));
      const available = [...options, ...values.filter(v => !known.has(v)).map(v => ({value:v,label:v + "（当前未登记）"}))];
      if (!available.length) root.append(el("span","暂无已登记条目","muted"));
      for (const option of available) {
        const label = el("label",undefined,"choice");
        const input = el("input");
        input.type = "checkbox";
        input.value = option.value;
        input.dataset.group = id;
        input.checked = values.includes(option.value);
        input.disabled = formMode === "view";
        label.append(input,el("span",option.label));
        root.append(label);
      }
    }
    function setField(id, value) { $(id).value = value === undefined || value === null ? "" : String(value); }
    function numberValue(id) { return Number($(id).value); }
    function collect() {
      return {
        name:$("name").value.trim(), systemPrompt:$("prompt").value,
        agentsMd:agentsMdValues(),
        model:{provider:$("provider").value.trim(),modelId:$("model").value.trim()},
        tools:selectedValues("tools"),skills:selectedValues("skills"),
        mcpServers:selectedValues("mcps"),subagents:selectedValues("subagents"),
        skillBundle:$("bundle").value.trim(),maxSteps:numberValue("steps"),
        maxTokens:numberValue("tokens"),timeoutSeconds:numberValue("timeout"),
        maxSubagents:numberValue("max-subagents"),maxDepth:numberValue("depth")
      };
    }
    function agentsMdValues() {
      return [...$("agents-md").querySelectorAll("textarea[data-agents-md]")].map(input=>input.value);
    }
    function renderAgentsMd(values) {
      const root = $("agents-md");root.replaceChildren();
      if (!values.length) root.append(el("p","暂无指令条目","note"));
      values.forEach((value,index)=>{
        const row = el("div",undefined,"field-wrap");
        const label = el("label","指令条目 " + (index + 1),"field");
        const input = el("textarea");input.id = "agents-md-" + index;label.htmlFor = input.id;
        input.className = "full";input.rows = 4;input.maxLength = 32000;
        input.dataset.agentsMd = "true";input.value = value;input.disabled = formMode === "view";
        const remove = el("button","移除条目","btn btn-sm");remove.type = "button";
        remove.dataset.agentsMdAction = "true";remove.disabled = formMode === "view" || busy || !token;
        remove.addEventListener("click",()=>{
          if (formMode === "view" || busy || !token) return;
          renderAgentsMd(agentsMdValues().filter((_,i)=>i !== index));
        });
        row.append(label,input,remove);root.append(row);
      });
      $("add-agents-md").disabled = formMode === "view" || busy || !token;
    }
    function renderChoices(c) {
      checkboxGroup("tools",toolNames.map(s=>({value:s,label:s})),c.tools || []);
      checkboxGroup("skills",skills.map(s=>({value:s.id,label:s.name + " · " + s.id + (s.enabled ? "" : "（禁用）")})),c.skills || []);
      checkboxGroup("mcps",mcps.map(s=>({value:s.id,label:s.id + " · " + s.endpointRef + (s.enabled ? "" : "（禁用）")})),c.mcpServers || []);
      checkboxGroup("subagents",agents.filter(a=>a.id !== (selected && selected.id)).map(a=>({value:a.id,label:a.config.name + " · " + a.id.slice(0,8) + (a.enabled ? "" : "（禁用）")})),c.subagents || []);
    }
    function loadForm(c, mode) {
      draft = structuredClone(c);
      formMode = mode;
      setField("name",c.name);setField("prompt",c.systemPrompt);
      renderAgentsMd(c.agentsMd || []);
      setField("provider",c.model.provider);setField("model",c.model.modelId);
      setField("bundle",c.skillBundle);setField("steps",c.maxSteps);
      setField("tokens",c.maxTokens);setField("timeout",c.timeoutSeconds);
      setField("max-subagents",c.maxSubagents);setField("depth",c.maxDepth);
      renderChoices(c);
      const view = mode === "view";
      for (const input of $("form").querySelectorAll("input,textarea")) input.disabled = view;
      $("publish").disabled = view || !token || busy;
      $("publish").textContent = mode === "clone" ? "发布并激活版本" : "发布 Agent";
      $("clone").disabled = !selected || !token || busy;
      $("form-title").textContent = view ? "查看已发布版本" : mode === "clone" ? "发布新版本" : "新建 Agent";
      $("mode").textContent = view ? "只读版本" : "待发布草稿";
    }
    function renderList() {
      const term = $("search").value.trim().toLowerCase();
      const root = $("list");root.replaceChildren();
      const filtered = agents.filter(a=>a.config.name.toLowerCase().includes(term) || a.id.includes(term));
      $("count").textContent = String(agents.length);
      if (!filtered.length) root.append(el("div",token ? "没有匹配的 Agent" : "请先连接管理员令牌","empty"));
      for (const a of filtered) {
        const btn = el("button",undefined,"agent-item" + (selected && a.id === selected.id ? " active" : ""));
        btn.type = "button";
        const name = el("div",undefined,"agent-name");
        name.append(el("span",a.config.name),el("span",a.enabled ? (a.activeVersionId === a.id ? "生效" : "历史") : "禁用","pill" + (a.enabled ? "" : " off")));
        btn.append(name,el("div","Agent " + (a.agentId || a.id).slice(0,8) + " · 版本 " + a.id.slice(0,8) + " · " + new Date(a.publishedAt).toLocaleDateString(),"agent-id"));
        btn.addEventListener("click",()=>selectAgent(a));
        root.append(btn);
      }
    }
    function renderDetails() {
      $("details").style.display = selected ? "block" : "none";
      $("selection-note").style.display = selected ? "none" : "block";
      if (!selected) return;
      $("agent-id").textContent = selected.agentId || selected.id;
      $("version-id").textContent = selected.id;
      $("published-at").textContent = new Date(selected.publishedAt).toLocaleString();
      $("enabled-label").textContent = selected.enabled ? "已启用" : "已禁用";
      $("digest").textContent = (selected.digest || "").slice(0,16) + "…";
      setField("access-mode",selected.allowedUsers && selected.allowedUsers.length ? "restricted" : "all");
      setField("allowed-users",(selected.allowedUsers || []).join("\n"));
      $("allowed-users").disabled = $("access-mode").value === "all" || busy || !token;
      $("access-mode").disabled = busy || !token;
      $("toggle").textContent = selected.enabled ? "禁用版本" : "启用版本";
      $("toggle").className = "btn btn-sm " + (selected.enabled ? "danger" : "primary");
      $("toggle").disabled = !token || busy;
      $("activate").disabled = !token || busy || !selected.enabled || selected.activeVersionId === selected.id;
      $("save-access").disabled = !token || busy;
    }
    function selectAgent(a) {
      selected = a;
      resetMessage(); renderList();renderDetails();
      loadForm(a.config,"view");
    }
    function newDraft() {
      selected = null;
      renderList();renderDetails();
      loadForm({...defaults,...(configuration && configuration.agentDefaults || {})},"new");
      resetMessage();
    }
    async function refresh(preferredId, session = connection, preserveDraft = false) {
      const savedDraft = preserveDraft && formMode !== "view" ? collect() : null;
      const savedMode = formMode;
      const [a,s,m,c] = await Promise.all([allPages("/admin/agents",session),allPages("/admin/skills",session),api("/admin/mcp-servers",undefined,undefined,session),api("/admin/configuration",undefined,undefined,session)]);
      current(session);
      agents = a.sort((x,y)=>String(y.publishedAt).localeCompare(String(x.publishedAt)));
      skills = s;mcps = m.items || [];configuration = c;
      renderConsole();
      const pick = agents.find(v=>v.id === preferredId);
      if (savedDraft) {renderList();renderDetails();loadForm(savedDraft,savedMode);}
      else if (pick) selectAgent(pick);
      else if (selected && agents.some(v=>v.id === selected.id)) selectAgent(agents.find(v=>v.id === selected.id));
      else newDraft();
    }
    async function refreshAfterMutation(message, id, session, preserveDraft = false) {
      try {
        await refresh(id, session, preserveDraft);
        notify(message);
      } catch(e) {
        if (session !== connection) return;
        notify(message + "\n列表刷新失败：" + e.message + "。可重新连接以刷新数据。");
      }
    }
    function setBusy(value) {
      busy = value;
      $("connect").disabled = value;
      $("new").disabled = value || !token;
      $("publish").disabled = value || !token || formMode === "view";
      $("clone").disabled = value || !token || !selected;
      $("add-agents-md").disabled = value || !token || formMode === "view";
      for (const button of $("agents-md").querySelectorAll("button")) button.disabled = value || !token || formMode === "view";
      $("toggle").disabled = value || !token || !selected;
      $("activate").disabled = value || !token || !selected || !selected.enabled || selected.activeVersionId === selected.id;
      $("save-access").disabled = value || !token || !selected;
      $("access-mode").disabled = value || !token || !selected;
      $("allowed-users").disabled = value || !token || !selected || $("access-mode").value === "all";
      $("reload-defaults").disabled = value || !token;
      for (const id of ["refresh-console","register-skill","register-mcp","save-defaults"]) $(id).disabled = value || !token;
      for (const button of document.querySelectorAll("button[data-admin-action]")) button.disabled = value || !token || button.dataset.disabledServer === "true";
      for (const input of $("default-tools").querySelectorAll("input")) input.disabled = value || !token;
    }
    $("connect").addEventListener("click",async()=>{
      const candidate = $("token").value.trim().replace(/^Bearer\s+/i,"");
      if (!candidate) return notify("请输入管理员令牌",true);
      endConnection();
      const session = connection;
      token = candidate; $("token").value = ""; setBusy(true);
      $("disconnect").disabled = false;
      try {
        await refresh(undefined, session);
        $("disconnect").disabled = false;
        $("connection").textContent = "已连接";
        notify("已连接管理 API，可创建或管理 Agent 版本。");
      } catch(e) {
        if (session !== connection) return;
        endConnection();
        notify("连接失败：" + e.message,true);
      } finally { if (session === connection) setBusy(false); }
    });
    $("disconnect").addEventListener("click",()=>{
      endConnection();notify("已断开，令牌已从页面状态中清除。");
    });
    $("add-agents-md").addEventListener("click",()=>{
      if (formMode === "view" || busy || !token) return;
      renderAgentsMd([...agentsMdValues(),""]);
    });
    $("new").addEventListener("click",newDraft);
    $("search").addEventListener("input",renderList);
    $("clone").addEventListener("click",()=>{
      if (!selected) return;
      loadForm(selected.config,"clone");
      notify("已复制配置到草稿。发布将为同一 Agent 创建并激活新的版本，保留旧版本和当前访问范围。");
    });
    $("form").addEventListener("submit",async(event)=>{
      event.preventDefault();
      if (!token || formMode === "view" || busy) return;
      const config = collect();
      if (!config.name || !config.model.provider || !config.model.modelId || !config.skillBundle) return notify("请填写必填字段",true);
      if (!window.confirm("确认发布新的不可变 Agent 版本？")) return;
      const session = connection;
      setBusy(true);
      try {
        const path = formMode === "clone" && selected
          ? "/admin/agents/" + encodeURIComponent(selected.agentId || selected.id) + "/versions"
          : "/admin/agents";
        const created = await api(path,"POST",config,session);
        created.allowedUsers = formMode === "clone" && selected ? [...(selected.allowedUsers || [])] : [];
        created.activeVersionId = created.id;
        for (const item of agents) if (item.agentId === created.agentId) item.activeVersionId = created.id;
        agents.unshift(created);
        selectAgent(created);
        await refreshAfterMutation("发布成功，AgentVersion ID：" + created.id,created.id,session);
      } catch(e) {if (session === connection) notify("发布失败：" + e.message,true);}
      finally {if (session === connection) setBusy(false);}
    });
    $("access-mode").addEventListener("change",()=>{
      $("allowed-users").disabled = $("access-mode").value === "all" || busy || !token;
    });
    $("save-access").addEventListener("click",async()=>{
      if (!selected || !token || busy) return;
      const id = selected.id;
      const allUsers = $("access-mode").value === "all";
      const allowedUsers = allUsers ? [] : [...new Set($("allowed-users").value.split("\n").map(s=>s.trim()).filter(Boolean))];
      if (!allUsers && !allowedUsers.length) return notify("指定用户模式至少需要一个用户 ID。若要拒绝所有用户访问，请禁用版本。",true);
      if (allUsers && selected.allowedUsers && selected.allowedUsers.length && !window.confirm("此操作将扩大访问范围，允许租户内所有用户使用该 Agent。确认继续？")) return;
      const session = connection;
      setBusy(true);
      try {
        await api("/admin/logical-agents/" + encodeURIComponent(selected.agentId || id) + "/access","PUT",{allowedUsers},session);
        const version = agents.find(a=>a.id === id);
        for (const item of agents)
          if ((item.agentId || item.id) === (version.agentId || version.id)) item.allowedUsers = allowedUsers;
        selectAgent(version);
        await refreshAfterMutation("访问权限已保存。",id,session);
      } catch(e) { if (session === connection) notify("保存失败：" + e.message,true); }
      finally {if (session === connection) setBusy(false);}
    });
    $("activate").addEventListener("click",async()=>{
      if (!selected || !token || busy || !selected.enabled || selected.activeVersionId === selected.id) return;
      const id = selected.id, agentId = selected.agentId || id;
      if (!window.confirm("确认激活此版本？新独立任务将使用此版本，当前 ACL 保持不变。")) return;
      const session = connection;setBusy(true);
      try {
        await api("/admin/agents/" + encodeURIComponent(agentId) + "/active-version","PUT",{agentVersionId:id},session);
        for (const item of agents) if ((item.agentId || item.id) === agentId) item.activeVersionId = id;
        renderList();renderDetails();
        await refreshAfterMutation("生效版本已更新。",id,session);
      } catch(e) {if (session === connection) notify("激活失败：" + e.message,true);}
      finally {if (session === connection) setBusy(false);}
    });
    $("toggle").addEventListener("click",async()=>{
      if (!selected || !token || busy) return;
      const id = selected.id;
      const enabled = !selected.enabled;
      if (!window.confirm("确认" + (enabled ? "启用" : "禁用") + "该 Agent 版本？")) return;
      const session = connection;
      setBusy(true);
      try {
        const version = await api("/admin/agents/" + encodeURIComponent(id) + "/status","PUT",{enabled},session);
        const updated = {...selected,...version};
        agents = agents.map(a=>a.id === id ? updated : a);
        selectAgent(updated);
        await refreshAfterMutation("Agent 已" + (enabled ? "启用" : "禁用") + "。",id,session);
      } catch(e) { if (session === connection) notify("更新失败：" + e.message,true); }
      finally {if (session === connection) setBusy(false);}
    });
    function switchTab(tab) {
      for (const name of ["agents","skills","mcp","delegation","settings"]) {
        $("view-" + name).hidden = name !== tab;
        $("tab-" + name).className = "btn" + (name === tab ? " active" : "");
        $("tab-" + name).setAttribute("aria-pressed",String(name === tab));
      }
      $("new").hidden = tab !== "agents";
    }
    function options(id, values) {
      const root = $(id);const value = root.value;root.replaceChildren();
      for (const ref of values) {const option = el("option",ref);option.value = ref;root.append(option);}
      if (values.includes(value)) root.value = value;
    }
    function resourceCard(name, enabled, detail) {
      const card = el("article",undefined,"resource-card");
      const title = el("div",undefined,"toolbar");title.append(el("h3",name),el("span",enabled ? "启用" : "禁用","pill" + (enabled ? "" : " off")));
      card.append(title,el("p",detail,"note"));return card;
    }
    function action(label, callback) {
      const button = el("button",label,"btn btn-sm");button.type = "button";
      button.dataset.adminAction = "true";button.disabled = !token || busy;
      button.addEventListener("click",callback);return button;
    }
    async function consoleMutation(path, method, body, message, onSuccess) {
      if (!token || busy) return;
      const session = connection;setBusy(true);
      try {
        const result = await api(path,method,body,session);
        if (onSuccess) onSuccess(result);
        renderConsole();
        try {await refresh(undefined,session,true);notify(message);}
        catch(e) {if (session === connection) notify(message + "\n列表刷新失败：" + e.message + "。可重新连接以刷新数据。");}
      } catch(e) {if (session === connection) notify("操作失败：" + e.message,true);}
      finally {if (session === connection) setBusy(false);}
    }
    function collectDefaults() {
      return {model:{provider:$("default-provider").value.trim(),modelId:$("default-model").value.trim()},skillBundle:$("default-bundle").value,tools:selectedValues("default-tools"),maxSteps:numberValue("default-steps"),maxTokens:numberValue("default-tokens"),timeoutSeconds:numberValue("default-timeout"),maxSubagents:numberValue("default-subagents"),maxDepth:numberValue("default-depth")};
    }
    function defaultsKey(d) {
      return JSON.stringify({model:d.model,skillBundle:d.skillBundle,tools:[...(d.tools || [])].sort(),maxSteps:d.maxSteps,maxTokens:d.maxTokens,timeoutSeconds:d.timeoutSeconds,maxSubagents:d.maxSubagents,maxDepth:d.maxDepth});
    }
    function renderConsole() {
      $("skill-count").textContent = String(skills.length);$("mcp-count").textContent = String(mcps.length);
      for (const [id,items,kind] of [["skill-registry",skills,"skills"],["mcp-registry",mcps,"mcp-servers"]]) {
        const root = $(id);root.replaceChildren();
        if (!items.length) root.append(el("div",token ? "暂无已登记条目" : "连接管理员令牌后查看","empty"));
        for (const item of items) {
          const detail = kind === "skills" ? item.id + "\n" + item.description + "\nBundle：" + item.bundle + "\n" + item.path + "\nSHA-256：" + item.digest : "Endpoint：" + item.endpointRef + "\n允许工具：" + (item.allowedTools.join("、") || "无");
          const card = resourceCard(kind === "skills" ? item.name : item.id,item.enabled,detail);
          const toolbar = el("div",undefined,"toolbar");
          toolbar.append(action(item.enabled ? "禁用" : "启用",()=>{
            if (!window.confirm("确认" + (item.enabled ? "禁用" : "启用") + " " + item.id + "？")) return;
            const enabled = !item.enabled;
            return consoleMutation("/admin/" + kind + "/" + encodeURIComponent(item.id) + "/status","PUT",{enabled},"状态已更新。",()=>{item.enabled = enabled;});
          }));
          if (kind === "mcp-servers") {
            const check = action("检查连接",()=>checkMCP(item));check.dataset.disabledServer = String(!item.enabled);check.disabled = !item.enabled || !token || busy;toolbar.append(check);
          }
          card.append(toolbar);root.append(card);
        }
      }
      const deployment = configuration && configuration.deployment || {};
      options("skill-bundle",deployment.bundles || []);options("mcp-endpoint",deployment.endpoints || []);
      options("provider-options",[...new Set((deployment.models || []).map(m=>m.provider))]);options("model-options",[...new Set((deployment.models || []).map(m=>m.modelId))]);
      const rows = $("deployment-settings");rows.replaceChildren();
      const policy = deployment.sandbox || {};
      const entries = [["当前租户",configuration && configuration.tenantId || "未连接"],["获批模型",(deployment.models || []).map(m=>m.provider + " / " + m.modelId).join("、") || (token ? "Demo / 自定义模型" : "—")],["可用 Bundles",(deployment.bundles || []).join("、") || "—"],["可用 Endpoints",(deployment.endpoints || []).join("、") || "—"],["每用户活跃 Sandbox",policy.maxActivePerUser],["全局活跃 Sandbox",policy.maxActiveTotal],["空闲暂停（秒）",policy.idlePauseSeconds],["空闲释放（秒）",policy.idleReleaseSeconds],["扫描间隔（秒）",policy.sweepIntervalSeconds],["每工作区快照上限",policy.maxSnapshotsPerWorkspace]];
      for (const [name,value] of entries) {const row = el("tr");row.append(el("td",name),el("td",value === undefined ? "—" : String(value)));rows.append(row);}
      const serverDefaults = configuration && configuration.agentDefaults || defaults;
      const dirty = defaultsFormInitialized && defaultsKey(collectDefaults()) !== defaultsBaseline;
      defaultsConflict = dirty && (defaultsKey(serverDefaults) !== defaultsServerBaseline || (configuration && configuration.defaultsRevision || 0) !== defaultsExpectedRevision);
      if (!dirty) {
        options("default-bundle",deployment.bundles || []);
        const d = configuration && configuration.agentDefaults || defaults;
        setField("default-provider",d.model.provider);setField("default-model",d.model.modelId);setField("default-bundle",d.skillBundle);
        for (const [field,key] of [["steps","maxSteps"],["tokens","maxTokens"],["timeout","timeoutSeconds"],["subagents","maxSubagents"],["depth","maxDepth"]]) setField("default-" + field,d[key]);
        checkboxGroup("default-tools",toolNames.map(t=>({value:t,label:t})),d.tools || []);
        defaultsFormInitialized = !!configuration;
        defaultsBaseline = defaultsKey(collectDefaults());
        defaultsServerBaseline = defaultsKey(serverDefaults);
        defaultsExpectedRevision = configuration && configuration.defaultsRevision || 0;
      }
      $("defaults-conflict").hidden = !defaultsConflict;
      $("defaults-conflict").textContent = defaultsConflict ? "服务器默认值已被其他管理员更新。当前草稿已保留；保存将覆盖服务器值，也可放弃草稿并载入新值。" : "";
      $("reload-defaults").hidden = !defaultsConflict;
      for (const input of $("default-tools").querySelectorAll("input")) input.disabled = !token || busy;
      const summary = $("delegation-summary");summary.replaceChildren();
      for (const [name,count] of [["Agent 版本",agents.length],["委派关系",agents.reduce((sum,a)=>sum + a.config.subagents.length,0)],["允许委派的父 Agent",agents.filter(a=>a.config.tools.includes("delegate_to_agent")).length]]) {
        const card = el("div",name,"resource-card");card.append(el("strong",String(count)));summary.append(card);
      }
      const relations = $("delegation-registry");relations.replaceChildren();
      if (!agents.length) relations.append(el("div",token ? "发布 Agent 后查看委派关系" : "连接管理员令牌后查看","empty"));
      for (const a of agents) {
        const children = a.config.subagents.map(id=>{const child = agents.find(v=>v.id === id);return child ? child.config.name + " · " + id + (child.enabled ? "" : "（禁用）") : id + "（未找到）";});
        const card = resourceCard(a.config.name,a.enabled,a.id + "\n子 Agent：" + (children.join("\n") || "无") + "\n并发上限：" + a.config.maxSubagents + " · 最大深度：" + a.config.maxDepth + (a.config.tools.includes("delegate_to_agent") ? "" : "\n未启用 delegate_to_agent 工具"));
        card.append(action("查看 / 配置新版本",()=>{switchTab("agents");selectAgent(a);}));relations.append(card);
      }
    }
    async function checkMCP(item) {
      if (!token || busy || !item.enabled) return;
      const session = connection;setBusy(true);$("mcp-check-result").textContent = "正在检查 " + item.id + "…";
      try {
        const result = await api("/admin/mcp-servers/" + encodeURIComponent(item.id) + "/check","POST",{},session);
        $("mcp-check-result").textContent = item.id + " 连接正常。白名单工具：" + (result.tools.map(t=>t.name).join("、") || "无匹配工具");
        notify("MCP 连接检查完成。");
      } catch(e) {if (session === connection) {$("mcp-check-result").textContent = "检查失败：" + e.message;notify("MCP 检查失败：" + e.message,true);}}
      finally {if (session === connection) setBusy(false);}
    }
    for (const tab of ["agents","skills","mcp","delegation","settings"]) $("tab-" + tab).addEventListener("click",()=>switchTab(tab));
    $("refresh-console").addEventListener("click",async()=>{
      if (!token || busy) return;const session = connection;setBusy(true);
      try {await refresh(undefined,session,true);notify("数据已刷新。");}
      catch(e) {if (session === connection) notify("刷新失败：" + e.message,true);}
      finally {if (session === connection) setBusy(false);}
    });
    $("skill-form").addEventListener("submit",event=>{
      event.preventDefault();
      return consoleMutation("/admin/skills","POST",{id:$("skill-id").value.trim(),name:$("skill-name").value.trim(),description:$("skill-description").value,bundle:$("skill-bundle").value,path:$("skill-path").value.trim(),digest:$("skill-digest").value.trim()},"Skill 版本已登记。",created=>{skills.push(created);$("skill-form").reset();});
    });
    $("mcp-form").addEventListener("submit",event=>{
      event.preventDefault();
      return consoleMutation("/admin/mcp-servers","POST",{id:$("mcp-id").value.trim(),endpointRef:$("mcp-endpoint").value,allowedTools:[...new Set($("mcp-tools").value.split("\n").map(s=>s.trim()).filter(Boolean))]},"MCP Server 已登记。",created=>{mcps.push(created);$("mcp-form").reset();});
    });
    $("reload-defaults").addEventListener("click",()=>{
      if (!token || busy) return;
      if (!window.confirm("确认放弃未保存的草稿并载入服务器默认值？")) return;
      defaultsFormInitialized = false;renderConsole();notify("已载入服务器默认值。");
    });
    $("defaults-form").addEventListener("submit",async event=>{
      event.preventDefault();
      if (!token || busy) return;
      if (defaultsConflict && !window.confirm("服务器默认值已更新，确认用当前草稿覆盖服务器值？")) return;
      const expectedRevision = defaultsConflict ? configuration.defaultsRevision : defaultsExpectedRevision;
      const d = {...collectDefaults(),expectedRevision};
      const session = connection;setBusy(true);
      try {
        const saved = await api("/admin/configuration/defaults","PUT",d,session);
        configuration.agentDefaults = saved.agentDefaults;configuration.defaultsRevision = saved.defaultsRevision;
        defaultsFormInitialized = false;renderConsole();
        await refreshAfterMutation("默认值已保存，将用于新建 Agent 草稿。",undefined,session,true);
      } catch(e) {
        if (session !== connection) return;
        if (e.status === 409 && e.code === "DEFAULTS_CONFLICT") {
          try {
            configuration = await api("/admin/configuration",undefined,undefined,session);
            renderConsole();
            notify("保存冲突：服务器默认值已更新，本次未写入。草稿已保留，可重新载入或确认后重试。",true);
          } catch(refreshError) {
            if (session === connection) notify("保存冲突：本次未写入。读取最新配置失败，请刷新数据后重试。",true);
          }
        } else notify("操作失败：" + e.message,true);
      } finally {if (session === connection) setBusy(false);}
    });
    renderConsole();
    newDraft();
  </script>
</body>
</html>
`;
