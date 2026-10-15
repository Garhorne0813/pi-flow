import { settings } from "./settings.js";
import { skillUpload } from "./skillUpload.js";
import { registries } from "./registries.js";
import { agentEditor } from "./agentEditor.js";
import { controls } from "./controls.js";
import { apiClient } from "./apiClient.js";
/** Embedded console controller; composed into the nonce-protected HTML shell. */
export const controller = String.raw`    "use strict";
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
    let reviewConfig = null;
    let accessBaseline = "";
    function accessKey() { return JSON.stringify([$("access-mode").value,$("allowed-users").value]); }
    function accessDirty() { return !!selected && accessKey() !== accessBaseline; }
    const editorTabs = ["basic","model","capabilities","delegation","limits"];
    function switchEditor(tab, focus = false) {
      for (const name of editorTabs) {
        $("editor-" + name).hidden = name !== tab;
        const button = $("editor-tab-" + name);
        button.className = "btn" + (name === tab ? " active" : "");
        button.setAttribute("aria-selected",String(name === tab));
        button.tabIndex = name === tab ? 0 : -1;
      }
      if (focus) $("editor-tab-" + tab).focus();
    }
    function agentDirty() { return formMode !== "view" && draft && JSON.stringify(collect()) !== JSON.stringify(draft); }
    function defaultsDirty() { return defaultsFormInitialized && defaultsKey(collectDefaults()) !== defaultsBaseline; }
    function discardAgent(includeAccess = true) { return !(agentDirty() || (includeAccess && accessDirty())) || window.confirm("当前 Agent 有未保存更改，确认放弃草稿？"); }
    function discardConnection() { return !(agentDirty() || defaultsDirty() || accessDirty()) || window.confirm("当前有未保存更改，切换或断开连接会清除草稿。确认继续？"); }
    function clearReview() { reviewConfig = null;$("publish-review").hidden = true;$("confirm-publish").disabled = true;for (const id of ["review-summary","review-warning","review-diff"]) $(id).textContent = ""; }
    window.addEventListener?.("beforeunload",event=>{
      if (agentDirty() || defaultsDirty() || accessDirty()) {event.preventDefault();event.returnValue = "";}
    });
    for (const [index,tab] of editorTabs.entries()) {
      $("editor-tab-" + tab).addEventListener("click",()=>switchEditor(tab));
      $("editor-tab-" + tab).addEventListener("keydown",event=>{
        const next = event.key === "ArrowRight" ? (index + 1) % editorTabs.length : event.key === "ArrowLeft" ? (index + editorTabs.length - 1) % editorTabs.length : event.key === "Home" ? 0 : event.key === "End" ? editorTabs.length - 1 : -1;
        if (next >= 0) {event.preventDefault();switchEditor(editorTabs[next],true);}
      });
    }
    function validateEditor() {
      const invalid = $("form").querySelector?.("input:invalid,textarea:invalid");
      if (!invalid) return true;
      const panel = invalid.closest('[role="tabpanel"]');
      if (panel) switchEditor(panel.id.replace("editor-",""));
      invalid.reportValidity();
      return false;
    }
    $("form").addEventListener("input",clearReview);
    $("form").addEventListener("change",clearReview);
    $("cancel-review").addEventListener("click",()=>{clearReview();$("publish").focus?.();});
    let configuration = null;
    let defaultsFormInitialized = false;
    let defaultsBaseline = "", defaultsServerBaseline = "", defaultsConflict = false, defaultsExpectedRevision = 0;
    function notify(message, error) {
      $("message").textContent = message;
      $("message").className = "message " + (error ? "error" : "show");
    }
    function resetMessage() { $("message").className = "message"; }
    function endConnection() {
      connection.abort();
      connection = new AbortController();
      token = "";agents = [];skills = [];mcps = [];selected = null;configuration = null;defaultsFormInitialized = false;
      $("mcp-check-result").textContent = "";
      $("skill-form").reset?.();$("mcp-form").reset?.();
      $("skill-upload-form").reset?.();resetSkillZip();
      $("token").value = "";
      $("disconnect").disabled = true;$("connection").textContent = "未连接";
      newDraft(true);renderConsole();setBusy(false);
    }
${apiClient}${controls}${agentEditor}    async function refresh(preferredId, session = connection, preserveDraft = false) {
      const savedDraft = preserveDraft && formMode !== "view" ? collect() : null;
      const savedMode = formMode, savedBaseline = draft;
      const savedAccess = preserveDraft && accessDirty() ? {id:selected.id,mode:$("access-mode").value,users:$("allowed-users").value,baseline:accessBaseline} : null;
      const [a,s,m,c] = await Promise.all([allPages("/admin/agents",session),allPages("/admin/skills",session),api("/admin/mcp-servers",undefined,undefined,session),api("/admin/configuration",undefined,undefined,session)]);
      current(session);
      agents = a.sort((x,y)=>String(y.publishedAt).localeCompare(String(x.publishedAt)));
      skills = s;mcps = m.items || [];configuration = c;
      renderConsole();
      const pick = agents.find(v=>v.id === preferredId);
      if (savedDraft) {renderList();renderDetails();loadForm(savedDraft,savedMode);draft = savedBaseline;}
      else if (pick) selectAgent(pick,true);
      else if (selected && agents.some(v=>v.id === selected.id)) selectAgent(agents.find(v=>v.id === selected.id),true);
      else newDraft(true);
      if (savedAccess && selected && selected.id === savedAccess.id) {
        setField("access-mode",savedAccess.mode);setField("allowed-users",savedAccess.users);accessBaseline = savedAccess.baseline;
      }
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
      $("upload-skill").disabled = value || !token || !(configuration && configuration.skillUploads && configuration.skillUploads.enabled);
      renderSkillZip();
      for (const input of $("skill-upload-form").querySelectorAll("input,textarea,select")) input.disabled = value || !token;
      $("skill-zip").disabled = !canSelectSkillZip();
      for (const input of $("form").querySelectorAll("input,textarea")) input.disabled = value || !token || formMode === "view";
      for (const input of $("defaults-form").querySelectorAll("input,select")) input.disabled = value || !token;
      $("connect").disabled = value;
      $("confirm-publish").disabled = value || !token || !reviewConfig;
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
      if (!discardConnection()) return;
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
      if (!discardConnection()) return;
      endConnection();notify("已断开，令牌已从页面状态中清除。");
    });
    $("add-agents-md").addEventListener("click",()=>{
      if (formMode === "view" || busy || !token) return;
      renderAgentsMd([...agentsMdValues(),""]);
    });
    $("new").addEventListener("click",()=>newDraft());
    $("search").addEventListener("input",renderList);
    $("clone").addEventListener("click",()=>{
      if (!selected || busy || !discardAgent()) return;
      renderDetails();loadForm(selected.config,"clone");
      notify("已复制配置到草稿。发布将为同一 Agent 创建并激活新的版本，保留旧版本和当前访问范围。");
    });
    $("form").addEventListener("submit",async(event)=>{
      event.preventDefault();
      if (!token || formMode === "view" || busy || !validateEditor()) return;
      if (accessDirty()) return notify("访问权限有未保存更改，请先保存权限或放弃更改，再检查发布。",true);
      const config = collect();
      if (!config.name || !config.model.provider || !config.model.modelId || !config.skillBundle) return notify("请填写必填字段",true);
      reviewConfig = structuredClone(config);
      const baseline = formMode === "clone" && selected ? selected.config : null;
      const changes = Object.keys(config).filter(key=>!baseline || JSON.stringify(config[key]) !== JSON.stringify(baseline[key]));
      $("review-summary").textContent = config.name + " · " + config.model.provider + " / " + config.model.modelId + " · " + config.maxSteps + " 步 · " + config.maxTokens + " tokens · " + config.timeoutSeconds + " 秒";
      $("review-diff").textContent = changes.length ? changes.map(key=>key + "\n原值：" + (baseline ? JSON.stringify(baseline[key],null,2) : "（新建）") + "\n新值：" + JSON.stringify(config[key],null,2)).join("\n\n") : "配置与所选版本相同。";
      const warnings = [];
      const models = configuration && configuration.deployment && configuration.deployment.models || [];
      if (models.length && !models.some(m=>m.provider === config.model.provider && m.modelId === config.model.modelId)) warnings.push("模型未获部署层批准，请检查模型配置。");
      for (const [ids,registry,label] of [[config.skills,skills,"Skill"],[config.mcpServers,mcps,"MCP"],[config.subagents,agents,"子 Agent"]]) {
        for (const id of ids) {
          const item = registry.find(v=>v.id === id);
          if (!item || !item.enabled) warnings.push(label + " 不可用：" + id);
          if (label === "Skill" && item && item.bundle !== config.skillBundle) warnings.push("Skill Bundle 不匹配：" + id);
        }
      }
      if (config.subagents.length && !config.tools.includes("delegate_to_agent")) warnings.push("已选择子 Agent，但未启用 delegate_to_agent。");
      warnings.push(baseline ? "发布会激活新版本并保留 Agent 当前 ACL。已有会话仅在下一次独立任务时跟随；续跑和子任务保持原版本。" : "新建 Agent 将允许租户内所有用户访问。发布后可设为指定用户或禁用版本。");
      $("review-warning").textContent = warnings.join("\n");
      $("publish-review").hidden = false;$("confirm-publish").disabled = false;
      $("review-title").focus?.();
    });
    $("confirm-publish").addEventListener("click",async()=>{
      if (!token || busy || !reviewConfig || formMode === "view" || !validateEditor()) return;
      if (JSON.stringify(collect()) !== JSON.stringify(reviewConfig)) {clearReview();return notify("配置已变化，请重新检查后发布。",true);}
      const config = structuredClone(reviewConfig);
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
        selectAgent(created,true);
        await refreshAfterMutation("发布成功，AgentVersion ID：" + created.id,created.id,session);
      } catch(e) {if (session === connection) notify("发布失败：" + e.message,true);}
      finally {if (session === connection) setBusy(false);}
    });
    $("access-mode").addEventListener("change",()=>{
      $("allowed-users").disabled = $("access-mode").value === "all" || busy || !token;
    });
    $("save-access").addEventListener("click",async()=>{
      if (!selected || !token || busy) return;
      if (!discardAgent(false)) return;
      const id = selected.id;
      const allUsers = $("access-mode").value === "all";
      const allowedUsers = allUsers ? [] : [...new Set($("allowed-users").value.split("\n").map(s=>s.trim()).filter(Boolean))];
      if (!allUsers && !allowedUsers.length) return notify("指定用户模式至少需要一个用户 ID。若要拒绝所有用户访问，请禁用版本。",true);
      const previousUsers = selected.allowedUsers || [];
      if (previousUsers.length && (allUsers || allowedUsers.some(id=>!previousUsers.includes(id))) && !window.confirm(allUsers ? "此操作将扩大访问范围，允许租户内所有用户使用该 Agent。确认继续？" : "此操作将允许新的指定用户访问该 Agent 的全部版本。确认扩大授权范围？")) return;
      const session = connection;
      setBusy(true);
      try {
        await api("/admin/logical-agents/" + encodeURIComponent(selected.agentId || id) + "/access","PUT",{allowedUsers},session);
        const version = agents.find(a=>a.id === id);
        for (const item of agents)
          if ((item.agentId || item.id) === (version.agentId || version.id)) item.allowedUsers = allowedUsers;
        selectAgent(version,true);
        await refreshAfterMutation("访问权限已保存。",id,session);
      } catch(e) { if (session === connection) notify("保存失败：" + e.message,true); }
      finally {if (session === connection) setBusy(false);}
    });
    $("activate").addEventListener("click",async()=>{
      if (!selected || !token || busy || !selected.enabled || selected.activeVersionId === selected.id) return;
      if (!discardAgent()) return;
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
      if (!discardAgent()) return;
      const id = selected.id;
      const enabled = !selected.enabled;
      if (!window.confirm("确认" + (enabled ? "启用" : "禁用") + "该 Agent 版本？")) return;
      const session = connection;
      setBusy(true);
      try {
        const version = await api("/admin/agents/" + encodeURIComponent(id) + "/status","PUT",{enabled},session);
        const updated = {...selected,...version};
        agents = agents.map(a=>a.id === id ? updated : a);
        selectAgent(updated,true);
        await refreshAfterMutation("Agent 已" + (enabled ? "启用" : "禁用") + "。",id,session);
      } catch(e) { if (session === connection) notify("更新失败：" + e.message,true); }
      finally {if (session === connection) setBusy(false);}
    });
${registries}${skillUpload}    for (const tab of ["agents","skills","mcp","delegation","settings"]) $("tab-" + tab).addEventListener("click",()=>switchTab(tab));
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
${settings}
    renderConsole();
    newDraft();
    renderSkillZip();
`;
