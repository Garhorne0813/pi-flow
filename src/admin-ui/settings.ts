/** Tenant defaults draft serialization and revision-aware saving. */
export const settings = String.raw`    function collectDefaults() {
      return {model:{provider:$("default-provider").value.trim(),modelId:$("default-model").value.trim()},skillBundle:$("default-bundle").value,tools:selectedValues("default-tools"),maxSteps:numberValue("default-steps"),maxTokens:numberValue("default-tokens"),timeoutSeconds:numberValue("default-timeout"),maxSubagents:numberValue("default-subagents"),maxDepth:numberValue("default-depth")};
    }
    function defaultsKey(d) {
      return JSON.stringify({model:d.model,skillBundle:d.skillBundle,tools:[...(d.tools || [])].sort(),maxSteps:d.maxSteps,maxTokens:d.maxTokens,timeoutSeconds:d.timeoutSeconds,maxSubagents:d.maxSubagents,maxDepth:d.maxDepth});
    }
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
`;
