/** Embedded console agentEditor; composed into the nonce-protected HTML shell. */
export const agentEditor = String.raw`    function collect() {
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
      clearReview();
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
      clearReview();
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
      $("publish").textContent = "检查并发布";
      $("clone").disabled = !selected || !token || busy;
      $("form-title").textContent = view ? "查看已发布版本" : mode === "clone" ? "发布新版本" : "新建 Agent";
      $("mode").textContent = view ? "只读版本" : "待发布草稿";
      draft = collect();
    }
    function renderList() {
      const term = $("search").value.trim().toLowerCase();
      const root = $("list");root.replaceChildren();
      const filtered = agents.filter(a=>a.config.name.toLowerCase().includes(term) || a.id.includes(term));
      $("count").textContent = String(agents.length);
      if (!filtered.length) root.append(el("div",token ? "没有匹配的 Agent" : "请先连接管理员令牌","empty"));
      const groups = new Map();
      for (const a of filtered) {
        const key = a.agentId || a.id;
        if (!groups.has(key)) groups.set(key,[]);
        groups.get(key).push(a);
      }
      $("count").textContent = agents.length ? groups.size + " Agents / " + agents.length + " 版本" : "0";
      for (const [agentId,versions] of groups) {
        const group = el("section",undefined,"agent-group");
        const active = versions.find(a=>a.id === a.activeVersionId) || versions[0];
        group.append(el("h3",active.config.name + " · " + versions.length + " 版本"));
        group.append(el("div","Agent " + agentId,"agent-id"));
        for (const a of versions) {
          const btn = el("button",undefined,"agent-item" + (selected && a.id === selected.id ? " active" : ""));
          btn.type = "button";btn.setAttribute("aria-pressed",String(!!selected && a.id === selected.id));
          const name = el("div",undefined,"agent-name");
          name.append(el("span",a.config.name),el("span",a.enabled ? (a.activeVersionId === a.id ? "生效" : "历史") : "禁用","pill" + (a.enabled ? "" : " off")));
          btn.append(name,el("div","版本 " + a.id + " · " + new Date(a.publishedAt).toLocaleString(),"agent-id"));
          btn.addEventListener("click",()=>selectAgent(a));group.append(btn);
        }
        root.append(group);
      }
    }

    function renderDetails() {
      $("details").style.display = selected ? "block" : "none";
      $("selection-note").style.display = selected ? "none" : "block";
      if (!selected) {
        for (const id of ["agent-id","version-id","published-at","enabled-label","digest"]) $(id).textContent = "";
        setField("access-mode","restricted");setField("allowed-users","");accessBaseline = accessKey();
        return;
      }
      $("agent-id").textContent = selected.agentId || selected.id;
      $("version-id").textContent = selected.id;
      $("published-at").textContent = new Date(selected.publishedAt).toLocaleString();
      $("enabled-label").textContent = selected.enabled ? "已启用" : "已禁用";
      $("digest").textContent = (selected.digest || "").slice(0,16) + "…";
      setField("access-mode",selected.allowedUsers && selected.allowedUsers.length ? "restricted" : "all");
      setField("allowed-users",(selected.allowedUsers || []).join("\n"));
      accessBaseline = accessKey();
      $("allowed-users").disabled = $("access-mode").value === "all" || busy || !token;
      $("access-mode").disabled = busy || !token;
      $("toggle").textContent = selected.enabled ? "禁用版本" : "启用版本";
      $("toggle").className = "btn btn-sm " + (selected.enabled ? "danger" : "primary");
      $("toggle").disabled = !token || busy;
      $("activate").disabled = !token || busy || !selected.enabled || selected.activeVersionId === selected.id;
      $("save-access").disabled = !token || busy;
    }
    function selectAgent(a, force = false) {
      if (!force && (busy || !discardAgent())) return false;
      selected = a;
      resetMessage(); renderList();renderDetails();
      loadForm(a.config,"view");
      return true;
    }
    function newDraft(force = false) {
      if (!force && (busy || !discardAgent())) return;
      selected = null;
      renderList();renderDetails();
      loadForm({...defaults,...(configuration && configuration.agentDefaults || {})},"new");
      resetMessage();
    }
`;
