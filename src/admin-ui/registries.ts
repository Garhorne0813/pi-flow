/** Embedded console registries; composed into the nonce-protected HTML shell. */
export const registries = String.raw`    function switchTab(tab) {
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
        card.append(action("查看 / 配置新版本",()=>{switchTab("agents");if (selectAgent(a)) switchEditor("delegation");}));relations.append(card);
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
`;
