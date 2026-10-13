/** Minimal standalone admin console served by the Fastify API. */
export const agentAdminHTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Agent 管理 · Pi-Flow</title>
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
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">◆ Pi-Flow <span>Agent Configuration</span></div>
    <div class="auth">
      <input id="token" type="password" autocomplete="off" placeholder="输入管理员 Bearer Token" aria-label="管理员令牌">
      <button class="btn primary btn-sm" id="connect" type="button">连接</button>
      <button class="btn btn-sm" id="disconnect" type="button" disabled>断开</button>
      <span id="connection" style="font-size:12px;color:#a4b2cb">未连接</span>
    </div>
  </header>
  <main class="shell">
    <div class="intro">
      <div><h1>Agent 配置中心</h1><p class="muted">创建智能体、管理能力与发布不可变版本。修改配置需要发布新版本。</p></div>
      <button id="new" class="btn primary" type="button" disabled>＋ 新建 Agent</button>
    </div>
    <div id="message" role="status" aria-live="polite" class="message"></div>
    <div class="layout">
      <aside class="panel">
        <div class="panel-head"><h2>已发布版本</h2><span id="count" class="pill">0</span></div>
        <div class="pad" style="padding-bottom:0"><input class="full" id="search" placeholder="搜索 Agent 名称…" aria-label="搜索 Agent" type="search"></div>
        <div id="list" class="agent-list"><div class="empty">连接 API 后查看 Agent 版本</div></div>
      </aside>
      <section class="panel">
        <div class="panel-head"><h2 id="form-title">新建 Agent</h2><span class="pill" id="mode">草稿</span></div>
        <form id="form">
          <div class="section">
            <h3>基本信息</h3>
            <div class="field-wrap"><label class="field" for="name">Agent 名称</label><input class="full" id="name" required maxlength="100" placeholder="例如：企业代码助手"></div>
            <div class="field-wrap"><label class="field" for="prompt">System Prompt <small>定义角色、职责与行为边界</small></label><textarea class="full" id="prompt" required maxlength="32000" rows="6" placeholder="你是一位…"></textarea></div>
            <div class="field-wrap"><label class="field" for="agents-md">AGENTS.md 指令 <small>每行一条指令；会被转换为 agentsMd 数组，而不是文件路径</small></label><textarea class="full" id="agents-md" rows="3" placeholder="遵循项目编码规范"></textarea></div>
          </div>
          <div class="section">
            <h3>模型配置</h3>
            <div class="grid2">
              <div class="field-wrap"><label class="field" for="provider">Provider</label><input class="full" id="provider" required placeholder="enterprise / demo"></div>
              <div class="field-wrap"><label class="field" for="model">Model ID</label><input class="full" id="model" required placeholder="coding-model / demo"></div>
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
            <button type="button" class="btn" id="clone" disabled>复制为新版本</button>
            <button type="submit" class="btn primary" id="publish" disabled>发布 Agent</button>
          </div>
        </form>
      </section>
      <aside class="panel side-detail">
        <div class="panel-head"><h2>版本与访问控制</h2></div>
        <div class="pad">
          <div class="note" id="selection-note">选中一个已发布版本后，可以管理其状态和访问范围。</div>
          <div id="details" style="display:none">
            <div class="detail-row"><span>版本 ID</span><strong><code id="version-id"></code></strong></div>
            <div class="detail-row"><span>发布时间</span><strong id="published-at"></strong></div>
            <div class="detail-row"><span>状态</span><strong id="enabled-label"></strong></div>
            <div class="detail-row"><span>摘要</span><strong><code id="digest"></code></strong></div>
            <div class="field-wrap" style="margin-top:24px">
              <label class="field" for="allowed-users">允许访问的用户 ID <small>每行一个 UCS Subject，留空表示租户内所有用户可使用</small></label>
              <textarea class="full" id="allowed-users" rows="5"></textarea>
            </div>
            <div class="toolbar">
              <button id="save-access" type="button" class="btn primary btn-sm">保存访问权限</button>
              <button id="toggle" type="button" class="btn danger btn-sm">禁用版本</button>
            </div>
          </div>
          <hr style="border:0;border-top:1px solid #edf0f5;margin:23px 0">
          <p class="note">仅管理员可以访问管理 API。此页不保存令牌到 localStorage、Cookie 或 URL。关闭或刷新页面后需要重新连接。</p>
          <p class="note">已创建的会话仍绑定原 AgentVersion。重新发布不会自动修改历史会话。</p>
          <p class="note"><a href="https://github.com/Garhorne0813/pi-flow/blob/work/docs/api.md" target="_blank" rel="noopener noreferrer">API 文档 ↗</a></p>
        </div>
      </aside>
    </div>
  </main>
  <script>
    "use strict";
    const $ = (id) => document.getElementById(id);
    const toolNames = ["read","write","edit","bash","ls","grep","find","todo","ask_user_question","delegate_to_agent"];
    const defaults = {
      name:"",systemPrompt:"",agentsMd:[],model:{provider:"",modelId:""},
      tools:["read","ls","grep","find"],skills:[],mcpServers:[],subagents:[],
      skillBundle:"default",maxSteps:30,maxTokens:100000,timeoutSeconds:600,maxSubagents:2,maxDepth:1
    };
    let token = "";
    let agents = [], skills = [], mcps = [], selected = null, draft = null, busy = false;
    let formMode = "new";
    function notify(message, error) {
      $("message").textContent = message;
      $("message").className = "message " + (error ? "error" : "show");
    }
    function resetMessage() { $("message").className = "message"; }
    async function api(path, method, body) {
      if (!token) throw new Error("请先连接管理员令牌");
      const response = await fetch("/api/v1" + path, {
        method: method || "GET",
        headers: {Authorization: "Bearer " + token, ...(body === undefined ? {} : {"Content-Type":"application/json"})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        cache:"no-store",
        credentials:"omit"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = data.error || {};
        throw new Error((err.code || "HTTP_" + response.status) + ": " + (err.message || response.statusText));
      }
      return data;
    }
    async function allPages(path) {
      const output = [];
      for (let offset = 0; offset < 10000; offset += 100) {
        const data = await api(path + "?offset=" + offset + "&limit=100");
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
        agentsMd:$("agents-md").value.split("\n").map(s => s.trim()).filter(Boolean),
        model:{provider:$("provider").value.trim(),modelId:$("model").value.trim()},
        tools:selectedValues("tools"),skills:selectedValues("skills"),
        mcpServers:selectedValues("mcps"),subagents:selectedValues("subagents"),
        skillBundle:$("bundle").value.trim(),maxSteps:numberValue("steps"),
        maxTokens:numberValue("tokens"),timeoutSeconds:numberValue("timeout"),
        maxSubagents:numberValue("max-subagents"),maxDepth:numberValue("depth")
      };
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
      setField("agents-md",(c.agentsMd || []).join("\n"));
      setField("provider",c.model.provider);setField("model",c.model.modelId);
      setField("bundle",c.skillBundle);setField("steps",c.maxSteps);
      setField("tokens",c.maxTokens);setField("timeout",c.timeoutSeconds);
      setField("max-subagents",c.maxSubagents);setField("depth",c.maxDepth);
      renderChoices(c);
      const view = mode === "view";
      for (const input of $("form").querySelectorAll("input,textarea")) input.disabled = view;
      $("publish").disabled = view || !token || busy;
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
        name.append(el("span",a.config.name),el("span",a.enabled ? "启用" : "禁用","pill" + (a.enabled ? "" : " off")));
        btn.append(name,el("div",a.id.slice(0,8) + " · " + new Date(a.publishedAt).toLocaleDateString(),"agent-id"));
        btn.addEventListener("click",()=>selectAgent(a));
        root.append(btn);
      }
    }
    function renderDetails() {
      $("details").style.display = selected ? "block" : "none";
      $("selection-note").style.display = selected ? "none" : "block";
      if (!selected) return;
      $("version-id").textContent = selected.id;
      $("published-at").textContent = new Date(selected.publishedAt).toLocaleString();
      $("enabled-label").textContent = selected.enabled ? "已启用" : "已禁用";
      $("digest").textContent = (selected.digest || "").slice(0,16) + "…";
      setField("allowed-users",(selected.allowedUsers || []).join("\n"));
      $("toggle").textContent = selected.enabled ? "禁用版本" : "启用版本";
      $("toggle").className = "btn btn-sm " + (selected.enabled ? "danger" : "primary");
      $("toggle").disabled = !token || busy;
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
      loadForm(defaults,"new");
      resetMessage();
    }
    async function refresh(preferredId) {
      const [a,s,m] = await Promise.all([allPages("/admin/agents"),allPages("/admin/skills"),api("/admin/mcp-servers")]);
      agents = a.sort((x,y)=>String(y.publishedAt).localeCompare(String(x.publishedAt)));
      skills = s;mcps = m.items || [];
      const pick = agents.find(v=>v.id === preferredId);
      if (pick) selectAgent(pick);
      else if (selected && agents.some(v=>v.id === selected.id)) selectAgent(agents.find(v=>v.id === selected.id));
      else newDraft();
    }
    function setBusy(value) {
      busy = value;
      $("connect").disabled = value;
      $("new").disabled = value || !token;
      $("publish").disabled = value || !token || formMode === "view";
      $("clone").disabled = value || !token || !selected;
      $("toggle").disabled = value || !token || !selected;
      $("save-access").disabled = value || !token || !selected;
    }
    $("connect").addEventListener("click",async()=>{
      const candidate = $("token").value.trim().replace(/^Bearer\s+/i,"");
      if (!candidate) return notify("请输入管理员令牌",true);
      token = candidate; $("token").value = ""; setBusy(true);
      try {
        await refresh();
        $("disconnect").disabled = false;
        $("connection").textContent = "已连接";
        notify("已连接管理 API，可创建或管理 Agent 版本。");
      } catch(e) {
        token = "";agents = [];skills = [];mcps = [];newDraft();
        $("connection").textContent = "未连接";
        notify("连接失败：" + e.message,true);
      } finally { setBusy(false); }
    });
    $("disconnect").addEventListener("click",()=>{
      token = "";agents = [];skills = [];mcps = [];selected = null;
      $("disconnect").disabled = true;$("connection").textContent = "未连接";
      newDraft();setBusy(false);notify("已断开，令牌已从页面状态中清除。");
    });
    $("new").addEventListener("click",newDraft);
    $("search").addEventListener("input",renderList);
    $("clone").addEventListener("click",()=>{
      if (!selected) return;
      loadForm(selected.config,"clone");
      notify("已复制配置到草稿。发布将创建新的 AgentVersion ID，不会覆盖旧版本。");
    });
    $("form").addEventListener("submit",async(event)=>{
      event.preventDefault();
      if (!token || formMode === "view" || busy) return;
      const config = collect();
      if (!config.name || !config.model.provider || !config.model.modelId || !config.skillBundle) return notify("请填写必填字段",true);
      if (!window.confirm("确认发布新的不可变 Agent 版本？")) return;
      setBusy(true);
      try {
        const created = await api("/admin/agents","POST",config);
        await refresh(created.id);
        notify("发布成功，AgentVersion ID：" + created.id);
      } catch(e) {notify("发布失败：" + e.message,true);}
      finally {setBusy(false);}
    });
    $("save-access").addEventListener("click",async()=>{
      if (!selected || !token || busy) return;
      const id = selected.id;
      const allowedUsers = [...new Set($("allowed-users").value.split("\n").map(s=>s.trim()).filter(Boolean))];
      setBusy(true);
      try {
        await api("/admin/agents/" + encodeURIComponent(id) + "/access","PUT",{allowedUsers});
        await refresh(id);
        notify("访问权限已保存。");
      } catch(e) { notify("保存失败：" + e.message,true); }
      finally {setBusy(false);}
    });
    $("toggle").addEventListener("click",async()=>{
      if (!selected || !token || busy) return;
      const id = selected.id;
      const enabled = !selected.enabled;
      if (!window.confirm("确认" + (enabled ? "启用" : "禁用") + "该 Agent 版本？")) return;
      setBusy(true);
      try {
        await api("/admin/agents/" + encodeURIComponent(id) + "/status","PUT",{enabled});
        await refresh(id);
        notify("Agent 已" + (enabled ? "启用" : "禁用") + "。");
      } catch(e) { notify("更新失败：" + e.message,true); }
      finally {setBusy(false);}
    });
    newDraft();
  </script>
</body>
</html>
`;
