# 新前端管理中心

旧的嵌入式 HTML 管理台已移除。`/admin/ui`、`/admin/agents/ui` 仅重定向到
新前端 `/admin/agents`；不再输入或单独保存管理员 Token，统一使用前端登录态。
管理入口、页面守卫和所有管理 API 均要求管理员身份。

| 页面 | 功能 |
| --- | --- |
| `/admin/agents` | 搜索、新建、编辑 Agent；System Prompt、多条 AGENTS.md 原样保存、模型、工具、Skills/MCP 绑定、子 Agent、预算、启停、用户访问范围；保存前预览和 revision 冲突保护 |
| `/admin/skills` | ZIP 选择/拖拽上传、登记已部署版本、查看元数据、启停 |
| `/admin/mcp` | 登记授权 Endpoint、工具白名单、启停、只读连接检查 |
| `/admin/delegation` | 委派关系、工具开关和执行限制概览，进入对应 Agent 编辑 |
| `/admin/settings` | 模型目录、只写密钥更新、全局工具策略、新建 Agent 默认配置、只读部署信息 |

当前 Personal Platform 的 Agent 原地编辑；保存使用完整清单和 revision 防止覆盖
其他管理员的修改。尚未暴露在表单中的合法配置字段会保留。排队和审批续跑任务仍
使用原有配置快照。扩大指定用户访问范围需额外确认；指定用户为空不会变成所有用户。

Skills 的版本内容不可变，更新需新版本 ID；现有后端未提供删除和远程文本编辑接口，
因此页面提供停用和新版本上传。ZIP 必须包含单个 Skill（根目录或唯一顶层目录下的
SKILL.md），可包含 scripts/references。大小、路径、摘要及解压安全校验仍由后端负责。
上传未配置时禁用上传控件，已有部署版本仍可登记。

MCP Endpoint 和凭证在服务端部署配置中设置；连接检查只执行工具发现，不调用工具。

构建：`npm ci --prefix web && npm run build --prefix web`。Fastify 默认从 `web/dist`
提供 SPA 和带哈希的静态资源；未构建返回 `WEB_UI_NOT_BUILT`。Docker 镜像构建包含
前端阶段。生产通过公开的 VITE_OIDC_* 构建参数配置 OIDC，严禁将密钥作为构建参数。
`CHAT_UI_ENABLED=false` 可禁用静态前端，API 保持原有授权；`CHAT_WEB_DIR` 可指定
静态资源目录。外部反向代理部署时需为上述 SPA 地址配置 history fallback。

用户自己的主题、快捷键和默认 Agent 偏好位于 `/settings`，不会修改平台全局配置。
