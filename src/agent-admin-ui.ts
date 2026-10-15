import { styles } from "./admin-ui/styles.js";
import { controller } from "./admin-ui/controller.js";

/** Standalone management console served by the Fastify API. */
export const agentAdminHTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>管理控制台 · Pi-Flow</title>
  <style>
${styles}    .zip-dropzone { overflow-wrap:anywhere; padding:20px; border:2px dashed #c2cee4; border-radius:12px; background:#f8faff; text-align:center; transition:background .15s,border-color .15s; }
    .zip-dropzone.dragging { border-color:#405cf5; background:#edf2ff; }
    .zip-dropzone[aria-disabled="true"] { opacity:.6; }
    .zip-dropzone:focus-within { outline:2px solid #a0b4ff; outline-offset:2px; }
    .zip-dropzone p { margin:0 0 12px; }
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
      <button id="tab-settings" class="btn" type="button" aria-pressed="false">部署策略 / 草稿默认值</button>
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
        <form id="form" novalidate>
          <nav class="tabs editor-tabs" role="tablist" aria-label="Agent 配置">
            <button id="editor-tab-basic" type="button" class="btn active" role="tab" aria-controls="editor-basic" aria-selected="true" tabindex="0">基本信息与 Prompt</button>
            <button id="editor-tab-model" type="button" class="btn" role="tab" aria-controls="editor-model" aria-selected="false" tabindex="-1">模型</button>
            <button id="editor-tab-capabilities" type="button" class="btn" role="tab" aria-controls="editor-capabilities" aria-selected="false" tabindex="-1">工具和 Skills</button>
            <button id="editor-tab-delegation" type="button" class="btn" role="tab" aria-controls="editor-delegation" aria-selected="false" tabindex="-1">子 Agent</button>
            <button id="editor-tab-limits" type="button" class="btn" role="tab" aria-controls="editor-limits" aria-selected="false" tabindex="-1">预算与访问</button>
          </nav>
          <div class="section" id="editor-basic" role="tabpanel" aria-labelledby="editor-tab-basic">
            <h3>基本信息</h3>
            <div class="field-wrap"><label class="field" for="name">Agent 名称</label><input class="full" id="name" required maxlength="100" placeholder="例如：企业代码助手"></div>
            <div class="field-wrap"><label class="field" for="prompt">System Prompt <small>定义角色、职责与行为边界</small></label><textarea class="full" id="prompt" maxlength="32000" rows="6" placeholder="你是一位…"></textarea></div>
            <div class="field-wrap"><label class="field">AGENTS.md 指令 <small>每个条目可包含完整的多行 Markdown，按原样保存；不是文件路径。</small></label><div id="agents-md"></div><button id="add-agents-md" class="btn btn-sm" type="button" disabled>＋ 添加指令条目</button></div>
          </div>
          <div class="section" id="editor-model" role="tabpanel" aria-labelledby="editor-tab-model" hidden>
            <h3>模型配置</h3>
            <div class="grid2">
              <div class="field-wrap"><label class="field" for="provider">Provider</label><input class="full" id="provider" list="provider-options" required placeholder="enterprise / demo"></div>
              <div class="field-wrap"><label class="field" for="model">Model ID</label><input class="full" id="model" list="model-options" required placeholder="coding-model / demo"></div>
            </div>
            <p class="section-note">模型必须与服务端 LLM_PROVIDER / LLM_MODEL_ID 的获批配置一致。此页面不管理密钥。</p>
          </div>
          <div class="section" id="editor-capabilities" role="tabpanel" aria-labelledby="editor-tab-capabilities" hidden>
            <h3>工具权限</h3>
            <div id="tools" class="choices"></div>
            <h3 style="margin-top:22px">扩展能力</h3>
            <div class="field-wrap"><label class="field" for="bundle">Skill Bundle</label><input class="full" id="bundle" required value="default" placeholder="default"></div>
            <label class="field">Skills</label><p class="section-note">只能启用管理员已登记、部署端已挂载且属于指定 Bundle 的 Skill。</p>
            <div id="skills" class="choices" style="margin-bottom:18px"></div>
            <label class="field">MCP Servers</label><p class="section-note">使用已登记的 MCP Server ID；Endpoint 与凭证在部署端配置。</p>
            <div id="mcps" class="choices" style="margin-bottom:18px"></div>
          </div>
          <div class="section" id="editor-delegation" role="tabpanel" aria-labelledby="editor-tab-delegation" hidden>
            <h3>子 Agent 委派</h3>
            <label class="field">子 Agent</label><p class="section-note">引用已有 AgentVersion ID。要实际委派，需启用 delegate_to_agent 工具。</p>
            <div id="subagents" class="choices"></div>
          </div>
          <div class="section" id="editor-limits" role="tabpanel" aria-labelledby="editor-tab-limits" hidden>
            <h3>执行配额</h3>
            <p class="note">访问控制统一作用于同一 Agent 的全部版本。已发布版本的访问范围在下方管理；新建 Agent 默认允许租户内所有用户。</p>
            <div class="grid3">
              <div class="field-wrap"><label class="field" for="steps">最大步骤</label><input class="full" id="steps" type="number" min="1" max="100" required></div>
              <div class="field-wrap"><label class="field" for="tokens">Token 预算</label><input class="full" id="tokens" type="number" min="100" max="1000000" required></div>
              <div class="field-wrap"><label class="field" for="timeout">超时（秒）</label><input class="full" id="timeout" type="number" min="1" max="1800" required></div>
              <div class="field-wrap"><label class="field" for="max-subagents">子 Agent 上限</label><input class="full" id="max-subagents" type="number" min="0" max="5" required></div>
              <div class="field-wrap"><label class="field" for="depth">最大委派深度</label><input class="full" id="depth" type="number" min="0" max="3" required></div>
            </div>
          </div>
          <section id="publish-review" class="review" aria-labelledby="review-title" hidden>
            <h3 id="review-title" tabindex="-1">发布前检查</h3>
            <p id="review-summary" class="note"></p>
            <p id="review-warning" class="note" role="status"></p>
            <pre id="review-diff" aria-label="配置差异"></pre>
            <button id="confirm-publish" type="button" class="btn primary" disabled>确认发布不可变版本</button>
            <button id="cancel-review" type="button" class="btn">返回编辑</button>
          </section>
          <div class="footer-actions">
            <button type="button" class="btn" id="clone" disabled>发布后续版本</button>
            <button type="submit" class="btn primary" id="publish" disabled>检查并发布</button>
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
        <section class="panel"><div class="panel-head"><h2>上传 Skill ZIP</h2></div>
          <form id="skill-upload-form" class="pad">
            <p class="note">ZIP 中包含一个 Skill：SKILL.md 位于根目录，或位于唯一的顶层目录中，可附带 scripts / references 等文件。上传后自动登记为不可变版本，可直接在 Agent 中选择。</p>
            <p id="skill-upload-status" class="note" role="status" aria-live="polite">连接后查看上传能力。</p>
            <div class="field-wrap"><label class="field" for="upload-skill-id">版本 ID</label><input id="upload-skill-id" class="full" required maxlength="200" pattern="[a-zA-Z0-9_\-]+@[a-zA-Z0-9_\-]+" placeholder="code-review@v1"></div>
            <div class="field-wrap"><label class="field" for="upload-skill-name">名称</label><input id="upload-skill-name" class="full" required maxlength="100" placeholder="代码审查"></div>
            <div class="field-wrap"><label class="field" for="upload-skill-description">描述</label><textarea id="upload-skill-description" class="full" maxlength="2000"></textarea></div>
            <div class="field-wrap"><label class="field" for="upload-skill-bundle">Bundle</label><select id="upload-skill-bundle" class="full" required></select></div>
            <div class="field-wrap"><label class="field" for="skill-zip">Skill ZIP 包</label>
              <div id="skill-zip-dropzone" class="zip-dropzone" role="group" aria-label="Skill ZIP 拖拽上传区" aria-disabled="true">
                <p>将单个 ZIP 文件拖到这里</p>
                <input id="skill-zip" class="full" type="file" accept=".zip,application/zip,application/x-zip-compressed" aria-describedby="skill-zip-selection" required disabled>
                <p id="skill-zip-selection" class="note" role="status" aria-live="polite" style="margin:12px 0 0">也可点击选择文件，填写版本信息后点击上传。</p>
              </div>
            </div>
            <button id="upload-skill" class="btn primary" type="submit" disabled>上传并登记版本</button>
          </form>
          <details><summary class="pad">登记已有部署版本</summary><form id="skill-form" class="pad">
          <p class="note">Skill 版本不可变。更新内容需登记新的版本 ID；Skill 文件和卷需先部署到服务器。</p>
          <div class="field-wrap"><label class="field" for="skill-id">版本 ID</label><input id="skill-id" class="full" required pattern="[a-zA-Z0-9_\-]+@[a-zA-Z0-9_\-]+" placeholder="code-review@v1"></div>
          <div class="field-wrap"><label class="field" for="skill-name">名称</label><input id="skill-name" class="full" required maxlength="100"></div>
          <div class="field-wrap"><label class="field" for="skill-description">描述</label><textarea id="skill-description" class="full" maxlength="2000"></textarea></div>
          <div class="field-wrap"><label class="field" for="skill-bundle">Bundle</label><select id="skill-bundle" class="full" required></select></div>
          <div class="field-wrap"><label class="field" for="skill-path">文件路径</label><input id="skill-path" class="full" required pattern="/skills/([a-zA-Z0-9_\-]+/)+SKILL\.md" placeholder="/skills/code-review/SKILL.md"></div>
          <div class="field-wrap"><label class="field" for="skill-digest">SHA-256 摘要</label><input id="skill-digest" class="full" required pattern="[a-f0-9]{64}" minlength="64" maxlength="64" placeholder="Skill 文件的 SHA-256"></div>
          <button id="register-skill" class="btn primary" type="submit" disabled>登记版本</button>
        </form></details></section>
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
${controller}  </script>
</body>
</html>
`;
